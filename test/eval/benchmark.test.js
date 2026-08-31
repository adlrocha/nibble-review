import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const benchmark = path.join(repoRoot, "eval", "benchmark.mjs")

function writeSummary(root, name, score, runner = "aml", provider = "opencode", options = {}) {
  const runDir = path.join(root, name)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify({
      generatedAt: options.generatedAt || "2026-08-02T00:00:00.000Z",
      run: {
        runner,
        provider,
        ...(!options.omitRunStatus ? { status: options.runStatus || "completed" } : {}),
        endedAt: "2026-08-02T00:01:00.000Z",
        inputs: [{ ref: "owner/repo#1" }],
        models: ["opencode-go/example:variant"]
      },
      results: [
        {
          pr: "owner/repo#1",
          runner,
          provider,
          model: "opencode-go/example:variant",
          status: options.resultStatus || "passed",
          captureStatus: options.captureStatus || "completed",
          scorePercent: score,
          captureDurationMs: 65_000,
          durationMs: 60_000,
          producedComments: 1,
          usage: {
            totalTokens: 100,
            inputTokens: 10,
            outputTokens: 20,
            reasoningTokens: 30,
            cacheReadTokens: 40,
            cacheWriteTokens: 0,
            costUsd: 0.01
          },
          questions: []
        }
      ]
    })
  )
}

test("benchmark --avg keeps repeated captures and groups them by exact model variant", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nibble-benchmark-"))
  try {
    writeSummary(root, "wave-a", 70)
    writeSummary(root, "wave-b", 90)
    const json = path.join(root, "benchmark.json")
    const html = path.join(root, "benchmark.html")

    execFileSync(process.execPath, [benchmark, "--runs", root, "--avg", "--json", json, "--out", html], {
      cwd: repoRoot
    })

    const summary = JSON.parse(fs.readFileSync(json, "utf8"))
    assert.equal(summary.models.length, 1)
    assert.equal(summary.models[0].model, "opencode-go/example:variant")
    assert.equal(summary.models[0].runs, 2)
    assert.equal(summary.models[0].averageScore, 80)
    assert.equal(summary.models[0].avgCaptureDurationMs, 65_000)
    assert.equal(summary.models[0].avgReviewerDurationMs, 60_000)
    assert.equal(summary.models[0].implementations, "aml")
    assert.equal(summary.models[0].providers, "opencode")
    assert.equal(summary.filters.average, true)
    const rendered = fs.readFileSync(html, "utf8")
    assert.match(rendered, /Implementation/u)
    assert.match(rendered, /Provider/u)
    assert.doesNotMatch(rendered, /PR x Model Matrix/u)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("benchmark keeps src and AML evidence for the same PR and model", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nibble-benchmark-runners-"))
  try {
    writeSummary(root, "aml", 90, "aml", "opencode")
    writeSummary(root, "src", 80, "src", "opencode")
    const json = path.join(root, "benchmark.json")
    const html = path.join(root, "benchmark.html")

    execFileSync(process.execPath, [benchmark, "--runs", root, "--json", json, "--out", html], {
      cwd: repoRoot
    })

    const summary = JSON.parse(fs.readFileSync(json, "utf8"))
    assert.equal(summary.results.length, 2)
    assert.deepEqual(summary.results.map(result => result.implementation).sort(), ["aml", "src"])
    assert.equal(summary.models[0].runs, 2)
    assert.equal(summary.models[0].averageScore, 85)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("benchmark excludes partial runs and keeps older judged evidence over a newer failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nibble-benchmark-status-"))
  try {
    writeSummary(root, "passed", 88, "aml", "opencode", {
      generatedAt: "2026-08-02T00:00:01.000Z"
    })
    writeSummary(root, "newer-failure", null, "aml", "opencode", {
      generatedAt: "2026-08-02T00:00:03.000Z",
      resultStatus: "hard failed",
      captureStatus: "failed"
    })
    writeSummary(root, "partial", 99, "aml", "opencode", {
      generatedAt: "2026-08-02T00:00:04.000Z",
      runStatus: "running"
    })
    const json = path.join(root, "benchmark.json")
    const html = path.join(root, "benchmark.html")

    execFileSync(process.execPath, [benchmark, "--runs", root, "--json", json, "--out", html], {
      cwd: repoRoot
    })

    const summary = JSON.parse(fs.readFileSync(json, "utf8"))
    assert.equal(summary.results.length, 1)
    assert.equal(summary.results[0].scorePercent, 88)
    assert.equal(summary.ignoredResults.length, 2)
    assert.ok(summary.ignoredResults.some(result => /only completed runs are benchmarkable/u.test(result.error || "")))
    assert.ok(summary.ignoredResults.some(result => result.status === "hard failed"))
    const rendered = fs.readFileSync(html, "utf8")
    assert.match(rendered, /prefer completed judged evidence/u)
    assert.match(rendered, /Excluded evidence \(2\)/u)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("benchmark accepts a complete legacy summary without an explicit run status", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nibble-benchmark-legacy-"))
  try {
    writeSummary(root, "legacy", 82, "src", "opencode", { omitRunStatus: true })
    const json = path.join(root, "benchmark.json")
    const html = path.join(root, "benchmark.html")

    execFileSync(process.execPath, [benchmark, "--runs", root, "--json", json, "--out", html], {
      cwd: repoRoot
    })

    const summary = JSON.parse(fs.readFileSync(json, "utf8"))
    assert.equal(summary.results.length, 1)
    assert.equal(summary.results[0].scorePercent, 82)
    assert.deepEqual(summary.ignoredResults, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
