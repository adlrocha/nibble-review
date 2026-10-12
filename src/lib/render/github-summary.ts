import type { ReviewRunResult } from "../../types/review.js"

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(1)} s`
}

function formatNumber(value: number | null): string {
  return value === null ? "n/a" : value.toLocaleString("en-US")
}

function formatCost(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(4)}`
}

function reviewCounts(result: ReviewRunResult): {
  inlineComments: number
  replies: number
  dropped: number
} {
  if (result.status !== "reviewed") {
    return { inlineComments: 0, replies: 0, dropped: 0 }
  }
  return {
    inlineComments: result.validated.inlineComments.length,
    replies: result.validated.replies.length,
    dropped: result.validated.dropped.length
  }
}

/** Renders the content-free operational result into the GitHub Actions job summary. */
export function renderGitHubStepSummary(result: ReviewRunResult): string {
  const comments = reviewCounts(result)
  const publicationOperations = result.publication.filter(receipt => receipt.status === "submitted").length
  const evaluations = result.traceSummaries
    .map(
      (summary, index) =>
        `| ${index + 1} | ${summary.status} | ${formatDuration(summary.durationMs)} | ${summary.agents.sessions.count} | ${summary.agents.turns.count} | ${summary.tools.count} | ${summary.acpToolCalls.count} |`
    )
    .join("\n")

  return `# Nibble Review Telemetry

| Metric | Value |
| --- | --- |
| Provider | ${result.provider} |
| Model | ${result.model} |
| Repository | ${result.repository} |
| Pull request | ${result.prNumber} |
| Outcome | ${result.status} |
| Gate decision | ${result.gate.decision} |
| Duration | ${formatDuration(result.durationMs)} |
| Agent turns | ${formatNumber(result.usage.agentCalls)} |
| Input tokens | ${formatNumber(result.usage.inputTokens)} |
| Output tokens | ${formatNumber(result.usage.outputTokens)} |
| Reasoning tokens | ${formatNumber(result.usage.reasoningTokens)} |
| Cache read tokens | ${formatNumber(result.usage.cacheReadTokens)} |
| Cache write tokens | ${formatNumber(result.usage.cacheWriteTokens)} |
| Total tokens | ${formatNumber(result.usage.totalTokens)} |
| Estimated cost | ${formatCost(result.usage.estimatedCostUsd)} |
| Inline comments | ${comments.inlineComments} |
| Replies | ${comments.replies} |
| Dropped comments | ${comments.dropped} |
| Publication | ${result.publicationStatus} (${publicationOperations} submitted operations) |

Token counts and cost come from pi's session log; cost uses pi's model catalog rates and is not a reconciled provider bill.

## AML Evaluations

${evaluations ? `| # | Status | Duration | Agent sessions | Agent turns | AML Tools | ACP Tool calls |\n| --- | --- | --- | --- | --- | --- | --- |\n${evaluations}` : "_No completed AML evaluation telemetry was recorded._"}
`
}
