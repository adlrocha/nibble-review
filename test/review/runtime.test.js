import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

import { createReviewProvider } from "../../dist/lib/review-provider.js"
import { reviewExitCode } from "../../dist/cli/review.js"
import { ReviewUnavailableError, runReview } from "../../dist/run-review.js"
import { ReviewGitHubActions } from "../../dist/services/github-actions.js"
import { createGitHubClient } from "../../dist/services/github-client.js"
import { createGitHubWriteTools } from "../../dist/tools/github-write.js"

const lanes = [
  "intent-contract",
  "standards-architecture",
  "code-path-bug-hunter",
  "correctness-risk-testing",
  "documentation-commentary",
  "maintainability-elegance"
]

const reviewDiff = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1 +1,2 @@",
  " export const stable = true",
  "+export const changed = true",
  ""
].join("\n")

function lane(prompt) {
  return lanes.find(name => prompt.includes("## Your lane is `" + name + "`"))
}

function githubFixture(overrides = {}) {
  const writes = []
  return {
    writes,
    client: {
      async getPullRequest(prNumber) {
        return {
          number: prNumber,
          title: "Change behavior",
          body: "Review this change.",
          author: { login: "author" },
          headRefOid: "2222222222222222222222222222222222222222",
          ...overrides.pullRequest
        }
      },
      async getPullRequestDiff() {
        return overrides.diff ?? reviewDiff
      },
      async getIssueComment(commentId) {
        return { id: commentId, body: "@nibble-review what does this do?", user: { login: "author" } }
      },
      async listIssueComments() {
        return overrides.issueComments ?? []
      },
      async listReviewComments() {
        return overrides.reviewComments ?? []
      },
      async listReviews() {
        return overrides.reviews ?? []
      },
      async listPullRequestTimeline() {
        return overrides.timelineEvents ?? []
      },
      async listPullRequestCommits() {
        return overrides.commits ?? []
      },
      async listReviewThreads() {
        return { available: true, threads: [] }
      },
      async listIssueCommentReactions() {
        return []
      },
      async createIssueCommentReaction(commentId, content) {
        writes.push({ kind: "reaction", commentId, content })
      },
      async createIssueComment(prNumber, body) {
        writes.push({ kind: "issue-comment", prNumber, body })
      },
      async submitReview(prNumber, headSha, payload) {
        writes.push({ kind: "review", prNumber, headSha, payload })
      },
      async submitReply(prNumber, commentId, body) {
        writes.push({ kind: "reply", prNumber, commentId, body })
      }
    }
  }
}

function git(workspace, args) {
  return execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim()
}

/** Builds a real commit delta so AML exercises the production ancestry gate. */
function reReviewFixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aml-rereview-"))
  const eventFile = path.join(workspace, "event.json")
  const sourceFile = path.join(workspace, "src", "retry.ts")
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true })
  git(workspace, ["init"])
  git(workspace, ["config", "user.email", "reviewer@example.com"])
  git(workspace, ["config", "user.name", "Reviewer"])

  fs.writeFileSync(sourceFile, "export const stable = true\n")
  git(workspace, ["add", "src/retry.ts"])
  git(workspace, ["commit", "-m", "base"])
  const base = git(workspace, ["rev-parse", "HEAD"])

  fs.writeFileSync(sourceFile, "export const stable = true\nexport const releaseRetriedSocket = false\n")
  git(workspace, ["add", "src/retry.ts"])
  git(workspace, ["commit", "-m", "reviewed change"])
  const reviewed = git(workspace, ["rev-parse", "HEAD"])

  fs.writeFileSync(sourceFile, "export const stable = true\nexport const releaseRetriedSocket = true\n")
  git(workspace, ["add", "src/retry.ts"])
  git(workspace, ["commit", "-m", "address review feedback"])
  const head = git(workspace, ["rev-parse", "HEAD"])
  const diff = git(workspace, ["diff", `${base}..${head}`]) + "\n"
  fs.writeFileSync(eventFile, JSON.stringify({ action: "synchronize", sender: { login: "author" } }))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))

  const botLogin = "nibble-review[bot]"
  return {
    workspace,
    eventFile,
    base,
    reviewed,
    head,
    diff,
    reviews: [
      {
        id: 100,
        user: { login: botLogin },
        state: "COMMENTED",
        body: "Release the socket before retrying.",
        submitted_at: "2026-08-20T16:20:00Z",
        commit_id: reviewed
      }
    ],
    reviewComments: [
      {
        id: 101,
        user: { login: botLogin },
        body: "**low:** Release the previous socket before starting another retry.",
        path: "src/retry.ts",
        line: 2,
        side: "RIGHT",
        created_at: "2026-08-20T16:20:00Z"
      }
    ]
  }
}

