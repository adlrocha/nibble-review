import { minimatch } from "minimatch"
import { parse as parseToml } from "smol-toml"
import { z } from "zod"

import type { PullRequestFile } from "../services/github/client.js"
import { REVIEW_MARKER } from "./review-authorship.js"
import { isIgnoredLockfile } from "./review-diff.js"
import { inlineSeverityPrefix, type ReviewVerdictLabel } from "./review-queue.js"

/** Commit status context that carries the land decision for one pull-request head. */
export const LAND_STATUS_CONTEXT = "nibble-review/land"

/** Repository path of the delivery settings, always read from the default branch. */
export const LAND_CONFIG_PATH = ".nibble/sdlc.toml"

/** Hidden marker identifying the single `## Risk` comment on a pull request. */
export const RISK_COMMENT_MARKER = "<!-- nibble-review:risk -->"

/** Heading of the optional model-written list of places a reader should check. */
export const WHERE_TO_LOOK_HEADING = "## Where to look"

const MAX_STATUS_DESCRIPTION = 140

/** Repository path of the optional risk map, which is context for the judge and never a rule. */
export const RISK_MAP_PATH = ".nibble/risk.md"

/** How much a repository lets agents merge on their own. */
export const LAND_PROFILES = ["side-project", "standard", "critical"] as const
export type LandProfile = (typeof LAND_PROFILES)[number]

/** Paths that decide what merges. No profile or setting can drop these. */
const GATE_PATHS: readonly string[] = [
  ".nibble/sdlc.toml",
  ".github/workflows/nibble-review.yml",
  ".github/workflows/nibble-review.yaml"
]

/** Paths where merging acts on CI, secrets, stored data, or the rules agents follow. */
const STANDARD_PATHS: readonly string[] = [
  ".github/**",
  ".nibble/**",
  "**/migrations/**",
  "**/db/migrate/**",
  "**/db/migration/**",
  "**/drizzle/**/*.sql",
  "**/schema.prisma",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/.agents/**",
  "**/.claude/**",
  "**/.pi/**",
  "**/.mcp.json",
  "**/.husky/**",
  "**/.env*",
  "**/CODEOWNERS",
  "**/.gitmodules",
  "**/.gitattributes"
]

/** Paths that change dependencies, builds, or infrastructure. */
const CRITICAL_PATHS: readonly string[] = [
  "**/package.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/Cargo.toml",
  "**/Cargo.lock",
  "**/go.mod",
  "**/go.sum",
  "**/requirements*.txt",
  "**/pyproject.toml",
  "**/poetry.lock",
  "**/uv.lock",
  "**/Gemfile",
  "**/Gemfile.lock",
  "**/Pipfile",
  "**/Pipfile.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/composer.json",
  "**/composer.lock",
  "**/pom.xml",
  "**/build.gradle",
  "**/build.gradle.kts",
  "**/mix.exs",
  "**/mix.lock",
  "**/.npmrc",
  "**/.cargo/config",
  "**/.cargo/config.toml",
  "**/build.rs",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/docker-compose*.y*ml",
  "**/compose*.y*ml",
  "**/*.tf",
  "**/k8s/**",
  "**/Makefile",
  "**/install.sh",
  "**/action.yml",
  "**/action.yaml"
]

/** The paths each profile sends to a person, before the repository's own `always_human`. */
export const PROFILE_PATHS: Readonly<Record<LandProfile, readonly string[]>> = {
  "side-project": GATE_PATHS,
  standard: [...GATE_PATHS, ...STANDARD_PATHS],
  critical: [...GATE_PATHS, ...STANDARD_PATHS, ...CRITICAL_PATHS]
}

// Dot directories and any letter case match too, so `.config/package.json` or
// EF Core's `Migrations/` can't slip past a pattern.
const GLOB_OPTIONS = { dot: true, nocase: true } as const

const nonEmpty = z.string().trim().min(1)

