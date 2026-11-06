import { Agent, Block, evaluate, Include, type AML } from "@aml-jsx/sdk"
import { z } from "zod"

import {
  compareReviewHistory,
  isComparableReviewDelta,
  MAX_REVIEW_DELTA_EVIDENCE_CHARS
} from "../../lib/review-gate.js"
import { WHERE_TO_LOOK_HEADING } from "../../lib/land.js"
import { reviewVerdict, type ReviewFinding } from "../../lib/review-queue.js"
import { REVIEW_POLICY_INCLUDE_LIMIT_BYTES } from "../../prompt-limits.js"
import { ReviewContextPrompt } from "../context/prompt.js"
import { useReviewContext } from "../context/review-context.js"

const SummarySchema = z
  .string()
  .trim()
  .min(1)
  .max(600)
  .refine(value => value.split(/\s+/u).length <= 80, "summary must contain at most 80 words")
const RecommendationSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine(value => value.split(/\s+/u).length <= 50, "recommendation must contain at most 50 words")
const SinceLastReviewSchema = SummarySchema.nullable()
  .default(null)
  .describe(
    "A concise comparison with the previous review, including a material direction change. Return a value only for a complete ancestor_diff or rebase_compare; otherwise return null."
  )

const WhereToLookSchema = z
  .array(z.string().trim().min(1).max(300))
  .max(5)
  .nullable()
  .default(null)
  .describe("Null unless the policy asks for this list.")

const SynthesisSchema = z
  .object({
    direct_answer: z.string().trim().min(1).max(2_000).nullable(),
    summary: SummarySchema,
    since_last_review: SinceLastReviewSchema,
    recommendation: RecommendationSchema.nullable(),
    where_to_look: WhereToLookSchema
  })
  .strict()

/** Selects the one retained concern synthesis should prioritize for the author. */
function primaryFinding(findings: ReviewFinding[]): ReviewFinding | null {
  let selected: { finding: ReviewFinding; rank: number } | null = null

  for (const finding of findings) {
    let rank: number | null = null
    if (finding.kind === "blocker") {
      rank = 0
    } else if (finding.kind === "inline") {
      rank = { critical: 1, high: 2, question: 3, low: 4, nit: 5 }[finding.severity]
    }
    if (rank !== null && (!selected || rank < selected.rank)) {
      selected = { finding, rank }
    }
  }

  return selected?.finding || null
}

type SynthesisAgentProps = AML.PropsWithRequiredChildren<{
  readonly evidence: unknown
  readonly land: boolean
}>

const SynthesisAgent: AML.Component<SynthesisAgentProps> = ({ children, evidence, land }) => {
  return (
    <Agent
      name="review-synthesis"
      permissions={{ filesystem: "read-only", network: false, shell: false }}
      system="You write a concise pull-request review summary from validated evidence without inventing findings."
    >
      <Block tag="synthesis-policy">
        <Include src="./instructions/synthesis.md" maxBytes={REVIEW_POLICY_INCLUDE_LIMIT_BYTES} title={false} />
        {land ? (
          <Include src="./instructions/where-to-look.md" maxBytes={REVIEW_POLICY_INCLUDE_LIMIT_BYTES} title={false} />
        ) : null}
      </Block>
      <Block tag="audit-handoff">
        The validated audit handoff resolves below before synthesis starts. Treat it as explanatory context; the
        application-owned final evidence that follows is authoritative.
        <Block>{children}</Block>
      </Block>
      <Block>
        Write the author-facing main review body from this application-owned final evidence:
        <Block tag="validated-review">{JSON.stringify(evidence, null, 2)}</Block>
        Use the pull-request and referenced-issue context below to describe the change and its requirement coverage. The
        application-owned conversation above contains the only prior PR discussion relevant to this top-level response.
        <ReviewContextPrompt history issues />
      </Block>
    </Agent>
  )
}

/** Resolves audit, finalizes its queue, and returns the composed author-facing review body. */
type ReviewSynthesisProps = AML.PropsWithRequiredChildren

