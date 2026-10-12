#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { DEFAULT_REVIEW_MODEL } from "../config.js"
import { runFixAgent, type FixAgentRun } from "../fix/agent.js"
import { collectChanges, UnpublishableChangeError } from "../fix/changes.js"
import { gatherFixContext, hasWork, renderFixContext } from "../fix/context.js"
import { createFixGitHub, type FileChange } from "../fix/github.js"
import { publishFix } from "../fix/publish.js"
import type { FixContext, FixOutcome, FixResult } from "../fix/types.js"
import { modelApiHost } from "../sandbox/model-host.js"
import { createGitHubClient } from "../services/github/client.js"

/** Files exchanged between the fix action's steps, all inside one directory. */
export const FIX_FILES = {
  context: "context.json",
  prompt: "context.md",
  agent: "agent.json",
  verify: "verify.json"
} as const

type AgentRecord = { result: FixResult | null; error: string | null; model: string; usage: FixAgentRun["usage"] | null }
type VerifyRecord = { failed: string | null }

const USAGE = `usage: fix <command> [options]

Commands (each runs as its own trust step in fix/action.yml):
  context  --pr <n> --dir <path> [--attempt n --max-attempts n]   gather evidence (read token)
  agent    --dir <path> --workspace <path>                         run the fixer Agent (sandbox only)
  verify   --dir <path> --workspace <path>                         run verify commands (sandbox only)
  publish  --dir <path> --workspace <path> --pristine <path>       commit and reply (write token)
  egress-hosts                                                     print the sandbox allowlist for FIX_MODEL/FIX_FALLBACK_MODEL

Environment: GITHUB_REPOSITORY, GH_TOKEN (context, publish), FIX_MODEL, FIX_FALLBACK_MODEL,
FIX_THINKING_LEVEL (agent), FIX_VERIFY (newline-separated commands; agent, verify).
`

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function output(env: NodeJS.ProcessEnv, values: Record<string, string>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value.replace(/\r?\n/gu, " ")}`)
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`)
  }
  process.stdout.write(`${lines.join("\n")}\n`)
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error(`${name} is required`)
  }
  return trimmed
}

function positive(value: string | undefined, name: string, fallback?: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(parsed) || (parsed as number) < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed as number
}

/** Parses FIX_VERIFY: one shell command per non-empty line. */
export function verifyCommands(env: NodeJS.ProcessEnv): string[] {
  return (env.FIX_VERIFY || "")
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
}

async function contextCommand(values: Record<string, string | undefined>, env: NodeJS.ProcessEnv): Promise<void> {
  const repository = required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY")
  const token = required(env.GH_TOKEN || env.GITHUB_TOKEN, "GH_TOKEN")
  const prNumber = positive(values.pr, "--pr")
  const attempt = {
    number: positive(values.attempt, "--attempt", 1),
    max: positive(values["max-attempts"], "--max-attempts", 1)
  }
  const dir = resolve(required(values.dir, "--dir"))
  mkdirSync(dir, { recursive: true })
  const context = await gatherFixContext({
    github: createGitHubClient({ token, repository }),
    fixGitHub: createFixGitHub({ token, repository }),
    repository,
    prNumber
  })
  if (context.headRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(
      `pull request #${prNumber} comes from ${context.headRepository}; the fixer only pushes to same-repository branches`
    )
  }
  writeJson(join(dir, FIX_FILES.context), context)
  writeFileSync(join(dir, FIX_FILES.prompt), renderFixContext(context, attempt), { mode: 0o600 })
  output(env, {
    has_work: String(hasWork(context)),
    head_sha: context.headSha,
    head_ref: context.headRef,
    failing_checks: String(context.failingChecks.length),
    open_threads: String(context.threads.length)
  })
}

async function agentCommand(values: Record<string, string | undefined>, env: NodeJS.ProcessEnv): Promise<void> {
  const dir = resolve(required(values.dir, "--dir"))
  const workspace = resolve(required(values.workspace, "--workspace"))
  const context = readFileSync(join(dir, FIX_FILES.prompt), "utf8")
  const models = [env.FIX_MODEL || DEFAULT_REVIEW_MODEL, env.FIX_FALLBACK_MODEL]
    .map(model => model?.trim())
    .filter((model, index, all): model is string => Boolean(model) && all.indexOf(model) === index)
  let record: AgentRecord = { result: null, error: "no model configured", model: "", usage: null }
  for (const model of models) {
    try {
      const run = await runFixAgent({
        workspace,
        context,
        verifyCommands: verifyCommands(env),
        model,
        ...(env.FIX_THINKING_LEVEL ? { thinkingLevel: env.FIX_THINKING_LEVEL } : {})
      })
      record = { result: run.result, error: null, model, usage: run.usage }
      break
    } catch (error) {
      // A failed run may have half-edited files; the publish step only commits a `fixed` result.
      record = { result: null, error: error instanceof Error ? error.message : String(error), model, usage: null }
      process.stderr.write(`fix: ${model} failed: ${record.error}\n`)
    }
  }
  writeJson(join(dir, FIX_FILES.agent), record)
  output(env, { agent_status: record.result?.status || "failed", agent_model: record.model })
}

