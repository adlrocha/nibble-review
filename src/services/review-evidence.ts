import { readFileSync } from "node:fs"

import type {
  ReferencedIssueContext,
  IssueComment,
  PullRequestCommit,
  PullRequestReview,
  PullRequestSummary,
  ReviewComment,
  ReviewThread
} from "./github/client.js"
import type { ReviewActionItem, ReviewRequest, ReviewSnapshot, ReviewTrigger } from "../types/review.js"
import type { DiffFile, ValidCommentRanges } from "../lib/review-diff.js"
import { reviewAuthorship, type ReviewAuthorship } from "../lib/review-authorship.js"
import { compactContextText, type CompactPullRequestContext } from "./github/context-model.js"

export const REVIEW_COMMAND = "@nibble-review"
export const DEFAULT_REVIEW_BOT_LOGIN = "nibble-review[bot]"

// Active requests need more room than historical events because the current run must answer them accurately.
const ACTION_TEXT_LIMIT = 1_600

type GitHubEventPayload = {
  action?: string
  sender?: { login?: string | null } | null
  comment?: {
    id?: number
    body?: string | null
    user?: { login?: string | null } | null
  } | null
}

type ReviewEvidenceInput = {
  request: ReviewRequest
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
  reviews: PullRequestReview[]
  commits: PullRequestCommit[]
  context: CompactPullRequestContext
  reviewThreadsAvailable: boolean
  reviewThreads: ReviewThread[]
}

/**
 * Converts cached GitHub responses into the one immutable evidence snapshot
 * shared by the AML tree, queue validation, and deterministic publication.
 */
export class ReviewEvidence {
  readonly #input: ReviewEvidenceInput
  readonly #authorship: ReviewAuthorship

  constructor(input: ReviewEvidenceInput) {
    this.#input = input
    this.#authorship = reviewAuthorship(input.request.botLogin)
  }

  /** Reads the GitHub Actions event once and reduces it to review routing data. */
  static trigger(request: Pick<ReviewRequest, "eventName" | "eventPath" | "actor">): ReviewTrigger {
    let payload: GitHubEventPayload = {}
    if (request.eventPath) {
      payload = JSON.parse(readFileSync(request.eventPath, "utf8")) as GitHubEventPayload
    }

    const eventName = request.eventName
    const action = payload.action
    let reason: ReviewTrigger["reason"] = "manual"
    if (eventName === "issue_comment") {
      reason = "mention"
    } else if (eventName === "pull_request" && action === "ready_for_review") {
      reason = "ready_for_review"
    } else if (eventName === "pull_request" && action === "opened") {
      reason = "opened"
    } else if (eventName === "pull_request" && action === "synchronize") {
      reason = "synchronize"
    } else if (eventName === "workflow_dispatch") {
      reason = "workflow_dispatch"
    }

    const eventComment = payload.comment
    return {
      eventName,
      reason,
      actor: request.actor || payload.sender?.login || null,
      comment:
        eventComment?.id && eventComment.id > 0
          ? {
              id: eventComment.id,
              author: eventComment.user?.login || null,
              body: compactContextText(eventComment.body, ACTION_TEXT_LIMIT)
            }
          : null
    }
  }

  /** Adds routing and publication derivatives to the service-owned context DTO. */
  snapshot(): ReviewSnapshot {
    const unresolvedReviewThreads = this.#input.reviewThreads.filter(thread => !thread.is_resolved)
    const unresolvedBotThreads = unresolvedReviewThreads.filter(thread => this.#ownThreadStart(thread))
    const actionItems = this.#actionItems()

    return Object.freeze({
      generatedAt: new Date().toISOString(),
      botLogin: this.#input.request.botLogin,
      command: this.#command(),
      trigger: this.#input.trigger,
      pullRequest: this.#input.pullRequest,
      diff: this.#input.diff,
      issueComments: this.#input.issueComments,
      referencedIssues: this.#input.referencedIssues || [],
      reviewComments: this.#input.reviewComments,
      reviewThreadsAvailable: this.#input.reviewThreadsAvailable,
      reviewThreads: this.#input.reviewThreads,
      unresolvedReviewThreads,
      unresolvedBotThreads,
      reviews: this.#input.reviews,
      commits: this.#input.commits,
      context: this.#input.context,
      timeline: this.#input.context.history,
      previousBotFindings: this.#input.reviewComments.filter(
        comment => this.#authorship.isOwn(comment) && !comment.in_reply_to_id
      ),
      actionItems,
      participants: this.#participants(actionItems)
    })
  }

  /** Finds direct requests that still require a top-level answer or thread reply. */
  #actionItems(): ReviewActionItem[] {
    const items: ReviewActionItem[] = []
    const trigger = this.#input.trigger

    if (trigger.comment) {
      items.push({
        id: `issue-comment:${trigger.comment.id}`,
        kind: "trigger_request",
        actor: trigger.comment.author,
        body: compactContextText(trigger.comment.body, ACTION_TEXT_LIMIT),
        commentId: trigger.comment.id
      })
    }

    const latestBotActivity = this.#latestBotActivity()
    for (const comment of this.#input.issueComments) {
      const createdAt = comment.created_at || comment.updated_at || null
      if (
        comment.id === trigger.comment?.id ||
        this.#authorship.isOwn(comment) ||
        !this.#mentionsReviewer(comment.body) ||
        (latestBotActivity !== null && createdAt && Date.parse(createdAt) <= latestBotActivity)
      ) {
        continue
      }
      items.push({
        id: `issue-comment:${comment.id}`,
        kind: "mentioned",
        actor: comment.user?.login || null,
        body: compactContextText(comment.body, ACTION_TEXT_LIMIT),
        commentId: comment.id,
        createdAt
      })
    }