export const ReviewSynthesis: AML.Component<ReviewSynthesisProps> = async ({ children }) => {
  const review = useReviewContext()
  const auditHandoff = await evaluate(children)
  const lanes = review.queue.completed()
  const validated = review.queue.finalize()
  const finalVerdict = reviewVerdict(validated.findings)
  // Manual reviews bypass gate comparison, while follow-up gates may escalate.
  // Rebuild from the immutable snapshot so synthesis owns the evidence it publishes.
  const comparison = compareReviewHistory(review.snapshot, review.github.request.workspace)
  const { text: comparisonText, ...comparisonMetadata } = comparison.delta
  const comparisonEvidenceComplete = comparisonText.length <= MAX_REVIEW_DELTA_EVIDENCE_CHARS
  const canUseSinceLastReview =
    comparisonEvidenceComplete && comparison.previousReview !== null && isComparableReviewDelta(comparison.delta.mode)
  const topLevelActionItems = review.snapshot.actionItems.filter(
    item => item.kind === "trigger_request" || item.kind === "mentioned"
  )
  const synthesis = await evaluate(
    <SynthesisAgent
      land={review.github.request.land === true}
      evidence={{
        lane_assessments: lanes,
        review_iteration: {
          previous_review: comparison.previousReview
            ? {
                commit_id: comparison.previousReview.commitId,
                submitted_at: comparison.previousReview.submittedAt,
                state: comparison.previousReview.state
              }
            : null,
          comparison: {
            ...comparisonMetadata,
            evidence_complete: comparisonEvidenceComplete,
            evidence: comparisonEvidenceComplete ? comparisonText : null
          }
        },
        final_review: {
          findings: validated.findings,
          primary_finding: primaryFinding(validated.findings),
          verdict: finalVerdict
        },
        conversation: {
          participants: review.snapshot.participants,
          top_level_action_items: topLevelActionItems
        }
      }}
    >
      {auditHandoff}
    </SynthesisAgent>,
    SynthesisSchema
  )
  // Anchorless findings render in their own verdict sections: blockers hijack
  // the verdict, notes never do.
  const blockers = validated.findings.filter(finding => finding.kind === "blocker")
  const notes = validated.findings.filter(finding => finding.kind === "note")
  // Thread replies are published beside their original comment. Even if a
  // provider ignores the prompt, they must never leak into the top-level body.
  const directAnswer = topLevelActionItems.length > 0 ? synthesis.direct_answer : null
  // An LGTM has no required work regardless of prose a provider returns
  // against the structured contract.
  const recommendation = finalVerdict === "✅ LGTM" ? null : synthesis.recommendation
  // Synthesis owns semantic continuity. The complete summary remains a safe
  // fallback, while known missing comparison anchors fail closed even if the
  // provider returns relative prose against the contract.
  const sinceLastReview = canUseSinceLastReview ? synthesis.since_last_review : null
  const summary = sinceLastReview || synthesis.summary
  const summaryHeading = sinceLastReview ? "Since last review" : "Review Summary"
  const whereToLook = review.github.request.land ? synthesis.where_to_look : null
  return (
    <>
      {directAnswer ? <Block>{directAnswer}</Block> : null}
      ## {summaryHeading}
      <Block>{summary}</Block>
      {recommendation ? (
        <>
          ## Recommendations
          <Block>{recommendation}</Block>
        </>
      ) : null}
      {blockers.length > 0 ? (
        <>
          ## Blockers
          <Block>{blockers.map(finding => `- ${finding.body}`).join("\n")}</Block>
        </>
      ) : null}
      {notes.length > 0 ? (
        <>
          ## 📝 Review notes
          <Block>{notes.map(finding => `- ${finding.body}`).join("\n")}</Block>
        </>
      ) : null}
      {whereToLook && whereToLook.length > 0 ? (
        <>
          {WHERE_TO_LOOK_HEADING}
          <Block>{whereToLook.map(item => `- ${item}`).join("\n")}</Block>
        </>
      ) : null}
      ## Verdict
      <Block>{finalVerdict}</Block>
    </>
  )
}
