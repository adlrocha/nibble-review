import assert from "node:assert/strict"
import test from "node:test"

import { ReviewPreflight } from "../../dist/services/review-preflight.js"

function evaluateGuard({ triggerCommentId, ...options }) {
  return new ReviewPreflight(options).evaluate(triggerCommentId)
}

test("guard allows trusted same-repository trigger comments", async () => {
  const result = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 42,
    triggerCommentId: 99,
    github: {
      async getPullRequest() {
        return { number: 42, head: { repo: { full_name: "owner/repo" } } }
      },
      async getIssueComment() {
        return {
          id: 99,
          issue_url: "https://api.github.com/repos/owner/repo/issues/42",
          author_association: "MEMBER",
          user: { login: "alice", type: "User" },
          body: "@nibble-review please review"
        }
      }
    }
  })

  assert.deepEqual(result, { shouldReview: true, reason: "allowed" })
})

test("guard skips only a pull request confirmed missing by GitHub", async () => {
  const missing = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 42,
    triggerCommentId: null,
    github: {
      async getPullRequest() {
        throw Object.assign(new Error("Not Found"), { status: 404 })
      },
      async getIssueComment() {
        throw new Error("not used")
      }
    }
  })

  assert.deepEqual(missing, { shouldReview: false, reason: "pull request not found" })

  const unavailable = Object.assign(new Error("Service Unavailable"), { status: 503 })
  await assert.rejects(
    evaluateGuard({
      repository: "owner/repo",
      prNumber: 42,
      triggerCommentId: null,
      github: {
        async getPullRequest() {
          throw unavailable
        },
        async getIssueComment() {
          throw new Error("not used")
        }
      }
    }),
    error => error === unavailable
  )
})

test("guard rethrows unavailable trigger comment lookups", async () => {
  const unavailable = Object.assign(new Error("Service Unavailable"), { status: 503 })

  await assert.rejects(
    evaluateGuard({
      repository: "owner/repo",
      prNumber: 42,
      triggerCommentId: 99,
      github: {
        async getPullRequest() {
          return { number: 42, head: { repo: { full_name: "owner/repo" } } }
        },
        async getIssueComment() {
          throw unavailable
        }
      }
    }),
    error => error === unavailable
  )
})

test("guard does not let an untrusted PR author trigger a review", async () => {
  const result = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 42,
    triggerCommentId: 99,
    github: {
      async getPullRequest() {
        return {
          number: 42,
          user: { login: "pr-author" },
          head: { repo: { full_name: "owner/repo" } }
        }
      },
      async getIssueComment() {
        return {
          id: 99,
          issue_url: "https://api.github.com/repos/owner/repo/issues/42",
          author_association: "CONTRIBUTOR",
          user: { login: "pr-author", type: "User" },
          body: "@nibble-review please review"
        }
      }
    }
  })

  assert.deepEqual(result, { shouldReview: false, reason: "trigger comment author is not trusted" })
})

test("guard deterministically skips trusted skip commands", async () => {
  const result = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 42,
    triggerCommentId: 99,
    github: {
      async getPullRequest() {
        return { number: 42, head: { repo: { full_name: "owner/repo" } } }
      },
      async getIssueComment() {
        return {
          id: 99,
          issue_url: "https://api.github.com/repos/owner/repo/issues/42",
          author_association: "MEMBER",
          user: { login: "alice", type: "User" },
          body: "@nibble-review skip"
        }
      }
    }
  })

  assert.deepEqual(result, { shouldReview: false, reason: "trigger comment requested skip" })
})

test("guard does not treat incidental skip wording as a skip command", async () => {
  const result = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 42,
    triggerCommentId: 99,
    github: {
      async getPullRequest() {
        return { number: 42, head: { repo: { full_name: "owner/repo" } } }
      },
      async getIssueComment() {
        return {
          id: 99,
          issue_url: "https://api.github.com/repos/owner/repo/issues/42",
          author_association: "MEMBER",
          user: { login: "alice", type: "User" },
          body: "@nibble-review why did you skip the last review?"
        }
      }
    }
  })

  assert.deepEqual(result, { shouldReview: true, reason: "allowed" })
})

test("guard skips pull requests with a skip title prefix", async () => {
  const result = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 42,
    triggerCommentId: null,
    github: {
      async getPullRequest() {
        return {
          number: 42,
          title: "  [skip] Drafting generated fixtures",
          head: { repo: { full_name: "owner/repo" } }
        }
      },
      async getIssueComment() {
        throw new Error("not used")
      }
    }
  })

  assert.deepEqual(result, { shouldReview: false, reason: "pull request title requested skip" })
})

test("guard skips pull requests with a body skip directive", async () => {
  const result = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 42,
    triggerCommentId: 99,
    github: {
      async getPullRequest() {
        return {
          number: 42,
          body: "Generated update.\n\n@nibble-review skip\n\nNo bot review needed.",
          head: { repo: { full_name: "owner/repo" } }
        }
      },
      async getIssueComment() {
        throw new Error("not used because PR body skip wins")
      }
    }
  })

  assert.deepEqual(result, { shouldReview: false, reason: "pull request body requested skip" })
})

test("guard denies forks and untrusted trigger comments", async () => {
  assert.deepEqual(
    await evaluateGuard({
      repository: "owner/repo",
      prNumber: 42,
      triggerCommentId: null,
      github: {
        async getPullRequest() {
          return { number: 42, head: { repo: { full_name: "someone/fork" } } }
        },
        async getIssueComment() {
          throw new Error("not used")
        }
      }
    }),
    { shouldReview: false, reason: "fork pull requests are not reviewed" }
  )

  assert.deepEqual(
    await evaluateGuard({
      repository: "owner/repo",
      prNumber: 42,
      triggerCommentId: 99,
      github: {
        async getPullRequest() {
          return {
            number: 42,
            user: { login: "pr-author" },
            head: { repo: { full_name: "owner/repo" } }
          }
        },
        async getIssueComment() {
          return {
            id: 99,
            issue_url: "https://api.github.com/repos/owner/repo/issues/42",
            author_association: "CONTRIBUTOR",
            user: { login: "alice", type: "User" },
            body: "@nibble-review please review"
          }
        }
      }
    }),
    { shouldReview: false, reason: "trigger comment author is not trusted" }
  )
})

test("guard rejects bot trigger comments from the PR author", async () => {
  const result = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 42,
    triggerCommentId: 99,
    github: {
      async getPullRequest() {
        return {
          number: 42,
          user: { login: "review-bot" },
          head: { repo: { full_name: "owner/repo" } }
        }
      },
      async getIssueComment() {
        return {
          id: 99,
          issue_url: "https://api.github.com/repos/owner/repo/issues/42",
          author_association: "CONTRIBUTOR",
          user: { login: "review-bot", type: "Bot" },
          body: "@nibble-review please review"
        }
      }
    }
  })

  assert.deepEqual(result, { shouldReview: false, reason: "bot trigger comments are ignored" })
})

test("guard matches trigger comment issue URLs by exact PR number", async () => {
  const result = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 4,
    triggerCommentId: 99,
    github: {
      async getPullRequest() {
        return { number: 4, head: { repo: { full_name: "owner/repo" } } }
      },
      async getIssueComment() {
        return {
          id: 99,
          issue_url: "https://api.github.com/repos/owner/repo/issues/42",
          author_association: "MEMBER",
          user: { login: "alice", type: "User" },
          body: "@nibble-review please review"
        }
      }
    }
  })

  assert.deepEqual(result, {
    shouldReview: false,
    reason: "trigger comment does not belong to this pull request"
  })
})