const LandSettingsSchema = z
  .object({
    mode: z.enum(["off", "shadow", "enforce"]).default("shadow"),
    profile: z.enum(LAND_PROFILES).default("standard"),
    main_is_staging: z.boolean().default(false),
    /** Logins whose pull requests may merge unattended. Empty means any human author. */
    authors: z.array(nonEmpty).default([]),
    /** Checks that must pass on the head. Unattended merging needs at least one. */
    required_checks: z.array(nonEmpty).default([]),
    /** Optional hard size limit. Without it, size is only a signal for the judge. */
    max_lines: z.number().int().positive().optional(),
    /** No longer read: rounds alone say nothing. Accepted so older files keep parsing. */
    max_review_rounds: z.number().int().positive().optional(),
    always_human: z.array(nonEmpty).default([]),
    /** Named situations, in plain language, that the judge must send to a person. */
    ask_when: z.record(z.string(), nonEmpty).default({})
  })
  .strict()

// Other tables in the file belong to other tools, such as `nibble sdlc`, so only [land] is checked.
const SdlcConfigSchema = z.object({ land: LandSettingsSchema.prefault({}) })

export type SdlcConfig = z.infer<typeof SdlcConfigSchema>
export type LandVerdict = "lgtm" | "request-changes" | "block"
export type LandReviewKind = "full" | "delta"

/** What one published review recorded about the commit it judged. */
export type VerdictRecord = {
  sha: string
  verdict: LandVerdict
  kind: LandReviewKind
}

export type LandThread = {
  is_resolved: boolean
  is_outdated: boolean
  path: string | null
  firstBody: string
  /** True when this reviewer opened the thread, false for a person or another bot. */
  isOwn: boolean
}

/** CI state of one named check on the head commit. */
export type LandCheck = { name: string; state: "success" | "pending" | "failure" }

/** Facts that only exist when someone is about to merge, so CI's own report leaves them out. */
export type MergeFacts = {
  isOpen: boolean
  isDraft: boolean
  /** Null while GitHub is still computing it. */
  mergeable: boolean | null
  checks: LandCheck[]
  /** People whose latest review requests changes. */
  changesRequestedBy: string[]
  /** Files that changed on both the base branch and this pull request since they diverged. */
  overlappingFiles: string[]
}

export type LandInput = {
  headSha: string
  author: string
  authorIsBot: boolean
  records: VerdictRecord[]
  files: PullRequestFile[]
  threads: LandThread[]
  config: SdlcConfig
  /** Present only for a merge attempt. */
  merge?: MergeFacts | undefined
}

/**
 * `not-ready` means the agent has work left, `ask` means a person must decide,
 * and `ready` means no fixed rule stops it and the judge decides.
 */
export type LandOutcome = "ready" | "not-ready" | "ask"

export type LandDecision = {
  outcome: LandOutcome
  /** Work the agent must finish before anyone is asked anything. */
  blockers: string[]
  /** Fixed rules that need a person. */
  asks: string[]
  /** Facts that decide nothing here, for the judge to weigh. */
  signals: string[]
  countedLines: number
  rounds: number
}

/** A "where to look" list and the commit it was written for, when known. */
export type WhereToLook = {
  list: string
  sha: string | null
}