function options(github, workspace, overrides = {}) {
  return {
    request: {
      repository: "owner/repository",
      prNumber: 42,
      workspace,
      workspaceHeadSha: "2222222222222222222222222222222222222222",
      botLogin: "nibble-review[bot]",
      eventName: null,
      eventPath: null,
      actor: "author",
      ignoreHistory: false
    },
    github,
    actionMode: "dry-run",
    model: "opencode-go/deepseek-v4-flash",
    maximumConcurrency: 6,
    ...overrides
  }
}

async function invoke(request, context, toolName, input = {}) {
  const tool = request.tools.find(candidate => candidate.name === toolName)
  assert.ok(tool, toolName + " not granted")
  return tool.execute(input, context)
}

function completeProvider(publisher) {
  return new DeterministicAgentProvider({
    supportsSandbox: () => true,
    async respond(request, context) {
      const name = lane(request.prompt)
      if (name) {
        return { text: `Checked the ${name} lane; no actionable issue found.` }
      }
      if (request.system.includes("evidence auditor")) {
        return {
          text: "",
          structured: { findings: [] }
        }
      }
      if (request.system.includes("final calibration judge")) {
        return { text: "", structured: { keep: [] } }
      }
      if (request.system.includes("calibrate pull-request findings")) {
        return { text: "The empty typed queue was audited." }
      }
      if (request.system.includes("concise pull-request review summary")) {
        return {
          text: "",
          structured: {
            direct_answer: null,
            summary: "The change is focused and no actionable issue remains.",
            next_steps: null
          }
        }
      }
      return publisher(request, context)
    }
  })
}

test("review CLI reserves fallback exit status for pre-publication review failure", () => {
  assert.equal(reviewExitCode(new ReviewUnavailableError("provider failed")), 2)
  assert.equal(reviewExitCode(new Error("publication failed")), 1)
})

test("runtime materializes only the three Agent-readable review context files", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aml-runtime-"))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const github = githubFixture({
    pullRequest: { created_at: "2026-08-29T10:00:00Z", isDraft: false },
    issueComments: [
      {
        id: 700,
        user: { login: "maintainer" },
        body: "Keep the public contract unchanged.",
        created_at: "2026-08-29T11:00:00Z"
      }
    ],
    reviews: [
      {
        id: 701,
        user: { login: "reviewer" },
        state: "COMMENTED",
        body: "The first push needed a clearer boundary.",
        submitted_at: "2026-08-29T11:30:00Z"
      }
    ],
    timelineEvents: [
      {
        id: 699,
        event: "ready_for_review",
        actor: { login: "author" },
        created_at: "2026-08-29T10:30:00Z"
      }
    ],
    commits: [
      {
        sha: "2222222222222222222222222222222222222222",
        author: { login: "author" },
        commit: {
          author: { name: "Author Person", date: "2026-08-29T12:00:00Z" },
          message: "Keep the review context readable"
        }
      }
    ]
  })
  const created = []

  const model = "opencode-go/deepseek-v4-flash"
  const result = await runReview(options(github.client, workspace, { model }), providerOptions => {
    created.push(providerOptions)
    return completeProvider(async (request, context) => {
      await invoke(request, context, "submit_pull_request_review")
      return { text: "", structured: { completed: true, operations: 1 } }
    })
  })

  assert.deepEqual(
    result.attempts.map(attempt => attempt.status),
    ["completed"]
  )
  assert.deepEqual(
    created.map(item => [item.model, item.workspace]),
    [[model, workspace]]
  )
  const contextDirectory = path.join(workspace, ".nibble-review")
  assert.deepEqual(fs.readdirSync(workspace), [".nibble-review"])
  assert.deepEqual(fs.readdirSync(contextDirectory).sort(), ["history.md", "pr.diff", "pr.md"])
  const pullRequestContext = fs.readFileSync(path.join(contextDirectory, "pr.md"), "utf8")
  assert.match(pullRequestContext, /Review this change\./u)
  assert.match(pullRequestContext, /Keep the review context readable/u)
  assert.match(pullRequestContext, /## Participants\n\nAuthor Person <@author>\n<@maintainer>\n<@reviewer>/u)
  assert.equal(fs.readFileSync(path.join(contextDirectory, "pr.diff"), "utf8").trimEnd(), reviewDiff.trimEnd())
  const historyContext = fs.readFileSync(path.join(contextDirectory, "history.md"), "utf8")
  assert.match(historyContext, /## Chronological timeline/u)
  assert.match(historyContext, /Keep the public contract unchanged\./u)
  assert.match(historyContext, /The first push needed a clearer boundary\./u)
  assert.match(historyContext, /pull request opened \| @author \| draft/u)
  assert.match(historyContext, /ready for review \| @author/u)
  assert.deepEqual(github.writes, [])
})

