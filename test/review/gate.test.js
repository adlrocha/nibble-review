import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { REVIEW_MARKER } from "../../dist/lib/review-authorship.js"
import { prepareGate } from "../../dist/lib/review-gate.js"
import { ReviewDiff } from "../../dist/lib/review-diff.js"

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
      files:
        diff.files.length > 0
          ? diff.files
          : [
              {
                path: "src/app.js",
                status: "modified",
                addedLines: [],
                deletedLines: [],
                rightLines: [],
                leftLines: []
              }
            ],
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

test("a shared github-actions login only counts as a previous review when it carries the marker", () => {
  const { repo, base, reviewed } = createRepo()
  const sharedLogin = "github-actions[bot]"
  const foreign = { ...botReview(reviewed), user: { login: sharedLogin }, body: "Lint passed." }
  const own = { ...foreign, id: 2, body: `Previous review.\n\n${REVIEW_MARKER}` }

  const withForeign = {
    ...reviewSnapshot({ reason: "synchronize", base, head: reviewed, reviews: [foreign] }),
    botLogin: sharedLogin
  }
  assert.deepEqual(prepareGate(withForeign, repo), { action: "review", reason: "no previous bot review" })

  const withOwn = { ...withForeign, reviews: [foreign, own] }
  assert.equal(prepareGate(withOwn, repo).decision.decision, "no-review")
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

// Regression for force-pushed PRs (adlrocha/nibble-review#16): the checkout
// holds only the current PR head, so a rebased-away reviewed commit is missing
// locally even though GitHub still serves it by SHA. The action must fetch it
// before the gate runs, or every rebase pays for a full review.
const fetchReviewedCommits = path.resolve(import.meta.dirname, "..", "..", "bin", "fetch-reviewed-commits.sh")

/** Simulates GitHub: an origin that kept the reviewed commit, and a checkout of only the rebased head. */
function createForcePushedCheckout(t) {
  const { repo: origin, reviewed, defaultBranch } = createRepo()
  t.after(() => fs.rmSync(origin, { recursive: true, force: true }))
  // GitHub serves any commit of the repository by SHA; plain git needs this opt-in.
  git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"])
  git(origin, ["checkout", defaultBranch])
  write(origin, "README.md", "base\nnew base\n")
  const newBase = commit(origin, "base update")
  git(origin, ["checkout", "-b", "feature-rebased"])
  write(origin, "src/app.js", "export const value = 1;\n")
  const head = commit(origin, "feature reviewed rebased")
  // The force-push removed the reviewed commit from every branch; only the object remains.
  git(origin, ["branch", "-D", "feature"])

  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "gate-checkout-"))
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }))
  execFileSync("git", ["clone", "--quiet", "--no-tags", "--branch", "feature-rebased", `file://${origin}`, checkout])
  git(checkout, ["fetch", "--quiet", "origin", `${defaultBranch}:${defaultBranch}`])
  const rawDiff = git(checkout, ["diff", `${newBase}..${head}`])
  return { checkout, reviewed, newBase, head, rawDiff }
}

function runFetchReviewedCommits(checkout, shas) {
  return spawnSync("bash", [fetchReviewedCommits, checkout, ...shas], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME }
  })
}

test("force-pushed head: the checkout alone cannot reach the reviewed commit", t => {
  const { checkout, reviewed, newBase, head, rawDiff } = createForcePushedCheckout(t)
  const snapshot = reviewSnapshot(
    { reason: "synchronize", base: newBase, head, reviews: [botReview(reviewed)] },
    rawDiff
  )

  const result = prepareGate(snapshot, checkout)

  assert.equal(result.action, "review")
  assert.match(result.reason, /not available in the checkout/u)
})

test("force-pushed head: fetching the reviewed commit lets the gate compare the rebase", t => {
  const { checkout, reviewed, newBase, head, rawDiff } = createForcePushedCheckout(t)
  const fetched = runFetchReviewedCommits(checkout, [reviewed])
  assert.equal(fetched.status, 0, fetched.stderr)

  const snapshot = reviewSnapshot(
    { reason: "synchronize", base: newBase, head, reviews: [botReview(reviewed)] },
    rawDiff
  )
  const result = prepareGate(snapshot, checkout)

  assert.equal(result.action, "agent")
  assert.equal(result.context.delta.mode, "rebase_compare")
  assert.equal(result.context.delta.patchIdsMatch, true)
})

test("force-pushed head: a reviewed commit GitHub no longer serves still falls back to a full review", t => {
  const { checkout, newBase, head, rawDiff } = createForcePushedCheckout(t)
  const missing = "0123456789abcdef0123456789abcdef01234567"
  const fetched = runFetchReviewedCommits(checkout, [missing])
  assert.equal(fetched.status, 0, "an unfetchable commit must never fail the review job")

  const snapshot = reviewSnapshot(
    { reason: "synchronize", base: newBase, head, reviews: [botReview(missing)] },
    rawDiff
  )
  const result = prepareGate(snapshot, checkout)

  assert.equal(result.action, "review")
  assert.match(result.reason, /not available in the checkout/u)
})

test("fetching reviewed commits skips ones the checkout already has and rejects non-SHA arguments", t => {
  const { checkout, head } = createForcePushedCheckout(t)

  assert.equal(runFetchReviewedCommits(checkout, [head]).status, 0)
  const rejected = runFetchReviewedCommits(checkout, ["--upload-pack=touch /tmp/pwned"])
  assert.notEqual(rejected.status, 0, "only 40-hex SHAs may reach git fetch")
})
