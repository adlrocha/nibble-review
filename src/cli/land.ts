#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs"
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
  RISK_MAP_PATH,
  statusDescription,
  type LandDecision,
  type MergeFacts,
  type SdlcConfig,
  type VerdictRecord,
  type WhereToLook
} from "../lib/land.js"
import { reviewAuthorship, type ReviewAuthorship } from "../lib/review-authorship.js"
import {
  createGitHubClient,
  MAX_PULL_REQUEST_FILES,
  type GitHubClient,
  type IssueComment,
  type PullRequestFile,
  type PullRequestReview,
  type PullRequestSummary,
  type ReviewThread
} from "../services/github/client.js"
import { REVIEW_COMMAND } from "../services/review-evidence.js"
import { ReviewPreflight } from "../services/review-preflight.js"

/** One of this reviewer's top-level bodies, and whether it was posted as a review or a comment. */
type OwnBody = {
  body: string
  source: "review" | "comment"
  at: string
  /** The commit GitHub says a review was submitted for. */
  commit: string | null
  /** True when the text changed after it was posted, which the reviewer never does. */
  edited: boolean
}

/** Keeps this reviewer's top-level bodies, oldest first, from a pull request's comments and reviews. */
function ownBodies(authorship: ReviewAuthorship, comments: IssueComment[], reviews: PullRequestReview[]): OwnBody[] {
  const dated: OwnBody[] = [
    ...comments
      .filter(item => authorship.isOwn(item))
      .map(item => ({
        at: item.created_at ?? "",
        body: String(item.body ?? ""),
        source: "comment" as const,
        commit: null,
        edited: Boolean(item.updated_at) && item.updated_at !== item.created_at
      })),
    ...reviews
      .filter(item => authorship.isOwn(item))
      .map(item => ({
        at: item.submitted_at ?? item.submittedAt ?? "",
        body: String(item.body ?? ""),
        source: "review" as const,
        commit: item.commit_id ?? item.commitId ?? null,
        edited: false
      }))
  ]
  return dated.sort((left, right) => left.at.localeCompare(right.at))
}

/**
 * Reads a verdict record only where publication can have written it.
 *
 * Full reviews are submitted as pull-request reviews and no-review LGTMs as
 * comments. Answers are comments that carry no record, so a full record in a
 * comment, or a delta record in a review, did not come from publication.
 */
function trustedRecord({ body, source, commit, edited }: OwnBody): VerdictRecord | null {
  const record = parseVerdictMarker(body)
  if (!record || edited) {
    return null
  }
  if (record.kind === "delta") {
    return source === "comment" ? record : null
  }
  return source === "review" && (commit === null || commit === record.sha) ? record : null
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

/** The pull request land works on, and how its reviewer is asked for a review. */
export type LandTarget = { repository: string; prNumber: number; command?: string | undefined }

/** Everything the fixed rules read about one pull-request head. */
type LandFacts = {
  defaultBranch: string
  pullRequest: PullRequestSummary
  headSha: string
  config: SdlcConfig
  comments: IssueComment[]
  reviews: PullRequestReview[]
  files: PullRequestFile[]
  threads: ReviewThread[]
  authorship: ReviewAuthorship
  own: OwnBody[]
}

/** Reads the policy and the pull request, or null when land is off. */
async function gatherFacts(
  github: GitHubClient,
  prNumber: number,
  source: { botLogin?: string | undefined; configText?: string | null | undefined }
): Promise<LandFacts | null> {
  const defaultBranch = await github.getDefaultBranch()
  // The default branch, never the PR head, so a pull request cannot relax its own rules.
  const config = parseSdlcConfig(source.configText ?? (await github.getRepositoryFile(LAND_CONFIG_PATH, defaultBranch)))
  if (config.land.mode === "off") {
    return null
  }

  const pullRequest = await github.getPullRequest(prNumber)
  const headSha = pullRequest.headRefOid
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
  // GitHub stops listing at a cap, and a rule can't protect a path it never saw.
  if (files.length > MAX_PULL_REQUEST_FILES || (pullRequest.changed_files ?? files.length) !== files.length) {
    throw new Error(`GitHub listed only ${files.length} of the changed files, so no decision was made`)
  }
  const authorship = reviewAuthorship(source.botLogin ?? config.land.reviewer)
  // The risk comment is land's own output, so it never counts as review evidence.
  const own = ownBodies(authorship, comments, reviews).filter(item => !item.body.startsWith(RISK_COMMENT_MARKER))
  return {
    defaultBranch,
    pullRequest,
    headSha,
    config,
    comments,
    reviews,
    files,
    threads: threads.threads,
    authorship,
    own
  }
}

/** Applies the fixed rules to gathered facts. */
function decide(facts: LandFacts, target: LandTarget, merge?: MergeFacts): LandDecision {
  return evaluateLand({
    headSha: facts.headSha,
    author: facts.pullRequest.author?.login ?? "",
    authorIsBot: facts.pullRequest.user?.type === "Bot",
    records: facts.own.map(trustedRecord).filter(record => record !== null),
    files: facts.files,
    threads: facts.threads.map(thread => ({
      is_resolved: thread.is_resolved,
      is_outdated: thread.is_outdated,
      path: thread.path,
      firstBody: thread.comments[0]?.body ?? "",
      isOwn: facts.authorship.isOwn(thread.comments[0])
    })),
    config: facts.config,
    otherBase:
      facts.pullRequest.baseRefName === facts.defaultBranch ? null : (facts.pullRequest.baseRefName ?? "unknown"),
    isFork: facts.pullRequest.head?.repo?.full_name !== target.repository,
    command: target.command ?? REVIEW_COMMAND,
    merge
  })
}

/** People whose latest decisive review asks for changes. */
function changesRequestedBy(reviews: PullRequestReview[]): string[] {
  const latest = new Map<string, string>()
  const dated = reviews.toSorted((left, right) =>
    String(left.submitted_at ?? left.submittedAt ?? "").localeCompare(
      String(right.submitted_at ?? right.submittedAt ?? "")
    )
  )
  for (const review of dated) {
    const login = review.user?.login
    // A plain comment leaves an earlier decision in place.
    if (login && review.user?.type !== "Bot" && review.state !== "COMMENTED" && review.state !== "PENDING") {
      latest.set(login, String(review.state))
    }
  }
  return [...latest].filter(([, state]) => state === "CHANGES_REQUESTED").map(([login]) => login)
}

/** Reads what only matters when someone is about to merge. */
async function gatherMergeFacts(github: GitHubClient, prNumber: number, facts: LandFacts): Promise<MergeFacts> {
  const { pullRequest, headSha } = facts
  const base = pullRequest.baseRefName
  if (!base) {
    throw new Error("the pull request has no base branch")
  }
  const [checks, drift, timeline] = await Promise.all([
    github.listCommitChecks(headSha),
    github.getBaseDrift(base, headSha),
    github.listPullRequestTimeline(prNumber)
  ])
  const reviewedAt = facts.own.filter(item => trustedRecord(item)?.kind === "full").at(-1)?.at ?? ""
  const changed = new Set(
    facts.files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])])
  )
  return {
    isOpen: pullRequest.state === "open",
    isDraft: pullRequest.isDraft === true,
    mergeable: pullRequest.mergeable ?? null,
    checks,
    changesRequestedBy: changesRequestedBy(facts.reviews),
    // A verdict judged the diff against the old base, so a new base needs a new one.
    retargeted: timeline.some(
      event => event.event === "base_ref_changed" && String(event.created_at ?? "") > reviewedAt
    ),
    // A partial list can't prove there is no overlap, so it counts as one.
    overlappingFiles: drift.truncated
      ? [...changed]
      : [...new Set(drift.files.filter(file => changed.has(file)))].toSorted()
  }
}

