import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { PI_ISOLATION_FLAGS, isolatedArgs, isolatedEnv } from "../../dist/cli/pi-isolated.js"
import { PI_FORWARD_ENV, PI_SESSION_DIR_ENV } from "../../dist/lib/pi-env.js"
import { readPiUsage, withPiUsage } from "../../dist/lib/pi-usage.js"
import {
  PROJECT_PI_DIRECTORY,
  QUARANTINED_PI_DIRECTORY,
  quarantineProjectPiConfig
} from "../../dist/lib/project-pi-config.js"
import { createReviewProvider, credentialEnvNames, resolvePackageFile } from "../../dist/lib/review-provider.js"

function tempDir() {
  return mkdtempSync(join(tmpdir(), "nibble-review-test-"))
}

const emptyUsage = {
  agentCalls: 3,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  totalTokens: null,
  costUsd: null,
  estimatedCostUsd: null
}

test("credential forwarding selects provider keys and never GitHub or Actions tokens", () => {
  const names = credentialEnvNames({
    OPENCODE_API_KEY: "o",
    ANTHROPIC_API_KEY: "a",
    AWS_SECRET_ACCESS_KEY: "s",
    EMPTY_API_KEY: "",
    GH_TOKEN: "g",
    GITHUB_TOKEN: "g",
    ACTIONS_RUNTIME_TOKEN: "r",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "i",
    lower_api_key: "x"
  })
  assert.deepEqual(names, ["ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "OPENCODE_API_KEY"])
})

test("isolated pi env keeps the allowlist plus forwarded credentials only", () => {
  const env = isolatedEnv({
    PATH: "/bin",
    HOME: "/state",
    PI_CODING_AGENT_DIR: "/state/agent",
    OPENCODE_API_KEY: "secret",
    [PI_FORWARD_ENV]: "OPENCODE_API_KEY, MISSING_API_KEY",
    GH_TOKEN: "ghs_x",
    GITHUB_TOKEN: "ghs_y",
    ACTIONS_RUNTIME_TOKEN: "runtime",
    UNRELATED: "value"
  })
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/state",
    PI_CODING_AGENT_DIR: "/state/agent",
    OPENCODE_API_KEY: "secret"
  })
})

test("isolated pi env redirects sessions only when the runner asks", () => {
  assert.equal(isolatedEnv({ PI_CODING_AGENT_SESSION_DIR: "/aml" }).PI_CODING_AGENT_SESSION_DIR, "/aml")
  assert.equal(
    isolatedEnv({ PI_CODING_AGENT_SESSION_DIR: "/aml", [PI_SESSION_DIR_ENV]: "/runner" }).PI_CODING_AGENT_SESSION_DIR,
    "/runner"
  )
})

test("isolated pi args disable every project resource before AML's own flags", () => {
  assert.deepEqual(isolatedArgs("/pi/cli.js", ["--tools", "read", "--mode", "rpc"]), [
    "/pi/cli.js",
    ...PI_ISOLATION_FLAGS,
    "--tools",
    "read",
    "--mode",
    "rpc"
  ])
  assert.ok(PI_ISOLATION_FLAGS.includes("--no-extensions"))
  assert.ok(PI_ISOLATION_FLAGS.includes("--no-context-files"))
})

test("project .pi directory is hidden during a review and restored once", () => {
  const workspace = tempDir()
  mkdirSync(join(workspace, PROJECT_PI_DIRECTORY))
  writeFileSync(join(workspace, PROJECT_PI_DIRECTORY, "settings.json"), '{"packages":["evil"]}')

  const restore = quarantineProjectPiConfig(workspace)
  assert.equal(existsSync(join(workspace, PROJECT_PI_DIRECTORY)), false)
  assert.equal(existsSync(join(workspace, QUARANTINED_PI_DIRECTORY, "settings.json")), true)

  restore()
  restore()
  assert.equal(readFileSync(join(workspace, PROJECT_PI_DIRECTORY, "settings.json"), "utf8"), '{"packages":["evil"]}')
  assert.equal(existsSync(join(workspace, QUARANTINED_PI_DIRECTORY)), false)
})

test("project .pi quarantine is a no-op without a .pi directory", () => {
  const workspace = tempDir()
  quarantineProjectPiConfig(workspace)()
  assert.equal(existsSync(join(workspace, PROJECT_PI_DIRECTORY)), false)
})

test("project .pi quarantine refuses to overwrite a leftover quarantine", () => {
  const workspace = tempDir()
  mkdirSync(join(workspace, QUARANTINED_PI_DIRECTORY))
  assert.throws(() => quarantineProjectPiConfig(workspace), /did not restore it/u)
})

test("pi usage sums assistant messages across nested session files", () => {
  const sessions = tempDir()
  mkdirSync(join(sessions, "nested"))
  const assistant = (input, output, cost, extra = {}) =>
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        usage: {
          input,
          output,
          cacheRead: 10,
          cacheWrite: 1,
          totalTokens: input + output + 11,
          cost: { total: cost },
          ...extra
        }
      }
    })
  writeFileSync(
    join(sessions, "a.jsonl"),
    [
      JSON.stringify({ type: "session" }),
      assistant(100, 20, 0.5, { reasoning: 5 }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
      '{"type":"message","message":{"role":"assistant"'
    ].join("\n")
  )
  writeFileSync(join(sessions, "nested", "b.jsonl"), `${assistant(50, 10, 0.25)}\n`)
  writeFileSync(join(sessions, "ignored.json"), assistant(999, 999, 9))

  assert.deepEqual(readPiUsage(sessions), {
    messages: 2,
    inputTokens: 150,
    outputTokens: 30,
    reasoningTokens: 5,
    cacheReadTokens: 20,
    cacheWriteTokens: 2,
    totalTokens: 202,
    costUsd: 0.75
  })
})

test("pi usage treats a missing session directory as no usage", () => {
  assert.equal(readPiUsage(join(tempDir(), "missing")).messages, 0)
})

test("pi usage fills review usage only when pi recorded messages", () => {
  assert.equal(withPiUsage(emptyUsage, readPiUsage(join(tempDir(), "missing"))), emptyUsage)
  const merged = withPiUsage(emptyUsage, {
    messages: 1,
    inputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 0,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 10,
    costUsd: 0.01
  })
  assert.equal(merged.agentCalls, 3)
  assert.equal(merged.totalTokens, 10)
  assert.equal(merged.estimatedCostUsd, 0.01)
  assert.equal(merged.costUsd, null)
})

test("package files resolve from the installed tree and fail with guidance otherwise", () => {
  assert.match(resolvePackageFile("pi-acp", "package.json"), /node_modules\/pi-acp\/package\.json$/u)
  assert.throws(() => resolvePackageFile("definitely-not-installed", "x.js"), /reinstall nibble-review dependencies/u)
})

test("review provider launches pi-acp through node with the isolated pi launcher", () => {
  const provider = createReviewProvider({ model: "opencode-go/deepseek-v4-flash", workspace: tempDir() }, {})
  assert.equal(provider.name, "pi")
})
