#!/usr/bin/env node
import { appendFileSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { createGitHubClient } from "../services/github/client.js"
import { ReviewPreflight } from "../services/review-preflight.js"

/** Parses REVIEW_ALLOW_SKIP; unset means skip directives are honored. */
export function parseAllowSkip(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() || "true"
  if (normalized !== "true" && normalized !== "false") {
    throw new Error("REVIEW_ALLOW_SKIP must be true or false")
  }
  return normalized === "true"
}

/** Runs the reusable workflow's credential and trigger preflight. */
export async function main(env = process.env): Promise<void> {
  const repository = env.GITHUB_REPOSITORY?.trim()
  const prNumber = Number(env.PR_NUMBER)
  const token = (env.GH_TOKEN || env.GITHUB_TOKEN)?.trim()
  const triggerCommentId = env.TRIGGER_COMMENT_ID ? Number(env.TRIGGER_COMMENT_ID) : null
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is required")
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("PR_NUMBER must be a positive integer")
  }
  if (!token) {
    throw new Error("GH_TOKEN is required")
  }
  if (triggerCommentId !== null && (!Number.isInteger(triggerCommentId) || triggerCommentId <= 0)) {
    throw new Error("TRIGGER_COMMENT_ID must be a positive integer")
  }

  const github = createGitHubClient({ token, repository })
  const result = await new ReviewPreflight({
    github,
    repository,
    prNumber,
    command: env.REVIEW_COMMAND?.trim() || undefined,
    allowSkip: parseAllowSkip(env.REVIEW_ALLOW_SKIP)
  }).evaluate(triggerCommentId)
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `should_review=${result.shouldReview}\nreason=${result.reason}\n`)
  }
  process.stderr.write(
    result.shouldReview
      ? "[nibble-review] review preflight allowed request\n"
      : `[nibble-review] review preflight skipped request: ${result.reason}\n`
  )
}

const entrypoint = process.argv[1]
if (entrypoint && realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`review_preflight: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
