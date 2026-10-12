import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { evalJobKey } from "../../eval/lib/job-key.mjs"
import { JudgeAttemptStore } from "../../eval/lib/judge-attempts.mjs"
import { normalizeEvalModel } from "../../eval/lib/models.mjs"
import { reviewCacheKey } from "../../eval/lib/review-cache-key.mjs"
import { piJudgeCommand } from "../../eval/lib/pi-judge.mjs"
import { reviewerIdentity } from "../../eval/lib/reviewer-identity.mjs"
import { reviewerProcessConfig } from "../../eval/lib/reviewer-runner.mjs"
import { runProcess, sameCaptureJob, validateAppendReviewerIdentity, writeRunFile } from "../../eval/run.mjs"
import { completedJobArtifacts } from "../../eval/lib/job-artifacts.mjs"
import { resolveJudgeConfigFile } from "../../eval/judge.mjs"

const input = {
  slug: "owner-repository-pr-42",
  repository: "owner/repository",
  number: 42,
  ref: "owner/repository#42",
  ignoreHistory: true,
  baseSha: "1111111111111111111111111111111111111111",
  headSha: "2222222222222222222222222222222222222222"
}

test("review process settles at the timeout even when the child ignores SIGTERM", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nibble-eval-runner-"))
  const started = Date.now()
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 250)"],
    cwd: process.cwd(),
    env: process.env,
    stdoutFile: join(directory, "stdout.log"),
    stderrFile: join(directory, "stderr.log"),
    timeoutMs: 20
  })

  assert.equal(result.status, 1)
  assert.match(result.error, /timed out after 20ms/)
  assert.ok(Date.now() - started < 180, "timeout should not wait for child close")
})

test("judge config follows the capture unless explicitly overridden", () => {
  const directory = mkdtempSync(join(tmpdir(), "nibble-eval-judge-config-"))
  const capturedConfig = join(directory, "capture.ts")
  const explicitConfig = join(directory, "override.ts")

  assert.equal(resolveJudgeConfigFile("", { configFile: capturedConfig }), capturedConfig)
  assert.equal(resolveJudgeConfigFile(explicitConfig, { configFile: capturedConfig }), explicitConfig)
  assert.match(resolveJudgeConfigFile("", {}), /eval\/config\.ts$/)
})

