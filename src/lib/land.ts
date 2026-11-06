import { matchesGlob } from "node:path"

import { parse as parseToml } from "smol-toml"
import { z } from "zod"

import type { PullRequestFile } from "../services/github/client.js"
import { REVIEW_MARKER } from "./review-authorship.js"
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

/** Paths that always need a person: merging them acts on CI, dependencies, data, or these rules. */
export const BUILT_IN_ALWAYS_HUMAN: readonly string[] = [
  ".github/**",
  ".nibble/**",
  "**/migrations/**",
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
  "**/mix.lock"
]

const LandSettingsSchema = z
  .object({
    // Enforcement does not exist yet, so a config asking for it fails loudly
    // instead of silently reporting decisions nothing acts on.
    mode: z.enum(["off", "shadow"]).default("shadow"),
    main_is_staging: z.boolean().default(false),
    max_lines: z.number().int().positive().default(400),
    max_review_rounds: z.number().int().positive().default(5),
    always_human: z.array(z.string().trim().min(1)).default([])
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
}

export type LandInput = {
  headSha: string
  authorIsBot: boolean
  records: VerdictRecord[]
  files: PullRequestFile[]
  threads: LandThread[]
  config: SdlcConfig
}

export type LandDecision = {
  /** True when no rule asks for a person. */
  merge: boolean
  /** One line per rule that asked for a person, empty when `merge` is true. */
  reasons: string[]
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
  return text.replaceAll(new RegExp(VERDICT_RECORD_SOURCE, "gu"), "").replaceAll(RISK_COMMENT_MARKER, "")
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

const NOT_COUNTED = /(^|\/)(docs?|fixtures|generated|dist)\/|\.(md|mdx|txt|snap)$|(^|\/)[^/]*\.lock$|-lock\.[^/]+$/iu

const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)(test_[^/]+|tests\.[^/]+)$/iu

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
    .filter(file => !NOT_COUNTED.test(file.filename) && !isTestFile(file.filename))
    .reduce((sum, file) => sum + file.changes, 0)
}

/** Lists the changed paths, old names included, that match an always-human pattern. */
function alwaysHumanHits(files: PullRequestFile[], extra: readonly string[]): string[] {
  const patterns = [...BUILT_IN_ALWAYS_HUMAN, ...extra]
  const paths = files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])])
  return [...new Set(paths.filter(path => patterns.some(pattern => matchesGlob(path, pattern))))].sort()
}

/** Describes how one test file got weaker, or null when it did not. */
function testWeakening(file: PullRequestFile): string | null {
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

/** True when a reviewer finding was rendered at critical severity. */
function isCritical(body: string): boolean {
  const [first] = body.trim().split(/\s+/u, 2)
  const prefix = inlineSeverityPrefix("critical")
  return body.trim().startsWith(prefix) || body.trim().startsWith(`${first} ${prefix}`)
}

/**
 * Decides whether a pull-request head could merge without a person.
 *
 * This is the whole policy, and it reads only facts. A model can raise a
 * finding that blocks the verdict, but nothing here lets one clear a rule.
 */
export function evaluateLand(input: LandInput): LandDecision {
  const { config, files, headSha, records, threads } = input
  const reasons: string[] = []
  // A full review outranks a fast-track of the same commit: the fast-track path
  // says LGTM for any head it has seen, including one a full review blocked.
  const forHead = records.filter(record => record.sha === headSha)
  const onHead = forHead.filter(record => record.kind === "full").at(-1) ?? forHead.at(-1)

  if (input.authorIsBot) {
    reasons.push("opened by a bot or App")
  }
  if (!onHead) {
    reasons.push("no review verdict on this commit")
  } else if (onHead.verdict !== "lgtm") {
    reasons.push(`verdict on this commit is ${onHead.verdict}`)
  }
  if (!records.some(record => record.kind === "full")) {
    reasons.push("no full review on this pull request")
  }
  if (records.length > config.land.max_review_rounds) {
    reasons.push(`${records.length} review rounds, over the limit of ${config.land.max_review_rounds}`)
  }

  const lines = countedLines(files)
  if (lines > config.land.max_lines) {
    reasons.push(`${lines} counted lines, over the limit of ${config.land.max_lines}`)
  }
  const hits = alwaysHumanHits(files, config.land.always_human)
  if (hits.length > 0) {
    const shown = hits.slice(0, 5).map(codeSpan).join(", ")
    reasons.push(`always-human paths: ${shown}${hits.length > 5 ? ` and ${hits.length - 5} more` : ""}`)
  }
  reasons.push(...files.map(testWeakening).filter(reason => reason !== null))

  const unresolved = threads.filter(thread => !thread.is_resolved).length
  if (unresolved > 0) {
    reasons.push(`${unresolved} unresolved review thread${unresolved === 1 ? "" : "s"}`)
  }
  // Outdated means the anchored code changed. A resolved critical that is not
  // outdated was closed by a reply alone, which is fine for anything else.
  for (const thread of threads) {
    if (thread.is_resolved && !thread.is_outdated && isCritical(thread.firstBody)) {
      reasons.push(
        `critical finding closed without a code change: ${thread.path ? codeSpan(thread.path) : "unknown path"}`
      )
    }
  }

  return { merge: reasons.length === 0, reasons, countedLines: lines, rounds: records.length }
}

/** Short text for the commit status, within GitHub's description limit. */
export function statusDescription(decision: LandDecision): string {
  const text = decision.merge ? "shadow: would merge" : `shadow: would ask you (${decision.reasons[0]})`
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
  const lines = [
    RISK_COMMENT_MARKER,
    "## Risk",
    "",
    `**Land (shadow, nothing was merged):** ${decision.merge ? "would merge" : "would ask you"}, judged on ${headSha}`,
    "",
    `- Counted lines: ${decision.countedLines} of ${config.land.max_lines}`,
    `- Review rounds: ${decision.rounds} of ${config.land.max_review_rounds}`,
    `- \`main\` is a safe staging step: ${config.land.main_is_staging ? "yes" : "no"}`
  ]
  if (decision.reasons.length > 0) {
    lines.push("", "**Why it needs you**", "", ...decision.reasons.map(reason => `- ${reason}`))
  }
  if (whereToLook) {
    const stale = whereToLook.sha === headSha ? "" : ` (from the review of ${whereToLook.sha ?? "an earlier commit"})`
    lines.push("", `**Where to look**${stale}`, "", whereToLook.list)
  }
  return lines.join("\n")
}
