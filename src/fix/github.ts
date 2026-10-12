import { Octokit } from "@octokit/rest"

import { redactSecrets, secretValues } from "../lib/secret-redaction.js"
import { splitRepository } from "../services/github/client.js"

/** A CI check run on the PR head, as GitHub reports it. */
export type CheckRun = {
  id: number
  name: string
  status: string
  conclusion: string | null
  html_url?: string | null
  app?: { slug?: string | null } | null
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null
}

/** One file change for an API-created commit. `content: null` deletes the path. */
export type FileChange = {
  path: string
  mode: "100644" | "100755" | "120000"
  content: Buffer | null
}

/** GitHub operations the fixer needs beyond the reviewer's read-only client. */
export type FixGitHub = {
  listCheckRuns(ref: string): Promise<CheckRun[]>
  /** Raw log text of a GitHub Actions job, or null when it is not an Actions job or logs expired. */
  getJobLog(jobId: number): Promise<string | null>
  /**
   * Creates one commit on `branch` from `parentSha` through the Git Data API
   * and fast-forwards the branch. Never forces: a moved branch rejects.
   */
  commitFiles(options: { branch: string; parentSha: string; message: string; changes: FileChange[] }): Promise<string>
  resolveReviewThread(threadId: string): Promise<void>
}

/** Conclusions the fixer treats as a broken check. */
export const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out", "startup_failure"])

/** Creates the fixer's GitHub port. Commit messages are scrubbed of secret values like every published body. */
export function createFixGitHub(options: {
  token: string
  repository: string
  secrets?: readonly string[]
}): FixGitHub {
  const octokit = new Octokit({ auth: options.token, userAgent: "nibble-review-fix" })
  const { owner, repo } = splitRepository(options.repository)
  const secrets = options.secrets ?? secretValues(process.env)

  return {
    async listCheckRuns(ref) {
      const runs = (await octokit.paginate("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
        owner,
        repo,
        ref,
        per_page: 100
      })) as CheckRun[]
      return runs
    },

    async getJobLog(jobId) {
      try {
        const response = await octokit.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
          owner,
          repo,
          job_id: jobId
        })
        return typeof response.data === "string" ? response.data : String(response.data ?? "")
      } catch (error) {
        const status = (error as { status?: number }).status
        // Non-Actions check runs have no job logs, and Actions expires old logs.
        if (status === 404 || status === 410) {
          return null
        }
        throw new Error(`cannot read logs for job ${jobId}`, { cause: error })
      }
    },

    async commitFiles({ branch, parentSha, message, changes }) {
      const parent = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner,
        repo,
        commit_sha: parentSha
      })
      const tree = await Promise.all(
        changes.map(async change => {
          if (change.content === null) {
            return { path: change.path, mode: change.mode, type: "blob" as const, sha: null }
          }
          const blob = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
            owner,
            repo,
            content: change.content.toString("base64"),
            encoding: "base64"
          })
          return { path: change.path, mode: change.mode, type: "blob" as const, sha: blob.data.sha }
        })
      )
      const createdTree = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
        owner,
        repo,
        base_tree: parent.data.tree.sha,
        tree
      })
      const commit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message: redactSecrets(message, secrets),
        tree: createdTree.data.sha,
        parents: [parentSha]
      })
      await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
        force: false
      })
      return commit.data.sha
    },

    async resolveReviewThread(threadId) {
      await octokit.graphql(
        `mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }`,
        { threadId }
      )
    }
  }
}
