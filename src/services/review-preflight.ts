import { REVIEW_COMMAND } from "./review-evidence.js"
import type { GitHubClient } from "./github/client.js"

const SKIP_TITLE_PREFIX = "[skip]"
const SKIP_COMMAND_PATTERN = /^(?:please\s+)?skip(?:\s+(?:this|review|run))?[.!?]?\s*$/u
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

export type ReviewPreflightResult = { shouldReview: boolean; reason: string }

/** Owns the trust, fork, and explicit-skip policy shared by both production CLIs. */
export class ReviewPreflight {
  readonly #github: Pick<GitHubClient, "getPullRequest" | "getIssueComment">
  readonly #repository: string
  readonly #prNumber: number
  readonly #command: string

  constructor(options: {
    github: Pick<GitHubClient, "getPullRequest" | "getIssueComment">
    repository: string
    prNumber: number
    command?: string
  }) {
    this.#github = options.github
    this.#repository = options.repository
    this.#prNumber = options.prNumber
    this.#command = options.command || REVIEW_COMMAND
  }

  /** Verifies one workflow request before trusted credentials reach PR code. */
  async evaluate(triggerCommentId: number | null): Promise<ReviewPreflightResult> {
    let pullRequest
    try {
      pullRequest = await this.#github.getPullRequest(this.#prNumber)
    } catch (error) {
      // A confirmed missing PR is a safe skip. GitHub or transport failures
      // must fail the workflow instead of silently suppressing a review.
      if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
        return { shouldReview: false, reason: "pull request not found" }
      }
      throw error
    }

    if (pullRequest.head?.repo?.full_name !== this.#repository) {
      return { shouldReview: false, reason: "fork pull requests are not reviewed" }
    }
    if (
      String(pullRequest.title || "")
        .trimStart()
        .toLowerCase()
        .startsWith(SKIP_TITLE_PREFIX)
    ) {
      return { shouldReview: false, reason: "pull request title requested skip" }
    }
    if (this.#requestsSkip(pullRequest.body)) {
      return { shouldReview: false, reason: "pull request body requested skip" }
    }
    if (!triggerCommentId) {
      return { shouldReview: true, reason: "allowed" }
    }

    let comment
    try {
      comment = await this.#github.getIssueComment(triggerCommentId)
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
        return { shouldReview: false, reason: "trigger comment not found" }
      }
      throw error
    }

    // Comment IDs can be supplied as workflow input. Bind the fetched comment
    // back to this exact repository and PR before trusting its author or body.
    const issue = this.#issueReference(comment.issue_url)
    if (issue?.repository !== this.#repository || issue.number !== this.#prNumber) {
      return { shouldReview: false, reason: "trigger comment does not belong to this pull request" }
    }
    if (comment.user?.type === "Bot") {
      return { shouldReview: false, reason: "bot trigger comments are ignored" }
    }

    if (!TRUSTED_ASSOCIATIONS.has(comment.author_association || "")) {
      return { shouldReview: false, reason: "trigger comment author is not trusted" }
    }
    if (!String(comment.body || "").includes(this.#command)) {
      return { shouldReview: false, reason: `trigger comment does not mention ${this.#command}` }
    }
    if (this.#requestsSkip(comment.body)) {
      return { shouldReview: false, reason: "trigger comment requested skip" }
    }

    return { shouldReview: true, reason: "allowed" }
  }

  /** Recognizes only an explicit command on the same line as the bot mention. */
  #requestsSkip(body: unknown): boolean {
    return String(body || "")
      .toLowerCase()
      .split(/\r?\n/u)
      .some(line => {
        const mention = line.indexOf(this.#command)
        return mention >= 0 && SKIP_COMMAND_PATTERN.test(line.slice(mention + this.#command.length).trim())
      })
  }

  /** Parses the GitHub API issue URL carried by an issue-comment response. */
  #issueReference(value: string | null | undefined): { repository: string; number: number } | null {
    if (!value) {
      return null
    }
    try {
      const match = new URL(value).pathname.match(/\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/?$/u)
      if (!match?.[1] || !match[2] || !match[3]) {
        return null
      }
      return {
        repository: `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`,
        number: Number(match[3])
      }
    } catch {
      return null
    }
  }
}
