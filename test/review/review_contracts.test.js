import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { applyReviewBanner, buildReviewPayload, enforceReviewBodyLimit } from "../../dist/lib/review-body.js"
import { ReviewDiff } from "../../dist/lib/review-diff.js"
import { ReviewQueue, ReviewSeveritySchema } from "../../dist/lib/review-queue.js"
import { ReviewEvidence } from "../../dist/services/review-evidence.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const fixture = path.join(repoRoot, "test", "fixtures", "sample.patch")

function queueOptions(diffText, overrides = {}) {
  return {
    botLogin: "review-bot",
    commentRanges: ReviewDiff.from(diffText).commentRanges,
    reviewThreadsAvailable: false,
    unresolvedBotThreads: [],
    reviewComments: [{ id: 456, body: "Original", user: { login: "review-bot" } }],
    ...overrides
  }
}

function inline(body, overrides = {}) {
  return {
    kind: "inline",
    severity: "high",
    body,
    evidence: "Changed-line evidence.",
    confidence: "high",
    path: "src/app.js",
    line: 2,
    side: "RIGHT",
    ...overrides
  }
}

test("review severity exposes one nonblocking nit category", () => {
  assert.deepEqual(ReviewSeveritySchema.options, ["critical", "high", "low", "question", "nit"])
  assert.equal(ReviewSeveritySchema.safeParse("hint").success, false)
})

test("ReviewQueue renders optional application-owned severity emoji", () => {
  const diffText = fs.readFileSync(fixture, "utf8")
  const emojis = {
    critical: ":stop_sign:",
    high: ":red_circle:",
    low: ":large_orange_diamond:",
    question: ":question:",
    nit: ":nerd_face::point_up_2:"
  }

  for (const [severity, emoji] of Object.entries(emojis)) {
    const queue = new ReviewQueue(queueOptions(diffText))
    queue.add("intent-contract", inline("Finding body.", { severity }))
    queue.beginAudit()
    assert.equal(queue.finalize().queue.inlineComments[0].body, `${emoji} **${severity}:** Finding body.`)
  }

  const plainQueue = new ReviewQueue(queueOptions(diffText, { reviewEmojis: false }))
  plainQueue.add("intent-contract", inline("Finding body."))
  plainQueue.beginAudit()
  assert.equal(plainQueue.finalize().queue.inlineComments[0].body, "**high:** Finding body.")
})

test("audit demotion follows the inline severity ladder and preserves category boundaries", () => {
  const queue = new ReviewQueue(queueOptions(fs.readFileSync(fixture, "utf8")))
  const critical = queue.add("code-path-bug-hunter", inline("Critical concern.", { severity: "critical" }))
  const explicit = queue.add("maintainability-elegance", inline("Overstated cleanup.", { severity: "high", line: 6 }))
  const question = queue.add(
    "intent-contract",
    inline("Which contract should this preserve?", { severity: "question", line: 4 })
  )
  const blocker = queue.add("standards-architecture", {
    kind: "blocker",
    severity: "critical",
    body: "The approach cannot safely land.",
    evidence: "No changed line can honestly anchor the repository-wide conflict.",
    confidence: "high"
  })
  queue.beginAudit()

  assert.deepEqual(queue.demote(critical.id), { action: "demoted", severity: "high" })
  assert.deepEqual(queue.demote(critical.id), { action: "demoted", severity: "low" })
  assert.deepEqual(queue.demote(critical.id), { action: "demoted", severity: "nit" })
  assert.deepEqual(queue.demote(critical.id), { action: "dropped" })
  assert.deepEqual(queue.demote(explicit.id, "nit"), { action: "demoted", severity: "nit" })
  assert.throws(() => queue.demote(explicit.id, "low"), /severity low is not lower than nit/u)
  assert.throws(() => queue.demote(question.id), /questions must be retained or dropped/u)
  assert.throws(() => queue.demote(blocker.id), /only anchored inline findings have ordered severity/u)
})

