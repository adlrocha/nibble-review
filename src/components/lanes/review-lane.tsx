import { Agent, Block, evaluate, Include, Tool, type AML } from "@aml-jsx/sdk"

import { REVIEW_POLICY_INCLUDE_LIMIT_BYTES } from "../../prompt-limits.js"
import { REVIEW_CONTEXT_PATHS } from "../context/files.js"
import { ReviewContextPrompt } from "../context/prompt.js"
import { useReviewContext } from "../context/review-context.js"
import type { ReviewLaneName } from "../../lib/review-queue.js"
import { createGitHubReadTools } from "../../tools/github-read.js"
import { createLaneReviewTools } from "../../tools/review.js"

export type ReviewLaneProps = AML.PropsWithRequiredChildren<{
  readonly lane: ReviewLaneName
}>

/** Runs one focused specialist and hands its non-canonical assessment to audit. */
export const ReviewLane: AML.Component<ReviewLaneProps> = async ({ lane, children }) => {
  const { github, queue } = useReviewContext()
  const tools = createLaneReviewTools(queue, lane)
  // Tool adapters are a consumer concern, not request state. Each lane derives
  // the model-facing GitHub surface from the shared cached session it receives.
  const githubTools = createGitHubReadTools(github)
  const assessment = await evaluate(
    <Agent name={lane} permissions={{ filesystem: "read-only", network: false, shell: false }}>
      <Block tag="review-policy">
        <Include src="./instructions/lane.md" maxBytes={REVIEW_POLICY_INCLUDE_LIMIT_BYTES} title={false} />
      </Block>
      <Tool use={githubTools.getPullRequest} />
      <Tool use={githubTools.getPullRequestDiff} />
      <Tool use={githubTools.getIssue} />
      <Tool use={githubTools.getComment} />
      <Tool use={githubTools.getCommit} />
      <Tool use={tools.addReviewBlocker} />
      <Tool use={tools.addReviewNote} />
      <Tool use={tools.addReviewComment} />
      <Tool use={tools.addReviewReply} />
      <Block tag="review-context">
        <Block>## Review context</Block>
        The active review is already materialized in these workspace-relative files; use the GitHub Tools for referenced
        entities or genuinely necessary structured reinspection, not as a routine first step:
        <Block multiline>{`
          - ${REVIEW_CONTEXT_PATHS.pullRequest}: PR description, refs, changed files, and commits
          - ${REVIEW_CONTEXT_PATHS.diff}: filtered unified diff
          - ${REVIEW_CONTEXT_PATHS.history}: prior comments, reviews, threads, and timeline
          - ${REVIEW_CONTEXT_PATHS.issues}: closing issue requirements, related issues and PRs, and compact history
        `}</Block>
        <ReviewContextPrompt diff history issues />
        <Block>## Your lane is `{lane}`</Block>
      </Block>
      {children}
    </Agent>
  )

  queue.complete(lane, assessment)
  return <Block>{assessment}</Block>
}
