import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildEvalSummary, evalRunStatus } from "../../eval/lib/analysis.mjs"
import { buildJudgePrompt } from "../../eval/lib/judge-prompt.mjs"
import { evalJobKey } from "../../eval/lib/job-key.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("judge prompt separates review quality from the pull-request verdict", () => {
  const prompt = buildJudgePrompt({
    repoRoot,
    job: {
      input: { ref: "owner/repository#42", ignoreHistory: true },
      model: "opencode-go/deepseek-v4-flash"
    }
  })

  assert.match(prompt, /top-level `verdict` grades the quality of that candidate review/u)
  assert.match(prompt, /sound even if it correctly requests PR changes/u)
  assert.match(prompt, /Independently verify every candidate finding that affects merge readiness/u)
})

test("legacy run completion requires a terminal job for every matrix cell", () => {
  const run = {
    endedAt: "2026-08-24T10:10:00.000Z",
    inputs: [{ ref: "owner/repo#1" }, { ref: "owner/repo#2" }],
    models: ["model"],
    jobs: [{ status: "completed" }, { status: "failed" }]
  }

  assert.equal(evalRunStatus(run), "completed")
  assert.equal(evalRunStatus({ ...run, jobs: run.jobs.slice(0, 1) }), "unknown")
  assert.equal(evalRunStatus({ ...run, status: "running" }), "running")
})

test("eval analysis reads AML turns and token totals from the canonical stats export", t => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aml-analysis-"))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const reviewFile = path.join(runDir, "review.md")
  const commentsFile = path.join(runDir, "review_comments.json")
  const statsFile = path.join(runDir, "review_stats.json")
  fs.writeFileSync(reviewFile, "# Final Review Body\n\n✅ LGTM")
  fs.writeFileSync(
    commentsFile,
    JSON.stringify({ review: { body: "✅ LGTM" }, issueComments: [], inlineComments: [], replies: [], dropped: [] })
  )
  fs.writeFileSync(
    statsFile,
    JSON.stringify({
      phases: [{ name: "gate" }, { name: "intent-contract" }],
      totals: {
        durationMs: 420_000,
        turns: 9,
        totalTokens: 400,
        inputTokens: 280,
        outputTokens: 80,
        reasoningTokens: 40,
        costUsd: 0
      }
    })
  )

  const summary = buildEvalSummary({
    runDir,
    run: {
      status: "completed",
      startedAt: "2026-08-23T10:00:00.000Z",
      endedAt: "2026-08-23T10:08:00.000Z",
      targetDurationMs: 300_000,
      reviewTimeoutMs: 600_000,
      jobs: [
        {
          runner: "aml",
          provider: "opencode",
          model: "opencode/deepseek-v4-flash",
          status: "completed",
          error: null,
          outputBytes: fs.statSync(reviewFile).size,
          startedAt: "2026-08-23T10:00:00.000Z",
          endedAt: "2026-08-23T10:08:00.000Z",
          input: {
            slug: "owner-repository-pr-42",
            ref: "owner/repository#42",
            label: "fixture"
          },
          files: {
            review: reviewFile,
            comments: commentsFile,
            stats: statsFile
          }
        }
      ]
    },
    judgments: []
  })

  const usage = summary.results[0].captureUsage
  assert.deepEqual(usage, {
    steps: 9,
    totalTokens: 400,
    inputTokens: 280,
    outputTokens: 80,
    reasoningTokens: 40,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    estimatedCostUsd: null
  })
  assert.equal(summary.results[0].durationMs, 420_000)
  assert.equal(summary.results[0].reviewerDurationMs, 420_000)
  assert.equal(summary.results[0].reviewerDurationBoundary, "aml-workflow")
  assert.equal(summary.results[0].captureDurationMs, 480_000)
  assert.equal(summary.results[0].cacheHit, false)
  assert.equal(summary.run.runner, "src")
  assert.equal(summary.run.status, "completed")
  assert.equal(summary.run.provider, "opencode")
  assert.equal(summary.results[0].runner, "aml")
  assert.equal(summary.results[0].provider, "opencode")
  assert.equal(summary.results[0].heuristics.find(item => item.id === "max-duration").passed, false)
  assert.equal(summary.results[0].costUsd, null)
  assert.equal(summary.results[0].costLabel, "n/a")
})

test("eval analysis takes the published verdict from the captured review", t => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "captured-verdict-"))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const reviewFile = path.join(runDir, "review.md")
  const commentsFile = path.join(runDir, "review_comments.json")
  const reviewBody = "## Review Summary\n\nOne correction remains.\n\n## Verdict\n\n⚠️ Request changes"
  fs.writeFileSync(reviewFile, `# Final Review Body\n\n${reviewBody}`)
  fs.writeFileSync(
    commentsFile,
    JSON.stringify({ review: { body: reviewBody }, issueComments: [], inlineComments: [{}], replies: [], dropped: [] })
  )
  const job = {
    runner: "aml",
    provider: "opencode",
    model: "opencode-go/deepseek-v4-flash",
    status: "completed",
    outputBytes: fs.statSync(reviewFile).size,
    startedAt: "2026-08-28T10:00:00.000Z",
    endedAt: "2026-08-28T10:01:00.000Z",
    input: {
      slug: "owner-repository-pr-42",
      ref: "owner/repository#42",
      label: "fixture"
    },
    files: { review: reviewFile, comments: commentsFile }
  }

  const summary = buildEvalSummary({
    runDir,
    run: {
      status: "completed",
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      inputs: [job.input],
      models: [job.model],
      jobs: [job]
    },
    // The judge is grading review quality here, not authoring the publication
    // decision, and may therefore use "lgtm" for a good blocking review.
    judgments: [{ jobKey: evalJobKey(job), status: "completed", score: 8.8, verdict: "lgtm", questions: [] }]
  })

  assert.equal(summary.results[0].verdictKey, "request_changes")
  assert.equal(summary.results[0].verdictLabel, "⚠ request changes")
})