test("runtime rejects a checkout that does not match the pull request head before starting an Agent", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aml-runtime-"))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const github = githubFixture()
  const base = options(github.client, workspace)
  let providers = 0

  await assert.rejects(
    runReview(
      options(github.client, workspace, {
        request: {
          ...base.request,
          workspaceHeadSha: "1111111111111111111111111111111111111111"
        }
      }),
      () => {
        providers += 1
        return completeProvider(() => {
          throw new Error("mismatched checkouts must stop before provider construction")
        })
      }
    ),
    /checked-out head .* does not match pull request head/u
  )

  assert.equal(providers, 0)
  assert.deepEqual(github.writes, [])
})

test("runtime rejects a push during snapshot assembly before starting an Agent", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aml-runtime-"))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const github = githubFixture()
  let reads = 0
  github.client.getPullRequest = async prNumber => {
    reads += 1
    return {
      number: prNumber,
      title: "Change behavior",
      headRefOid: reads === 1 ? "2".repeat(40) : "3".repeat(40)
    }
  }
  let providers = 0

  await assert.rejects(
    runReview(options(github.client, workspace), () => {
      providers += 1
      return completeProvider(() => {
        throw new Error("a drifting snapshot must stop before provider construction")
      })
    }),
    /pull request head changed during review/u
  )
  assert.equal(reads, 2)
  assert.equal(providers, 0)
})

