#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"

import {
  evaluateLand,
  LAND_CONFIG_PATH,
  LAND_STATUS_CONTEXT,
  parseSdlcConfig,
  parseVerdictMarker,
  parseWhereToLook,
  renderRiskComment,
  RISK_COMMENT_MARKER,
  statusDescription,
  type WhereToLook
} from "../lib/land.js"
import { reviewAuthorship, type ReviewAuthorship } from "../lib/review-authorship.js"
import {
  createGitHubClient,
  type GitHubClient,
  type IssueComment,
  type PullRequestReview
} from "../services/github/client.js"
import { DEFAULT_REVIEW_BOT_LOGIN } from "../services/review-evidence.js"
import { ReviewPreflight } from "../services/review-preflight.js"

/** Keeps this reviewer's top-level bodies, oldest first, from a pull request's comments and reviews. */
function ownBodies(authorship: ReviewAuthorship, comments: IssueComment[], reviews: PullRequestReview[]): string[] {
  const dated = [
    ...comments.filter(item => authorship.isOwn(item)).map(item => ({ at: item.created_at, body: item.body })),
    ...reviews
      .filter(item => authorship.isOwn(item))
      .map(item => ({ at: item.submitted_at ?? item.submittedAt, body: item.body }))
  ]
  return dated
    .sort((left, right) => String(left.at ?? "").localeCompare(String(right.at ?? "")))
    .map(item => String(item.body ?? ""))
}

/** Finds the newest "where to look" list, remembering which commit it was written for. */
function latestWhereToLook(bodies: string[]): WhereToLook | null {
  for (const body of bodies.toReversed()) {
    const list = parseWhereToLook(body)
    if (list) {
      return { list, sha: parseVerdictMarker(body)?.sha ?? null }
    }
  }
  return null
}

/**
 * Judges the current head and reports it. Never merges and never blocks.
 *
 * Without `publish` it writes nothing, matching the review CLI. Both writes
 * are safe to repeat: the comment is replaced and the status is per commit.
 */
export async function runLand(
  github: GitHubClient,
  prNumber: number,
  botLogin: string,
  publish: boolean
): Promise<string> {
  const defaultBranch = await github.getDefaultBranch()
  // The default branch, never the PR head, so a pull request cannot relax its own rules.
  const config = parseSdlcConfig(await github.getRepositoryFile(LAND_CONFIG_PATH, defaultBranch))
  if (config.land.mode === "off") {
    return "land is off"
  }

  const pullRequest = await github.getPullRequest(prNumber)
  const headSha = pullRequest.headRefOid || pullRequest.head?.sha
  if (!headSha) {
    throw new Error(`pull request #${prNumber} has no head commit`)
  }

  const [comments, reviews, files, threads] = await Promise.all([
    github.listPullRequestComments(prNumber),
    github.listReviews(prNumber),
    github.listPullRequestFiles(prNumber),
    github.listReviewThreads(prNumber)
  ])
  if (!threads.available) {
    throw new Error("review threads are unavailable, so no decision was made")
  }

  const authorship = reviewAuthorship(botLogin)
  // The risk comment is land's own output, so it never counts as review evidence.
  const bodies = ownBodies(authorship, comments, reviews).filter(body => !body.startsWith(RISK_COMMENT_MARKER))
  const decision = evaluateLand({
    headSha,
    authorIsBot: pullRequest.user?.type === "Bot",
    records: bodies.map(parseVerdictMarker).filter(record => record !== null),
    files,
    threads: threads.threads
      .filter(thread => authorship.isOwn(thread.comments[0]))
      .map(thread => ({
        is_resolved: thread.is_resolved,
        is_outdated: thread.is_outdated,
        path: thread.path,
        firstBody: thread.comments[0]?.body ?? ""
      })),
    config
  })

  const whereToLook = latestWhereToLook(bodies)
  const body = renderRiskComment({ headSha, decision, config, whereToLook })
  if (!publish) {
    return `dry run: ${statusDescription(decision)}\n${body}`
  }
  const existing = comments.filter(
    comment => authorship.isOwn(comment) && String(comment.body ?? "").startsWith(RISK_COMMENT_MARKER)
  )
  // Two racing runs can each create a comment, so every copy is refreshed.
  for (const comment of existing) {
    await github.updateIssueComment(comment.id, body)
  }
  if (existing.length === 0) {
    await github.createPullRequestComment(prNumber, body)
  }
  // Shadow mode always reports success, so it can never block a pull request.
  await github.createCommitStatus(headSha, {
    state: "success",
    context: LAND_STATUS_CONTEXT,
    description: statusDescription(decision)
  })
  return statusDescription(decision)
}

/** Action entry point: land is advisory here, so any failure is a warning, not a red job. */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  try {
    const token = env.GH_TOKEN || env.GITHUB_TOKEN
    const repository = env.GITHUB_REPOSITORY
    const prNumber = Number(env.PR_NUMBER)
    if (!token || !repository || !Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error("GH_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are required")
    }
    const { values } = parseArgs({ args: argv, options: { publish: { type: "boolean" } }, strict: true })
    const publish = values.publish === true
    const github = createGitHubClient({ token, repository })
    if (publish) {
      // The action checks first, but direct runs don't, so the write boundary repeats the policy.
      const guard = await new ReviewPreflight({
        github,
        repository,
        prNumber,
        command: env.REVIEW_COMMAND?.trim() || undefined
      }).evaluate(env.TRIGGER_COMMENT_ID ? Number(env.TRIGGER_COMMENT_ID) : null)
      if (!guard.shouldReview) {
        process.stdout.write(`land skipped: ${guard.reason}\n`)
        return
      }
    }
    const result = await runLand(github, prNumber, env.REVIEW_BOT_LOGIN || DEFAULT_REVIEW_BOT_LOGIN, publish)
    process.stdout.write(`${result}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`::warning title=Nibble Review land::${message.replaceAll("\n", " ")}\n`)
  }
}

// Packaged commands enter through a symlink, so compare canonical paths.
const entrypoint = process.argv[1]
if (entrypoint && realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))) {
  await main()
}