/**
 * Checks the current head against the fixed rules and reports it. Never merges and never blocks.
 *
 * Without `publish` it writes nothing, matching the review CLI. Both writes
 * are safe to repeat: the comment is replaced and the status is per commit.
 */
export async function runLand(
  github: GitHubClient,
  target: LandTarget,
  botLogin: string | undefined,
  publish: boolean
): Promise<string> {
  const { prNumber } = target
  const facts = await gatherFacts(github, prNumber, { botLogin })
  if (!facts) {
    return "land is off"
  }
  const { authorship, comments, config, headSha, own } = facts
  const decision = decide(facts, target)
  const whereToLook = latestWhereToLook(own.map(item => item.body))
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
  // The CI report always succeeds, so it can never block a pull request.
  await github.createCommitStatus(headSha, {
    state: "success",
    context: LAND_STATUS_CONTEXT,
    description: statusDescription(decision)
  })
  return statusDescription(decision)
}

/** Version of the bundle's shape, so a reader can reject one it doesn't know. */
export const LAND_BUNDLE_VERSION = 1

/** The decision and evidence a local merge tool acts on. */
export type LandBundle = {
  version: typeof LAND_BUNDLE_VERSION
  mode: SdlcConfig["land"]["mode"]
  policy: SdlcConfig["land"]
  pullRequest: {
    repository: string
    number: number
    title: string
    body: string
    author: string
    base: string
    headSha: string
  }
  decision: LandDecision
  files: Pick<PullRequestFile, "filename" | "status" | "additions" | "deletions">[]
  /** Null when GitHub refuses a very large diff. */
  diff: string | null
  riskMap: string | null
  issues: { number: number; title: string; body: string }[]
  reviews: { author: string; state: string; at: string; body: string }[]
  threads: {
    path: string | null
    resolved: boolean
    codeChanged: boolean
    comments: { author: string; body: string }[]
  }[]
  comments: { author: string; association: string; at: string; body: string }[]
}

/** What the bundle is when land is off. */
export type LandBundleOff = { version: typeof LAND_BUNDLE_VERSION; mode: "off" }

/**
 * Builds everything a local merge tool needs: the fixed-rule decision with
 * merge facts, and the evidence its judge reads. It writes nothing.
 *
 * `configText` replaces the default branch's policy, for replaying past pull
 * requests against a proposed one. A merge must never pass it.
 */
