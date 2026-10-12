import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const root = path.resolve(import.meta.dirname, "..")
const fallbackScript = path.join(root, "bin", "review-with-fallback.sh")
const action = fs.readFileSync(path.join(root, "action.yml"), "utf8")

/** Runs the fallback script against a fake runner that exits with the given codes in order. */
function runFallback(t, exitCodes, env = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nibble-fallback-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const log = path.join(directory, "calls.log")
  const runner = path.join(directory, "runner.sh")
  fs.writeFileSync(
    runner,
    `#!/usr/bin/env bash
codes=(${exitCodes.join(" ")})
count=$(wc -l < "${log}" 2>/dev/null || echo 0)
echo "$REVIEW_MODEL $*" >> "${log}"
exit "\${codes[$count]}"
`
  )
  fs.chmodSync(runner, 0o755)
  const result = spawnSync("bash", [fallbackScript], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      NIBBLE_REVIEW_RUNNER: runner,
      REVIEW_MODEL: "primary/model",
      REVIEW_FALLBACK_MODEL: "fallback/model",
      TIMEOUT_MINUTES: "1",
      ...env
    }
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []
  return { status: result.status, calls, stdout: result.stdout }
}

test("a successful primary review does not retry", t => {
  const { status, calls } = runFallback(t, [0])
  assert.equal(status, 0)
  assert.deepEqual(calls, ["primary/model --publish"])
})

test("a pre-publication failure retries once with the fallback model", t => {
  const { status, calls, stdout } = runFallback(t, [2, 0])
  assert.equal(status, 0)
  assert.deepEqual(calls, ["primary/model --publish", "fallback/model --publish"])
  assert.match(stdout, /::warning title=Nibble Review::primary\/model failed before publication/u)
})

test("other failures never retry, because something may already be published", t => {
  const { status, calls } = runFallback(t, [1, 0])
  assert.equal(status, 1)
  assert.deepEqual(calls, ["primary/model --publish"])
})

test("the fallback result is final", t => {
  const { status, calls } = runFallback(t, [2, 2])
  assert.equal(status, 2)
  assert.equal(calls.length, 2)
})

test("no retry when the fallback model is empty or identical", t => {
  for (const fallback of ["", "primary/model"]) {
    const { status, calls, stdout } = runFallback(t, [2, 0], { REVIEW_FALLBACK_MODEL: fallback })
    assert.equal(status, 2)
    assert.equal(calls.length, 1)
    assert.match(stdout, /no distinct fallback model is configured/u)
  }
})

test("the action only accepts *_API_KEY names so a key can never overwrite a GitHub token", () => {
  assert.match(action, /\^\[A-Z\]\[A-Z0-9_\]\*_API_KEY\$/u)
})

test("the action checks out the pull request without persisting credentials, after preflight", () => {
  assert.match(action, /persist-credentials: false/u)
  assert.ok(action.indexOf("id: preflight") < action.indexOf("name: Check out pull request"))
  assert.match(action, /ref: refs\/pull\/\$\{\{ inputs\.pr-number \}\}\/head/u)
})

test("the action posts as github-actions[bot] unless an App token is configured", () => {
  assert.match(action, /default: \$\{\{ github\.token \}\}/u)
  assert.match(
    action,
    /REVIEW_BOT_LOGIN: \$\{\{ steps\.app-token\.outputs\.app-slug && format\('\{0\}\[bot\]', steps\.app-token\.outputs\.app-slug\) \|\| 'github-actions\[bot\]' \}\}/u
  )
})

const fixAction = fs.readFileSync(path.join(root, "fix", "action.yml"), "utf8")

/** Splits a composite action into its steps, keyed by step name. */
function steps(yaml) {
  return Object.fromEntries(
    yaml
      .split(/\n    - name: /u)
      .slice(1)
      .map(block => [block.split("\n")[0].trim(), block])
  )
}

test("the fix action exposes the model key only to the sandboxed Agent step", () => {
  const byName = steps(fixAction)
  const withKey = Object.entries(byName)
    .filter(([, block]) => block.includes("inputs.api-key }}"))
    .map(([name]) => name)
  assert.deepEqual(withKey, ["Validate inputs", "Fix in sandbox"])
  assert.match(byName["Fix in sandbox"], /fix-sandbox\.sh" run/u)
})

test("the fix action keeps GitHub tokens away from every step that runs repository code", () => {
  const byName = steps(fixAction)
  for (const name of ["Install repository dependencies", "Fix in sandbox", "Verify in sandbox"]) {
    assert.doesNotMatch(byName[name], /GH_TOKEN|github-token|app-token/u, name)
  }
  assert.match(byName["Check out pull request"], /persist-credentials: false/u)
})

test("the fix action mints the App token after the sandbox stops and only publishes with it", () => {
  const order = Object.keys(steps(fixAction))
  const index = name => order.indexOf(name)
  assert.ok(index("Keep a pristine copy before any repository code runs") < index("Install repository dependencies"))
  assert.ok(index("Start sandbox") < index("Install repository dependencies"))
  assert.ok(index("Stop sandbox") < index("Create GitHub App token"))
  assert.ok(index("Create GitHub App token") < index("Publish fix"))
  assert.equal(order.at(-1), "Publish fix")
  const tokenUsers = Object.entries(steps(fixAction))
    .filter(([, block]) => block.includes("steps.app-token.outputs.token"))
    .map(([name]) => name)
  assert.deepEqual(tokenUsers, ["Publish fix"])
})

test("neither action asks setup-node to cache files outside the caller's workspace", () => {
  // setup-node only resolves cache-dependency-path inside GITHUB_WORKSPACE; the action's
  // own lockfile lives in the action path, so caching it fails the job before review.
  for (const yaml of [action, fixAction]) {
    assert.doesNotMatch(yaml, /cache-dependency-path/u)
  }
})