/** Parses `.nibble/sdlc.toml`; a missing file means the defaults. */
export function parseSdlcConfig(text: string | null): SdlcConfig {
  try {
    return SdlcConfigSchema.parse(text === null ? {} : parseToml(text))
  } catch (cause) {
    throw new Error(`invalid ${LAND_CONFIG_PATH}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

const VERDICT_RECORD_SOURCE =
  "<!-- nibble-review:verdict sha=([0-9a-f]{40}) verdict=(lgtm|request-changes|block) kind=(full|delta) -->"
const FINAL_VERDICT_RECORD = new RegExp(`${VERDICT_RECORD_SOURCE}$`, "u")

/** Renders the application-owned record land trusts, for the very end of a published body. */
export function verdictMarker(record: VerdictRecord): string {
  return `<!-- nibble-review:verdict sha=${record.sha} verdict=${record.verdict} kind=${record.kind} -->`
}

/** Machine-readable name of each verdict the application can render. */
export const LAND_VERDICTS: Readonly<Record<ReviewVerdictLabel, LandVerdict>> = {
  "✅ LGTM": "lgtm",
  "⚠️ Request changes": "request-changes",
  "⛔ Block": "block"
}

/**
 * Removes land's own markers from model-written text.
 *
 * Publication runs this before appending its own record, so the only record a
 * published body can end with is one the application wrote. Only complete
 * markers go: anything else can't be parsed, and it may be text the author wants.
 */
export function stripLandMarkers(text: string): string {
  // Repeat until nothing changes: removing a marker nested inside another
  // would otherwise leave the outer one whole.
  const once = text.replaceAll(new RegExp(VERDICT_RECORD_SOURCE, "gu"), "").replaceAll(RISK_COMMENT_MARKER, "")
  return once === text ? text : stripLandMarkers(once)
}

/**
 * Reads the verdict record from a published body.
 *
 * Only a record at the very end counts. Model-written prose comes earlier in
 * the body, so a fake record copied into a summary is ignored.
 */
export function parseVerdictMarker(body: string): VerdictRecord | null {
  const trimmed = body.trimEnd()
  const tail = trimmed.endsWith(REVIEW_MARKER) ? trimmed.slice(0, -REVIEW_MARKER.length).trimEnd() : trimmed
  const match = FINAL_VERDICT_RECORD.exec(tail)
  if (!match) {
    return null
  }
  return { sha: match[1] as string, verdict: match[2] as LandVerdict, kind: match[3] as LandReviewKind }
}

/** Extracts the list under `## Where to look`, or null when the body has none. */
export function parseWhereToLook(body: string): string | null {
  const start = body.indexOf(`${WHERE_TO_LOOK_HEADING}\n`)
  if (start < 0) {
    return null
  }
  const rest = body.slice(start + WHERE_TO_LOOK_HEADING.length)
  const end = rest.search(/\n#{1,6} /u)
  return (end < 0 ? rest : rest.slice(0, end)).trim() || null
}

// By extension, never by folder: code under `docs/` or `dist/` still runs.
const NOT_COUNTED = /\.(md|mdx|txt|snap)$/iu

const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)(test_[^/]+|tests\.[^/]+)$/iu

// Case-sensitive, or names like `latest.ts` would count as tests.
const TEST_CLASS_FILE = /[a-z0-9]Tests?\.[^/]+$/u

/** True for test files across common layouts, inside or outside a test directory. */
function isTestFile(path: string): boolean {
  return TEST_PATH.test(path) || TEST_CLASS_FILE.test(path)
}

/** Formats a path as a code span, so a file name can only ever render as text. */
function codeSpan(path: string): string {
  return `\`${path.replace(/[`\r\n]/gu, "?")}\``
}

const SKIP_MARKER =
  /\.(skip|only)\(|\b(xit|xdescribe|xtest)\(|#\[ignore|t\.Skip\(|pytest\.mark\.(skip|xfail)|@Disabled\b/u

const ASSERTION = /\b(assert\w*|expect)\b/u

/** Counts the changed lines that carry risk, leaving out docs, tests, and generated output. */
function countedLines(files: PullRequestFile[]): number {
  return files
    .filter(
      file =>
        ![NOT_COUNTED.test(file.filename), isTestFile(file.filename), isIgnoredLockfile(file.filename)].some(Boolean)
    )
    .reduce((sum, file) => sum + file.changes, 0)
}

/** Lists the changed paths, old names included, that this repository sends to a person. */
function alwaysHumanHits(files: PullRequestFile[], config: SdlcConfig): string[] {
  const patterns = [...PROFILE_PATHS[config.land.profile], ...config.land.always_human]
  const paths = files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])])
  return [...new Set(paths.filter(path => patterns.some(pattern => minimatch(path, pattern, GLOB_OPTIONS))))].sort()
}

/** Describes how one test file got weaker, or null when it did not. */
function testWeakening(file: PullRequestFile): string | null {
  if (file.previous_filename && isTestFile(file.previous_filename) && !isTestFile(file.filename)) {
    return `test file renamed away: ${codeSpan(file.previous_filename)}`
  }
  if (!isTestFile(file.filename)) {
    return null
  }
  if (file.status === "removed") {
    return `test file removed: ${codeSpan(file.filename)}`
  }
  if (file.changes > 0 && file.patch === undefined) {
    return `test diff unavailable: ${codeSpan(file.filename)}`
  }
  const lines = (file.patch ?? "").split("\n")
  const added = lines.filter(line => line.startsWith("+") && !line.startsWith("+++"))
  const removed = lines.filter(line => line.startsWith("-") && !line.startsWith("---"))
  if (added.some(line => SKIP_MARKER.test(line))) {
    return `test skipped or focused: ${codeSpan(file.filename)}`
  }
  const assertions = (changed: string[]) => changed.filter(line => ASSERTION.test(line)).length
  return assertions(removed) > assertions(added) ? `assertions removed: ${codeSpan(file.filename)}` : null
}

