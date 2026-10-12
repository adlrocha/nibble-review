import assert from "node:assert/strict"
import test from "node:test"

import { ReviewEvidence } from "../../dist/services/review-evidence.js"

function snapshot(overrides = {}) {
  return new ReviewEvidence({
    request: {
      repository: "owner/repo",
      prNumber: 42,
      workspace: "/workspace",
      workspaceHeadSha: "a".repeat(40),
      botLogin: "nibble-review[bot]",
      eventName: null,
      eventPath: null,
      actor: "author",
      ignoreHistory: false
    },
    trigger: { eventName: null, reason: "manual", actor: "author", comment: null },
    pullRequest: { number: 42, author: { login: "author" } },
    diff: { text: "", files: [], ignoredFiles: [], commentRanges: {} },
    issueComments: [],
    reviewComments: [],
    reviewThreads: [],
    reviewThreadsAvailable: true,
    reviews: [],
    commits: [],
    ...overrides
  }).snapshot()
}

test("review history is a chronological GraphQL-thread-aware event stream", () => {
  const result = snapshot({
    commits: [
      {
        sha: "abcdef123456",
        author: { login: "author" },
        commit: {
          committer: { date: "2026-08-31T10:00:00Z" },
          message: "Fix the contract\n\nLong commit body that should not be repeated."
        }
      }
    ],
    reviews: [
      {
        id: 10,
        user: { login: "author" },
        state: "COMMENTED",
        body: "",
        submitted_at: "2026-08-31T10:01:00Z"
      }
    ],
    reviewComments: [{ id: 20, pull_request_review_id: 10 }],
    reviewThreads: [
      {
        id: "thread-1",
        is_resolved: true,
        is_outdated: false,
        path: "src/example.ts",
        line: 12,
        start_line: 10,
        comments: [
          {
            id: 20,
            user: { login: "reviewer" },
            body: "Please apply:\n```suggestion\nconst value = true\n```",
            path: "src/example.ts",
            line: 12,
            created_at: "2026-08-31T10:02:00Z"
          }
        ]
      }
    ]
  })

  assert.deepEqual(result.timeline.entries, [
    "2026-08-31T10:00:00Z | commit | abcdef1 | @author\n> Fix the contract",
    "2026-08-31T10:02:00Z | review comment | #20 | @reviewer | resolved | src/example.ts:10-12\n> Please apply: suggestion: const value = true"
  ])
  assert.doesNotMatch(result.timeline.entries.join("\n"), /Long commit body/u)
})

test("participants preserve exact human handles and prefer commit names", () => {
  const result = snapshot({
    reviewThreadsAvailable: false,
    commits: [
      {
        author: { login: "author" },
        commit: { author: { name: "Author Person" } }
      }
    ],
    issueComments: [{ id: 1, user: { login: "nibble-review" } }],
    reviewComments: [
      { id: 2, user: { login: "reviewer" } },
      { id: 3, user: { login: "linear-code[bot]" } }
    ]
  })

  assert.deepEqual(result.participants, ["Author Person <@author>", "<@reviewer>"])
})

test("review history compacts long bodies to a bounded single line", () => {
  const result = snapshot({
    issueComments: [
      {
        id: 30,
        user: { login: "author" },
        body: "Decision: " + "detail ".repeat(100),
        created_at: "2026-08-31T10:00:00Z",
        author_association: "MEMBER"
      }
    ]
  })

  const [entry] = result.timeline.entries
  assert.match(entry, /^2026-08-31T10:00:00Z \| issue comment \| #30 \| @author \| MEMBER\n> Decision:/u)
  assert.equal(entry.split("\n").length, 2)
  assert.ok(entry.split("\n")[1].length <= 502)
  assert.match(entry, /… \(truncated\)$/u)
})

test("review history retains substantive review bodies and bodyless decisions", () => {
  const result = snapshot({
    reviewComments: [{ id: 42, pull_request_review_id: 40 }],
    reviews: [
      {
        id: 40,
        user: { login: "reviewer" },
        state: "COMMENTED",
        body: "The migration order needs another pass.",
        submitted_at: "2026-08-31T10:00:00Z"
      },
      {
        id: 41,
        user: { login: "reviewer" },
        state: "APPROVED",
        body: "",
        submitted_at: "2026-08-31T10:01:00Z"
      }
    ]
  })

  assert.deepEqual(result.timeline.entries, [
    "2026-08-31T10:00:00Z | review | #40 | @reviewer | COMMENTED\n> The migration order needs another pass.",
    "2026-08-31T10:01:00Z | review | #41 | @reviewer | APPROVED"
  ])
})

test("review history includes pull-request lifecycle and scope events", () => {
  const result = snapshot({
    pullRequest: {
      number: 42,
      author: { login: "author" },
      created_at: "2026-08-31T09:00:00Z",
      isDraft: false
    },
    timelineEvents: [
      {
        id: 50,
        event: "ready_for_review",
        actor: { login: "author" },
        created_at: "2026-08-31T10:00:00Z"
      },
      {
        id: 51,
        event: "labeled",
        actor: { login: "automation" },
        label: { name: "api" },
        created_at: "2026-08-31T10:01:00Z"
      },
      {
        id: 52,
        event: "convert_to_draft",
        actor: { login: "author" },
        created_at: "2026-08-31T10:02:00Z"
      },
      {
        id: 53,
        event: "head_ref_force_pushed",
        actor: { login: "author" },
        commit_id: "abcdef123456",
        created_at: "2026-08-31T10:03:00Z"
      },
      {
        id: 54,
        event: "commented",
        actor: { login: "author" },
        created_at: "2026-08-31T10:04:00Z"
      }
    ]
  })

  assert.deepEqual(result.timeline.entries, [
    "2026-08-31T09:00:00Z | pull request opened | @author | draft",
    "2026-08-31T10:00:00Z | ready for review | @author",
    "2026-08-31T10:01:00Z | labeled | @automation | api",
    "2026-08-31T10:02:00Z | convert to draft | @author",
    "2026-08-31T10:03:00Z | head ref force pushed | @author | abcdef1"
  ])
})
