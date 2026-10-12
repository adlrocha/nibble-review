import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { formatCost, priceUsage } from "./pricing.mjs";
import { evalJobKey } from "./job-key.mjs";

function readText(file) {
  if (!file || !existsSync(file)) {
    return "";
  }
  return readFileSync(file, "utf8");
}

function readJson(file, fallback = null) {
  if (!file || !existsSync(file)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function durationMs(startedAt, endedAt) {
  const start = Date.parse(startedAt || "");
  const end = Date.parse(endedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return end - start;
}

/** Resolves current and legacy run completion without accepting partial matrices. */
export function evalRunStatus(run) {
  if (typeof run?.status === "string" && run.status) {
    return run.status;
  }
  const expectedJobs = (run?.inputs?.length || 0) * (run?.models?.length || 0);
  const jobs = Array.isArray(run?.jobs) ? run.jobs : [];
  const legacyComplete =
    Boolean(run?.endedAt) &&
    expectedJobs > 0 &&
    jobs.length === expectedJobs &&
    jobs.every((job) => job?.status === "completed" || job?.status === "failed");
  return legacyComplete ? "completed" : "unknown";
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "n/a";
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function formatTokens(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(toNumber(value)));
}

function relativePath(runDir, file) {
  if (!file) {
    return "";
  }
  return relative(runDir, file).split("\\").join("/");
}

function tokenValue(tokens, key) {
  if (!tokens || typeof tokens !== "object") {
    return 0;
  }
  return toNumber(tokens[key]);
}

function readOpenCodeUsage(file) {
  const usage = {
    steps: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
  };

  for (const line of readText(file).split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      const part = event.part && typeof event.part === "object" ? event.part : {};
      const tokens = part.tokens && typeof part.tokens === "object" ? part.tokens : null;
      if (!tokens) {
        continue;
      }
      usage.steps += 1;
      usage.totalTokens += tokenValue(tokens, "total");
      usage.inputTokens += tokenValue(tokens, "input");
      usage.outputTokens += tokenValue(tokens, "output");
      usage.reasoningTokens += tokenValue(tokens, "reasoning");
      usage.cacheReadTokens += tokenValue(tokens.cache, "read");
      usage.cacheWriteTokens += tokenValue(tokens.cache, "write");
      if (typeof part.cost === "number" && Number.isFinite(part.cost)) {
        usage.costUsd = (usage.costUsd ?? 0) + part.cost;
      }
    } catch {
      // Raw JSONL is still saved for inspection when OpenCode changes event shapes.
    }
  }

  return usage;
}

/** Usage sources whose estimated cost covers every model call of the review. */
const TRUSTED_USAGE_SOURCES = new Set(["pi-session", "opencode-db"]);

function readReviewStats(file) {
  const stats = readJson(file, null);
  const totals = stats && typeof stats === "object" ? stats.totals || {} : {};
  return {
    usageSource: stats?.usageSource,
    durationMs:
      totals.durationMs !== null && totals.durationMs !== undefined && Number.isFinite(Number(totals.durationMs))
        ? Number(totals.durationMs)
        : null,
    usage: {
      steps: toNumber(totals.turns) || (Array.isArray(stats?.phases) ? stats.phases.length : 0),
      totalTokens: toNumber(totals.totalTokens),
      inputTokens: toNumber(totals.inputTokens),
      outputTokens: toNumber(totals.outputTokens),
      reasoningTokens: toNumber(totals.reasoningTokens),
      cacheReadTokens: toNumber(totals.cacheReadTokens),
      cacheWriteTokens: toNumber(totals.cacheWriteTokens),
      // Review cost is pi's catalog estimate from its session log; old OpenCode
      // captures keep their database estimate. ACP-only captures stay n/a.
      costUsd: null,
      estimatedCostUsd: TRUSTED_USAGE_SOURCES.has(stats?.usageSource) && typeof totals.estimatedCostUsd === "number" ? totals.estimatedCostUsd : null,
    },
  };
}

function combineUsage(...items) {
  return items.reduce(
    (total, item) => ({
      steps: total.steps + item.steps,
      totalTokens: total.totalTokens + item.totalTokens,
      inputTokens: total.inputTokens + item.inputTokens,
      outputTokens: total.outputTokens + item.outputTokens,
      reasoningTokens: total.reasoningTokens + item.reasoningTokens,
      cacheReadTokens: total.cacheReadTokens + item.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + item.cacheWriteTokens,
      costUsd: total.costUsd + item.costUsd,
    }),
    readOpenCodeUsage(""),
  );
}

function judgeAttempts(judgment) {
  const attempts = Array.isArray(judgment?.attempts) ? judgment.attempts : [];
  const retained = attempts.filter((attempt) => attempt?.files?.raw && existsSync(attempt.files.raw));
  return retained.length > 0 ? retained : judgment ? [judgment] : [];
}

function priceJudgeAttempts(attempts, usageByAttempt) {
  if (attempts.length === 0) {
    return { costUsd: 0, label: formatCost(0), rawReportedCostUsd: 0, source: "not-run" };
  }
  const prices = attempts.map((attempt, index) =>
    priceUsage({
      model: attempt.model || "",
      usage: usageByAttempt[index],
      reportedCostUsd: usageByAttempt[index].costUsd,
    }),
  );
  const costUsd = sumKnownCosts(prices.map((price) => price.costUsd));
  const sources = [...new Set(prices.map((price) => price.source))];
  return {
    costUsd,
    label: formatCost(costUsd),
    rawReportedCostUsd: prices.reduce((sum, price) => sum + price.rawReportedCostUsd, 0),
    source: attempts.length > 1 ? `all-attempts:${sources.join("+")}` : sources[0],
  };
}

function countProducedComments(reviewText) {
  const text = String(reviewText || "");
  const findingsStart = text.search(/^##\s+Findings\b/imu);
  const findingsText = findingsStart >= 0 ? text.slice(findingsStart) : text;
  const findingsEnd = findingsText.search(/^##\s+(Summary|Verdict)\b/imu);
  const section = findingsEnd >= 0 ? findingsText.slice(0, findingsEnd) : findingsText;
  if (/\bNo findings\b/iu.test(section)) {
    return 0;
  }
  const headingFindings = section.match(/^#{3,6}\s+(?!Findings\b|Summary\b|Verdict\b).+/gimu);
  if (headingFindings) {
    return headingFindings.length;
  }
  const numbered = section.match(/^\s*(?:\*\*)?\d+[.)]\s+/gimu);
  if (numbered) {
    return numbered.length;
  }
  const fileMarkers = section.match(/^\s*-\s+\*\*File:\*\*/gimu);
  return fileMarkers ? fileMarkers.length : 0;
}

function readCommentExport(file) {
  const comments = readJson(file, {});
  const list = (key) => (Array.isArray(comments?.[key]) ? comments[key] : []);
  const review = comments?.review && typeof comments.review === "object" ? comments.review : {};
  return {
    body: String(review.body || "").trim(),
    issueComments: list("issueComments"),
    inlineComments: list("inlineComments"),
    replies: list("replies"),
    dropped: list("dropped"),
    validationStats: comments?.validationStats || null,
  };
}

function check(id, label, passed, { hard = false, value = "", limit = "", points = null } = {}) {
  return { id, label, passed, hard, value, limit, points };
}

function buildHeuristics({ job, judgment, hasJudgments, duration, usage, captureCost, maxDurationMs }) {
  const heuristics = [
    check("capture-completed", "Capture completed", job.status === "completed", {
      hard: true,
      value: job.status,
    }),
    check("review-output", "Review output", toNumber(job.outputBytes) > 0, {
      hard: true,
      value: `${formatTokens(job.outputBytes)} bytes`,
    }),
  ];

  if (hasJudgments) {
    heuristics.push(
      check("judge-completed", "Judge completed", judgment?.status === "completed", {
        hard: true,
        value: judgment?.status || "missing",
      }),
    );
  }

  if (typeof judgment?.score === "number") {
    heuristics.push(
      check("judge-score", "Judge score", true, {
        value: `${judgment.score}/10 ${judgment.verdict || ""}`.trim(),
        points: Math.round(judgment.score * 10),
      }),
    );
  }

  heuristics.push(
    check("max-duration", "Duration budget", duration === null || duration <= maxDurationMs, {
      value: formatDuration(duration),
      limit: formatDuration(maxDurationMs),
    }),
  );

  heuristics.push(
    check("token-spend", "Tokens spent", true, {
      value: formatTokens(usage.totalTokens),
    }),
  );

  heuristics.push(
    check("cost-spend", "Cost reported", true, {
      value: captureCost.label,
    }),
  );

  return heuristics;
}

function scorePercent(judgment) {
  if (typeof judgment?.score !== "number") {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(judgment.score * 10)));
}

function capturedReviewVerdict(reviewBody) {
  const terminalVerdict = String(reviewBody || "").match(
    /(?:^|\n)\s*(⛔\s*Block|⚠️?\s*Request changes|✅\s*LGTM)(?::[^\n]*)?\.?\s*$/iu,
  );
  if (!terminalVerdict) {
    return null;
  }
  return /LGTM/iu.test(terminalVerdict[1])
    ? { key: "lgtm", label: "✓ LGTM" }
    : { key: "request_changes", label: "⚠ request changes" };
}

function normalizeVerdict({ job, judgment, reviewBody }) {
  if (job.status !== "completed" || judgment?.status === "failed" || judgment?.status === "skipped") {
    return { key: "error", label: "? error" };
  }

  // The captured body owns the publication decision. A quality judge may call
  // a good blocking review "lgtm", so its verdict is only a legacy fallback.
  const captured = capturedReviewVerdict(reviewBody);
  if (captured) {
    return captured;
  }
  const value = String(judgment?.verdict || "").toLowerCase().replace(/[\s-]+/gu, "_");
  if (["lgtm", "good", "pass", "passed", "approve"].includes(value)) {
    return { key: "lgtm", label: "✓ LGTM" };
  }
  if (["request_changes", "bad", "fail", "failed", "changes"].includes(value)) {
    return { key: "request_changes", label: "⚠ request changes" };
  }
  if (["error", "mixed", "unknown", "not_judgeable"].includes(value)) {
    return { key: "error", label: "? error" };
  }
  return { key: "error", label: "? error" };
}

function questionResult(score) {
  if (score >= 8) {
    return "pass";
  }
  if (score >= 5) {
    return "partial";
  }
  return "fail";
}

function normalizeJudgeQuestions(judgment) {
  const questions = judgment?.questions || judgment?.answers;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions
    .filter((question) => question && typeof question === "object")
    .map((question) => {
      const score = typeof question.score === "number" && Number.isFinite(question.score) ? question.score : null;
      const reason = String(question.reason || question.answer || question.evidence || question.notes || "").trim();
      return {
        id: String(question.id || ""),
        question: String(question.question || question.id || ""),
        score,
        scoreLabel: score === null ? "n/a" : `${score.toFixed(1)}/10`,
        answer: reason,
        reason,
        result: score === null ? String(question.result || question.verdict || "") : questionResult(score),
        evidence: String(question.evidence || ""),
      };
    })
    .filter((question) => question.question || question.answer);
}

function resultStatus({ job, judgment, hasJudgments, hardFailures }) {
  if (hardFailures.length > 0) {
    return "hard failed";
  }
  if (job.status !== "completed") {
    return "failed";
  }
  if (hasJudgments && judgment?.status !== "completed") {
    return "judge failed";
  }
  if (!hasJudgments) {
    return "pending judge";
  }
  return "passed";
}

function summarizeResult({ job, judgment, hasJudgments, runDir, maxDurationMs }) {
  const jobKey = evalJobKey(job);
  const reviewStats = job.files?.stats ? readReviewStats(job.files.stats) : null;
  const captureUsage = reviewStats?.usage || readOpenCodeUsage(job.files?.raw);
  const retainedJudgeAttempts = judgeAttempts(judgment);
  const judgeUsageByAttempt = retainedJudgeAttempts.map(attempt => readOpenCodeUsage(attempt.files?.raw));
  const judgeUsage = combineUsage(...judgeUsageByAttempt);
  // Keep the captured estimate, or n/a for ACP-only captures. Repricing
  // fallback tokens would reintroduce the incomplete costs we deliberately exclude.
  const captureCost = reviewStats ? {
    costUsd: captureUsage.estimatedCostUsd,
    label: formatCost(captureUsage.estimatedCostUsd),
    rawReportedCostUsd: 0,
    source: captureUsage.estimatedCostUsd === null ? "unavailable" : "estimate",
  } : priceUsage({
    model: job.model,
    usage: captureUsage,
    reportedCostUsd: captureUsage.costUsd,
  });
  const judgeCost = priceJudgeAttempts(retainedJudgeAttempts, judgeUsageByAttempt);
  const usage = combineUsage(captureUsage, judgeUsage);
  usage.costUsd = sumKnownCosts([captureCost.costUsd, judgeCost.costUsd]);
  const judgeModel = judgment?.model || "";
  const reviewerDuration = reviewStats?.durationMs;
  // Cached jobs preserve reviewer telemetry, but their job timestamps only
  // measure artifact restoration and must not enter wall-clock comparisons.
  const captureDuration = job.cache?.hit ? null : durationMs(job.startedAt, job.endedAt);
  const performanceDuration = captureDuration ?? reviewerDuration;
  const heuristics = buildHeuristics({
    job,
    judgment,
    hasJudgments,
    duration: performanceDuration,
    usage,
    captureCost,
    maxDurationMs,
  });
  const hardFailures = heuristics.filter((item) => item.hard && item.passed === false);
  const percent = scorePercent(judgment);
  const reviewText = readText(job.files?.review);
  const commentExport = readCommentExport(job.files?.comments);
  const exportedCommentCount = commentExport.issueComments.length + commentExport.inlineComments.length + commentExport.replies.length;
  const producedComments = job.files?.comments && existsSync(job.files.comments) ? exportedCommentCount : countProducedComments(reviewText);
  const verdict = normalizeVerdict({ job, judgment, reviewBody: commentExport.body || reviewText });
  const judgeQuestions = normalizeJudgeQuestions(judgment);

  return {
    jobKey,
    pr: job.input.ref,
    label: job.input.label || "",
    runner: job.runner || "src",
    provider: job.provider || job.amlProvider || (job.runner === "aml" ? "" : "opencode"),
    model: job.model,
    judgeModel,
    status: resultStatus({ job, judgment, hasJudgments, hardFailures }),
    captureStatus: job.status,
    judgeStatus: judgment?.status || (hasJudgments ? "missing" : "not run"),
    score: judgment?.score ?? null,
    scorePercent: percent,
    scoreLabel: percent === null ? "n/a" : `${percent}%`,
    verdictKey: verdict.key,
    verdictLabel: verdict.label,
    reason: judgment?.reason || judgment?.notes || "",
    questions: judgeQuestions,
    answers: judgeQuestions,
    strengths: Array.isArray(judgment?.strengths) ? judgment.strengths : [],
    risks: Array.isArray(judgment?.risks) ? judgment.risks : [],
    error: job.error || judgment?.error || "",
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    cacheHit: Boolean(job.cache?.hit),
    captureDurationMs: captureDuration,
    captureDurationLabel: formatDuration(captureDuration),
    reviewerDurationMs: reviewerDuration,
    reviewerDurationLabel: formatDuration(reviewerDuration),
    reviewerDurationBoundary: job.runner === "aml" ? "aml-workflow" : "model-phases",
    // Retain the original field for report consumers written before the two
    // timing boundaries became explicit.
    durationMs: reviewerDuration ?? captureDuration,
    durationLabel: formatDuration(reviewerDuration ?? captureDuration),
    outputBytes: toNumber(job.outputBytes),
    producedComments,
    commentCounts: {
      issue: commentExport.issueComments.length,
      inline: commentExport.inlineComments.length,
      replies: commentExport.replies.length,
      dropped: commentExport.dropped.length,
    },
    validationStats: commentExport.validationStats,
    heuristics,
    hardFailures,
    usage,
    captureUsage,
    judgeUsage,
    costUsd: captureCost.costUsd,
    costLabel: captureCost.label,
    costSource: captureCost.source,
    rawReportedCostUsd: captureCost.rawReportedCostUsd,
    reportedCostUsd: captureCost.costUsd,
    reportedCostLabel: captureCost.label,
    judgeCostUsd: judgeCost.costUsd,
    judgeCostLabel: judgeCost.label,
    judgeCostSource: judgeCost.source,
    rawJudgeReportedCostUsd: judgeCost.rawReportedCostUsd,
    judgeReportedCostUsd: judgeCost.costUsd,
    judgeReportedCostLabel: judgeCost.label,
    totalReportedCostUsd: usage.costUsd,
    totalReportedCostLabel: formatCost(usage.costUsd),
    reviewText,
    reviewExcerpt: reviewText.split(/\r?\n/u).slice(0, 12).join("\n"),
    files: {
      context: relativePath(runDir, job.files?.context),
      diff: relativePath(runDir, job.files?.diff),
      review: relativePath(runDir, job.files?.review),
      transcript: relativePath(runDir, job.files?.transcript),
      comments: relativePath(runDir, job.files?.comments),
      stats: relativePath(runDir, job.files?.stats),
      payload: relativePath(runDir, job.files?.payload),
      validated: relativePath(runDir, job.files?.validated),
      validationContext: relativePath(runDir, job.files?.validationContext),
      auditModelContext: relativePath(runDir, job.files?.auditModelContext),
      reviewQueue: relativePath(runDir, job.files?.reviewQueue),
      reviewOutput: relativePath(runDir, job.files?.reviewOutput),
      reviewJsonOutput: relativePath(runDir, job.files?.reviewJsonOutput),
      auditOutput: relativePath(runDir, job.files?.auditOutput),
      auditJsonOutput: relativePath(runDir, job.files?.auditJsonOutput),
      synthesisOutput: relativePath(runDir, job.files?.synthesisOutput),
      synthesisJsonOutput: relativePath(runDir, job.files?.synthesisJsonOutput),
      stdout: relativePath(runDir, job.files?.stdout),
      stderr: relativePath(runDir, job.files?.stderr),
      judge: relativePath(runDir, judgment?.files ? `${runDir}/jobs/${jobKey}/judge.json` : ""),
      judgeRaw: relativePath(runDir, judgment?.files?.raw),
      judgeStderr: relativePath(runDir, judgment?.files?.stderr),
    },
  };
}

function average(values) {
  const numbers = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (numbers.length === 0) {
    return null;
  }
  return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function sumKnownCosts(values) {
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0);
}

function sortResults(left, right) {
  const leftScore = left.scorePercent ?? -1;
  const rightScore = right.scorePercent ?? -1;
  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }
  return left.pr.localeCompare(right.pr) || left.model.localeCompare(right.model);
}

export function buildEvalSummary({ run, judgments = [], runDir, generatedAt = new Date().toISOString() }) {
  const judgmentByJob = new Map(judgments.map((judgment) => [judgment.jobKey, judgment]));
  const hasJudgments = judgments.length > 0;
  // Keep the advisory performance target separate from the hard capture kill.
  const maxDurationMs = run.targetDurationMs || run.reviewTimeoutMs || 600_000;
  const results = (run.jobs || [])
    .map((job) =>
      summarizeResult({
        job,
        judgment: judgmentByJob.get(evalJobKey(job)),
        hasJudgments,
        runDir,
        maxDurationMs,
      }),
    )
    .sort(sortResults);

  const usage = combineUsage(...results.map((result) => result.usage));
  const reportedCostUsd = sumKnownCosts(results.map((result) => result.reportedCostUsd));
  const judgeReportedCostUsd = sumKnownCosts(results.map((result) => result.judgeReportedCostUsd));
  const totalReportedCostUsd = sumKnownCosts(results.map((result) => result.totalReportedCostUsd));
  usage.costUsd = totalReportedCostUsd;
  const rawReportedCostUsd = results.reduce((sum, result) => sum + result.rawReportedCostUsd, 0);
  const rawJudgeReportedCostUsd = results.reduce((sum, result) => sum + result.rawJudgeReportedCostUsd, 0);
  const completed = results.filter((result) => result.captureStatus === "completed").length;
  const passed = results.filter((result) => result.status === "passed").length;
  const hardFailed = results.filter((result) => result.hardFailures.length > 0).length;
  const averageScore = average(results.map((result) => result.scorePercent));
  const runDuration = durationMs(run.startedAt, run.endedAt);

  return {
    generatedAt,
    run: {
      status: evalRunStatus(run),
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      updatedAt: run.updatedAt,
      durationMs: runDuration,
      durationLabel: formatDuration(runDuration),
      configFile: run.configFile,
      runner: run.runner || "src",
      provider:
        (run.runner || "src") === "aml" ? run.provider || run.amlProvider || "" : "opencode",
      models: run.models || [],
      inputs: run.inputs || [],
      concurrency: run.concurrency,
      targetDurationMs: run.targetDurationMs,
      reviewTimeoutMs: run.reviewTimeoutMs,
      keepScratch: run.keepScratch,
    },
    totals: {
      jobs: results.length,
      completed,
      passed,
      failed: results.length - passed,
      hardFailed,
      averageScore,
      averageScoreLabel: averageScore === null ? "n/a" : `${averageScore}%`,
      producedComments: results.reduce((sum, result) => sum + result.producedComments, 0),
      outputBytes: results.reduce((sum, result) => sum + result.outputBytes, 0),
      usage,
      reportedCostUsd,
      judgeReportedCostUsd,
      totalReportedCostUsd,
      rawReportedCostUsd,
      rawJudgeReportedCostUsd,
      usageLabels: {
        totalTokens: formatTokens(usage.totalTokens),
        inputTokens: formatTokens(usage.inputTokens),
        outputTokens: formatTokens(usage.outputTokens),
        reasoningTokens: formatTokens(usage.reasoningTokens),
        cacheReadTokens: formatTokens(usage.cacheReadTokens),
        reportedCostUsd: formatCost(reportedCostUsd),
        judgeReportedCostUsd: formatCost(judgeReportedCostUsd),
        totalReportedCostUsd: formatCost(totalReportedCostUsd),
        rawReportedCostUsd: formatCost(rawReportedCostUsd),
        rawJudgeReportedCostUsd: formatCost(rawJudgeReportedCostUsd),
      },
    },
    results,
  };
}
