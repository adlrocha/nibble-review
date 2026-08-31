import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { evalJobKey } from "../eval/lib/job-key.mjs"
import { JudgeAttemptStore } from "../eval/lib/judge-attempts.mjs"
import { normalizeEvalModel } from "../eval/lib/models.mjs"
import { reviewCacheKey } from "../eval/lib/review-cache-key.mjs"
import { reviewerContainerConfig } from "../eval/lib/reviewer-runner.mjs"
import {
  isOrphanedEvalContainer,
  runProcess,
  sameCaptureJob,
  validateAppendImageIdentity,
  writeRunFile
} from "../eval/run.mjs"
import { completedJobArtifacts } from "../eval/lib/job-artifacts.mjs"
import { resolveJudgeConfigFile } from "../eval/judge.mjs"

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

test("stale cleanup ignores fresh and unowned evaluator leases", () => {
  assert.equal(
    isOrphanedEvalContainer("", () => false),
    false
  )
  assert.equal(
    isOrphanedEvalContainer("owner-123", () => true),
    false
  )
  assert.equal(
    isOrphanedEvalContainer("owner-123", () => false),
    true
  )
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

test("eval job identity includes the OpenCode provider", () => {
  const key = evalJobKey({
    runner: "aml",
    provider: "opencode",
    model: "opencode/deepseek-v4-flash",
    input
  })

  assert.match(key, /^aml-opencode__/)
})

test("append reuse requires identical review-context semantics", () => {
  const captured = { runner: "aml", provider: "opencode", model: "opencode-go/deepseek-v4-flash", input }

  assert.equal(sameCaptureJob(captured, structuredClone(captured)), true)
  assert.equal(sameCaptureJob(captured, { ...captured, input: { ...input, ignoreHistory: false } }), false)
  assert.equal(sameCaptureJob(captured, { ...captured, input: { ...input, notes: "focus on rollout" } }), false)
  assert.equal(sameCaptureJob(captured, { ...captured, input: { ...input, label: "migration" } }), false)
  assert.equal(sameCaptureJob(captured, { ...captured, input: { ...input, headSha: null } }), false)
  assert.equal(sameCaptureJob(captured, { ...captured, input: { ...input, headSha: "3".repeat(40) } }), false)
})

test("append reuse requires immutable image identity for completed legacy jobs", () => {
  const requested = {
    image: "reviewer:local",
    imageId: "sha256:reviewer",
    baseImage: "sandbox:local",
    baseImageId: "sha256:sandbox"
  }

  assert.throws(
    () => validateAppendImageIdentity({ jobs: [{ status: "completed" }] }, requested),
    /legacy run with completed jobs and no immutable image IDs/
  )
  assert.doesNotThrow(() => validateAppendImageIdentity({ jobs: [{ status: "failed" }] }, requested))
  assert.throws(
    () =>
      validateAppendImageIdentity(
        { jobs: [{ status: "completed" }], imageId: "sha256:old", baseImageId: "sha256:sandbox" },
        requested
      ),
    /reviewer:local changed from sha256:old to sha256:reviewer/
  )
  assert.doesNotThrow(() =>
    validateAppendImageIdentity(
      { jobs: [{ status: "completed" }], imageId: "sha256:reviewer", baseImageId: "sha256:sandbox" },
      requested
    )
  )
})

test("eval reviewer selection maps OpenCode to the production executable", () => {
  assert.deepEqual(reviewerContainerConfig({ model: "opencode-go/deepseek-v4-flash" }), {
    command: "/usr/local/bin/review_runner",
    environment: {
      REVIEW_MODEL: "opencode-go/deepseek-v4-flash"
    },
    inheritedEnvironment: [
      "ANTHROPIC_API_KEY",
      "CONTEXT7_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "OPENCODE_API_KEY",
      "OPENROUTER_API_KEY",
      "Z_AI_API_KEY"
    ],
    requiredEnvironment: [],
    usesOpenCodeAuth: true
  })
})

test("review cache identity separates OpenCode models and reviewer images", () => {
  const context = { baseSha: "base", headSha: "head" }
  const common = { input, context, diffText: "diff", reviewerImageId: "sha256:image-a" }
  const deepseek = reviewCacheKey({
    ...common,
    runner: "aml",
    provider: "opencode",
    model: "opencode-go/deepseek-v4-flash"
  })
  const minimax = reviewCacheKey({
    ...common,
    runner: "aml",
    provider: "opencode",
    model: "opencode-go/minimax-m3"
  })
  const rebuilt = reviewCacheKey({
    ...common,
    reviewerImageId: "sha256:image-b",
    runner: "aml",
    provider: "opencode",
    model: "opencode-go/deepseek-v4-flash"
  })

  assert.notEqual(deepseek, minimax)
  assert.notEqual(deepseek, rebuilt)
})
