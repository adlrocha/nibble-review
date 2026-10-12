/** Hidden marker appended to everything the reviewer publishes. GitHub renders it invisibly. */
export const REVIEW_MARKER = "<!-- nibble-review -->"

/** Logins that many workflows share, so login alone cannot identify this reviewer's output. */
export const SHARED_BOT_LOGINS: ReadonlySet<string> = new Set(["github-actions[bot]"])

/** The GITHUB_TOKEN identity reviews post as when no GitHub App token is configured. */
export const GITHUB_ACTIONS_BOT_LOGIN = "github-actions[bot]"

/** Appends the reviewer marker once, keeping published bodies idempotent. */
export function withReviewMarker(body: string): string {
  return body.includes(REVIEW_MARKER) ? body : `${body}\n\n${REVIEW_MARKER}`
}

/** Minimal shape shared by GitHub comments, reviews, and thread comments. */
export type AuthoredContent = {
  user?: { login?: string | null } | null
  body?: unknown
}

/**
 * Decides whether GitHub content was written by this reviewer.
 *
 * A dedicated App login is unambiguous. A shared login such as
 * `github-actions[bot]` also needs the marker, otherwise another workflow's
 * comment could be mistaken for a previous review and suppress a new one.
 *
 * @example
 * const own = reviewAuthorship("github-actions[bot]")
 * own.isOwn({ user: { login: "github-actions[bot]" }, body: "Lint passed" }) // false
 */
export function reviewAuthorship(botLogin: string) {
  const shared = SHARED_BOT_LOGINS.has(botLogin)
  return {
    botLogin,
    /** True when `login` is the reviewer's login, ignoring whether the content is marked. */
    isBotLogin(login: string | null | undefined): boolean {
      return Boolean(login) && login === botLogin
    },
    /** True when the content was published by this reviewer. */
    isOwn(content: AuthoredContent | null | undefined): boolean {
      if (!content || content.user?.login !== botLogin) {
        return false
      }
      return !shared || String(content.body ?? "").includes(REVIEW_MARKER)
    }
  }
}

export type ReviewAuthorship = ReturnType<typeof reviewAuthorship>
