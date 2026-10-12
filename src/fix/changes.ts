import { spawnSync } from "node:child_process"
import { lstatSync, readFileSync, readdirSync, readlinkSync, type Stats } from "node:fs"
import { join, posix } from "node:path"

import type { FileChange } from "./github.js"

/** Paths the fixer may never change, whatever the Agent was asked. */
export const PROTECTED_PATH_PREFIXES: readonly string[] = [".github/"]

export const CHANGE_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxNewFilesScanned: 20_000
} as const

/** Raised when the Agent's edits cannot be published as-is; the run becomes gave-up. */
export class UnpublishableChangeError extends Error {
  override readonly name = "UnpublishableChangeError"
}

type TrackedEntry = { mode: string; path: string }

/** Runs git only in the pristine clone, which no repository code has touched. */
function pristineGit(pristine: string, args: string[], input?: string): string {
  const result = spawnSync("git", ["-C", pristine, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024
  })
  // check-ignore exits 1 when nothing matched, which is a valid answer.
  if (result.status !== 0 && !(args[0] === "check-ignore" && result.status === 1)) {
    throw new Error(`git ${args[0]} failed in the pristine clone: ${result.stderr.trim() || result.status}`)
  }
  return result.stdout
}

function trackedEntries(pristine: string): TrackedEntry[] {
  return pristineGit(pristine, ["ls-files", "-z", "-s"])
    .split("\0")
    .filter(Boolean)
    .map(line => {
      const [meta = "", path = ""] = line.split("\t")
      return { mode: meta.split(" ")[0] || "", path }
    })
    .filter(entry => entry.path && entry.mode !== "160000")
}

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }
    throw error
  }
}

function fileMode(stats: Stats): FileChange["mode"] {
  if (stats.isSymbolicLink()) {
    return "120000"
  }
  return stats.mode & 0o111 ? "100755" : "100644"
}

function content(path: string, stats: Stats): Buffer {
  if (stats.isSymbolicLink()) {
    return Buffer.from(readlinkSync(path))
  }
  if (stats.size > CHANGE_LIMITS.maxFileBytes) {
    throw new UnpublishableChangeError(`${path} is larger than ${CHANGE_LIMITS.maxFileBytes} bytes`)
  }
  return readFileSync(path)
}

/** Lists untracked, non-ignored files, pruning ignored directories such as node_modules. */
function newFiles(pristine: string, workspace: string, tracked: ReadonlySet<string>): string[] {
  const found: string[] = []
  let scanned = 0
  const queue = [""]
  while (queue.length > 0) {
    const directory = queue.shift() as string
    const entries = readdirSync(join(workspace, directory), { withFileTypes: true }).filter(
      entry => !(directory === "" && entry.name === ".git")
    )
    scanned += entries.length
    if (scanned > CHANGE_LIMITS.maxNewFilesScanned) {
      throw new UnpublishableChangeError("the checkout has too many untracked, non-ignored files to review")
    }
    const candidates = entries.map(entry => {
      const path = posix.join(directory, entry.name)
      return { path, directory: entry.isDirectory(), query: entry.isDirectory() ? `${path}/` : path }
    })
    if (candidates.length === 0) {
      continue
    }
    const ignored = new Set(
      pristineGit(
        pristine,
        ["check-ignore", "-z", "--no-index", "--stdin"],
        `${candidates.map(c => c.query).join("\0")}\0`
      )
        .split("\0")
        .filter(Boolean)
    )
    for (const candidate of candidates) {
      if (ignored.has(candidate.query)) {
        continue
      }
      if (candidate.directory) {
        queue.push(candidate.path)
      } else if (!tracked.has(candidate.path)) {
        found.push(candidate.path)
      }
    }
  }
  return found
}

/**
 * Computes the commit the Agent's edits amount to, by comparing the workspace
 * with a pristine clone taken before any repository code ran. No git command
 * runs in the workspace, whose .git a dependency script may have tampered with.
 */
export function collectChanges(options: { pristine: string; workspace: string }): FileChange[] {
  const tracked = trackedEntries(options.pristine)
  const trackedPaths = new Set(tracked.map(entry => entry.path))
  const changes: FileChange[] = []

  for (const entry of tracked) {
    const current = statOrNull(join(options.workspace, entry.path))
    if (!current) {
      changes.push({ path: entry.path, mode: entry.mode as FileChange["mode"], content: null })
      continue
    }
    if (current.isDirectory()) {
      throw new UnpublishableChangeError(`${entry.path} was replaced by a directory`)
    }
    const original = lstatSync(join(options.pristine, entry.path))
    const before = content(join(options.pristine, entry.path), original)
    const after = content(join(options.workspace, entry.path), current)
    const mode = fileMode(current)
    if (mode !== entry.mode || !before.equals(after)) {
      changes.push({ path: entry.path, mode, content: after })
    }
  }

  for (const path of newFiles(options.pristine, options.workspace, trackedPaths)) {
    const stats = lstatSync(join(options.workspace, path))
    changes.push({ path, mode: fileMode(stats), content: content(join(options.workspace, path), stats) })
  }

  const protectedPaths = changes.filter(change =>
    PROTECTED_PATH_PREFIXES.some(prefix => change.path.startsWith(prefix))
  )
  if (protectedPaths.length > 0) {
    throw new UnpublishableChangeError(
      `the fix changed protected paths: ${protectedPaths.map(change => change.path).join(", ")}`
    )
  }
  if (changes.length > CHANGE_LIMITS.maxFiles) {
    throw new UnpublishableChangeError(`the fix changed ${changes.length} files, more than ${CHANGE_LIMITS.maxFiles}`)
  }
  return changes.toSorted((left, right) => left.path.localeCompare(right.path))
}