/** True when a reviewer finding was rendered at high or critical severity. */
function isSevere(body: string): boolean {
  const text = body.trim()
  const [first] = text.split(/\s+/u, 1)
  return (["critical", "high"] as const).some(severity => {
    const prefix = inlineSeverityPrefix(severity)
    return text.startsWith(prefix) || text.startsWith(`${first} ${prefix}`)
  })
}

/** Formats paths as code spans, shortened when there are many. */
function shownPaths(paths: string[]): string {
  const shown = paths.slice(0, 5).map(codeSpan).join(", ")
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown
}

/** What the review still needs before this exact commit counts as approved. */
function reviewBlockers({ headSha, records, threads }: LandInput): string[] {
  const blockers: string[] = []
  // A full review outranks a fast-track of the same commit: the fast-track path
  // says LGTM for any head it has seen, including one a full review blocked.
  const forHead = records.filter(record => record.sha === headSha)
  const onHead = forHead.filter(record => record.kind === "full").at(-1) ?? forHead.at(-1)
  if (!onHead) {
    blockers.push("no review verdict on this commit")
  } else if (onHead.verdict !== "lgtm") {
    blockers.push(`verdict on this commit is ${onHead.verdict}`)
  }
  const lastFull = records.filter(record => record.kind === "full").at(-1)
  if (!lastFull) {
    blockers.push("no full review on this pull request")
  } else if (lastFull.verdict === "block" && lastFull.sha !== headSha) {
    // A PR-level blocker leaves no thread to resolve, and a fast-track of a
    // later commit can't clear it. Request-changes findings do leave threads.
    blockers.push("the last full review blocked and no full review has cleared it")
  } else if (lastFull.verdict !== "lgtm" && threads.some(thread => thread.isOwn && isSevere(thread.firstBody))) {
    blockers.push("a high or critical finding needs a full review to clear it: ask the reviewer for a full re-review")
  }
  const unresolved = threads.filter(thread => !thread.is_resolved).length
  if (unresolved > 0) {
    blockers.push(`${unresolved} unresolved review thread${unresolved === 1 ? "" : "s"}`)
  }
  return blockers
}

/** What the pull request still needs before GitHub could merge it safely. */
function mergeBlockers(merge: MergeFacts, config: SdlcConfig): string[] {
  const blockers: string[] = []
  if (!merge.isOpen) {
    blockers.push("the pull request is not open")
  }
  if (merge.isDraft) {
    blockers.push("the pull request is a draft")
  }
  if (merge.mergeable === null) {
    blockers.push("GitHub is still computing whether it merges cleanly: try again shortly")
  } else if (!merge.mergeable) {
    blockers.push("it conflicts with the base branch")
  }
  if (merge.overlappingFiles.length > 0) {
    blockers.push(
      `the base branch changed the same files, so update this branch: ${shownPaths(merge.overlappingFiles)}`
    )
  }
  for (const name of config.land.required_checks) {
    const states = merge.checks.filter(check => check.name === name).map(check => check.state)
    if (states.length === 0) {
      blockers.push(`required check has not run: ${codeSpan(name)}`)
    } else if (states.some(state => state !== "success")) {
      blockers.push(`required check is ${states.find(state => state !== "success")}: ${codeSpan(name)}`)
    }
  }
  const others = merge.checks.filter(
    check => check.state !== "success" && !config.land.required_checks.includes(check.name)
  )
  blockers.push(...others.map(check => `check is ${check.state}: ${codeSpan(check.name)}`))
  blockers.push(...merge.changesRequestedBy.map(login => `${codeSpan(login)} requested changes`))
  return blockers
}

/**
 * Applies every fixed rule to a pull-request head.
 *
 * It reads only facts, and nothing a model says can clear a rule here. The
 * judge runs afterwards, only on a `ready` head, and can only hold it back.
 */
