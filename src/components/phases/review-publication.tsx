import type { AML } from "@aml-jsx/sdk"

import {
  LAND_VERDICTS,
  stripLandMarkers,
  verdictMarker,
  type LandReviewKind,
  type LandVerdict
} from "../../lib/land.js"
import { reviewVerdict } from "../../lib/review-queue.js"
import { applyReviewBanner, enforceReviewBodyLimit } from "../../lib/render/review-body.js"
import { serializeReviewPayload } from "../../services/github/review-serializer.js"
import type { PublishedReview, ReviewDraft, ReviewRequest } from "../../types/review.js"
import type { PublicationExpectation } from "../../services/github/actions.js"
import { createGitHubWriteTools, type ReviewPublicationPlan } from "../../tools/github-write.js"
import { useReviewContext } from "../context/review-context.js"

/** Renders the verdict record for repositories that opted into land, and nothing otherwise. */
function landRecord(request: ReviewRequest, verdict: LandVerdict, kind: LandReviewKind): string {
  return request.land ? `\n\n${verdictMarker({ sha: request.workspaceHeadSha, verdict, kind })}` : ""
}

/** Reads the completed route and publishes it through deterministic application-owned Tools. */
export const ReviewPublication: AML.Component = async () => {
  const review = useReviewContext()
  const { actions, github, model, outcome, routing } = review
  const { gate, body } = routing.get()

  let draft: ReviewDraft
  if (gate.decision === "review") {
    const validated = review.queue.finalize()
    draft = {
      status: "reviewed",
      gate,
      lanes: review.queue.completed(),
      audit: { findings: review.queue.audited() },
      validated: validated.queue,
      body
    }
  } else {
    draft = {
      status: gate.decision === "answer" ? "answered" : "no-review",
      gate,
      body
    }
  }

  let published: PublishedReview
  let plan: ReviewPublicationPlan
  let expectation: PublicationExpectation

  if (draft.status === "reviewed") {
    // The record goes after the length limit so truncation can never drop it.
    const limited = enforceReviewBodyLimit(applyReviewBanner(stripLandMarkers(draft.body), model))
    const verdict = LAND_VERDICTS[reviewVerdict(review.queue.finalize().findings)]
    const body = `${limited}${landRecord(github.request, verdict, "full")}`
    const validated = { ...draft.validated, conclusion: body }
    const payload = serializeReviewPayload(validated)
    published = { ...draft, body, validated, payload }
    plan = { kind: "review", prNumber: github.request.prNumber, payload, replies: validated.replies }
    expectation = { kind: "review", replies: validated.replies.length }
  } else {
    // A no-review decision is always an LGTM of the delta; an answer judges nothing.
    const record = draft.status === "no-review" ? landRecord(github.request, "lgtm", "delta") : ""
    published = { ...draft, body: `${stripLandMarkers(draft.body)}${record}` }
    plan = { kind: "pr-comment", prNumber: github.request.prNumber, body: published.body }
    expectation = { kind: "pr-comment" }
  }

  const tools = createGitHubWriteTools(actions, plan)
  let publicationError: string | null = null

  try {
    // Validation anchors belong to one immutable head. Re-review instead of
    // publishing comments prepared for a commit GitHub has already replaced.
    await github.assertReviewContextUnchanged()
    if (plan.kind === "pr-comment") {
      await tools.postPrComment({})
    } else {
      await tools.submitPullRequestReview({})
      for (const [index] of plan.replies.entries()) {
        await tools.replyToReviewComment({ index })
      }
    }
  } catch (error) {
    // A rejected POST may have reached GitHub. The action ledger decides
    // whether completion is proven; ambiguous mutations are never replayed.
    const message = error instanceof Error ? error.message : String(error)
    const state = actions.publicationState(expectation)
    if (state === "ambiguous") {
      publicationError = `GitHub mutation outcome is ambiguous; publication was not replayed: ${message}`
    } else if (state !== "completed") {
      publicationError = `GitHub publication failed before completion: ${message}`
    }
  }

  if (!publicationError && actions.publicationState(expectation) !== "completed") {
    publicationError = "GitHub publisher finished without completing every prepared mutation"
  }
  outcome.publish(published, publicationError)
  return ""
}
