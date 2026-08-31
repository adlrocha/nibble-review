import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { prepareGate } from "../dist/lib/review-gate.js"
import { ReviewDiff } from "../dist/lib/review-diff.js"

const botLogin = "nibble-review[bot]"

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
}

function write(repo, file, body) {
  const target = path.join(repo, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body)
}

function commit(repo, message) {
  git(repo, ["add", "."])
  git(repo, ["commit", "-m", message])
  return git(repo, ["rev-parse", "HEAD"])
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gate-repo-"))
  git(repo, ["init"])
  git(repo, ["config", "user.email", "reviewer@example.com"])
  git(repo, ["config", "user.name", "Reviewer"])
  const defaultBranch = git(repo, ["branch", "--show-current"])
  write(repo, "README.md", "base\n")
  const base = commit(repo, "base")
  git(repo, ["checkout", "-b", "feature"])
  write(repo, "src/app.js", "export const value = 1;\n")
  const reviewed = commit(repo, "feature reviewed")
  return { repo, base, reviewed, defaultBranch }
}

function reviewSnapshot(options, rawDiff = "diff") {
  const triggerComment =
    options.reason === "mention"
      ? {
          id: 123,
          author: "octocat",
          body: options.commentBody || "@nibble-review should this run again?"
        }
      : null

  const diff = ReviewDiff.from(rawDiff)
  return {
    generatedAt: "2026-06-15T00:00:00Z",
    botLogin,
    command: "@nibble-review",
    trigger: {
      eventName: options.reason === "mention" ? "issue_comment" : "pull_request",
      reason: options.reason,
      actor: "octocat",
      comment: triggerComment
    },
    pullRequest: {
      number: 42,
      title: "Test PR",
      base: { sha: options.base },
      head: { sha: options.head, repo: { full_name: "owner/repo" } },
      baseRefOid: options.base,
      headRefOid: options.head
    },
    diff: {
      text: diff.text,
      files: diff.files.length > 0 ? diff.files.map(file => file.path) : ["src/app.js"],
      ignoredFiles: diff.ignoredFiles,
      commentRanges: diff.commentRanges
    },
    reviews: options.reviews || [],
    issueComments: triggerComment
      ? [
          {
            id: 123,
            user: { login: "octocat" },
            body: triggerComment.body,
            html_url: null,
            author_association: "MEMBER"
          }
        ]
      : [],
    reviewComments: [],
    reviewThreadsAvailable: true,
    reviewThreads: [],
    unresolvedReviewThreads: [],
    unresolvedBotThreads: [],
    commits: [],
    timeline: { olderEntriesOmitted: 0, entries: [] },
    previousBotFindings: [],
    actionItems: [],
    participants: ["@octocat"]
  }
}

function botReview(commitId) {
  return {
    id: 1,
    user: { login: botLogin },
    state: "COMMENTED",
    body: "Previous review.",
    submitted_at: "2026-06-15T00:00:00Z",
    commit_id: commitId,
    html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-1"
  }
}

test("synchronize without a previous bot review runs the full review without gate", () => {
  const { repo, base, reviewed } = createRepo()
  const snapshot = reviewSnapshot({ reason: "synchronize", base, head: reviewed, reviews: [] })
  const result = prepareGate(snapshot, repo)

  assert.deepEqual(result, { action: "review", reason: "no previous bot review" })
})

test("synchronize on the already reviewed head posts no-review without OpenCode", () => {
  const { repo, base, reviewed } = createRepo()
  const snapshot = reviewSnapshot({
    reason: "synchronize",
    base,
    head: reviewed,
    reviews: [botReview(reviewed)]
  })
  const result = prepareGate(snapshot, repo)

  assert.equal(result.action, "post")
  assert.equal(result.decision.decision, "no-review")
})

