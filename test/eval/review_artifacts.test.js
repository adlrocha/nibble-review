import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { writeReviewArtifacts } from "../../eval/lib/review-artifacts.mjs"

function result() {
  return {
    status: "reviewed",
    gate: { decision: "review", reason: "manual review", source: "bypass" },
    lanes: [
      {
        lane: "intent-contract",
        summary: "The changed request path loses the caller contract."
      }
    ],
    audit: {
      findings: []
    },
    validated: {
      inlineComments: [{ kind: "comment", path: "src/request.ts", line: 8, side: "RIGHT", body: "Fix this." }],
      replies: [{ kind: "reply", to: 123, body: "This still applies." }],
      dropped: [{ reason: "duplicate" }],
      conclusion: "REQUEST_CHANGES",
      stats: { valid_inline: 1, valid_replies: 1, dropped: 1 }
    },
    body: "Summary\n\n⚠️ Request changes: preserve the response contract.",
    payload: { body: "Summary", event: "COMMENT", comments: [] },
    generatedAt: "2026-08-23T00:00:00.000Z",
    provider: "opencode",
    model: "test-model",
    repository: "owner/repo",
    prNumber: 42,
    durationMs: 1234,
    attempts: [],
    usage: {
      agentCalls: 8,
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 0,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      totalTokens: 200,
      costUsd: 0.01
    },
    traceSummaries: [
      {
        runId: "review-run"
      }
    ],
    providerCompletions: [
      {
        runId: "review-run",
        sessionId: "session-1",
        stopReason: "end_turn"
      }
    ],
    publication: [],
    publicationStatus: "completed",
    publicationError: null
  }
}

test("eval adapter writes canonical artifacts from one in-memory result", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "aml-artifacts-"))
  const exported = writeReviewArtifacts(result(), outputDir, "2026-08-23T00:00:00.000Z")

  assert.deepEqual(Object.keys(exported.paths).sort(), [
    "comments",
    "providerCompletions",
    "review",
    "stats",
    "transcript"
  ])
  assert.equal(fs.readFileSync(exported.paths.review, "utf8").includes("Request changes"), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(exported.paths.comments, "utf8")).replies, [
    { kind: "reply", to: 123, body: "This still applies." }
  ])
  const stats = JSON.parse(fs.readFileSync(exported.paths.stats, "utf8"))
  assert.equal(stats.totals.durationMs, 1234)
  assert.equal(stats.totals.cacheReadTokens, 80)
  assert.equal(Object.hasOwn(stats.phases[0], "durationMs"), false)
  assert.equal(stats.phases[1].status, "completed")
  assert.equal(stats.phases.find(phase => phase.name === "audit").findings, 0)
  assert.equal(stats.phases.find(phase => phase.name === "publication").operations, 0)
  assert.deepEqual(
    stats.traceSummaries.map(summary => summary.runId),
    ["review-run"]
  )
  assert.deepEqual(stats.providerCompletions, result().providerCompletions)
  assert.deepEqual(fs.readFileSync(exported.paths.providerCompletions, "utf8").trim().split("\n").map(JSON.parse), [
    {
      runId: "review-run",
      sessionId: "session-1",
      stopReason: "end_turn",
      provider: "opencode",
      model: "test-model"
    }
  ])
  assert.match(fs.readFileSync(exported.paths.transcript, "utf8"), /Specialist Output/u)
  assert.equal(
    fs.readdirSync(outputDir).some(file => file.includes(".tmp-")),
    false
  )
})

test("eval adapter replaces stale canonical artifacts", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "aml-artifacts-"))
  const first = writeReviewArtifacts(result(), outputDir, "2026-08-23T00:00:00.000Z")
  const secondResult = { ...result(), body: "✅ LGTM", payload: { ...result().payload, body: "✅ LGTM" } }
  writeReviewArtifacts(secondResult, outputDir, "2026-08-23T00:01:00.000Z")

  assert.notEqual(fs.readFileSync(first.paths.review, "utf8").includes("Request changes"), true)
  assert.match(fs.readFileSync(first.paths.review, "utf8"), /LGTM/u)
  assert.deepEqual(
    fs.readdirSync(outputDir).filter(file => file.includes(".tmp-")),
    []
  )
})