test("review body limit keeps verbose synthesized conclusions compact", () => {
  const body = enforceReviewBodyLimit("x".repeat(6_500))

  assert.ok(body.length <= 6_000)
  assert.match(body, /\[Review body truncated\]$/u)
})

test("comment normalization keeps Markdown rules and suggestions safe for GitHub rendering", () => {
  const comment = ReviewQueue.normalizeComment({
    path: "src/app.js",
    line: 2,
    body: "Problem sentence.\n---\n**action:** Fix the contract."
  })
  const suggestion = ReviewQueue.normalizeComment({
    kind: "suggestion",
    path: "src/new.js",
    start_line: 1,
    line: 2,
    body: "Use the literal block.\n\n```suggestion\n---\nvalue\n```"
  })

  assert.equal(comment.body, "Problem sentence.\n\n---\n**action:** Fix the contract.")
  assert.match(suggestion.body, /```suggestion\n---\nvalue\n```/u)
})

test("ReviewQueue validates targets and keeps distinct same-line findings", () => {
  const diffText = fs.readFileSync(fixture, "utf8")
  const queue = new ReviewQueue(queueOptions(diffText))

  queue.add("intent-contract", inline("The timeout can become NaN."))
  queue.add("standards-architecture", inline("The timeout can overflow the retry budget."))
  queue.add("code-path-bug-hunter", inline("The timeout can become NaN."))
  queue.add("correctness-risk-testing", inline("Deleted return path is valid.", { line: 3, side: "LEFT" }))
  queue.add("documentation-commentary", {
    kind: "reply",
    to: 456,
    body: "Reply is valid.",
    evidence: "Comment 456 asks a direct question."
  })

  assert.throws(
    () => queue.add("maintainability-elegance", inline("Right-side context should drop.", { line: 1 })),
    /line is not a changed RIGHT-side line/u
  )
  assert.throws(
    () =>
      queue.add("maintainability-elegance", {
        kind: "reply",
        to: 789,
        body: "Missing reply.",
        evidence: "No matching comment."
      }),
    /target is not a review comment/u
  )

  queue.beginAudit()
  const validated = queue.finalize().queue
  assert.equal(validated.inlineComments.length, 3)
  assert.equal(validated.replies.length, 1)
  assert.deepEqual(
    validated.dropped.map(item => item.reason),
    ["duplicate queued comment"]
  )
})

test("diff anchors include right-side context and left-side deletions", () => {
  const diff = ReviewDiff.from(fs.readFileSync(fixture, "utf8"))
  const app = diff.files.find(file => file.path === "src/app.js")

  assert.deepEqual(app?.addedLines, [2, 4, 6])
  assert.deepEqual(app?.deletedLines, [3])
  assert.deepEqual(app?.rightLines, [1, 2, 3, 4, 5, 6])
  assert.deepEqual(app?.leftLines, [1, 2, 3, 4])
})

test("review diff filtering excludes lockfiles and binary hunks", () => {
  const diff = ReviewDiff.from(`diff --git a/package-lock.json b/package-lock.json
index 111..222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-old
+new
diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..1111111
Binary files /dev/null and b/assets/logo.png differ
diff --git a/src/app.js b/src/app.js
index 333..444 100644
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`)

  assert.deepEqual(diff.ignoredFiles, ["assets/logo.png", "package-lock.json"])
  assert.doesNotMatch(diff.text, /package-lock|Binary files/u)
  assert.deepEqual(
    diff.files.map(file => file.path),
    ["src/app.js"]
  )
})

