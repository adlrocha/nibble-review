import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sha256Text } from "./cache.mjs"

/** Paths whose content changes what the reviewer does. */
const REVIEWER_PATHS = ["src", "package.json", "package-lock.json", "tsconfig.json"]

function git(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.status}`)
  }
  return result.stdout
}

/**
 * Identifies the exact reviewer that produced a capture: commit, any
 * uncommitted reviewer changes, and the pinned pi version. Appends and cache
 * hits are only valid within one identity.
 */
export function reviewerIdentity(repoRoot) {
  const commit = git(repoRoot, ["rev-parse", "HEAD"]).trim()
  const pending = [
    git(repoRoot, ["diff", "HEAD", "--", ...REVIEWER_PATHS]),
    git(repoRoot, ["ls-files", "--others", "--exclude-standard", "--", ...REVIEWER_PATHS]),
  ].join("\n").trim()
  const piVersion = JSON.parse(
    readFileSync(join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
  ).version
  const dirtyHash = pending ? sha256Text(pending).slice(0, 12) : null
  return {
    commit,
    dirtyHash,
    piVersion,
    id: `${commit}${dirtyHash ? `+${dirtyHash}` : ""}@pi-${piVersion}`,
  }
}