    if (this.#input.reviewThreadsAvailable) {
      // GraphQL thread grouping and resolution state are authoritative when available.
      for (const thread of this.#input.reviewThreads) {
        if (
          thread.is_resolved ||
          !this.#ownThreadStart(thread) ||
          this.#authorship.isOwn(thread.comments.find(comment => comment.id === thread.latest_comment_id)) ||
          !thread.top_level_comment_id
        ) {
          continue
        }
        const latest = thread.comments[thread.comments.length - 1]
        items.push({
          id: `review-thread:${thread.id}`,
          kind: "reply_requested",
          actor: thread.latest_author,
          body: compactContextText(latest?.body, ACTION_TEXT_LIMIT),
          replyToCommentId: thread.top_level_comment_id,
          latestReplyId: thread.latest_comment_id,
          reviewThreadId: thread.id,
          path: thread.path,
          line: thread.line
        })
      }
      return items
    }

    // REST comments lack resolution state, but their parent ids still recover
    // direct human replies when GraphQL review threads are unavailable.
    const commentsByParent = new Map<number, ReviewComment[]>()
    for (const comment of this.#input.reviewComments) {
      const parent = comment.in_reply_to_id || comment.id
      commentsByParent.set(parent, [...(commentsByParent.get(parent) || []), comment])
    }
    for (const [parent, comments] of commentsByParent) {
      const topLevel = comments.find(comment => comment.id === parent)
      if (!this.#authorship.isOwn(topLevel)) {
        continue
      }
      const latest = comments.toSorted(
        (left, right) => Date.parse(left.created_at || "1970-01-01") - Date.parse(right.created_at || "1970-01-01")
      )[comments.length - 1]
      if (latest?.user?.login && !this.#authorship.isOwn(latest)) {
        items.push({
          id: `review-comment:${parent}`,
          kind: "reply_requested",
          actor: latest.user.login,
          body: compactContextText(latest.body, ACTION_TEXT_LIMIT),
          replyToCommentId: parent,
          latestReplyId: latest.id
        })
      }
    }
    return items
  }

  /** True when this reviewer opened the thread, judged by its top-level comment. */
  #ownThreadStart(thread: ReviewThread): boolean {
    return this.#authorship.isOwn(thread.comments.find(comment => comment.id === thread.top_level_comment_id))
  }

  #command(): string {
    return this.#input.request.command || REVIEW_COMMAND
  }

  #mentionsReviewer(body: unknown): boolean {
    const text = String(body || "").toLowerCase()
    const bot = this.#input.request.botLogin.toLowerCase()
    return text.includes(this.#command().toLowerCase()) || text.includes(`@${bot}`)
  }

  #latestBotActivity(): number | null {
    const timestamps: number[] = []
    for (const comment of this.#input.issueComments) {
      if (this.#authorship.isOwn(comment)) {
        timestamps.push(Date.parse(comment.created_at || comment.updated_at || ""))
      }
    }
    for (const review of this.#input.reviews) {
      if (this.#authorship.isOwn(review)) {
        timestamps.push(Date.parse(review.submitted_at || review.submittedAt || ""))
      }
    }
    const valid = timestamps.filter(Number.isFinite)
    return valid.length > 0 ? Math.max(...valid) : null
  }

  /** Collects human handles once so synthesis can address the right participant. */
  #participants(actionItems: ReviewActionItem[]): string[] {
    const people = new Map<string, string>()
    this.#addParticipant(people, this.#input.trigger.actor)
    this.#addParticipant(people, this.#input.trigger.comment?.author)
    this.#addParticipant(people, this.#input.pullRequest.author?.login || this.#input.pullRequest.user?.login)
    for (const commit of this.#input.commits) {
      this.#addParticipant(people, commit.author?.login, commit.commit?.author?.name)
      this.#addParticipant(people, commit.committer?.login, commit.commit?.committer?.name)
    }
    for (const comment of this.#input.issueComments) {
      this.#addParticipant(people, comment.user?.login)
    }
    for (const review of this.#input.reviews) {
      this.#addParticipant(people, review.user?.login)
    }
    for (const thread of this.#input.reviewThreads) {
      for (const comment of thread.comments) {
        this.#addParticipant(people, comment.user.login)
      }
    }
    if (!this.#input.reviewThreadsAvailable) {
      for (const comment of this.#input.reviewComments) {
        this.#addParticipant(people, comment.user?.login)
      }
    }
    for (const item of actionItems) {
      this.#addParticipant(people, item.actor)
    }
    return [...people.values()]
  }

  /** Prefers a participant's human-readable name without ever retaining bots. */
  #addParticipant(people: Map<string, string>, login?: string | null, name?: string | null): void {
    if (!login) {
      return
    }
    const normalized = login.toLowerCase()
    const bot = this.#input.request.botLogin.toLowerCase()
    if (normalized === bot || normalized === bot.replace(/\[bot\]$/u, "") || /\[bot\]$/u.test(normalized)) {
      return
    }

    const named = name && name.toLowerCase() !== normalized
    const unnamed = `<@${login}>`
    const label = named ? `${name} ${unnamed}` : unnamed
    const existing = people.get(normalized)
    if (!existing || (named && existing.toLowerCase() === unnamed.toLowerCase())) {
      people.set(normalized, label)
    }
  }
}