test("judge retries preserve prior raw evidence and update canonical aliases", t => {
  const directory = mkdtempSync(join(tmpdir(), "nibble-eval-judge-attempts-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, "judge.raw.jsonl"), "first raw\n")
  writeFileSync(join(directory, "judge.stderr.log"), "first stderr\n")
  writeFileSync(
    join(directory, "judge.json"),
    JSON.stringify({
      model: "opencode-go/deepseek-v4-flash",
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      endedAt: "2026-08-30T10:01:00.000Z",
      error: "invalid JSON",
      cache: { hit: false }
    })
  )

  const store = new JudgeAttemptStore(directory)
  const retry = store.start()
  assert.equal(retry.number, 2)
  assert.equal(readFileSync(join(directory, "judge-attempts", "attempt-1", "judge.raw.jsonl"), "utf8"), "first raw\n")
  assert.equal(
    readFileSync(join(directory, "judge-attempts", "attempt-1", "judge.stderr.log"), "utf8"),
    "first stderr\n"
  )

  writeFileSync(retry.files.raw, "second raw\n")
  writeFileSync(retry.files.stderr, "second stderr\n")
  const judgment = store.record(retry, {
    model: "opencode-go/deepseek-v4-flash",
    status: "completed",
    startedAt: "2026-08-30T10:02:00.000Z",
    endedAt: "2026-08-30T10:03:00.000Z",
    error: null
  })

  assert.equal(readFileSync(join(directory, "judge.raw.jsonl"), "utf8"), "second raw\n")
  assert.equal(judgment.attempt, 2)
  assert.deepEqual(
    judgment.attempts.map(attempt => [attempt.attempt, attempt.status]),
    [
      [1, "failed"],
      [2, "completed"]
    ]
  )

  const cacheDirectory = join(directory, "cache-entry")
  const cached = store.writeCache(cacheDirectory, judgment)
  assert.equal(cached.attempts[0].files.raw, join("judge-attempts", "attempt-1", "judge.raw.jsonl"))
  assert.equal(readFileSync(join(cacheDirectory, cached.attempts[0].files.raw), "utf8"), "first raw\n")

  const restoredDirectory = join(directory, "restored-job")
  const restoredStore = new JudgeAttemptStore(restoredDirectory)
  const restored = restoredStore.restoreCache(cacheDirectory, cached)
  assert.equal(readFileSync(restored.files.raw, "utf8"), "second raw\n")
  assert.equal(readFileSync(restored.attempts[0].files.raw, "utf8"), "first raw\n")
  assert.equal(restoredStore.start().number, 3)
})

test("run checkpoints are running and final snapshots receive endedAt", () => {
  const directory = mkdtempSync(join(tmpdir(), "nibble-eval-run-file-"))
  const runConfig = { startedAt: "2026-08-24T00:00:00.000Z", models: ["test-model"] }
  const args = { outDir: directory, runConfig, preservedJobs: [], results: [] }

  writeRunFile(args)
  const checkpoint = JSON.parse(readFileSync(join(directory, "run.json"), "utf8"))
  assert.equal(checkpoint.status, "running")
  assert.equal("endedAt" in checkpoint, false)
  assert.equal(typeof checkpoint.updatedAt, "string")

  writeRunFile({ ...args, complete: true })
  const final = JSON.parse(readFileSync(join(directory, "run.json"), "utf8"))
  assert.equal(final.status, "completed")
  assert.equal(final.endedAt, final.updatedAt)
})

test("completed capture reuse requires a valid result and every canonical artifact", () => {
  const directory = mkdtempSync(join(tmpdir(), "nibble-eval-artifacts-"))
  mkdirSync(join(directory, "artifacts"))
  for (const file of [
    "review.md",
    "review_transcript.md",
    "review_comments.json",
    "review_stats.json",
    "provider_completions.jsonl",
    "artifacts/pr.diff",
    "artifacts/review_model_context.json"
  ]) {
    writeFileSync(
      join(directory, file),
      file === "provider_completions.jsonl"
        ? '{"runId":"run-1","sessionId":"session-1","stopReason":"end_turn"}\n'
        : file.endsWith(".json")
          ? "{}"
          : "ok"
    )
  }
  writeFileSync(join(directory, "result.json"), JSON.stringify({ status: "completed" }))
  assert.equal(completedJobArtifacts(directory), true)

  writeFileSync(join(directory, "result.json"), "not json")
  assert.equal(completedJobArtifacts(directory), false)
})

test("canonical capture artifacts reject malformed required JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "nibble-eval-artifacts-json-"))
  mkdirSync(join(directory, "artifacts"))
  for (const file of [
    "review.md",
    "review_transcript.md",
    "review_comments.json",
    "review_stats.json",
    "provider_completions.jsonl",
    "artifacts/pr.diff",
    "artifacts/review_model_context.json"
  ]) {
    writeFileSync(
      join(directory, file),
      file === "provider_completions.jsonl"
        ? '{"runId":"run-1","sessionId":"session-1","stopReason":"end_turn"}\n'
        : file.endsWith(".json")
          ? "{}"
          : "ok"
    )
  }
  writeFileSync(join(directory, "result.json"), JSON.stringify({ status: "completed" }))
  writeFileSync(join(directory, "review_stats.json"), "malformed")
  assert.equal(completedJobArtifacts(directory), false)
})

test("canonical capture artifacts require provider completion evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "nibble-eval-provider-completions-"))
  mkdirSync(join(directory, "artifacts"))
  for (const file of [
    "review.md",
    "review_transcript.md",
    "review_comments.json",
    "review_stats.json",
    "provider_completions.jsonl",
    "artifacts/pr.diff",
    "artifacts/review_model_context.json"
  ]) {
    writeFileSync(join(directory, file), file.endsWith(".json") ? "{}" : "ok")
  }
  writeFileSync(join(directory, "result.json"), JSON.stringify({ status: "completed" }))

  assert.equal(completedJobArtifacts(directory), false)
})

test("bare eval model names use the OpenCode provider namespace", () => {
  assert.equal(normalizeEvalModel("deepseek-v4-flash"), "opencode-go/deepseek-v4-flash")
  assert.equal(normalizeEvalModel("deepseek-v4-flash", "model", "opencode-go"), "opencode-go/deepseek-v4-flash")
})

test("eval job identity includes the reviewer provider", () => {
  assert.match(
    evalJobKey({ runner: "aml", provider: "pi", model: "opencode-go/deepseek-v4-flash", input }),
    /^aml-pi__/
  )
  // Historical captures without a provider were OpenCode runs.
  assert.match(evalJobKey({ runner: "aml", model: "opencode-go/deepseek-v4-flash", input }), /^aml-opencode__/)
})

