import type { TraceSummary } from "@aml-jsx/sdk"

import type {
  ReferencedIssueContext,
  IssueComment,
  PullRequestCommit,
  PullRequestReview,
  PullRequestSummary,
  ReviewComment,
  ReviewThread
} from "../services/github/client.js"
import type { DiffFile, ValidCommentRanges } from "../lib/review-diff.js"
import type { ReviewPayload } from "../services/github/review-serializer.js"
import type { LaneAssessment, ValidatedReviewQueue } from "../lib/review-queue.js"
import type { AuditedReview } from "../components/phases/review-audit.js"
import type { ReviewGateResult } from "../components/phases/review-gate.js"
import type { GitHubActionReceipt } from "../services/github/actions.js"
import type { ReviewProviderCompletion, ReviewUsage } from "../lib/review-telemetry.js"
import type { CompactHistory, CompactPullRequestContext } from "../services/github/context-model.js"

/**
 * Contracts carried between the CLI, deterministic snapshot, AML phases, and
 * final eval/publication result. This module owns no runtime behavior.
 */

export type ReviewRequest = {
  repository: string
  prNumber: number
  workspace: string
  workspaceHeadSha: string
  botLogin: string
  command?: string
  eventName: string | null
  eventPath: string | null
  actor: string | null
  triggerCommentId?: number | null
  ignoreHistory: boolean
}

export type ReviewTrigger = {
  eventName: string | null
  reason: "manual" | "mention" | "ready_for_review" | "opened" | "synchronize" | "workflow_dispatch"
  actor: string | null
  comment: { id: number; author: string | null; body: string } | null
}

export type ReviewActionItem =
  | {
      id: string
      kind: "trigger_request" | "mentioned"
      actor: string | null
      body: string
      commentId: number
      createdAt?: string | null
    }
  | {
      id: string
      kind: "reply_requested"
      actor: string | null
      body: string
      replyToCommentId: number
      latestReplyId?: number | null
      reviewThreadId?: string | null
      path?: string | null
      line?: number | null
    }

export type ReviewTimeline = CompactHistory

/** Immutable evidence assembled once from cached GitHub reads for one PR head. */
export type ReviewSnapshot = {
  generatedAt: string
  botLogin: string
  command: string
  trigger: ReviewTrigger
  pullRequest: PullRequestSummary
  diff: {
    text: string
    files: DiffFile[]
    ignoredFiles: string[]
    commentRanges: ValidCommentRanges
  }
  issueComments: IssueComment[]
  referencedIssues: ReferencedIssueContext[]
  reviewComments: ReviewComment[]
  reviewThreadsAvailable: boolean
  reviewThreads: ReviewThread[]
  unresolvedReviewThreads: ReviewThread[]
  unresolvedBotThreads: ReviewThread[]
  reviews: PullRequestReview[]
  commits: PullRequestCommit[]
  context: CompactPullRequestContext
  timeline: ReviewTimeline
  previousBotFindings: ReviewComment[]
  actionItems: ReviewActionItem[]
  participants: string[]
}

/** Full-review draft derived after audit, queue finalization, and synthesis. */
export type ReviewedDraft = {
  status: "reviewed"
  gate: Extract<ReviewGateResult, { decision: "review" }>
  lanes: LaneAssessment[]
  audit: AuditedReview
  validated: ValidatedReviewQueue
  body: string
}

/** Cheap gate result selected without running the specialist tree. */
export type GateDraft = {
  status: "answered" | "no-review"
  gate: Extract<ReviewGateResult, { decision: "answer" | "no-review" }>
  body: string
}

export type ReviewDraft = ReviewedDraft | GateDraft

export type PublishedReview = (ReviewedDraft & { payload: ReviewPayload }) | GateDraft

/** One provider attempt recorded even when no publishable review is produced. */
export type ReviewAttempt = {
  number: number
  provider: string
  model: string
  status: "completed" | "failed"
  startedAt: string
  endedAt: string
  error: string | null
}

type ReviewRunMetadata = {
  generatedAt: string
  repository: string
  prNumber: number
  provider: string
  model: string
  durationMs: number
  attempts: ReviewAttempt[]
  usage: ReviewUsage
  /** Original AML accounting, preserved while OpenCode's ACP usage is incomplete. */
  amlUsage: ReviewUsage
  usageSource: "opencode-db" | "aml-acp"
  usageNote: string
  traceSummaries: readonly TraceSummary[]
  providerCompletions: readonly ReviewProviderCompletion[]
  publication: GitHubActionReceipt[]
  publicationStatus: "completed" | "failed"
  publicationError: string | null
}

export type ReviewedRunResult = Extract<PublishedReview, { status: "reviewed" }> & ReviewRunMetadata
export type GateRunResult = Extract<PublishedReview, { status: "answered" | "no-review" }> & ReviewRunMetadata

/** One typed in-memory result consumed by the CLI and eval exporter. */
export type ReviewRunResult = ReviewedRunResult | GateRunResult
