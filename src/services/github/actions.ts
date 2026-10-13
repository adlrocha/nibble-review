import { createHash } from "node:crypto"

import type { ReviewPayload } from "./review-serializer.js"
import type { GitHubClient } from "./client.js"

export type GitHubActionMode = "dry-run" | "live"
export type PublicationState = "completed" | "ambiguous" | "pending"
export type PublicationExpectation = { kind: "pr-comment" } | { kind: "review"; replies: number }

export type GitHubActionReceipt = {
  key: string
  kind: "pr-comment" | "review" | "reply"
  status: "prepared" | "submitted" | "skipped" | "failed"
  payload: unknown
  error?: string
}

export type GitHubActions = {
  readonly mode: GitHubActionMode
  postPullRequestComment(prNumber: number, body: string): Promise<GitHubActionReceipt>
  submitPullRequestReview(prNumber: number, payload: ReviewPayload): Promise<GitHubActionReceipt>
  replyToReviewComment(prNumber: number, commentId: number, body: string): Promise<GitHubActionReceipt>
  publicationState(expectation: PublicationExpectation): PublicationState
  receipts(): GitHubActionReceipt[]
  /** True once any live GitHub mutation has started, even if it has not settled. */
  mutationStarted(): boolean
}

type ActionKind = GitHubActionReceipt["kind"]

/** Owns request-local idempotency across publication retries and partial failures. */
class ActionLedger {
  readonly #scope: string
  readonly #inFlight = new Map<string, Promise<GitHubActionReceipt>>()
  readonly #receipts = new Map<string, GitHubActionReceipt>()
  #mutated = false

  constructor(scope: string) {
    this.#scope = scope
  }

  /** Coalesces identical calls and never retries a mutation with an unknown outcome. */
  async execute(
    kind: ActionKind,
    payload: unknown,
    mode: GitHubActionMode,
    operation: () => Promise<void>
  ): Promise<GitHubActionReceipt> {
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex")
    const key = `${this.#scope}:${kind}:${digest}`
    const inFlight = this.#inFlight.get(key)
    if (inFlight) {
      return inFlight
    }
    const previous = this.#receipts.get(key)
    if (previous?.status === "prepared" || previous?.status === "submitted") {
      return { ...previous, status: "skipped" }
    }
    if (previous?.status === "failed") {
      // A rejected POST may still have reached GitHub. Replaying it could
      // duplicate a review or comment, so recovery requires reconciliation.
      throw new Error(`refusing to replay ambiguous ${kind} mutation: ${previous.error || "unknown failure"}`)
    }

    // Start the mutation in a microtask after registering its promise, so
    // concurrent duplicate Tool calls coalesce before GitHub is invoked.
    const execution = Promise.resolve().then(async () => {
      try {
        if (mode === "live") {
          this.#mutated = true
          await operation()
        }
        const receipt: GitHubActionReceipt = {
          key,
          kind,
          status: mode === "live" ? "submitted" : "prepared",
          payload
        }
        this.#receipts.set(key, receipt)
        return receipt
      } catch (error) {
        const receipt: GitHubActionReceipt = {
          key,
          kind,
          status: "failed",
          payload,
          error: error instanceof Error ? error.message : String(error)
        }
        this.#receipts.set(key, receipt)
        throw error
      }
    })
    this.#inFlight.set(key, execution)
    const clear = () => {
      if (this.#inFlight.get(key) === execution) {
        this.#inFlight.delete(key)
      }
    }
    void execution.then(clear, clear)
    return execution
  }

  /** Whether a live mutation was ever sent, so a retry could duplicate it. */
  mutated(): boolean {
    return this.#mutated
  }

  /** Returns a detached audit trail in first-execution order. */
  values(): GitHubActionReceipt[] {
    return Array.from(this.#receipts.values(), receipt => structuredClone(receipt))
  }
}

/**
 * GitHub mutation port shared by live and dry-run execution. Dry runs exercise
 * the exact payloads and idempotency keys without invoking the delegate.
 */
export class ReviewGitHubActions implements GitHubActions {
  readonly mode: GitHubActionMode
  readonly #github: GitHubClient
  readonly #headSha: string | null
  readonly #ledger: ActionLedger

  constructor(options: {
    mode: GitHubActionMode
    github: GitHubClient
    repository: string
    prNumber: number
    headSha: string | null
  }) {
    this.mode = options.mode
    this.#github = options.github
    this.#headSha = options.headSha
    this.#ledger = new ActionLedger(`${options.repository}#${options.prNumber}@${options.headSha || "unknown-head"}`)
  }

  /** Posts the prepared top-level gate response. */
  postPullRequestComment(prNumber: number, body: string): Promise<GitHubActionReceipt> {
    const payload = { prNumber, body }
    return this.#ledger.execute("pr-comment", payload, this.mode, () =>
      this.#github.createPullRequestComment(prNumber, body)
    )
  }

  /** Submits one batched review bound to the inspected head commit. */
  submitPullRequestReview(prNumber: number, payload: ReviewPayload): Promise<GitHubActionReceipt> {
    const action = { prNumber, headSha: this.#headSha, payload }
    return this.#ledger.execute("review", action, this.mode, async () => {
      if (!this.#headSha) {
        throw new Error("cannot publish a pull request review without its inspected head SHA")
      }
      await this.#github.submitReview(prNumber, this.#headSha, payload)
    })
  }

  /** Replies with one previously validated body and target. */
  replyToReviewComment(prNumber: number, commentId: number, body: string): Promise<GitHubActionReceipt> {
    const payload = { prNumber, commentId, body }
    return this.#ledger.execute("reply", payload, this.mode, () => this.#github.submitReply(prNumber, commentId, body))
  }

  /** Interprets the ledger without replaying a rejected GitHub mutation. */
  publicationState(expectation: PublicationExpectation): PublicationState {
    const expectedKinds: ActionKind[] = expectation.kind === "pr-comment" ? ["pr-comment"] : ["review", "reply"]
    const relevant = this.#ledger.values().filter(receipt => expectedKinds.includes(receipt.kind))
    if (relevant.some(receipt => receipt.status === "failed")) {
      return "ambiguous"
    }

    const completed = relevant.filter(receipt => receipt.status === "prepared" || receipt.status === "submitted")
    if (expectation.kind === "pr-comment") {
      return completed.some(receipt => receipt.kind === "pr-comment") ? "completed" : "pending"
    }

    const reviews = completed.filter(receipt => receipt.kind === "review").length
    const replies = completed.filter(receipt => receipt.kind === "reply").length
    return reviews === 1 && replies === expectation.replies ? "completed" : "pending"
  }

  /** Exposes the immutable publication ledger to run results and evals. */
  receipts(): GitHubActionReceipt[] {
    return this.#ledger.values()
  }

  /** Lets the runner tell a pre-publication abort from one that may leave partial output. */
  mutationStarted(): boolean {
    return this.#ledger.mutated()
  }
}
