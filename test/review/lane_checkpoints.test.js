import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { LaneCheckpoints, laneCheckpointScope } from "../../dist/lib/lane-checkpoints.js"
import { laneCheckpointOptions } from "../../dist/cli/review.js"
import { signedCheckpoint } from "../helpers/lane-checkpoints.js"

const secret = "provider-key"
const scope = { head: "2".repeat(40), base: "1".repeat(40), contract: "c".repeat(64) }
const finding = {
  kind: "inline",
  severity: "low",
  body: "Guard the empty case.",
  evidence: "The loop indexes element zero.",
  confidence: "high",
  path: "src/a.ts",
  line: 3,
  side: "RIGHT"
}

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nibble-lanes-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, "lanes")
}

test("a finished lane round-trips for its own head and base only", t => {
  const dir = directory(t)
  const lines = []
  const store = new LaneCheckpoints(dir, secret, line => lines.push(line))
  assert.equal(store.load("code-path-bug-hunter", scope), null)

  store.save("code-path-bug-hunter", scope, { summary: "Traced it.", findings: [finding] })
  assert.deepEqual(store.load("code-path-bug-hunter", scope), { summary: "Traced it.", findings: [finding] })
  assert.match(lines.at(-1), /code-path-bug-hunter: restored 1 finding/u)

  assert.equal(store.load("code-path-bug-hunter", { ...scope, head: "3".repeat(40) }), null)
  assert.equal(store.load("code-path-bug-hunter", { ...scope, base: "3".repeat(40) }), null)
  assert.equal(store.load("code-path-bug-hunter", { ...scope, contract: "d".repeat(64) }), null)
  assert.equal(store.load("intent-contract", scope), null)

  const mode = file => fs.statSync(file).mode & 0o777
  assert.equal(mode(dir), 0o700)
  assert.equal(mode(path.join(dir, "code-path-bug-hunter.json")), 0o600)
})

test("a blank summary is not stored: the queue owns the neutral handoff", t => {
  const store = new LaneCheckpoints(directory(t), secret)
  store.save("intent-contract", scope, { summary: "  ", findings: [] })
  assert.equal(store.load("intent-contract", scope), null)
})

test("malformed, unsigned, forged, foreign, or invalid checkpoints are misses", t => {
  const dir = directory(t)
  const lines = []
  const store = new LaneCheckpoints(dir, secret, line => lines.push(line))
  fs.mkdirSync(dir, { recursive: true })
  const write = (lane, text) => fs.writeFileSync(path.join(dir, `${lane}.json`), text)
  const file = { version: 1, ...scope, lane: "intent-contract", summary: "ok", findings: [] }

  write("intent-contract", "{not json")
  assert.equal(store.load("intent-contract", scope), null)
  assert.match(lines.at(-1), /ignored an unreadable or unsigned checkpoint/u)

  // Unsigned, signed with another key, or edited after signing: all planted, all ignored.
  write("intent-contract", JSON.stringify(file))
  assert.equal(store.load("intent-contract", scope), null)
  write("intent-contract", signedCheckpoint(file, "someone-else"))
  assert.equal(store.load("intent-contract", scope), null)
  const tampered = JSON.parse(signedCheckpoint(file, secret))
  tampered.checkpoint = tampered.checkpoint.replace('"ok"', '"no issues"')
  write("intent-contract", JSON.stringify(tampered))
  assert.equal(store.load("intent-contract", scope), null)

  write("intent-contract", signedCheckpoint({ ...file, extra: true }, secret))
  assert.equal(store.load("intent-contract", scope), null)
  write("intent-contract", signedCheckpoint({ ...file, version: 2 }, secret))
  assert.equal(store.load("intent-contract", scope), null)
  write("intent-contract", signedCheckpoint({ ...file, findings: [{ kind: "inline" }] }, secret))
  assert.equal(store.load("intent-contract", scope), null)
  // A file renamed onto another lane is not that lane's work.
  write("standards-architecture", signedCheckpoint(file, secret))
  assert.equal(store.load("standards-architecture", scope), null)

  write("intent-contract", signedCheckpoint(file, secret))
  assert.deepEqual(store.load("intent-contract", scope), { summary: "ok", findings: [] })

  // An invalid finding is never written in the first place.
  store.save("documentation-commentary", scope, { summary: "x", findings: [{ kind: "inline" }] })
  assert.equal(fs.existsSync(path.join(dir, "documentation-commentary.json")), false)
})

test("checkpoints need a signing secret", () => {
  assert.throws(() => new LaneCheckpoints("/tmp/unused", ""), /need a secret/u)
})

