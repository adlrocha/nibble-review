import { join } from "node:path"

/** Model credentials pi may read; mirrors the reviewer's own *_API_KEY forwarding rule. */
const CREDENTIAL_ENVIRONMENT = /^[A-Z][A-Z0-9_]*_API_KEY$/u

/**
 * Maps one eval job to the production reviewer CLI. The capture runs the same
 * dry-run boundary as the GitHub Action, without --publish.
 */
export function reviewerProcessConfig(job, { repoRoot, environment = process.env }) {
  return {
    command: process.execPath,
    args: [join(repoRoot, "dist", "cli", "review.js")],
    environment: {
      REVIEW_MODEL: job.model,
    },
    inheritedEnvironment: Object.keys(environment)
      .filter((key) => CREDENTIAL_ENVIRONMENT.test(key) && String(environment[key] || "").trim())
      .sort(),
  }
}