export function evaluateLand(input: LandInput): LandDecision {
  const { config, files, records, threads } = input
  const blockers = [...reviewBlockers(input), ...(input.merge ? mergeBlockers(input.merge, config) : [])]

  const asks: string[] = []
  if (input.authorIsBot) {
    asks.push("opened by a bot or App")
  } else if (config.land.authors.length > 0 && !config.land.authors.includes(input.author)) {
    asks.push(`opened by ${codeSpan(input.author)}, who is not in \`authors\``)
  }
  if (config.land.required_checks.length === 0) {
    asks.push("no `required_checks` are configured, so nothing proves the change works")
  }
  const hits = alwaysHumanHits(files, config)
  if (hits.length > 0) {
    asks.push(`always-human paths: ${shownPaths(hits)}`)
  }
  const lines = countedLines(files)
  if (config.land.max_lines !== undefined && lines > config.land.max_lines) {
    asks.push(`${lines} counted lines, over the limit of ${config.land.max_lines}`)
  }

  const signals = files.map(testWeakening).filter(reason => reason !== null)
  // Outdated means the anchored code changed. A reply alone may be a fair
  // answer, because the reviewer can be wrong, so the judge reads those.
  for (const thread of threads) {
    if (thread.isOwn && thread.is_resolved && !thread.is_outdated && isSevere(thread.firstBody)) {
      signals.push(
        `severe finding closed without a code change: ${thread.path ? codeSpan(thread.path) : "unknown path"}`
      )
    }
  }

  // Unfinished work comes first, so a person is only asked about a finished change.
  const outcome = blockers.length > 0 ? "not-ready" : asks.length > 0 ? "ask" : "ready"
  return { outcome, blockers, asks, signals, countedLines: lines, rounds: records.length }
}

const OUTCOME_TEXT: Readonly<Record<LandOutcome, string>> = {
  ready: "ready for the judge",
  "not-ready": "not ready",
  ask: "needs you"
}

/** The reasons behind an outcome, empty when it is ready. */
function outcomeReasons(decision: LandDecision): string[] {
  return decision.outcome === "not-ready" ? decision.blockers : decision.asks
}

/** Short text for the commit status, within GitHub's description limit. */
export function statusDescription(decision: LandDecision): string {
  // Commit statuses are plain text, so the Markdown code spans go.
  const reason = outcomeReasons(decision)[0]?.replaceAll("`", "")
  const text = `${OUTCOME_TEXT[decision.outcome]}${reason ? ` (${reason})` : ""}`
  return text.length <= MAX_STATUS_DESCRIPTION ? text : `${text.slice(0, MAX_STATUS_DESCRIPTION - 1)}…`
}

/** Renders the `## Risk` comment body for one judged commit. */
export function renderRiskComment(options: {
  headSha: string
  decision: LandDecision
  config: SdlcConfig
  whereToLook: WhereToLook | null
}): string {
  const { config, decision, headSha, whereToLook } = options
  const limit = config.land.max_lines === undefined ? "" : ` of ${config.land.max_lines}`
  const lines = [
    RISK_COMMENT_MARKER,
    "## Risk",
    "",
    `**Land (fixed rules only, nothing was merged):** ${OUTCOME_TEXT[decision.outcome]}, checked on ${headSha}`,
    "",
    `- Mode and profile: ${config.land.mode}, ${config.land.profile}`,
    `- Counted lines: ${decision.countedLines}${limit}`,
    `- Review rounds: ${decision.rounds}`,
    `- \`main\` is a safe staging step: ${config.land.main_is_staging ? "yes" : "no"}`
  ]
  if (decision.blockers.length > 0) {
    lines.push("", "**What the agent still has to do**", "", ...decision.blockers.map(reason => `- ${reason}`))
  }
  if (decision.asks.length > 0) {
    lines.push("", "**Why it needs you**", "", ...decision.asks.map(reason => `- ${reason}`))
  }
  if (decision.signals.length > 0) {
    lines.push("", "**What the judge should weigh**", "", ...decision.signals.map(reason => `- ${reason}`))
  }
  if (whereToLook) {
    const stale = whereToLook.sha === headSha ? "" : ` (from the review of ${whereToLook.sha ?? "an earlier commit"})`
    lines.push("", `**Where to look**${stale}`, "", whereToLook.list)
  }
  return lines.join("\n")
}
