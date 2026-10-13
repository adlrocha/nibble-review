import assert from "node:assert/strict"
import test from "node:test"

import { parseAllowSkip } from "../../dist/cli/preflight.js"
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
          author_association: "MEMBER",
          user: { login: "alice", type: "User" },
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
          author_association: "COLLABORATOR",
          user: { login: "alice", type: "User" },
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

function skipRequest(pullRequest, options = {}) {
  return evaluateGuard({
    repository: "owner/repo",
    prNumber: 42,
    triggerCommentId: null,
    ...options,
    github: {
      async getPullRequest() {
        return { number: 42, head: { repo: { full_name: "owner/repo" } }, ...pullRequest }
      },
      async getIssueComment() {
        throw new Error("not used")
      }
    }
  })
}

test("guard ignores skip directives from bots and untrusted authors", async () => {
  const allowed = { shouldReview: true, reason: "allowed" }
  assert.deepEqual(
    await skipRequest({
      title: "[skip] bump",
      author_association: "MEMBER",
      user: { login: "nibble-review[bot]", type: "Bot" }
    }),
    allowed
  )
  assert.deepEqual(
    await skipRequest({
      body: "@nibble-review skip",
      author_association: "CONTRIBUTOR",
      user: { login: "mallory", type: "User" }
    }),
    allowed
  )
  assert.deepEqual(await skipRequest({ title: "[skip] no author data" }), allowed)
})

test("guard ignores every pull request skip directive when skipping is disabled", async () => {
  const author = { author_association: "OWNER", user: { login: "alice", type: "User" } }
  const allowed = { shouldReview: true, reason: "allowed" }
  assert.deepEqual(await skipRequest({ title: "[skip] docs", ...author }, { allowSkip: false }), allowed)
  assert.deepEqual(await skipRequest({ body: "@nibble-review skip", ...author }, { allowSkip: false }), allowed)
})

test("REVIEW_ALLOW_SKIP defaults to true and rejects anything but true or false", () => {
  assert.equal(parseAllowSkip(undefined), true)
  assert.equal(parseAllowSkip(""), true)
  assert.equal(parseAllowSkip(" FALSE "), false)
  assert.equal(parseAllowSkip("true"), true)
  assert.throws(() => parseAllowSkip("no"), /REVIEW_ALLOW_SKIP must be true or false/)
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