test("ReviewQueue drops previous bot findings across legacy severity presentation", () => {
  const diffText = fs.readFileSync(fixture, "utf8")
  const body = "**high:** Existing finding."
  const threadQueue = new ReviewQueue(
    queueOptions(diffText, {
      reviewThreadsAvailable: true,
      unresolvedBotThreads: [
        {
          id: "thread-1",
          is_resolved: false,
          is_outdated: false,
          path: "src/app.js",
          line: 2,
          start_line: null,
          side: "RIGHT",
          start_side: null,
          top_level_comment_id: 456,
          top_level_author: "review-bot",
          latest_author: "review-bot",
          latest_comment_id: 456,
          comments: [
            {
              id: 456,
              node_id: null,
              user: { login: "review-bot" },
              body,
              path: "src/app.js",
              line: 2,
              start_line: null,
              side: "RIGHT",
              start_side: null,
              created_at: null,
              html_url: null
            }
          ]
        }
      ]
    })
  )
  threadQueue.add("intent-contract", inline("Existing finding."))
  threadQueue.beginAudit()
  assert.equal(threadQueue.finalize().queue.dropped[0].reason, "matching unresolved bot thread already exists")

  const restQueue = new ReviewQueue(
    queueOptions(diffText, {
      reviewComments: [{ id: 456, path: "src/app.js", line: 2, side: "RIGHT", body, user: { login: "review-bot" } }]
    })
  )
  restQueue.add("intent-contract", inline("Existing finding."))
  restQueue.beginAudit()
  assert.equal(restQueue.finalize().queue.dropped[0].reason, "matching previous bot comment already exists")

  const malformedHistoryQueue = new ReviewQueue(
    queueOptions(diffText, {
      reviewComments: [{ id: 456, path: "src/app.js", line: 2, side: "SIDEWAYS", body, user: { login: "review-bot" } }]
    })
  )
  malformedHistoryQueue.add("intent-contract", inline("Fresh finding."))
  malformedHistoryQueue.beginAudit()
  assert.equal(malformedHistoryQueue.finalize().queue.inlineComments.length, 1)
})

test("review body banner is mechanical and does not sanitize model prose", () => {
  const body = applyReviewBanner(
    "> reviewer · minimax-m3\n\nThe model wrote a banner anyway.",
    "opencode-go/minimax-m3"
  )

  assert.equal(body, "> reviewer · minimax-m3\n\n> reviewer · minimax-m3\n\nThe model wrote a banner anyway.")
})

test("review payload maps the finalized queue to GitHub review shape", () => {
  const payload = buildReviewPayload({
    version: 1,
    conclusion: "> reviewer · minimax-m3\n\nReady to merge.",
    dropped: [],
    replies: [],
    stats: {
      queued_inline: 1,
      queued_replies: 0,
      has_conclusion: true,
      valid_inline: 1,
      valid_replies: 0,
      dropped: 0
    },
    inlineComments: [
      {
        kind: "comment",
        path: "src/app.js",
        start_line: 2,
        line: 3,
        side: "LEFT",
        start_side: "LEFT",
        body: "Deleted branch needs explanation."
      }
    ]
  })

  assert.deepEqual(payload, {
    body: "> reviewer · minimax-m3\n\nReady to merge.",
    event: "COMMENT",
    comments: [
      {
        path: "src/app.js",
        start_line: 2,
        line: 3,
        side: "LEFT",
        start_side: "LEFT",
        body: "Deleted branch needs explanation."
      }
    ]
  })
})

test("evidence participants exclude bot logins with or without the bot suffix", () => {
  const snapshot = new ReviewEvidence({
    request: {
      repository: "owner/repo",
      prNumber: 42,
      workspace: "/workspace",
      workspaceHeadSha: "a".repeat(40),
      botLogin: "nibble-review[bot]",
      eventName: null,
      eventPath: null,
      actor: null,
      ignoreHistory: false
    },
    trigger: { eventName: null, reason: "manual", actor: null, comment: null },
    pullRequest: { number: 42 },
    diff: { text: "", files: [], ignoredFiles: [], commentRanges: {} },
    issueComments: [
      { id: 1, user: { login: "nibble-review" }, body: "Bot-authored review note." },
      { id: 2, user: { login: "linear-code[bot]" }, body: "SHE-170" },
      { id: 3, user: { login: "fthemudo" }, body: "Thanks for the review." }
    ],
    reviewComments: [],
    reviewThreadsAvailable: false,
    reviewThreads: [],
    reviews: [],
    commits: []
  }).snapshot()

  assert.deepEqual(snapshot.participants, ["<@fthemudo>"])
})
