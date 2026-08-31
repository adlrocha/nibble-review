import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function listSection(title, values = []) {
  if (values.length === 0) {
    return `## ${title}\n\n_None._`
  }

  return [
    `## ${title}`,
    "",
    ...values.map((value, index) => {
      const item = value && typeof value === "object" ? value : {}
      const location = [item.path, item.line].filter(Boolean).join(":")
      const heading = location ? `${index + 1}. ${location}` : `${index + 1}.`
      return `${heading}\n\n${String(item.body || JSON.stringify(value, null, 2)).trim()}`
    })
  ].join("\n\n")
}

/** Normalizes the typed review result into the judge's comment contract. */
function comments(result, generatedAt) {
  if (result.status !== "reviewed") {
    return {
      generatedAt,
      gate: result.gate,
      review: { body: result.body },
      issueComments: [{ body: result.body }],
      inlineComments: [],
      replies: [],
      dropped: [],
      validationStats: null
    }
  }

  return {
    generatedAt,
    gate: result.gate,
    review: { body: result.body, event: result.payload.event },
    issueComments: [],
    inlineComments: result.validated.inlineComments,
    replies: result.validated.replies,
    dropped: result.validated.dropped,
    validationStats: result.validated.stats
  }
}

/** Reads one named application boundary without exposing trace content. */
function applicationDuration(result, name) {
  let found = false
  let durationMs = 0
  for (const summary of result.traceSummaries || []) {
    const aggregate = summary.applicationSpans?.[name]
    if (aggregate) {
      found = true
      durationMs += aggregate.totalDurationMs
    }
  }
  return found ? durationMs : undefined
}

function phases(result) {
  const output = [
    {
      name: "gate",
      status: "completed",
      decision: result.gate.decision,
      durationMs: applicationDuration(result, "review.gate")
    }
  ]
  if (result.status === "reviewed") {
    output.push(
      ...result.lanes.map(lane => ({
        name: lane.lane,
        status: "completed"
      })),
      {
        name: "audit",
        status: "completed",
        findings: result.audit.findings.length,
        durationMs: applicationDuration(result, "review.audit")
      },
      {
        name: "validation",
        status: "completed",
        findings: result.validated.inlineComments.length,
        durationMs: applicationDuration(result, "review.validation")
      },
      {
        name: "synthesis",
        status: "completed",
        durationMs: applicationDuration(result, "review.synthesis")
      }
    )
  }
  output.push({
    name: "publication",
    status: result.publicationStatus,
    operations: result.publication.length,
    durationMs: applicationDuration(result, "review.publication")
  })
  return output
}

function stats(result, generatedAt, runtimeDir) {
  return {
    generatedAt,
    model: result.model,
    provider: result.provider,
    repository: result.repository,
    prNumber: result.prNumber,
    runtimeDir,
    phases: phases(result),
    attempts: result.attempts,
    providerCompletions: result.providerCompletions || [],
    amlUsage: result.amlUsage,
    usageSource: result.usageSource,
    usageNote: result.usageNote,
    traceSummaries: result.traceSummaries || [],
    totals: {
      durationMs: result.durationMs,
      turns: result.usage.agentCalls,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      reasoningTokens: result.usage.reasoningTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      totalTokens: result.usage.totalTokens,
      costUsd: result.usage.costUsd,
      estimatedCostUsd: result.usage.estimatedCostUsd,
      jsonEvents: 0,
      textEvents: 0
    }
  }
}

/** Keeps the full typed evidence inspectable without making it workflow state. */
function transcript(result, commentExport, generatedAt) {
  const lines = [
    "# Nibble Review Transcript",
    "",
    `- Generated: ${generatedAt}`,
    `- Repository: ${result.repository}`,
    `- Pull request: ${result.prNumber}`,
    `- Provider: ${result.provider}`,
    `- Model: ${result.model}`,
    "",
    "## Gate",
    "",
    "```json",
    JSON.stringify(result.gate, null, 2),
    "```",
    "",
    "## Final Review Body",
    "",
    result.body
  ]

  if (result.status === "reviewed") {
    lines.push(
      "",
      "## Specialist Output",
      "",
      "```json",
      JSON.stringify(result.lanes, null, 2),
      "```",
      "",
      "## Audit Output",
      "",
      "```json",
      JSON.stringify(result.audit, null, 2),
      "```",
      "",
      listSection("Inline Comments", commentExport.inlineComments),
      "",
      listSection("Replies", commentExport.replies),
      "",
      "## Validation",
      "",
      "```json",
      JSON.stringify(result.validated, null, 2),
      "```"
    )
  }

  lines.push("", "## Publication", "", "```json", JSON.stringify(result.publication, null, 2), "```", "")
  return lines.join("\n")
}

function reviewMarkdown(result, commentExport) {
  return [
    "# Final Review Body",
    "",
    result.body,
    "",
    listSection("Issue Comments", commentExport.issueComments),
    "",
    listSection("Inline Comments", commentExport.inlineComments),
    "",
    listSection("Replies", commentExport.replies),
    "",
    listSection("Dropped Comments", commentExport.dropped),
    ""
  ].join("\n")
}

/** Renders the production result into the stable views consumed by eval and judge. */
export function writeReviewArtifacts(result, outputDir, generatedAt = result.generatedAt) {
  if (!result || typeof result !== "object") {
    throw new TypeError("review result must be an object")
  }

  mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  const commentExport = comments(result, generatedAt)
  const files = {
    review: join(outputDir, "review.md"),
    comments: join(outputDir, "review_comments.json"),
    stats: join(outputDir, "review_stats.json"),
    transcript: join(outputDir, "review_transcript.md"),
    providerCompletions: join(outputDir, "provider_completions.jsonl")
  }
  writeFileSync(files.review, reviewMarkdown(result, commentExport), { mode: 0o600 })
  writeFileSync(files.comments, json(commentExport), { mode: 0o600 })
  writeFileSync(files.stats, json(stats(result, generatedAt, outputDir)), { mode: 0o600 })
  writeFileSync(files.transcript, transcript(result, commentExport, generatedAt), { mode: 0o600 })
  writeFileSync(
    files.providerCompletions,
    (result.providerCompletions || [])
      .map(completion => JSON.stringify({ ...completion, provider: result.provider, model: result.model }))
      .join("\n") + "\n",
    { mode: 0o600 }
  )
  return { paths: files, comments: commentExport }
}

/** Reads the single JSON result emitted by review_runner from captured stdout. */
export function readReviewResult(stdoutFile) {
  if (!existsSync(stdoutFile)) {
    throw new Error(`review stdout capture is missing: ${stdoutFile}`)
  }
  const lines = readFileSync(stdoutFile, "utf8")
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
  const payload = lines.at(-1)
  if (!payload) {
    throw new Error("review stdout capture is empty")
  }
  return JSON.parse(payload)
}
