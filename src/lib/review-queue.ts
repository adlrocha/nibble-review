import { isAbsolute } from "node:path"
import { z } from "zod"

import type { ReviewComment, ReviewThread } from "../services/github/client.js"
import { reviewAuthorship } from "./review-authorship.js"
import type { ValidCommentRanges } from "./review-diff.js"

/** Canonical lane names and their short, model-facing finding ID prefixes. */
export const REVIEW_LANES = {
  "intent-contract": "INT",
  "standards-architecture": "ARCH",
  "code-path-bug-hunter": "BUG",
  "correctness-risk-testing": "RISK",
  "documentation-commentary": "DOC",
  "maintainability-elegance": "ELE"
} as const

export type ReviewLaneName = keyof typeof REVIEW_LANES
export const REVIEW_LANE_NAMES = Object.keys(REVIEW_LANES) as [ReviewLaneName, ...ReviewLaneName[]]

export const ReviewSeveritySchema = z.enum(["critical", "high", "low", "question", "nit"])
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>
export const ReviewDemotionSeveritySchema = z.enum(["high", "low", "nit"])
export type ReviewDemotionSeverity = z.infer<typeof ReviewDemotionSeveritySchema>

const REVIEW_SEVERITY_EMOJI: Record<ReviewSeverity, string> = {
  critical: ":stop_sign:",
  high: ":red_circle:",
  low: ":large_orange_diamond:",
  question: ":question:",
  nit: ":nerd_face::point_up_2:"
}

const REVIEW_SEVERITY_RANK = { critical: 3, high: 2, low: 1, nit: 0 } as const
const NEXT_REVIEW_SEVERITY: Record<Exclude<ReviewSeverity, "question">, ReviewDemotionSeverity | null> = {
  critical: "high",
  high: "low",
  low: "nit",
  nit: null
}

export type ReviewDemotionResult = { action: "demoted"; severity: ReviewDemotionSeverity } | { action: "dropped" }

const FindingBodySchema = z.string().trim().min(1).max(12_000).describe("Exact author-facing GitHub Markdown")
const FindingEvidenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .describe("Internal code-path evidence for audit; this text is not published")

export const InlineFindingSchema = z
  .object({
    kind: z.literal("inline"),
    severity: ReviewSeveritySchema.describe("Merge-decision severity from the shared lane policy"),
    body: FindingBodySchema.describe("Exact author-facing review body; this may include a fenced suggestion"),
    evidence: FindingEvidenceSchema,
    confidence: z.enum(["high", "medium", "low"]).describe("Confidence in the internal supporting evidence"),
    comment_type: z.enum(["comment", "suggestion"]).optional(),
    path: z.string().min(1).describe("Repository-relative changed file path"),
    line: z.number().int().positive().describe("Changed line receiving the review comment"),
    side: z.enum(["LEFT", "RIGHT"]).describe("Diff side used by the line or entire range"),
    start_line: z.number().int().positive().optional(),
    start_side: z.enum(["LEFT", "RIGHT"]).optional()
  })
  .strict()

export const ReplyFindingSchema = z
  .object({
    kind: z.literal("reply"),
    body: FindingBodySchema,
    evidence: FindingEvidenceSchema,
    to: z.number().int().positive().describe("Existing top-level review comment id")
  })
  .strict()

/**
 * Advisory PR-level note that cannot honestly anchor to a changed line. Notes
 * carry no severity: their kind alone decides rendering and verdict impact.
 */
export const ReviewNoteSchema = z
  .object({
    kind: z.literal("note"),
    body: FindingBodySchema,
    evidence: FindingEvidenceSchema
  })
  .strict()

/** Emergency stop for a PR-wide condition that is unsafe to land. */
export const ReviewBlockerSchema = z
  .object({
    kind: z.literal("blocker"),
    body: FindingBodySchema,
    evidence: FindingEvidenceSchema
  })
  .strict()