test("append reuse requires identical review-context semantics", () => {
  const captured = { runner: "aml", provider: "pi", model: "opencode-go/deepseek-v4-flash", input }

  assert.equal(sameCaptureJob(captured, structuredClone(captured)), true)
  assert.equal(sameCaptureJob(captured, { ...captured, input: { ...input, ignoreHistory: false } }), false)
  assert.equal(sameCaptureJob(captured, { ...captured, input: { ...input, notes: "focus on rollout" } }), false)
  assert.equal(sameCaptureJob(captured, { ...captured, input: { ...input, label: "migration" } }), false)
  assert.equal(sameCaptureJob(captured, { ...captured, input: { ...input, headSha: null } }), false)
  assert.equal(sameCaptureJob(captured, { ...captured, input: { ...input, headSha: "3".repeat(40) } }), false)
})

test("append reuse requires the same reviewer identity for completed jobs", () => {
  const requested = { reviewerId: "abc123@pi-1.1.0" }

  assert.throws(
    () => validateAppendReviewerIdentity({ jobs: [{ status: "completed" }] }, requested),
    /completed jobs and no reviewer identity/
  )
  assert.doesNotThrow(() => validateAppendReviewerIdentity({ jobs: [{ status: "failed" }] }, requested))
  assert.doesNotThrow(() => validateAppendReviewerIdentity(null, requested))
  assert.throws(
    () => validateAppendReviewerIdentity({ jobs: [{ status: "completed" }], reviewerId: "old@pi-1.0.0" }, requested),
    /reviewer changed from old@pi-1.0.0 to abc123@pi-1.1.0/
  )
  assert.doesNotThrow(() =>
    validateAppendReviewerIdentity({ jobs: [{ status: "completed" }], reviewerId: "abc123@pi-1.1.0" }, requested)
  )
})

test("eval captures run the production reviewer CLI with model credentials only", () => {
  const config = reviewerProcessConfig(
    { model: "opencode-go/deepseek-v4-flash" },
    {
      repoRoot: "/repo",
      environment: { OPENCODE_API_KEY: "key", ANTHROPIC_API_KEY: "", GH_TOKEN: "ghs", HOME: "/home/me" }
    }
  )
  assert.equal(config.command, process.execPath)
  assert.deepEqual(config.args, ["/repo/dist/cli/review.js"])
  assert.deepEqual(config.environment, { REVIEW_MODEL: "opencode-go/deepseek-v4-flash" })
  assert.deepEqual(config.inheritedEnvironment, ["OPENCODE_API_KEY"])
})

test("the pi judge is read-only, isolated, and receives only model credentials", () => {
  const judge = piJudgeCommand({
    repoRoot: "/repo",
    model: "opencode-go/deepseek-v4-flash",
    files: ["/job/review.md", "/job/pr.diff"],
    prompt: "Score this review.",
    home: "/scratch/home",
    environment: { PATH: "/bin", OPENCODE_API_KEY: "key", GH_TOKEN: "ghs" }
  })
  assert.equal(judge.args.at(-1), "Score this review.")
  assert.deepEqual(judge.args.slice(-3, -1), ["@/job/review.md", "@/job/pr.diff"])
  assert.equal(judge.args[judge.args.indexOf("--tools") + 1], "read,grep,find,ls")
  for (const flag of ["-p", "--no-session", "--no-extensions", "--no-context-files"]) {
    assert.ok(judge.args.includes(flag), flag)
  }
  assert.equal(judge.env.OPENCODE_API_KEY, "key")
  assert.equal(judge.env.GH_TOKEN, undefined)
  assert.equal(judge.env.HOME, "/scratch/home")
})

test("reviewer identity names the commit, pending reviewer changes, and pi version", () => {
  const identity = reviewerIdentity(join(import.meta.dirname, "..", ".."))
  assert.match(identity.commit, /^[0-9a-f]{40}$/u)
  assert.match(identity.piVersion, /^\d+\.\d+\.\d+/u)
  assert.equal(
    identity.id,
    `${identity.commit}${identity.dirtyHash ? `+${identity.dirtyHash}` : ""}@pi-${identity.piVersion}`
  )
})

test("review cache identity separates models and reviewer revisions", () => {
  const context = { baseSha: "base", headSha: "head" }
  const common = { input, context, diffText: "diff", reviewerId: "commit-a@pi-1.1.0" }
  const deepseek = reviewCacheKey({
    ...common,
    runner: "aml",
    provider: "pi",
    model: "opencode-go/deepseek-v4-flash"
  })
  const minimax = reviewCacheKey({
    ...common,
    runner: "aml",
    provider: "pi",
    model: "opencode-go/minimax-m3"
  })
  const rebuilt = reviewCacheKey({
    ...common,
    reviewerId: "commit-b@pi-1.1.0",
    runner: "aml",
    provider: "pi",
    model: "opencode-go/deepseek-v4-flash"
  })

  assert.notEqual(deepseek, minimax)
  assert.notEqual(deepseek, rebuilt)
})
