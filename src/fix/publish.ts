import type { GitHubClient } from "../services/github/client.js"
import type { FileChange, FixGitHub } from "./github.js"
import type { FixContext, FixOutcome, FixResult } from "./types.js"

/** Facts the trusted steps established before publication. */
export type PublishInput = {
  context: FixContext
  /** The Agent's structured result, or null when the Agent run failed. */
  result: FixResult | null
  /** Why the Agent run failed, when `result` is null. */
  agentError?: string
  changes: FileChange[]
  /** Set when change collection refused the edits, e.g. protected paths. */
  changeError?: string
  /** Name of the first verify command that failed in the sandbox, if any. */
  failedVerify?: string | null
}

/**
 * Decides the final outcome. Only a `fixed` result whose edits exist and
 * passed verification is committed; every other path publishes nothing but
 * thread replies the Agent was entitled to give.
 */
export function decideOutcome(input: PublishInput): { status: FixOutcome["status"]; reason: string; commit: boolean } {
  if (!input.result) {
    return {
      status: "gave-up",
      reason: `the fixer did not finish: ${input.agentError || "unknown error"}`,
      commit: false
    }
  }
  if (input.changeError) {
    return { status: "gave-up", reason: input.changeError, commit: false }
  }
  if (input.result.status !== "fixed") {
    return { status: input.result.status, reason: input.result.reason, commit: false }
  }
  if (input.failedVerify) {
    return { status: "gave-up", reason: `verification failed: ${input.failedVerify}`, commit: false }
  }
  if (input.changes.length === 0) {
    return {
      status: input.context.failingChecks.length > 0 ? "gave-up" : "fixed",
      reason:
        input.context.failingChecks.length > 0 ? "the fixer reported a fix but changed no files" : input.result.reason,
      commit: false
    }
  }
  return { status: "fixed", reason: input.result.reason, commit: true }
}

/**
 * Publishes one fixer attempt: at most one commit (fast-forward only), then
 * replies to and resolves the review threads the Agent addressed. Runs in a
 * trusted step that holds the write token and executes no repository code.
 */
export async function publishFix(
  input: PublishInput,
  ports: { github: GitHubClient; fixGitHub: FixGitHub }
): Promise<FixOutcome> {
  const decision = decideOutcome(input)
  let commitSha: string | null = null
  if (decision.commit && input.result) {
    commitSha = await ports.fixGitHub.commitFiles({
      branch: input.context.headRef,
      parentSha: input.context.headSha,
      message: input.result.commitMessage,
      changes: input.changes
    })
  }

  // Thread replies only claim resolution when the fix actually landed.
  const known = new Map(input.context.threads.map(thread => [thread.id, thread]))
  const repliedThreads: string[] = []
  const resolvedThreads: string[] = []
  const landed = decision.status === "fixed" && (commitSha !== null || input.changes.length === 0)
  for (const reply of input.result?.threads || []) {
    const thread = known.get(reply.threadId)
    if (!thread?.topLevelCommentId || repliedThreads.includes(thread.id)) {
      continue
    }
    const resolve = reply.resolved && landed
    const suffix = commitSha && resolve ? `\n\nAddressed in ${commitSha}.` : ""
    await ports.github.submitReply(input.context.prNumber, thread.topLevelCommentId, `${reply.reply}${suffix}`)
    repliedThreads.push(thread.id)
    if (resolve) {
      await ports.fixGitHub.resolveReviewThread(thread.id)
      resolvedThreads.push(thread.id)
    }
  }

  return { status: decision.status, reason: decision.reason, commitSha, repliedThreads, resolvedThreads }
}