export const ReviewFindingSchema = z.discriminatedUnion("kind", [
  InlineFindingSchema,
  ReplyFindingSchema,
  ReviewNoteSchema,
  ReviewBlockerSchema
])
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>

export const LaneAssessmentSchema = z
  .object({
    lane: z.enum(REVIEW_LANE_NAMES),
    summary: z.string().trim().min(1)
  })
  .strict()

export type LaneAssessment = z.infer<typeof LaneAssessmentSchema>
/**
 * Owner of a staged finding: one specialist lane, or the audit itself for a
 * note the auditor stages directly. Audit ownership stays outside
 * REVIEW_LANES so lane completion and assessments remain lane-only.
 */
export type FindingOwner = ReviewLaneName | "audit"

export type StagedReviewFinding = {
  id: string
  lane: FindingOwner
  finding: ReviewFinding
}

export type ReviewSide = "RIGHT" | "LEFT"
export type ReviewInlineCommentInput = {
  kind?: "comment" | "suggestion"
  path: string
  line: number | string
  start_line?: number | string
  side?: ReviewSide | string
  start_side?: ReviewSide | string
  body: string
}
export type ReviewInlineComment = {
  kind: "comment" | "suggestion"
  path: string
  line: number
  start_line?: number
  side: ReviewSide
  start_side?: ReviewSide
  body: string
}
export type ReviewReply = { to: number; body: string }
export type ValidatedReviewQueue = {
  version: 1
  inlineComments: ReviewInlineComment[]
  replies: ReviewReply[]
  dropped: Array<{ kind: "inline" | "reply"; item: unknown; reason: string }>
  stats: {
    queued_inline: number
    queued_replies: number
    has_conclusion: boolean
    valid_inline: number
    valid_replies: number
    dropped: number
  }
  conclusion: string | null
}

export type ReviewQueueOptions = {
  botLogin: string
  commentRanges: ValidCommentRanges
  reviewEmojis?: boolean
  reviewThreadsAvailable: boolean
  unresolvedBotThreads: ReviewThread[]
  reviewComments: ReviewComment[]
}

export type FinalizedReview = {
  queue: ValidatedReviewQueue
  findings: ReviewFinding[]
}

/**
 * Owns the complete finding lifecycle: lane staging, audit mutations, GitHub
 * anchor checks, exact duplicate suppression, and the final publication queue.
 */
export class ReviewQueue {
  readonly #options: ReviewQueueOptions
  readonly #findings: StagedReviewFinding[] = []
  readonly #findingIds = new Map<string, string>()
  readonly #laneSequences = new Map<ReviewLaneName, number>()
  #auditNoteSequence = 0
  readonly #assessments = new Map<ReviewLaneName, LaneAssessment>()
  #auditFindings: Map<string, StagedReviewFinding> | undefined
  #finalized: FinalizedReview | undefined

  constructor(options: ReviewQueueOptions) {
    this.#options = options
  }

  /** Normalizes a comment into the exact shape accepted by GitHub reviews. */
  static normalizeComment(input: ReviewInlineCommentInput): ReviewInlineComment {
    if (!input.path || input.path.includes("\0") || isAbsolute(input.path)) {
      throw new Error("path must be a non-empty repository-relative path")
    }
    const line = ReviewQueue.positiveInteger(input.line, "line")
    const startLine =
      input.start_line === undefined ? undefined : ReviewQueue.positiveInteger(input.start_line, "start-line")
    const side = ReviewQueue.side(input.side, "side")
    const startSide = input.start_side === undefined ? side : ReviewQueue.side(input.start_side, "start-side")
    const body = ReviewQueue.markdown(input.body)
    if (!body) {
      throw new Error("body must be non-empty")
    }
    if (startLine !== undefined && startSide === side && startLine > line) {
      throw new Error("start-line must be less than or equal to line")
    }

    const comment: ReviewInlineComment = { kind: input.kind || "comment", path: input.path, line, side, body }
    if (startLine !== undefined && (startLine !== line || startSide !== side)) {
      comment.start_line = startLine
      comment.start_side = startSide
    }
    return comment
  }