export async function landBundle(
  github: GitHubClient,
  target: LandTarget,
  source: { botLogin?: string | undefined; configText?: string | null | undefined } = {}
): Promise<LandBundle | LandBundleOff> {
  const { prNumber, repository } = target
  const facts = await gatherFacts(github, prNumber, source)
  if (!facts) {
    return { version: LAND_BUNDLE_VERSION, mode: "off" }
  }
  const { comments, config, files, headSha, pullRequest, reviews, threads } = facts
  const [merge, riskMap, issues, diff] = await Promise.all([
    gatherMergeFacts(github, prNumber, facts),
    github.getRepositoryFile(RISK_MAP_PATH, facts.defaultBranch),
    github.listPullRequestClosingIssues(prNumber),
    // GitHub refuses very large diffs. The reader then has nothing to judge, so it asks.
    github.getPullRequestDiff(prNumber).catch(() => null)
  ])
  // Files, threads and the diff are read by number, so a push in between would
  // pair this commit with another one's contents.
  const after = await github.getPullRequest(prNumber)
  if (after.headRefOid !== headSha || after.baseRefName !== pullRequest.baseRefName) {
    throw new Error("the pull request changed while it was being read; try again")
  }
  return {
    version: LAND_BUNDLE_VERSION,
    mode: config.land.mode,
    policy: config.land,
    pullRequest: {
      repository,
      number: prNumber,
      title: pullRequest.title ?? "",
      body: pullRequest.body ?? "",
      author: pullRequest.author?.login ?? "",
      base: pullRequest.baseRefName ?? "",
      headSha
    },
    decision: decide(facts, target, merge),
    files: files.map(({ filename, status, additions, deletions }) => ({ filename, status, additions, deletions })),
    diff,
    riskMap,
    issues: issues.map(({ number, title, body }) => ({ number, title: title ?? "", body: body ?? "" })),
    reviews: reviews
      .filter(review => String(review.body ?? "").trim() !== "")
      .map(review => ({
        author: review.user?.login ?? "",
        state: review.state ?? "",
        at: review.submitted_at ?? review.submittedAt ?? "",
        body: review.body ?? ""
      })),
    threads: threads.map(thread => ({
      path: thread.path,
      resolved: thread.is_resolved,
      codeChanged: thread.is_outdated,
      comments: thread.comments.map(comment => ({ author: comment.user.login ?? "", body: comment.body }))
    })),
    comments: comments.map(comment => ({
      author: comment.user?.login ?? "",
      association: comment.author_association ?? "",
      at: comment.created_at ?? "",
      body: comment.body ?? ""
    }))
  }
}

/** Reads the pull request and token land works with, failing when one is missing. */
function readTarget(env: NodeJS.ProcessEnv): { github: GitHubClient; repository: string; prNumber: number } {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN
  const repository = env.GITHUB_REPOSITORY
  const prNumber = Number(env.PR_NUMBER)
  if (!token || !repository || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("GH_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are required")
  }
  return { github: createGitHubClient({ token, repository }), repository, prNumber }
}

/**
 * Entry point for the action and for local tools.
 *
 * In the action land is advisory, so any failure is a warning, not a red job.
 * With `--json` a caller acts on the output, so a failure is an exit code.
 */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  // Decided before parsing, so a mistyped option still fails the way its caller expects.
  const json = argv.some(argument => argument === "--json" || argument.startsWith("--json="))
  try {
    const { github, repository, prNumber } = readTarget(env)
    const command = env.REVIEW_COMMAND?.trim() || undefined
    const target = { repository, prNumber, command }
    // The action knows which account it posts as. Without it, the policy says.
    const botLogin = env.REVIEW_BOT_LOGIN || undefined
    const { values } = parseArgs({
      args: argv,
      options: { publish: { type: "boolean" }, json: { type: "boolean" }, config: { type: "string" } },
      strict: true
    })
    const publish = values.publish === true
    if (json) {
      if (publish) {
        throw new Error("--json never publishes")
      }
      const configText = values.config === undefined ? null : readFileSync(values.config, "utf8")
      const bundle = await landBundle(github, target, { botLogin, configText })
      process.stdout.write(`${JSON.stringify(bundle)}\n`)
      return
    }
    if (values.config !== undefined) {
      throw new Error("--config needs --json")
    }
    if (publish) {
      // The action checks first, but direct runs don't, so the write boundary repeats the policy.
      const guard = await new ReviewPreflight({
        github,
        repository,
        prNumber,
        command
      }).evaluate(env.TRIGGER_COMMENT_ID ? Number(env.TRIGGER_COMMENT_ID) : null)
      if (!guard.shouldReview) {
        process.stdout.write(`land skipped: ${guard.reason}\n`)
        return
      }
    }
    const result = await runLand(github, target, botLogin, publish)
    process.stdout.write(`${result}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (json) {
      process.stderr.write(`land: ${message}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`::warning title=Nibble Review land::${message.replaceAll("\n", " ")}\n`)
  }
}

// Packaged commands enter through a symlink, so compare canonical paths.
const entrypoint = process.argv[1]
if (entrypoint && realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))) {
  await main()
}