test("synchronize after an ancestor commit sends the commit delta to the gate", () => {
  const { repo, base, reviewed } = createRepo()
  write(repo, "src/app.js", "export const value = 2;\n")
  const head = commit(repo, "feature update")
  const rawDiff = git(repo, ["diff", `${base}..${head}`])
  const snapshot = reviewSnapshot(
    {
      reason: "synchronize",
      base,
      head,
      reviews: [botReview(reviewed)]
    },
    rawDiff
  )
  const result = prepareGate(snapshot, repo)

  assert.equal(result.action, "agent")
  assert.equal(result.context.delta.mode, "ancestor_diff")
  assert.deepEqual(result.context.delta.changedFiles, ["src/app.js"])
  assert.match(result.deltaText, /value = 2/u)
})

test("large ancestor deltas fall back to the current PR diff for the gate", () => {
  const { repo, reviewed, defaultBranch } = createRepo()
  git(repo, ["checkout", defaultBranch])
  write(repo, "fixtures/large.json", `{\n  "payload": "${"x".repeat(100_000)}"\n}\n`)
  const newBase = commit(repo, "main large fixture")
  git(repo, ["checkout", "feature"])
  git(repo, ["merge", "--no-edit", defaultBranch])
  const head = git(repo, ["rev-parse", "HEAD"])
  const currentPrDiff = git(repo, ["diff", `${newBase}..${head}`])
  const snapshot = reviewSnapshot(
    {
      reason: "synchronize",
      base: newBase,
      head,
      reviews: [botReview(reviewed)]
    },
    currentPrDiff
  )
  const result = prepareGate(snapshot, repo)

  assert.equal(result.action, "agent")
  assert.equal(result.context.delta.mode, "current_pr_diff")
  assert.deepEqual(result.context.delta.changedFiles, ["src/app.js"])
  assert.match(result.deltaText, /src\/app.js/u)
  assert.doesNotMatch(result.deltaText, /fixtures\/large.json/u)
})

test("rebase-equivalent force push sends range comparison to the gate", () => {
  const { repo, reviewed, defaultBranch } = createRepo()
  git(repo, ["checkout", defaultBranch])
  write(repo, "README.md", "base\nnew base\n")
  const newBase = commit(repo, "base update")
  git(repo, ["checkout", "-b", "feature-rebased"])
  write(repo, "src/app.js", "export const value = 1;\n")
  const head = commit(repo, "feature reviewed rebased")
  const rawDiff = git(repo, ["diff", `${newBase}..${head}`])
  const snapshot = reviewSnapshot(
    {
      reason: "synchronize",
      base: newBase,
      head,
      reviews: [botReview(reviewed)]
    },
    rawDiff
  )
  const result = prepareGate(snapshot, repo)

  assert.equal(result.action, "agent")
  assert.equal(result.context.delta.mode, "rebase_compare")
  assert.equal(result.context.delta.patchIdsMatch, true)
  assert.match(result.deltaText, /range-diff:/u)
})

test("mention trigger can use the gate even before the first completed review", () => {
  const { repo, base, reviewed } = createRepo()
  const snapshot = reviewSnapshot({ reason: "mention", base, head: reviewed, reviews: [] })
  const result = prepareGate(snapshot, repo)

  assert.equal(result.action, "agent")
  assert.equal(result.context.delta.mode, "no_previous_review")
})

test("mention retry request bypasses the gate even when the same head was reviewed", () => {
  const { repo, base, reviewed } = createRepo()
  const snapshot = reviewSnapshot({
    reason: "mention",
    base,
    head: reviewed,
    reviews: [botReview(reviewed)],
    commentBody: "@nibble-review can you try again?"
  })
  const result = prepareGate(snapshot, repo)

  assert.deepEqual(result, { action: "review", reason: "mention explicitly requested a full review" })
})

test("mention with incidental try again wording still uses the gate", () => {
  const { repo, base, reviewed } = createRepo()
  const snapshot = reviewSnapshot({
    reason: "mention",
    base,
    head: reviewed,
    reviews: [botReview(reviewed)],
    commentBody: "@nibble-review why did the previous review tell me to try again?"
  })
  const result = prepareGate(snapshot, repo)

  assert.equal(result.action, "agent")
  assert.equal(result.context.delta.mode, "same_head")
})
