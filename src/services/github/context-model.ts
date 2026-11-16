export const CONTEXT_HISTORY_TEXT_LIMIT = 500
export const CONTEXT_HISTORY_ENTRY_LIMIT = 200

/** Four concurrent PR expansions leave headroom for other GitHub endpoint reads. */
export const CONTEXT_REFERENCE_BATCH_SIZE = 4

/** One provider-neutral history record retained by deterministic application context. */
export type CompactHistoryEntry = {
  at: string | null
  kind: string
  reference: string | null
  actor: string | null
  state: string | null
  location: string | null
  body: string | null
  url: string | null
}

export type CompactHistory = {
  olderEntriesOmitted: number
  entries: CompactHistoryEntry[]
}

/** Complete current issue contract plus compact historical decision evidence. */
export type CompactIssueContext = {
  kind: "issue"
  relation: "closes" | "related" | "referenced"
  repository: string
  number: number
  url: string | null
  title: string
  description: string
  state: string | null
  author: string | null
  labels: string[]
  createdAt: string | null
  updatedAt: string | null
  history: CompactHistory
}

/** Structured PR context retained for deterministic application decisions. */
export type CompactPullRequestContext = {
  kind: "pull_request"
  repository: string
  number: number
  url: string | null
  title: string
  description: string
  state: string | null
  author: string | null
  labels: string[]
  assignees: string[]
  createdAt: string | null
  updatedAt: string | null
  baseRefName: string | null
  headRefName: string | null
  baseRefOid: string | null
  headRefOid: string | null
  draft: boolean
  reviewDecision: string | null
  changedFiles: string[]
  ignoredFiles: string[]
  commits: Array<{
    sha: string
    url: string | null
    author: string | null
    at: string | null
    subject: string
  }>
  history: CompactHistory
  issues: CompactIssueContext[]
  pullRequests: CompactRelatedPullRequestContext[]
}

/** One related PR's complete context without recursively following its references. */
export type CompactRelatedPullRequestContext = Omit<CompactPullRequestContext, "issues" | "pullRequests"> & {
  relation: "related"
}

/** Reduces untrusted historical prose to one useful model-facing line. */
export function compactContextText(value: unknown, limit = CONTEXT_HISTORY_TEXT_LIMIT): string {
  const text = String(value || "")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/```suggestion\s*([\s\S]*?)```/giu, " suggestion: $1 ")
    .replace(/```[^\n]*\s*([\s\S]*?)```/gu, " code: $1 ")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim()
  const suffix = "… (truncated)"
  return text.length <= limit ? text : `${text.slice(0, limit - suffix.length).trimEnd()}${suffix}`
}

/** Sorts compact history and applies an explicit source-specific entry limit. */
export function compactHistory(entries: CompactHistoryEntry[], limit?: number): CompactHistory {
  const ordered = entries.toSorted((left, right) => String(left.at || "").localeCompare(String(right.at || "")))
  const visible = limit === undefined ? ordered : ordered.slice(-limit)
  return {
    olderEntriesOmitted: ordered.length - visible.length,
    entries: visible
  }
}

/** Finds explicit issue/PR relationship clauses; incidental mentions remain cheap links. */
export function parseRelatedReferences(body: string, repository: string) {
  const references = new Map<string, { repository: string; number: number }>()
  // First isolate explicit relationship clauses. Parsing every #123 in a PR
  // body would turn incidental links and examples into review requirements.
  const clausePattern = /\b(?:related\s+to|relates\s+to)\s*:?\s*(?<references>[^;\n]+)/giu
  // Consume Markdown link labels together with their URLs so a cross-repository
  // link labelled #123 does not also become an unrelated local reference.
  const referencePattern =
    /(?:\[[^\]\n]*\]\()?https:\/\/github\.com\/(?<urlOwner>[\w.-]+)\/(?<urlRepo>[\w.-]+)\/(?:issues|pull)\/(?<urlNumber>\d+)\b(?:[/?#][^\s)]*)?\)?|(?:(?<owner>[\w.-]+)\/(?<repo>[\w.-]+))?#(?<number>\d+)\b/gu

  for (const clause of body.matchAll(clausePattern)) {
    // A clause may list local and owner/repository-qualified references. The
    // map preserves first-seen order while collapsing repeated references.
    const text = String(clause.groups?.references || "")
    let previousEnd = 0
    for (const match of text.matchAll(referencePattern)) {
      // Periods within a matched URL or repository token remain intact. A
      // period between references ends the clause even before closing punctuation.
      if (text.slice(previousEnd, match.index).includes(".")) break
      previousEnd = match.index + match[0].length
      const owner = match.groups?.urlOwner || match.groups?.owner
      const repo = match.groups?.urlRepo || match.groups?.repo
      const targetRepository = owner && repo ? `${owner}/${repo}` : repository
      const number = Number(match.groups?.urlNumber || match.groups?.number)
      if (number > 0) {
        references.set(`${targetRepository}#${number}`, { repository: targetRepository, number })
      }
    }
  }
  return [...references.values()]
}

/** Keeps gathering and publication on the same closing, related, and self-link rules. */
export function selectRelatedReferences(input: {
  body: string
  repository: string
  prNumber: number
  closingIssues: ReadonlyArray<{ repository?: string | null; number: number }>
}) {
  const closingKeys = new Set(
    input.closingIssues.map(issue => `${issue.repository || input.repository}#${issue.number}`)
  )
  return parseRelatedReferences(input.body, input.repository).filter(
    reference =>
      !closingKeys.has(`${reference.repository}#${reference.number}`) &&
      !(reference.repository === input.repository && reference.number === input.prNumber)
  )
}

/** The sorted signatures of every issue and pull request a review's context references. */
export function contextReferenceSignatures(
  context: Pick<CompactPullRequestContext, "issues" | "pullRequests">
): string[] {
  return [...context.issues, ...context.pullRequests].map(contextReferenceSignature).toSorted()
}

/** Defines one freshness vocabulary for reviewed records and uncached GitHub reads. */
export function contextReferenceSignature(
  reference:
    | Pick<CompactIssueContext, "kind" | "relation" | "repository" | "number" | "updatedAt">
    | Pick<CompactRelatedPullRequestContext, "kind" | "relation" | "repository" | "number" | "updatedAt" | "headRefOid">
): string {
  const signature = `${reference.kind}:${reference.relation}:${reference.repository}#${reference.number}@${reference.updatedAt || "unknown"}`
  // A PR head can advance before its updatedAt timestamp changes.
  return reference.kind === "pull_request" ? `${signature}:${reference.headRefOid || "unknown"}` : signature
}
