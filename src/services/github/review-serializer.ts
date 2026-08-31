import type { ReviewInlineComment, ReviewSide, ValidatedReviewQueue } from "../../lib/review-queue.js"

export type ReviewPayloadComment = {
  path: string
  line: number
  side: ReviewSide
  start_line?: number
  start_side?: ReviewSide
  body: string
}

export type ReviewPayload = {
  body: string
  event: "COMMENT"
  comments: ReviewPayloadComment[]
}

/** Maps one validated finding to GitHub's pull-request review comment shape. */
export function serializeReviewComment(comment: ReviewInlineComment): ReviewPayloadComment {
  const payload: ReviewPayloadComment = {
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body
  }

  // GitHub accepts start_line and start_side only as a pair. A single-line
  // finding omits both rather than sending a partial range contract.
  if (comment.start_line !== undefined) {
    payload.start_line = comment.start_line
    payload.start_side = comment.start_side || comment.side
  }

  return payload
}

/** Serializes the finalized queue into the one batched GitHub review payload. */
export function serializeReviewPayload(validated: ValidatedReviewQueue): ReviewPayload {
  return {
    body: validated.conclusion?.trim() || "Nibble Review completed.",
    event: "COMMENT",
    comments: validated.inlineComments.map(serializeReviewComment)
  }
}
