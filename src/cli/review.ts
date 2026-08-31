#!/usr/bin/env node
import { execFile } from "node:child_process"
import { appendFileSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs, promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { DEFAULT_REVIEW_CONCURRENCY, DEFAULT_REVIEW_MODEL } from "../config.js"
import { renderGitHubStepSummary } from "../lib/render/github-summary.js"
import { ReviewUnavailableError, runReview } from "../run-review.js"
import { createGitHubClient } from "../services/github/client.js"
import { DEFAULT_REVIEW_BOT_LOGIN, REVIEW_COMMAND, ReviewEvidence } from "../services/review-evidence.js"
import { ReviewPreflight } from "../services/review-preflight.js"

type CliOptions = {
  repository: string
  prNumber: number
  workspace: string
  model: string
  concurrency: number
  publish: boolean
}

const execFileAsync = promisify(execFile)

function usage(): string {
  return `usage: review_runner --repo <owner/repo> --pr <number> [options]

Runs the review in memory. GitHub mutations are recorded by default; pass
--publish explicitly to execute the exact validated publication plan.

Options:
  --workspace <path>          checked-out pull request workspace
  --model <model>             reviewer model (OpenCode default: opencode-go/deepseek-flash)
  --concurrency <number>      maximum parallel AML Agents (default: 6)
  --publish                   allow live GitHub mutations
`
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`${name} is required`)
  }
  return normalized
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function model(options: { configured?: string; env: NodeJS.ProcessEnv }): string {
  const modelEnv = options.env.REVIEW_MODEL || options.env.OPENCODE_MODEL
  const configured = options.configured || modelEnv
  if (configured) {
    return required(configured, "REVIEW_MODEL")
  }
  return DEFAULT_REVIEW_MODEL
}

function parseOptions(argv: string[], env: NodeJS.ProcessEnv): CliOptions | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      concurrency: { type: "string" },
      help: { type: "boolean", short: "h" },
      model: { type: "string" },
      pr: { type: "string" },
      publish: { type: "boolean" },
      repo: { type: "string" },
      workspace: { type: "string" }
    },
    strict: true
  })
  if (values.help) {
    return null
  }
  const repository = required(values.repo || env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY")
  if (!repository.includes("/")) {
    throw new Error("repository must use owner/name format")
  }
  const workspace = resolve(required(values.workspace || env.WORKSPACE || env.GITHUB_WORKSPACE, "WORKSPACE"))
  return {
    repository,
    prNumber: positiveInteger(values.pr || env.PR_NUMBER, "PR_NUMBER"),
    workspace,
    model: model({ configured: values.model, env }),
    concurrency: positiveInteger(
      values.concurrency || env.REVIEW_CONCURRENCY || String(DEFAULT_REVIEW_CONCURRENCY),
      "concurrency"
    ),
    // Live mutation requires an explicit CLI flag; ambient CI variables cannot
    // silently turn a benchmark or local invocation into a publishing run.
    publish: values.publish || false
  }
}

/** Reads the exact commit whose surrounding source the Agents will inspect. */
async function checkedOutHead(workspace: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" })
    const head = stdout.trim()
    if (/^[0-9a-f]{40}$/u.test(head)) {
      return head
    }
  } catch (cause) {
    throw new Error(`cannot read the checked-out commit in ${workspace}`, { cause })
  }
  throw new Error(`git returned an invalid checked-out commit in ${workspace}`)
}

/** Parses the executable edge and emits one complete in-memory result. */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const options = parseOptions(argv, env)
  if (!options) {
    process.stdout.write(usage())
    return
  }

  const token = required(env.GH_TOKEN || env.GITHUB_TOKEN, "GH_TOKEN")
  const github = createGitHubClient({ token, repository: options.repository })
  const trigger = ReviewEvidence.trigger({
    eventName: env.GITHUB_EVENT_NAME || null,
    eventPath: env.GITHUB_EVENT_PATH || null,
    actor: env.GITHUB_ACTOR || null
  })
  const triggerCommentId = env.TRIGGER_COMMENT_ID ? positiveInteger(env.TRIGGER_COMMENT_ID, "TRIGGER_COMMENT_ID") : null
  if (options.publish) {
    // The reusable workflow checks before checkout; direct --publish CLI runs
    // do not, so the mutation boundary repeats the same reusable policy.
    const guard = await new ReviewPreflight({
      github,
      repository: options.repository,
      prNumber: options.prNumber,
      command: env.REVIEW_COMMAND?.trim() || undefined
    }).evaluate(trigger.comment?.id || triggerCommentId)
    if (!guard.shouldReview) {
      process.stdout.write(`${JSON.stringify({ status: "skipped", reason: guard.reason })}\n`)
      return
    }
  }

  const result = await runReview({
    request: {
      repository: options.repository,
      prNumber: options.prNumber,
      workspace: options.workspace,
      workspaceHeadSha: await checkedOutHead(options.workspace),
      botLogin: env.REVIEW_BOT_LOGIN || DEFAULT_REVIEW_BOT_LOGIN,
      command: env.REVIEW_COMMAND || REVIEW_COMMAND,
      eventName: trigger.eventName,
      eventPath: env.GITHUB_EVENT_PATH || null,
      actor: trigger.actor,
      triggerCommentId,
      ignoreHistory: env.REVIEW_IGNORE_HISTORY === "true"
    },
    github,
    actionMode: options.publish ? "live" : "dry-run",
    model: options.model,
    reviewEmojis: env.REVIEW_EMOJIS !== "false",
    maximumConcurrency: options.concurrency,
    progress: line => process.stderr.write(`${line}\n`)
  })

  // The result stays in memory; only the Agent-readable evidence files are
  // materialized in the isolated review checkout.
  process.stdout.write(`${JSON.stringify(result)}\n`)

  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${renderGitHubStepSummary(result)}\n`)
  }

  if (result.publicationStatus === "failed") {
    throw new Error(`review completed but publication failed: ${result.publicationError}`)
  }
}

/** Reserves exit code 2 for failures that happened before a publishable review existed. */
export function reviewExitCode(error: unknown): number {
  return error instanceof ReviewUnavailableError ? 2 : 1
}

// Packaged commands enter through a symlink, so compare canonical paths.
const entrypoint = process.argv[1]
if (entrypoint && realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`review_runner: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = reviewExitCode(error)
  })
}
