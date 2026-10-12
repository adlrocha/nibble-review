import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { ReviewUsage } from "./review-telemetry.js"

/** Token and cost totals summed from pi's persisted assistant messages. */
export type PiUsageTotals = {
  messages: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  /** pi's catalog-rate cost; an estimate, not a reconciled provider bill. */
  costUsd: number
}

const EMPTY_TOTALS: PiUsageTotals = {
  messages: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function sessionFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { recursive: true, encoding: "utf8" })
      .filter(name => name.endsWith(".jsonl"))
      .map(name => join(directory, name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }
    throw new Error(`cannot list pi sessions in ${directory}`, { cause: error })
  }
}

/** Adds one session JSONL line's assistant usage to the running totals. */
function addLine(totals: PiUsageTotals, line: string): PiUsageTotals {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    // A session interrupted mid-write can end with a partial line.
    return totals
  }
  const message = (entry as { type?: unknown; message?: { role?: unknown; usage?: Record<string, unknown> } }) || {}
  if (message.type !== "message" || message.message?.role !== "assistant" || !message.message.usage) {
    return totals
  }
  const usage = message.message.usage
  const cost = (usage.cost as Record<string, unknown> | undefined) || {}
  return {
    messages: totals.messages + 1,
    inputTokens: totals.inputTokens + count(usage.input),
    outputTokens: totals.outputTokens + count(usage.output),
    reasoningTokens: totals.reasoningTokens + count(usage.reasoning),
    cacheReadTokens: totals.cacheReadTokens + count(usage.cacheRead),
    cacheWriteTokens: totals.cacheWriteTokens + count(usage.cacheWrite),
    totalTokens: totals.totalTokens + count(usage.totalTokens),
    costUsd: totals.costUsd + count(cost.total)
  }
}

/**
 * Sums usage across every pi session file under `directory`. pi-acp does not
 * forward usage over ACP, so pi's own session log is the only complete source.
 */
export function readPiUsage(directory: string): PiUsageTotals {
  return sessionFiles(directory).reduce(
    (totals, file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter(line => line.trim())
        .reduce(addLine, totals),
    EMPTY_TOTALS
  )
}

/** Fills review usage from pi's session totals when any assistant message was recorded. */
export function withPiUsage(usage: ReviewUsage, totals: PiUsageTotals): ReviewUsage {
  if (totals.messages === 0) {
    return usage
  }
  return {
    ...usage,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    totalTokens: totals.totalTokens,
    estimatedCostUsd: totals.costUsd
  }
}
