import { posix } from "node:path"

export type DiffFile = {
  path: string
  status: "added" | "modified" | "removed"
  addedLines: number[]
  deletedLines: number[]
  rightLines: number[]
  leftLines: number[]
}

export type ValidCommentRanges = Record<
  string,
  {
    added_lines: number[]
    deleted_lines: number[]
    right_lines: number[]
    left_lines: number[]
  }
>

const IGNORED_LOCKFILES = new Set([
  ".terraform.lock.hcl",
  "bun.lock",
  "bun.lockb",
  "cabal.project.freeze",
  "cargo.lock",
  "composer.lock",
  "conan.lock",
  "conda-lock.yml",
  "conda-lock.yaml",
  "deno.lock",
  "flake.lock",
  "gemfile.lock",
  "go.sum",
  "gradle.lockfile",
  "mix.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.resolved",
  "packages.lock.json",
  "paket.lock",
  "pdm.lock",
  "pipfile.lock",
  "pixi.lock",
  "pnpm-lock.yaml",
  "podfile.lock",
  "poetry.lock",
  "pubspec.lock",
  "requirements.lock",
  "stack.yaml.lock",
  "uv.lock",
  "yarn.lock"
])

type MutableDiffFile = {
  path: string
  status: DiffFile["status"]
  addedLines: Set<number>
  deletedLines: Set<number>
  rightLines: Set<number>
  leftLines: Set<number>
}

/** True for lockfiles the reviewer treats as machine noise, wherever they live. */
export function isIgnoredLockfile(path: string): boolean {
  return IGNORED_LOCKFILES.has(posix.basename(path).toLowerCase())
}

/**
 * Owns the two deterministic diff policies the reviewer needs: removing
 * generated/binary noise from model context and calculating valid GitHub
 * review-comment anchors from the remaining hunks.
 */
export class ReviewDiff {
  readonly text: string
  readonly ignoredFiles: string[]
  readonly files: DiffFile[]
  readonly commentRanges: ValidCommentRanges

  private constructor(text: string, ignoredFiles: string[], files: DiffFile[]) {
    this.text = text
    this.ignoredFiles = ignoredFiles
    this.files = files
    this.commentRanges = Object.fromEntries(
      files.map(file => [
        file.path,
        {
          added_lines: file.addedLines,
          deleted_lines: file.deletedLines,
          right_lines: file.rightLines,
          left_lines: file.leftLines
        }
      ])
    )
  }

  /** Parses one raw GitHub or git unified diff into review-ready evidence. */
  static from(rawDiff: string): ReviewDiff {
    const { text, ignoredFiles } = ReviewDiff.filter(rawDiff)
    return new ReviewDiff(text, ignoredFiles, ReviewDiff.parseFiles(text))
  }

  /**
   * Drops lockfile and binary blocks only. Source remains available in the
   * checkout, so a lane can still inspect an omitted file when it matters.
   */
  private static filter(rawDiff: string): { text: string; ignoredFiles: string[] } {
    const blocks: string[][] = []
    let current: string[] = []
    for (const line of rawDiff.split(/\r?\n/u)) {
      if (line.startsWith("diff --git ") && current.length > 0) {
        blocks.push(current)
        current = []
      }
      current.push(line)
    }
    if (current.length > 0) {
      blocks.push(current)
    }

    const ignored = new Set<string>()
    const kept = blocks.filter(block => {
      const paths = ReviewDiff.paths(block)
      const lockfiles = paths.filter(isIgnoredLockfile)
      const binary = block.some(line => line === "GIT binary patch" || line.startsWith("Binary files "))
      if (lockfiles.length === 0 && !binary) {
        return true
      }
      for (const path of lockfiles.length > 0 ? lockfiles : paths) {
        ignored.add(path)
      }
      return false
    })

    const text = kept.map(block => block.join("\n")).join("\n")
    return {
      text: /\r?\n$/u.test(rawDiff) && text ? `${text}\n` : text,
      ignoredFiles: [...ignored].sort()
    }
  }