test("every lane counts as finished once it is saved or restored", t => {
  const dir = directory(t)
  const lines = []
  const store = new LaneCheckpoints(dir, secret, line => lines.push(line))
  const lanes = [
    "intent-contract",
    "standards-architecture",
    "code-path-bug-hunter",
    "correctness-risk-testing",
    "documentation-commentary"
  ]
  for (const lane of lanes) {
    store.save(lane, scope, { summary: "done", findings: [] })
  }
  assert.equal(store.allFinished(), false)
  // Files on disk alone do not count: a lane finishes in this process by running or being restored.
  assert.equal(new LaneCheckpoints(dir, secret).allFinished(), false)
  store.save("maintainability-elegance", scope, { summary: "done", findings: [] })
  assert.equal(store.allFinished(), true)
  store.note("lane checkpoint x: dropped a restored finding: gone")
  assert.equal(lines.at(-1), "↺ lane checkpoint x: dropped a restored finding: gone")
})

test("publishing clears every lane", t => {
  const dir = directory(t)
  const store = new LaneCheckpoints(dir, secret)
  // Nothing saved yet: clearing is a no-op, not an error.
  const lines = []
  new LaneCheckpoints(dir, secret, line => lines.push(line)).clear()
  assert.deepEqual(lines, [])

  store.save("intent-contract", scope, { summary: "a", findings: [] })
  store.save("code-path-bug-hunter", scope, { summary: "b", findings: [finding] })
  store.clear()
  assert.deepEqual(fs.readdirSync(dir), [])
  assert.equal(store.load("intent-contract", scope), null)

  store.save("intent-contract", scope, { summary: "again", findings: [] })
  assert.deepEqual(fs.readdirSync(dir), ["intent-contract.json"])
})

test("an unwritable directory only costs a re-run", t => {
  const root = directory(t)
  fs.mkdirSync(path.dirname(root), { recursive: true })
  const blocker = path.join(path.dirname(root), "file")
  fs.writeFileSync(blocker, "")
  const lines = []
  const store = new LaneCheckpoints(path.join(blocker, "lanes"), secret, line => lines.push(line))
  store.save("intent-contract", scope, { summary: "a", findings: [] })
  assert.match(lines.at(-1), /could not be saved/u)
  assert.equal(store.load("intent-contract", scope), null)
  store.clear()
  assert.match(lines.at(-1), /could not be cleared/u)
})

test("the scope needs both full commit SHAs and changes with the stated contract", () => {
  const issue = { kind: "issue", relation: "closes", repository: "o/r", number: 7, updatedAt: "2026-11-16T10:00:00Z" }
  const context = {
    headRefOid: scope.head,
    baseRefOid: scope.base,
    title: "Fix it",
    description: "Closes #7",
    issues: [issue],
    pullRequests: []
  }
  const base = laneCheckpointScope(context)
  assert.equal(base.head, scope.head)
  assert.equal(base.base, scope.base)
  assert.match(base.contract, /^[0-9a-f]{64}$/u)
  assert.deepEqual(laneCheckpointScope({ ...context }), base)
  for (const changed of [
    { title: "Fix it properly" },
    { description: "Closes #7 and more" },
    { issues: [{ ...issue, updatedAt: "2026-11-16T11:00:00Z" }] },
    { issues: [] }
  ]) {
    assert.notEqual(laneCheckpointScope({ ...context, ...changed }).contract, base.contract, JSON.stringify(changed))
  }
  assert.equal(laneCheckpointScope({ ...context, baseRefOid: null }), null)
  assert.equal(laneCheckpointScope({ ...context, headRefOid: "abc" }), null)
})

test("clearing leaves files the store did not write", t => {
  const dir = directory(t)
  const store = new LaneCheckpoints(dir, secret)
  store.save("intent-contract", scope, { summary: "a", findings: [] })
  fs.writeFileSync(path.join(dir, "intent-contract.json.123.tmp"), "partial")
  fs.writeFileSync(path.join(dir, "notes.txt"), "mine")
  store.clear()
  assert.deepEqual(fs.readdirSync(dir), ["notes.txt"])
})

test("the CLI turns checkpoints on only with a directory and the provider key", () => {
  assert.deepEqual(laneCheckpointOptions({}), {})
  assert.deepEqual(laneCheckpointOptions({ NIBBLE_REVIEW_LANE_CACHE: "/tmp/lanes" }), {})
  assert.deepEqual(laneCheckpointOptions({ NIBBLE_REVIEW_LANE_CACHE: " /tmp/lanes ", OPENCODE_API_KEY: "k" }), {
    laneCheckpointDirectory: "/tmp/lanes",
    laneCheckpointSecret: "k"
  })
  assert.deepEqual(
    laneCheckpointOptions({
      NIBBLE_REVIEW_LANE_CACHE: "/tmp/lanes",
      API_KEY_ENV: "ANTHROPIC_API_KEY",
      ANTHROPIC_API_KEY: "a"
    }),
    { laneCheckpointDirectory: "/tmp/lanes", laneCheckpointSecret: "a" }
  )
  assert.deepEqual(laneCheckpointOptions({ NIBBLE_REVIEW_LANE_CACHE: "", OPENCODE_API_KEY: "k" }), {})
})