test("OpenCode provider inherits AML permissions while preserving launch configuration", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aml-provider-"))
  const commandDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aml-opencode-"))
  const capture = path.join(workspace, "launch.txt")
  const command = path.join(commandDirectory, "opencode")
  const quoteShell = value => `'${value.replaceAll("'", "'\\''")}'`
  fs.writeFileSync(
    command,
    `#!/bin/sh
printf '%s\\n%s\\n%s\\n%s\\n' "$OPENCODE_CONFIG_CONTENT" "$OPENCODE_DISABLE_AUTOUPDATE" "$OPENCODE_DISABLE_PROJECT_CONFIG" "$PWD" > ${quoteShell(capture)}
sleep 30
`
  )
  fs.chmodSync(command, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${commandDirectory}${path.delimiter}${previousPath || ""}`
  t.after(() => {
    process.env.PATH = previousPath
    fs.rmSync(commandDirectory, { recursive: true, force: true })
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  const provider = createReviewProvider({
    model: "opencode-go/deepseek-v4-flash",
    workspace
  })
  const controller = new AbortController()
  const run = provider.run(
    {
      prompt: "credential-free provider wiring check",
      system: "",
      mcpServers: [],
      permissions: { filesystem: "read-only", network: false, shell: false },
      skills: [],
      tools: []
    },
    {
      events: {
        emit() {},
        subscribe() {
          return () => {}
        }
      },
      signal: controller.signal,
      trace: {}
    }
  )
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(run)

  const [configText, autoUpdate, projectConfig, launchDirectory] = fs
    .readFileSync(capture, "utf8")
    .trimEnd()
    .split("\n")
  const config = JSON.parse(configText)
  assert.equal(config.model, "opencode-go/deepseek-v4-flash")
  for (const tool of ["bash", "edit", "webfetch", "websearch"]) {
    assert.equal(config.permission[tool], "deny")
  }
  assert.deepEqual(config.tools, { task: false })
  assert.equal(config.agent.aml.permission["*"], "allow")
  assert.equal(config.agent.aml.tools.task, false)
  for (const tool of ["bash", "edit", "webfetch", "websearch", "write"]) {
    assert.equal(config.agent.aml.permission[tool], "deny")
    assert.equal(config.agent.aml.tools[tool], false)
  }
  assert.equal(autoUpdate, "true")
  assert.equal(projectConfig, "1")
  assert.equal(launchDirectory, workspace)
})

test("GitHub client binds a review request to the inspected commit", async t => {
  const previousFetch = globalThis.fetch
  let request = null
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init }
    return new Response(JSON.stringify({ id: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  }
  t.after(() => {
    globalThis.fetch = previousFetch
  })

  const github = createGitHubClient({ token: "test-token", repository: "owner/repository" })
  await github.submitReview(42, "2222222222222222222222222222222222222222", {
    body: "Prepared review",
    event: "COMMENT",
    comments: []
  })

  assert.equal(request?.url, "https://api.github.com/repos/owner/repository/pulls/42/reviews")
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    commit_id: "2222222222222222222222222222222222222222",
    body: "Prepared review",
    event: "COMMENT",
    comments: []
  })
})

test("live publication executes the prepared Tool without a provider confirmation turn", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aml-runtime-"))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const github = githubFixture()
  let publicationCalls = 0
  const provider = completeProvider(async () => {
    publicationCalls += 1
    throw new Error("publication must not require a model turn")
  })

  const result = await runReview(options(github.client, workspace, { actionMode: "live" }), () => provider)

  assert.equal(publicationCalls, 0)
  assert.equal(result.publicationStatus, "completed")
  assert.deepEqual(
    github.writes.map(write => write.kind),
    ["review"]
  )
  assert.equal(github.writes[0].headSha, "2222222222222222222222222222222222222222")
  assert.equal(result.publication.find(receipt => receipt.kind === "review")?.status, "submitted")
})

test("ambiguous GitHub mutation failure is not replayed", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aml-runtime-"))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const github = githubFixture()
  let publicationCalls = 0
  github.client.submitReview = async (prNumber, headSha, payload) => {
    github.writes.push({ kind: "review", prNumber, headSha, payload })
    throw new Error("connection closed after upload")
  }
  const provider = completeProvider(async () => {
    publicationCalls += 1
    throw new Error("publication must not require a model turn")
  })

  const result = await runReview(options(github.client, workspace, { actionMode: "live" }), () => provider)

  assert.equal(publicationCalls, 0)
  assert.equal(result.publicationStatus, "failed")
  assert.match(result.publicationError, /ambiguous; publication was not replayed/u)
  assert.deepEqual(
    github.writes.map(write => write.kind),
    ["review"]
  )
})

test("publication rejects findings when the pull request head changed during review", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aml-runtime-"))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const github = githubFixture()
  let reads = 0
  github.client.getPullRequest = async prNumber => {
    reads += 1
    return {
      number: prNumber,
      title: "Change behavior",
      body: "Review this change.",
      author: { login: "author" },
      headRefOid: reads <= 2 ? "2222222222222222222222222222222222222222" : "3333333333333333333333333333333333333333"
    }
  }
  let publicationCalls = 0
  const provider = completeProvider(async () => {
    publicationCalls += 1
    return { text: "", structured: { completed: true, operations: 1 } }
  })

  const result = await runReview(options(github.client, workspace, { actionMode: "live" }), () => provider)

  assert.equal(reads, 3)
  assert.equal(publicationCalls, 0)
  assert.equal(result.publicationStatus, "failed")
  assert.match(result.publicationError, /pull request head changed during review/u)
  assert.deepEqual(github.writes, [])
})

test("concurrent duplicate Tools share one live GitHub mutation", async () => {
  const github = githubFixture()
  github.client.createIssueComment = async (prNumber, body) => {
    github.writes.push({ kind: "issue-comment", prNumber, body })
    await new Promise(resolve => setImmediate(resolve))
  }
  const actions = new ReviewGitHubActions({
    mode: "live",
    github: github.client,
    repository: "owner/repository",
    prNumber: 42,
    headSha: "2222222222222222222222222222222222222222"
  })

  const receipts = await Promise.all([
    actions.postIssueComment(42, "same prepared answer"),
    actions.postIssueComment(42, "same prepared answer")
  ])

  assert.equal(github.writes.length, 1)
  assert.equal(receipts[0].key, receipts[1].key)
  assert.equal(receipts[0].status, "submitted")
  assert.equal(actions.receipts().length, 1)
})

test("review reply Tool accepts only prepared indexes and coalesces duplicates", async () => {
  const github = githubFixture()
  const actions = new ReviewGitHubActions({
    mode: "live",
    github: github.client,
    repository: "owner/repository",
    prNumber: 42,
    headSha: "2222222222222222222222222222222222222222"
  })
  const tools = createGitHubWriteTools(actions, {
    kind: "review",
    prNumber: 42,
    payload: { body: "Prepared review", event: "COMMENT", comments: [] },
    replies: [{ to: 123, body: "Prepared reply" }]
  })
  const context = { signal: new AbortController().signal }

  const first = await tools.replyToReviewComment.execute({ index: 0 }, context)
  const duplicate = await tools.replyToReviewComment.execute({ index: 0 }, context)

  assert.equal(first.status, "submitted")
  assert.equal(duplicate.status, "skipped")
  await assert.rejects(tools.replyToReviewComment.execute({ index: 1 }, context), /outside the prepared plan/u)
  assert.deepEqual(github.writes, [{ kind: "reply", prNumber: 42, commentId: 123, body: "Prepared reply" }])
})

test("gate answers publish through post_issue_comment without starting review lanes", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aml-runtime-"))
  const eventFile = path.join(workspace, "event.json")
  fs.writeFileSync(
    eventFile,
    JSON.stringify({
      action: "created",
      comment: { id: 77, body: "@nibble-review what does this do?", user: { login: "author" } },
      sender: { login: "author" }
    })
  )
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const github = githubFixture()
  const provider = new DeterministicAgentProvider({
    async respond(request) {
      if (request.system.includes("route pull-request follow-up")) {
        assert.deepEqual(request.skills, [])
        assert.match(request.prompt, /<gate-policy>\n# Review gate/u)
        assert.match(request.prompt, /<gate-context>/u)
        assert.match(request.prompt, /<review-delta>/u)
        return {
          text: "",
          structured: { decision: "answer", answer: "This change keeps the cached result fresh." }
        }
      }
      throw new Error("full review should not start")
    }
  })
  const base = options(github.client, workspace)

  const result = await runReview(
    options(github.client, workspace, {
      actionMode: "live",
      request: { ...base.request, eventName: "issue_comment", eventPath: eventFile }
    }),
    () => provider
  )

  assert.equal(result.status, "answered")
  assert.equal(result.gate.source, "agent")
  assert.deepEqual(
    github.writes.map(write => write.kind),
    ["reaction", "issue-comment"]
  )
  assert.equal(
    provider.calls.some(call => Boolean(lane(call.request.prompt))),
    false
  )
})

test("explicit re-review mentions bypass the gate Agent and start every review lane", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aml-runtime-"))
  const eventFile = path.join(workspace, "event.json")
  fs.writeFileSync(
    eventFile,
    JSON.stringify({
      action: "created",
      comment: { id: 78, body: "@nibble-review please re-review this", user: { login: "author" } },
      sender: { login: "author" }
    })
  )
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const github = githubFixture()
  const provider = completeProvider(request => {
    throw new Error(`unexpected Agent: ${request.system}`)
  })
  const base = options(github.client, workspace)

  const result = await runReview(
    options(github.client, workspace, {
      actionMode: "live",
      request: { ...base.request, eventName: "issue_comment", eventPath: eventFile }
    }),
    () => provider
  )

  assert.equal(result.status, "reviewed")
  assert.equal(result.gate.source, "deterministic")
  assert.match(result.gate.reason, /explicitly requested a full review/u)
  assert.equal(
    provider.calls.some(call => call.request.system.includes("route pull-request follow-up")),
    false
  )
  assert.equal(provider.calls.filter(call => Boolean(lane(call.request.prompt))).length, 6)
  assert.deepEqual(
    github.writes.map(write => write.kind),
    ["reaction", "review"]
  )
})

test("same-head synchronize exits deterministically with LGTM before starting an Agent", async t => {
  const history = reReviewFixture(t)
  const github = githubFixture({
    diff: history.diff,
    pullRequest: {
      baseRefOid: history.base,
      headRefOid: history.reviewed
    },
    reviews: history.reviews
  })
  const provider = new DeterministicAgentProvider({
    respond() {
      throw new Error("same-head synchronize should not start an Agent")
    }
  })
  const base = options(github.client, history.workspace)

  const result = await runReview(
    options(github.client, history.workspace, {
      actionMode: "live",
      request: {
        ...base.request,
        workspaceHeadSha: history.reviewed,
        eventName: "pull_request",
        eventPath: history.eventFile
      }
    }),
    () => provider
  )

  assert.equal(result.status, "no-review")
  assert.equal(result.gate.source, "deterministic")
  assert.match(result.body, /^## Review Summary\n\nNo full re-review needed/u)
  assert.match(result.body, /## Verdict\n\n✅ LGTM$/u)
  assert.equal(provider.calls.length, 0)
  assert.deepEqual(github.writes, [{ kind: "issue-comment", prNumber: 42, body: result.body }])
})

test("contained fixes use one gate Agent and fast-track without starting review lanes", async t => {
  const history = reReviewFixture(t)
  const github = githubFixture({
    diff: history.diff,
    pullRequest: {
      baseRefOid: history.base,
      headRefOid: history.head,
      html_url: "https://github.com/owner/repository/pull/42"
    },
    reviews: history.reviews,
    reviewComments: history.reviewComments,
    commits: [{ sha: history.reviewed }, { sha: history.head }]
  })
  const provider = new DeterministicAgentProvider({
    async respond(request) {
      if (request.system.includes("route pull-request follow-up")) {
        assert.match(request.prompt, /contained response to previous review feedback/u)
        assert.match(request.prompt, /cross runtime component boundaries/u)
        assert.match(request.prompt, /Release the previous socket before starting another retry/u)
        assert.match(request.prompt, /releaseRetriedSocket = true/u)
        assert.match(request.prompt, /https:\/\/github\.com\/owner\/repository\/pull\/42#discussion_r\d+/u)
        assert.match(request.prompt, /never as bare internal or API IDs/u)
        return {
          text: "",
          structured: {
            decision: "no-review",
            answer:
              "The latest push directly addresses the previous socket-release finding and adds no unrelated behavior.\n✅ LGTM"
          }
        }
      }
      throw new Error("contained re-review should stop before specialist lanes")
    }
  })
  const base = options(github.client, history.workspace)

  const result = await runReview(
    options(github.client, history.workspace, {
      actionMode: "live",
      request: {
        ...base.request,
        workspaceHeadSha: history.head,
        eventName: "pull_request",
        eventPath: history.eventFile
      }
    }),
    () => provider
  )

  assert.equal(result.status, "no-review")
  assert.equal(result.gate.source, "agent")
  assert.equal(provider.calls.length, 1)
  assert.equal(
    provider.calls.some(call => Boolean(lane(call.request.prompt))),
    false
  )
  assert.equal(
    result.body,
    "## Since last review\n\nThe latest push directly addresses the previous socket-release finding and adds no unrelated behavior.\n\n## Verdict\n\n✅ LGTM"
  )
  assert.deepEqual(github.writes, [{ kind: "issue-comment", prNumber: 42, body: result.body }])
})

test("uncertain re-review deltas escalate from the gate into the full specialist tree", async t => {
  const history = reReviewFixture(t)
  const github = githubFixture({
    diff: history.diff,
    pullRequest: {
      baseRefOid: history.base,
      headRefOid: history.head
    },
    reviews: history.reviews,
    reviewComments: history.reviewComments,
    commits: [{ sha: history.reviewed }, { sha: history.head }]
  })
  const provider = completeProvider(async request => {
    if (request.system.includes("route pull-request follow-up")) {
      return {
        text: "",
        structured: {
          decision: "review",
          reason: "The latest delta changes behavior beyond the previous finding and needs a full review."
        }
      }
    }
    throw new Error(`unexpected Agent: ${request.system}`)
  })
  const base = options(github.client, history.workspace)

  const result = await runReview(
    options(github.client, history.workspace, {
      actionMode: "live",
      request: {
        ...base.request,
        workspaceHeadSha: history.head,
        eventName: "pull_request",
        eventPath: history.eventFile
      }
    }),
    () => provider
  )

  assert.equal(result.status, "reviewed")
  assert.equal(result.gate.source, "agent")
  assert.equal(provider.calls.filter(call => Boolean(lane(call.request.prompt))).length, 6)
  assert.equal(
    github.writes.some(write => write.kind === "review"),
    true
  )
})

test("all failed attempts stop before any GitHub publication", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aml-runtime-"))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const github = githubFixture()
  let providers = 0

  await assert.rejects(
    runReview(options(github.client, workspace), () => {
      providers += 1
      return new DeterministicAgentProvider({ respond: () => Promise.reject(new Error("offline")) })
    }),
    error =>
      error instanceof ReviewUnavailableError && /attempt 1: intent-contract: .*failed: offline/u.test(error.message)
  )
  assert.equal(providers, 1)
  assert.deepEqual(github.writes, [])
})