  /**
   * Walks hunk line counters exactly as GitHub does. Added/deleted sets decide
   * whether a comment may end on a line; LEFT/RIGHT sets validate a full range.
   */
  private static parseFiles(diff: string): DiffFile[] {
    const files = new Map<string, MutableDiffFile>()
    let path: string | null = null
    let oldPath: string | null = null
    let newPath: string | null = null
    let oldLine = 0
    let newLine = 0
    let inHunk = false

    const file = (filePath: string, status: DiffFile["status"]): MutableDiffFile => {
      const existing = files.get(filePath)
      if (existing) {
        return existing
      }
      const created: MutableDiffFile = {
        path: filePath,
        status,
        addedLines: new Set(),
        deletedLines: new Set(),
        rightLines: new Set(),
        leftLines: new Set()
      }
      files.set(filePath, created)
      return created
    }

    for (const line of diff.split(/\r?\n/u)) {
      if (line.startsWith("diff --git ")) {
        // A pure rename or empty-file change has no hunk and may omit ---/+++.
        // Seed its inventory entry from the block header before parsing lines.
        const [headerOldPath = null, headerNewPath = null] = ReviewDiff.paths([line])
        oldPath = headerOldPath
        newPath = headerNewPath
        path = newPath || oldPath
        if (path) file(path, "modified")
        inHunk = false
        continue
      }
      if (line.startsWith("new file mode ") && path) {
        file(path, "added").status = "added"
        continue
      }
      if (line.startsWith("deleted file mode ") && path) {
        file(path, "removed").status = "removed"
        continue
      }
      if (line.startsWith("--- ")) {
        oldPath = ReviewDiff.normalizePath(line.slice(4).trim())
        path = newPath || oldPath
        inHunk = false
        continue
      }
      if (line.startsWith("+++ ")) {
        newPath = ReviewDiff.normalizePath(line.slice(4).trim())
        path = newPath || oldPath
        inHunk = false
        continue
      }
      if (line.startsWith("@@ ")) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?/u.exec(line)
        inHunk = Boolean(hunk)
        oldLine = hunk ? Number(hunk[1]) - 1 : 0
        newLine = hunk ? Number(hunk[2]) - 1 : 0
        continue
      }
      if (!inHunk || !path || line.startsWith("\\")) {
        continue
      }

      // `/dev/null` on one side is the canonical unified-diff signal for file
      // creation or deletion; all other hunks are grouped as modifications.
      const status = oldPath === null ? "added" : newPath === null ? "removed" : "modified"
      const lines = file(path, status)
      lines.status = status
      if (line.startsWith(" ")) {
        oldLine += 1
        newLine += 1
        lines.leftLines.add(oldLine)
        lines.rightLines.add(newLine)
      } else if (line.startsWith("-")) {
        oldLine += 1
        lines.leftLines.add(oldLine)
        lines.deletedLines.add(oldLine)
      } else if (line.startsWith("+")) {
        newLine += 1
        lines.rightLines.add(newLine)
        lines.addedLines.add(newLine)
      }
    }

    return [...files.values()].map(file => ({
      path: file.path,
      status: file.status,
      addedLines: [...file.addedLines].sort((left, right) => left - right),
      deletedLines: [...file.deletedLines].sort((left, right) => left - right),
      rightLines: [...file.rightLines].sort((left, right) => left - right),
      leftLines: [...file.leftLines].sort((left, right) => left - right)
    }))
  }

  /** Extracts old and new paths from one diff block, including quoted names. */
  private static paths(lines: string[]): string[] {
    const paths = new Set<string>()
    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        const values = line
          .slice("diff --git ".length)
          .match(/"(?:\\.|[^"])*"|\S+/gu)
          ?.slice(0, 2)
        for (const value of values || []) {
          const path = ReviewDiff.normalizePath(value.replace(/^"|"$/gu, "").replace(/\\"/gu, '"'))
          if (path) {
            paths.add(path)
          }
        }
      } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        const path = ReviewDiff.normalizePath(line.slice(4).trim())
        if (path) {
          paths.add(path)
        }
      }
    }
    return [...paths]
  }

  /** Removes git's a/b prefixes and excludes /dev/null creation metadata. */
  private static normalizePath(raw: string): string | null {
    if (!raw || raw === "/dev/null") {
      return null
    }
    return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw
  }
}