test("eval analysis includes every retained judge attempt in usage and cost", t => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-attempt-analysis-"))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const reviewFile = path.join(runDir, "review.md")
  const commentsFile = path.join(runDir, "review_comments.json")
  const firstRaw = path.join(runDir, "judge-attempts", "attempt-1", "judge.raw.jsonl")
  const secondRaw = path.join(runDir, "judge-attempts", "attempt-2", "judge.raw.jsonl")
  fs.mkdirSync(path.dirname(firstRaw), { recursive: true })
  fs.mkdirSync(path.dirname(secondRaw), { recursive: true })
  fs.writeFileSync(reviewFile, "# Final Review Body\n\n✅ LGTM")
  fs.writeFileSync(
    commentsFile,
    JSON.stringify({ review: { body: "✅ LGTM" }, issueComments: [], inlineComments: [], replies: [], dropped: [] })
  )
  fs.writeFileSync(firstRaw, '{"part":{"tokens":{"total":100,"input":80,"output":20},"cost":0.01}}\n')
  fs.writeFileSync(secondRaw, '{"part":{"tokens":{"total":200,"input":150,"output":50},"cost":0.02}}\n')

  const job = {
    runner: "aml",
    provider: "opencode",
    model: "opencode-go/deepseek-v4-flash",
    status: "completed",
    outputBytes: fs.statSync(reviewFile).size,
    startedAt: "2026-08-30T10:00:00.000Z",
    endedAt: "2026-08-30T10:01:00.000Z",
    input: { slug: "owner-repository-pr-42", ref: "owner/repository#42" },
    files: { review: reviewFile, comments: commentsFile }
  }
  const judgment = {
    jobKey: evalJobKey(job),
    model: "opencode-go/deepseek-v4-flash",
    status: "completed",
    score: 9,
    verdict: "lgtm",
    questions: [],
    files: { raw: secondRaw },
    attempts: [
      {
        attempt: 1,
        model: "opencode-go/deepseek-v4-flash",
        status: "failed",
        startedAt: "2026-08-30T10:01:00.000Z",
        files: { raw: firstRaw }
      },
      {
        attempt: 2,
        model: "opencode-go/deepseek-v4-flash",
        status: "completed",
        startedAt: "2026-08-30T10:02:00.000Z",
        files: { raw: secondRaw }
      }
    ]
  }

  const summary = buildEvalSummary({
    runDir,
    run: {
      status: "completed",
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      inputs: [job.input],
      models: [job.model],
      jobs: [job]
    },
    judgments: [judgment]
  })

  assert.equal(summary.results[0].judgeUsage.totalTokens, 300)
  assert.equal(summary.results[0].judgeReportedCostUsd, 0.03)
  assert.equal(summary.results[0].judgeCostSource, "all-attempts:provider")
})

test("eval report requires an explicit diagnostic flag for partial runs", t => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-eval-report-"))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify({
      status: "running",
      updatedAt: "2026-08-24T10:01:00.000Z",
      startedAt: "2026-08-24T10:00:00.000Z",
      jobs: []
    })
  )
  const report = path.join(repoRoot, "eval", "report.mjs")
  const rejected = spawnSync(process.execPath, [report, "--run", runDir], { cwd: repoRoot, encoding: "utf8" })

  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /pass --allow-partial for a diagnostic report/u)

  const allowed = spawnSync(process.execPath, [report, "--run", runDir, "--allow-partial"], {
    cwd: repoRoot,
    encoding: "utf8"
  })
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8")).run.status, "running")
})

test("eval analysis uses pi's session-log cost estimate as the capture cost", t => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aml-analysis-"))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const reviewFile = path.join(runDir, "review.md")
  const statsFile = path.join(runDir, "review_stats.json")
  fs.writeFileSync(reviewFile, "# Final Review Body\n\n✅ LGTM")
  fs.writeFileSync(
    statsFile,
    JSON.stringify({
      usageSource: "pi-session",
      totals: {
        durationMs: 1_000,
        turns: 8,
        totalTokens: 3_000,
        inputTokens: 2_000,
        outputTokens: 1_000,
        estimatedCostUsd: 0.12
      }
    })
  )
  const job = {
    runner: "aml",
    provider: "pi",
    model: "opencode-go/deepseek-v4-flash",
    status: "completed",
    error: null,
    outputBytes: fs.statSync(reviewFile).size,
    startedAt: "2026-10-12T10:00:00.000Z",
    endedAt: "2026-10-12T10:01:00.000Z",
    input: { slug: "owner-repository-pr-7", ref: "owner/repository#7", label: "pi" },
    files: { review: reviewFile, stats: statsFile }
  }
  const summary = buildEvalSummary({
    runDir,
    run: { status: "completed", runner: "aml", provider: "pi", jobs: [job] },
    judgments: []
  })

  assert.equal(summary.results[0].provider, "pi")
  assert.equal(summary.results[0].captureUsage.estimatedCostUsd, 0.12)
  assert.equal(summary.results[0].costUsd, 0.12)
})