function verifyCommand(values: Record<string, string | undefined>, env: NodeJS.ProcessEnv): void {
  const dir = resolve(required(values.dir, "--dir"))
  const workspace = resolve(required(values.workspace, "--workspace"))
  let failed: string | null = null
  for (const command of verifyCommands(env)) {
    process.stderr.write(`fix: verify $ ${command}\n`)
    const result = spawnSync("bash", ["-lc", command], { cwd: workspace, stdio: "inherit" })
    if (result.status !== 0) {
      failed = command
      break
    }
  }
  writeJson(join(dir, FIX_FILES.verify), { failed } satisfies VerifyRecord)
  output(env, { verify_failed: failed || "" })
}

async function publishCommand(values: Record<string, string | undefined>, env: NodeJS.ProcessEnv): Promise<FixOutcome> {
  const repository = required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY")
  const token = required(env.GH_TOKEN || env.GITHUB_TOKEN, "GH_TOKEN")
  const dir = resolve(required(values.dir, "--dir"))
  const context = readJson<FixContext>(join(dir, FIX_FILES.context))
  let agent: AgentRecord
  try {
    agent = readJson<AgentRecord>(join(dir, FIX_FILES.agent))
  } catch {
    // The sandboxed step crashed or timed out before writing its record.
    agent = { result: null, error: "the fixer step did not complete", model: env.FIX_MODEL || "", usage: null }
  }
  let verify: VerifyRecord = { failed: null }
  try {
    verify = readJson<VerifyRecord>(join(dir, FIX_FILES.verify))
  } catch {
    // Verification only runs after a reported fix; a fix without a record was never verified.
    if (agent.result?.status === "fixed") {
      verify = { failed: "verification did not complete" }
    }
  }
  let changes: FileChange[] = []
  let changeError: string | undefined
  if (agent.result?.status === "fixed") {
    try {
      changes = collectChanges({
        pristine: resolve(required(values.pristine, "--pristine")),
        workspace: resolve(required(values.workspace, "--workspace"))
      })
    } catch (error) {
      if (!(error instanceof UnpublishableChangeError)) {
        throw error
      }
      changeError = error.message
    }
  }
  const outcome = await publishFix(
    {
      context,
      result: agent.result,
      ...(agent.error ? { agentError: agent.error } : {}),
      changes,
      ...(changeError ? { changeError } : {}),
      failedVerify: verify.failed
    },
    { github: createGitHubClient({ token, repository }), fixGitHub: createFixGitHub({ token, repository }) }
  )
  output(env, {
    result: outcome.status,
    reason: outcome.reason,
    commit_sha: outcome.commitSha || "",
    changed_files: String(changes.length)
  })
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `# Nibble Fix\n\n| | |\n| --- | --- |\n| Result | ${outcome.status} |\n| Reason | ${outcome.reason.replace(/\|/gu, "\\|")} |\n| Model | ${agent.model} |\n| Commit | ${outcome.commitSha || "none"} |\n| Changed files | ${changes.length} |\n| Threads replied / resolved | ${outcome.repliedThreads.length} / ${outcome.resolvedThreads.length} |\n| Estimated cost | ${agent.usage ? `$${agent.usage.costUsd.toFixed(4)}` : "n/a"} |\n`
    )
  }
  return outcome
}

/** Model API hosts the sandbox proxy must allow, from pi's catalog or an explicit override. */
export function egressHosts(env: NodeJS.ProcessEnv): string[] {
  const explicit = (env.FIX_EGRESS_ALLOW || "")
    .split(",")
    .map(host => host.trim().toLowerCase())
    .filter(Boolean)
  if (explicit.length > 0) {
    return [...new Set(explicit)]
  }
  const models = [env.FIX_MODEL || DEFAULT_REVIEW_MODEL, env.FIX_FALLBACK_MODEL].filter((model): model is string =>
    Boolean(model?.trim())
  )
  return [...new Set(models.map(model => modelApiHost(model.trim())))]
}

/** Dispatches one fix subcommand. */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const [command, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: {
      pr: { type: "string" },
      dir: { type: "string" },
      workspace: { type: "string" },
      pristine: { type: "string" },
      attempt: { type: "string" },
      "max-attempts": { type: "string" }
    },
    strict: true
  })
  if (command === "context") {
    await contextCommand(values, env)
  } else if (command === "agent") {
    await agentCommand(values, env)
  } else if (command === "verify") {
    verifyCommand(values, env)
  } else if (command === "publish") {
    await publishCommand(values, env)
  } else if (command === "egress-hosts") {
    output(env, { hosts: egressHosts(env).join(",") })
  } else {
    process.stdout.write(USAGE)
    if (command && command !== "--help" && command !== "-h") {
      process.exitCode = 1
    }
  }
}

const entrypoint = process.argv[1]
if (entrypoint && realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`fix: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
