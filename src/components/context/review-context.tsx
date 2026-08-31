import { createContext, useContext, type AML } from "@aml-jsx/sdk"

import type { PublishedReview, ReviewRequest, ReviewSnapshot } from "../../types/review.js"
import { ReviewQueue } from "../../lib/review-queue.js"
import { ReviewGitHubActions, type GitHubActionMode } from "../../services/github/actions.js"
import type { GitHubClient } from "../../services/github/client.js"
import { GitHubReviewSession } from "../../services/github/session.js"
import type { ReviewGateResult } from "../phases/review-gate.js"

export type RoutedReview = {
  gate: ReviewGateResult
  body: string
}

/** Owns the one completed router handoff consumed by publication. */
export class ReviewRouting {
  #routed: RoutedReview | undefined

  /** Records the gate decision and the body produced by its selected route. */
  complete(gate: ReviewGateResult, body: string): void {
    if (this.#routed) {
      throw new Error("review routing is already complete")
    }
    this.#routed = { gate: structuredClone(gate), body: body.trim() }
  }

  /** Returns the completed route after the router has resolved. */
  get(): RoutedReview {
    if (!this.#routed) {
      throw new Error("review routing has not completed")
    }
    return structuredClone(this.#routed)
  }
}

/** Owns the one deterministic publication outcome returned to the runtime. */
export class ReviewOutcome {
  #published: PublishedReview | undefined
  #publicationError: string | null = null

  /** Records the exact rendered review and its deterministic write outcome. */
  publish(review: PublishedReview, error: string | null): void {
    if (this.#published) {
      throw new Error("the review publication outcome is already complete")
    }
    this.#published = structuredClone(review)
    this.#publicationError = error
  }

  /** Returns the completed publication boundary to the runtime. */
  result(): { review: PublishedReview; publicationError: string | null } {
    if (!this.#published) {
      throw new Error("the review finished without a publication outcome")
    }
    return { review: structuredClone(this.#published), publicationError: this.#publicationError }
  }
}

/** Request-scoped dependencies and workflow APIs for one reviewed PR head. */
export type ReviewContextValue = Readonly<{
  github: GitHubReviewSession
  actions: ReviewGitHubActions
  queue: ReviewQueue
  routing: ReviewRouting
  outcome: ReviewOutcome
  snapshot: ReviewSnapshot
  model: string
}>

export const ReviewContext = createContext<ReviewContextValue>("NibbleReview")

export type ReviewContextEnvironment = Readonly<{
  github: GitHubReviewSession
  actions: ReviewGitHubActions
  outcome: ReviewOutcome
  model: string
  reviewEmojis: boolean
}>

export type ReviewContextEnvironmentOptions = {
  request: ReviewRequest
  github: GitHubClient
  actionMode: GitHubActionMode
  model: string
  reviewEmojis: boolean
}

/**
 * Creates the external dependencies and result owners for one review run.
 *
 * The runner retains this object after AML evaluation so it can read the exact
 * publication outcome and action receipts without a Provider callback channel.
 */
export function createReviewContextEnvironment(options: ReviewContextEnvironmentOptions): ReviewContextEnvironment {
  const github = new GitHubReviewSession(options.github, options.request, options.actionMode === "live")
  const actions = new ReviewGitHubActions({
    mode: options.actionMode,
    github: options.github,
    repository: options.request.repository,
    prNumber: options.request.prNumber,
    headSha: options.request.workspaceHeadSha
  })
  return {
    github,
    actions,
    outcome: new ReviewOutcome(),
    model: options.model,
    reviewEmojis: options.reviewEmojis
  }
}

/**
 * Captures and validates one complete review snapshot before exposing workflow state.
 *
 * This async Provider owns snapshot loading, queue construction, and routing
 * state. Consumers receive a fully initialized request scope instead of
 * depending on bootstrap ordering in the runner.
 */
type ReviewContextProviderProps = AML.PropsWithRequiredChildren<{
  readonly environment: ReviewContextEnvironment
}>

export const ReviewContextProvider: AML.Component<ReviewContextProviderProps> = async ({ environment, children }) => {
  const { github, actions, outcome, model, reviewEmojis } = environment
  const snapshot = await github.snapshot()

  // Reject a stale checkout before constructing any Agent-facing review state.
  if (!snapshot.context.headRefOid || github.request.workspaceHeadSha !== snapshot.context.headRefOid) {
    throw new Error(
      `checked-out head ${github.request.workspaceHeadSha} does not match pull request head ${snapshot.context.headRefOid || "unknown"}`
    )
  }

  // Metadata, diff, and referenced issues are separate GitHub reads. Recheck
  // the complete claimed contract so no Agent can reason over a mixed snapshot.
  await github.assertReviewContextUnchanged()

  // Queue validation depends on the captured diff and thread state, so create
  // all request-local workflow owners only after snapshot validation succeeds.
  const value: ReviewContextValue = {
    github,
    actions,
    queue: new ReviewQueue({
      botLogin: snapshot.botLogin,
      commentRanges: snapshot.diff.commentRanges,
      reviewEmojis,
      reviewThreadsAvailable: snapshot.reviewThreadsAvailable,
      unresolvedBotThreads: snapshot.unresolvedBotThreads,
      reviewComments: snapshot.reviewComments
    }),
    routing: new ReviewRouting(),
    snapshot,
    outcome,
    model
  }

  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>
}

/** Reads the single request-scoped dependency and phase-result context. */
export function useReviewContext(): ReviewContextValue {
  return useContext(ReviewContext)
}