  /** Validates and idempotently stages one lane-owned finding for semantic audit. */
  add(lane: ReviewLaneName, value: ReviewFinding): { id: string } {
    if (this.#auditFindings) {
      throw new Error("cannot add review findings after audit started")
    }
    const parsed = ReviewFindingSchema.parse(value)
    const finding = { ...parsed, body: ReviewQueue.markdown(parsed.body) } as ReviewFinding
    const key = `${lane}\0${JSON.stringify(finding)}`
    const existingId = this.#findingIds.get(key)
    if (existingId) {
      return { id: existingId }
    }

    // Reject bad Tool arguments while the originating lane can still correct
    // them. Cross-lane and already-posted duplicates remain visible to audit.
    if (finding.kind === "inline") {
      this.#assertAnchor(ReviewQueue.comment(finding, this.#options.reviewEmojis !== false))
    } else if (finding.kind === "reply") {
      this.#assertReplyTarget(finding.to)
    }

    // Lane-local counters stay deterministic even when Parallel completes in a
    // different order, and the lane prefix makes every audit ID unambiguous.
    const sequence = (this.#laneSequences.get(lane) || 0) + 1
    const id = `${REVIEW_LANES[lane]}-${sequence}`
    this.#laneSequences.set(lane, sequence)
    this.#findingIds.set(key, id)
    this.#findings.push({ id, lane, finding })
    return { id }
  }

  /** Records the lane's short internal handoff after its Agent returns. */
  complete(lane: ReviewLaneName, terminalText: string): void {
    const summary = terminalText.trim() || "Review completed without an additional assessment."
    this.#assessments.set(lane, LaneAssessmentSchema.parse({ lane, summary }))
  }

  /** Returns every staged candidate without exposing mutable queue state. */
  staged(): readonly StagedReviewFinding[] {
    return structuredClone(this.#findings)
  }

  /** Opens audit's only mutable view after every parallel lane has finished. */
  beginAudit(): readonly StagedReviewFinding[] {
    if (this.#auditFindings) {
      throw new Error("review findings audit already started")
    }
    this.#auditFindings = new Map(this.#findings.map(finding => [finding.id, structuredClone(finding)]))
    return this.auditCandidates()
  }

  /**
   * Stages one auditor-owned note after audit started. Audit additions are
   * final: the auditor is the calibrator, so its own note needs no further
   * merge, demote, or drop calibration.
   */
  addAuditNote(value: Omit<z.infer<typeof ReviewNoteSchema>, "kind">): { id: string } {
    const audit = this.requireAudit()
    const parsed = ReviewNoteSchema.parse({ kind: "note", ...value })
    const finding = { ...parsed, body: ReviewQueue.markdown(parsed.body) } as ReviewFinding
    this.#auditNoteSequence += 1
    const id = `AUD-${this.#auditNoteSequence}`
    audit.set(id, { id, lane: "audit", finding })
    return { id }
  }

  /** Removes complete findings; audit cannot rewrite author-facing text. */
  drop(ids: readonly string[]): void {
    const audit = this.requireAudit()
    this.assertIds(audit, ids)
    for (const id of ids) {
      audit.delete(id)
    }
  }

  /** Keeps one author-ready finding and removes only its semantic duplicates. */
  merge(keep: string, duplicates: readonly string[]): void {
    const audit = this.requireAudit()
    if (duplicates.includes(keep)) {
      throw new Error(`cannot merge finding ${keep} into itself`)
    }
    this.assertIds(audit, [keep, ...duplicates])
    for (const id of duplicates) {
      audit.delete(id)
    }
  }

  /** Lowers one inline severity while preserving its author text and evidence. */
  demote(id: string, severity?: ReviewDemotionSeverity): ReviewDemotionResult {
    const audit = this.requireAudit()
    this.assertIds(audit, [id])
    const staged = audit.get(id)
    if (!staged) {
      throw new Error(`unknown or inactive review finding id: ${id}`)
    }

    const finding = staged.finding
    if (finding.kind !== "inline") {
      throw new Error(
        `cannot demote ${finding.kind} finding ${id}; only anchored inline findings have ordered severity`
      )
    }
    if (finding.severity === "question") {
      throw new Error(`cannot demote question finding ${id}; questions must be retained or dropped`)
    }

    const target = severity === undefined ? NEXT_REVIEW_SEVERITY[finding.severity] : severity
    if (target === null) {
      audit.delete(id)
      return { action: "dropped" }
    }
    if (REVIEW_SEVERITY_RANK[target] >= REVIEW_SEVERITY_RANK[finding.severity]) {
      throw new Error(`severity ${target} is not lower than ${finding.severity} for review finding ${id}`)
    }

    audit.set(id, { ...staged, finding: { ...finding, severity: target } })
    return { action: "demoted", severity: target }
  }

  /** Returns the author-facing findings produced by audit's calibration Tools. */
  audited(): ReviewFinding[] {
    return this.auditCandidates().map(candidate => candidate.finding)
  }

  /**
   * Freezes audit output into one GitHub queue while preserving typed finding
   * metadata for verdict and synthesis. Exact duplicates are dropped here
   * because only this phase can see both all lanes and prior bot comments.
   */
  finalize(): FinalizedReview {
    if (this.#finalized) {
      return structuredClone(this.#finalized)
    }

    const inlineComments: ReviewInlineComment[] = []
    const replies: ReviewReply[] = []
    const findings: ReviewFinding[] = []
    const dropped: ValidatedReviewQueue["dropped"] = []
    const seenComments = new Set<string>()
    const seenReplies = new Set<string>()
    const previousComments = this.#previousCommentKeys()
    const candidates = this.auditCandidates()

    for (const staged of candidates) {
      const finding = staged.finding
      // Blockers and notes publish at review level, never as an invented
      // inline anchor. Synthesis derives their distinct verdicts.
      if (finding.kind === "note" || finding.kind === "blocker") {
        findings.push(finding)
        continue
      }
      if (finding.kind === "reply") {
        const reply = { to: finding.to, body: ReviewQueue.markdown(finding.body) }
        const key = `${reply.to}\0${reply.body}`
        if (seenReplies.has(key)) {
          dropped.push({ kind: "reply", item: finding, reason: "duplicate queued reply" })
          continue
        }
        this.#assertReplyTarget(reply.to)
        seenReplies.add(key)
        replies.push(reply)
        findings.push(finding)
        continue
      }

      const comment = ReviewQueue.comment(finding, this.#options.reviewEmojis !== false)
      this.#assertAnchor(comment)
      const bodyKey = `${ReviewQueue.locationKey(comment)}\0${ReviewQueue.comparableBody(comment.body)}`
      const previousReason = previousComments.get(bodyKey)
      if (previousReason) {
        dropped.push({ kind: "inline", item: finding, reason: previousReason })
        continue
      }
      const key = ReviewQueue.commentKey(comment)
      if (seenComments.has(key)) {
        dropped.push({ kind: "inline", item: finding, reason: "duplicate queued comment" })
        continue
      }
      seenComments.add(key)
      inlineComments.push(comment)
      findings.push(finding)
    }

    this.#finalized = {
      findings,
      queue: {
        version: 1,
        inlineComments,
        replies,
        dropped,
        stats: {
          queued_inline: candidates.filter(candidate => candidate.finding.kind === "inline").length,
          queued_replies: candidates.filter(candidate => candidate.finding.kind === "reply").length,
          has_conclusion: false,
          valid_inline: inlineComments.length,
          valid_replies: replies.length,
          dropped: dropped.length
        },
        conclusion: null
      }
    }
    return structuredClone(this.#finalized)
  }

  /** Requires every authored lane to return before synthesis consumes summaries. */
  completed(): LaneAssessment[] {
    const missing = REVIEW_LANE_NAMES.filter(lane => !this.#assessments.has(lane))
    if (missing.length > 0) {
      throw new Error(`review lanes did not finish: ${missing.join(", ")}`)
    }
    return REVIEW_LANE_NAMES.map(lane => structuredClone(this.#assessments.get(lane) as LaneAssessment))
  }

  #assertAnchor(comment: ReviewInlineComment): void {
    const ranges = this.#options.commentRanges[comment.path]
    if (!ranges) {
      throw new Error("cannot queue review comment: path is not present in the PR diff")
    }
    const changed = comment.side === "LEFT" ? ranges.deleted_lines : ranges.added_lines
    if (!changed.includes(comment.line)) {
      throw new Error(`cannot queue review comment: line is not a changed ${comment.side}-side line`)
    }
    if (comment.start_line === undefined) {
      return
    }

    const startSide = comment.start_side || comment.side
    const available = startSide === "LEFT" ? ranges.left_lines : ranges.right_lines
    if (startSide !== comment.side) {
      if (!available.includes(comment.start_line)) {
        throw new Error(`cannot queue review comment: start line is not present on the ${startSide} side of the diff`)
      }
      return
    }

    const lineSet = new Set(available)
    for (let line = comment.start_line; line <= comment.line; line += 1) {
      if (!lineSet.has(line)) {
        throw new Error(
          `cannot queue review comment: multi-line range is not fully present on the ${comment.side} side of the diff`
        )
      }
    }
  }

  #assertReplyTarget(commentId: number): void {
    const target = this.#options.reviewComments.find(comment => comment.id === commentId)
    if (!target) {
      throw new Error("cannot queue review reply: target is not a review comment on this PR")
    }
    if (target.in_reply_to_id) {
      throw new Error("cannot queue review reply: GitHub does not support replies to review-comment replies")
    }
  }

  /** Maps exact unresolved/prior bot comments to the reason reported on drop. */
  #previousCommentKeys(): Map<string, string> {
    const matches = new Map<string, string>()
    if (this.#options.reviewThreadsAvailable) {
      for (const thread of this.#options.unresolvedBotThreads) {
        const comment = ReviewQueue.threadComment(thread)
        if (comment) {
          matches.set(
            `${ReviewQueue.locationKey(comment)}\0${ReviewQueue.comparableBody(comment.body)}`,
            "matching unresolved bot thread already exists"
          )
        }
      }
      return matches
    }

    // REST has no resolution state, so suppress only exact top-level bot matches.
    for (const posted of this.#options.reviewComments) {
      if (
        !reviewAuthorship(this.#options.botLogin).isOwn(posted) ||
        posted.in_reply_to_id ||
        !posted.path ||
        !posted.line
      ) {
        continue
      }
      let comment: ReviewInlineComment
      try {
        comment = ReviewQueue.normalizeComment({
          path: posted.path,
          line: posted.line,
          start_line: posted.start_line || posted.startLine || undefined,
          side: posted.side || "RIGHT",
          start_side: posted.start_side || posted.startSide || undefined,
          body: posted.body || ""
        })
      } catch {
        // Historical REST rows are optional duplicate evidence. One malformed
        // legacy comment must not prevent new, valid feedback from publishing.
        continue
      }
      matches.set(
        `${ReviewQueue.locationKey(comment)}\0${ReviewQueue.comparableBody(comment.body)}`,
        "matching previous bot comment already exists"
      )
    }
    return matches
  }

  private static threadComment(thread: ReviewThread): ReviewInlineComment | null {
    const topLevel = thread.comments[0]
    const path = thread.path || topLevel?.path
    const line = thread.line || topLevel?.line
    if (!path || !line) {
      return null
    }
    return ReviewQueue.normalizeComment({
      path,
      line,
      start_line: thread.start_line || topLevel?.start_line || undefined,
      side: thread.side || topLevel?.side || "RIGHT",
      start_side: thread.start_side || topLevel?.start_side || undefined,
      body: topLevel?.body || ""
    })
  }

  private static comment(
    finding: Extract<ReviewFinding, { kind: "inline" }>,
    reviewEmojis: boolean
  ): ReviewInlineComment {
    return ReviewQueue.normalizeComment({
      kind: finding.comment_type || "comment",
      path: finding.path,
      line: finding.line,
      start_line: finding.start_line,
      side: finding.side,
      start_side: finding.start_side,
      body: ReviewQueue.authorComment(finding, reviewEmojis)
    })
  }

  /** Renders application-owned severity once in the eventual inline body. */
  private static authorComment(finding: Extract<ReviewFinding, { kind: "inline" }>, reviewEmojis: boolean): string {
    const emoji = reviewEmojis ? `${REVIEW_SEVERITY_EMOJI[finding.severity]} ` : ""
    return `${emoji}**${finding.severity}:** ${finding.body}`
  }

  /** Preserves Markdown fences while avoiding accidental setext headings. */
  private static markdown(body: unknown): string {
    const normalized: string[] = []
    let fence: { marker: "`" | "~"; length: number } | null = null
    for (const line of String(body || "")
      .trim()
      .replace(/\r\n?/gu, "\n")
      .split("\n")) {
      const marker = /^(?<fence>`{3,}|~{3,})/u.exec(line.trim())?.groups?.fence
      if (marker) {
        const current = { marker: marker[0] as "`" | "~", length: marker.length }
        if (!fence) {
          fence = current
        } else if (current.marker === fence.marker && current.length >= fence.length) {
          fence = null
        }
      }
      if (!fence && /^-{3,}$/u.test(line.trim()) && normalized.at(-1)?.trim()) {
        normalized.push("")
      }
      normalized.push(line)
    }
    return normalized.join("\n").trim()
  }

  private static positiveInteger(value: unknown, name: string): number {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive integer`)
    }
    return parsed
  }

  private static side(value: unknown, name: string): ReviewSide {
    const side = String(value || "RIGHT").toUpperCase()
    if (side !== "LEFT" && side !== "RIGHT") {
      throw new Error(`${name} must be LEFT or RIGHT`)
    }
    return side
  }

  private static comparableBody(body: string): string {
    // Severity emoji are presentation only; toggling them must not replay an
    // otherwise identical finding from a previous review.
    const emoji = Object.values(REVIEW_SEVERITY_EMOJI).find(value => body.startsWith(`${value} `))
    const comparable = emoji ? body.slice(emoji.length).trimStart() : body
    return comparable.replace(/\s+/gu, " ").trim()
  }

  private static locationKey(comment: ReviewInlineComment): string {
    return [comment.path, comment.start_line || "", comment.line, comment.side, comment.start_side || ""].join("\0")
  }

  private static commentKey(comment: ReviewInlineComment): string {
    return [comment.kind, ReviewQueue.locationKey(comment), comment.body].join("\0")
  }

  private auditCandidates(): StagedReviewFinding[] {
    return structuredClone([...this.requireAudit().values()])
  }

  private requireAudit(): Map<string, StagedReviewFinding> {
    if (!this.#auditFindings) {
      throw new Error("review findings audit has not started")
    }
    return this.#auditFindings
  }

  /** Rejects empty, repeated, or stale IDs before mutating audit state. */
  private assertIds(findings: ReadonlyMap<string, StagedReviewFinding>, ids: readonly string[]): void {
    if (ids.length === 0) {
      throw new Error("at least one review finding id is required")
    }
    if (new Set(ids).size !== ids.length) {
      throw new Error("review finding ids must be distinct")
    }
    const unknown = ids.filter(id => !findings.has(id))
    if (unknown.length > 0) {
      throw new Error(`unknown or inactive review finding id: ${unknown.join(", ")}`)
    }
  }
}
