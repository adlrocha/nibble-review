import { buildPullRequestHistory } from "../../dist/services/github/context.js"

/**
 * Completes a ReviewEvidence input the way GitHubContextService does: the
 * compact context carries the chronological history built from the same
 * discussion sources the test supplies.
 */
export function withEvidenceContext(input) {
  if (input.context) {
    return input
  }
  const { timelineEvents = [], ...rest } = input
  return {
    ...rest,
    context: {
      history: buildPullRequestHistory({
        pullRequest: input.pullRequest,
        commits: input.commits || [],
        issueComments: input.issueComments || [],
        reviewComments: input.reviewComments || [],
        reviews: input.reviews || [],
        timelineEvents,
        threadsResult: { available: input.reviewThreadsAvailable !== false, threads: input.reviewThreads || [] }
      })
    }
  }
}
