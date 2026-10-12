import { z } from "zod"

/** Outcome of one fixer attempt. The caller labels the PR for a human on `gave-up`. */
export const FixStatusSchema = z.enum(["fixed", "gave-up", "nothing-to-do"])
export type FixStatus = z.infer<typeof FixStatusSchema>

/** A reply the Agent wants posted to one review thread it was shown. */
export const FixThreadReplySchema = z
  .object({
    threadId: z.string().trim().min(1).describe("The review thread id exactly as listed in the fix context"),
    reply: z.string().trim().min(1).max(4_000).describe("Short reply explaining what changed, or why nothing did"),
    resolved: z.boolean().describe("True only when the change fully addresses the thread")
  })
  .strict()
export type FixThreadReply = z.infer<typeof FixThreadReplySchema>

/** Structured result the fixer Agent returns through AML. */
export const FixResultSchema = z
  .object({
    status: FixStatusSchema,
    reason: z.string().trim().min(1).max(2_000).describe("One or two sentences on why this status was chosen"),
    commitMessage: z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .describe("Conventional commit message for the changes; a short subject line, then an optional body"),
    threads: z.array(FixThreadReplySchema).max(50)
  })
  .strict()
export type FixResult = z.infer<typeof FixResultSchema>

/** One failing CI check with the tail of its log, already trimmed for the prompt. */
export type FailingCheck = {
  id: number
  name: string
  conclusion: string
  url: string | null
  logTail: string
}

/** One unresolved review thread the fixer may address. */
export type FixThread = {
  id: string
  path: string | null
  line: number | null
  topLevelCommentId: number | null
  comments: { author: string | null; body: string }[]
}

/** Everything the fixer knows about the pull request, gathered in a trusted step. */
export type FixContext = {
  repository: string
  prNumber: number
  title: string
  body: string
  headSha: string
  headRef: string
  headRepository: string
  baseRef: string
  diff: string
  failingChecks: FailingCheck[]
  threads: FixThread[]
}

/** What the trusted publish step did. */
export type FixOutcome = {
  status: FixStatus
  reason: string
  commitSha: string | null
  repliedThreads: string[]
  resolvedThreads: string[]
}
