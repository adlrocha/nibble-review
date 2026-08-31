import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evalRunStatus } from "./lib/analysis.mjs";
import { escapeHtml } from "./lib/text.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const MODEL_FAMILIES = [
  { id: "minimax", label: "Minimax", pattern: /minimax/iu, color: "#2563eb" },
  { id: "glm", label: "GLM", pattern: /\bglm|z-ai/iu, color: "#16a34a" },
  { id: "qwen", label: "Qwen", pattern: /qwen/iu, color: "#d97706" },
  { id: "mimo", label: "Mimo", pattern: /mimo|xiaomi/iu, color: "#7c3aed" },
  { id: "deepseek", label: "DeepSeek", pattern: /deepseek/iu, color: "#dc2626" },
  { id: "kimi", label: "Kimi", pattern: /kimi|moonshot/iu, color: "#0891b2" },
  { id: "gpt", label: "GPT", pattern: /gpt|openai/iu, color: "#111827" },
  { id: "claude", label: "Claude", pattern: /claude|anthropic/iu, color: "#c2410c" },
  { id: "gemini", label: "Gemini", pattern: /gemini|google/iu, color: "#4f46e5" },
  { id: "grok", label: "Grok", pattern: /grok|x-ai/iu, color: "#be185d" },
  { id: "north", label: "North", pattern: /north/iu, color: "#64748b" },
  { id: "hy3", label: "HY3", pattern: /hy3|hunyuan|tencent/iu, color: "#0f766e" },
  { id: "poolside", label: "Poolside", pattern: /poolside|laguna/iu, color: "#ea580c" },
];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function escapeScriptJson(value) {
  return JSON.stringify(value).replace(/</gu, "\\u003c").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatPercent(value) {
  return value === null || value === undefined ? "n/a" : `${Math.round(value)}%`;
}

function formatTokens(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(toNumber(value)));
}

function formatMoney(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "n/a";
}

function formatCostLabel(value) {
  return formatMoney(value);
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

function modelFamily(model) {
  return MODEL_FAMILIES.find((family) => family.pattern.test(model)) || {
    id: "other",
    label: "Other",
    color: "#6b7280",
  };
}

function modelLabel(model) {
  const value = String(model || "");
  const [modelId, runLabel] = value.split(" @ ", 2);
  const label = (modelId.split("/").pop() || modelId).replace(/(?::free|-free)$/u, "");
  return runLabel ? `${label} @ ${runLabel.split("/").pop()}` : label;
}

function average(values) {
  const numbers = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (numbers.length === 0) {
    return null;
  }
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function sumKnownCosts(values) {
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0);
}

function sumUsage(results, key) {
  return results.reduce((sum, result) => sum + toNumber(result.usage?.[key]), 0);
}

function scoreVariance(scores, averageScore) {
  const numbers = scores.filter((score) => typeof score === "number" && Number.isFinite(score));
  if (numbers.length === 0 || averageScore === null || averageScore === undefined) {
    return null;
  }
  const minScore = Math.min(...numbers);
  const maxScore = Math.max(...numbers);
  return {
    minus: Math.max(0, averageScore - minScore),
    plus: Math.max(0, maxScore - averageScore),
    width: maxScore - minScore,
  };
}

function formatVariance(variance) {
  if (!variance) {
    return "n/a";
  }
  return `+${Math.round(variance.plus)}% / -${Math.round(variance.minus)}%`;
}

function parseArgs(argv) {
  const options = {
    runsDirs: [],
    outFile: resolve(repoRoot, "eval", "runs", "benchmark.html"),
    jsonFile: resolve(repoRoot, "eval", "runs", "benchmark-summary.json"),
    modelPrefixes: [],
    compareRuns: false,
    average: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runs") {
      options.runsDirs.push(resolve(argv[++index]));
    } else if (arg === "--out") {
      options.outFile = resolve(argv[++index]);
    } else if (arg === "--json") {
      options.jsonFile = resolve(argv[++index]);
    } else if (arg === "--model-prefix") {
      options.modelPrefixes.push(argv[++index] || "");
    } else if (arg === "--compare-runs") {
      options.compareRuns = true;
    } else if (arg === "--avg") {
      options.average = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (options.runsDirs.length === 0) {
    options.runsDirs.push(resolve(repoRoot, "eval", "runs"));
  }
  if (options.compareRuns && options.average) {
    throw new Error("--avg cannot be combined with --compare-runs");
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node eval/benchmark.mjs [options]

Build a cross-run benchmark from existing eval summary.json files.

Options:
  --runs <dir>    Directory containing eval runs. Can repeat. Default: eval/runs
  --out <file>    HTML report path. Default: eval/runs/benchmark.html
  --json <file>   JSON summary path. Default: eval/runs/benchmark-summary.json
  --model-prefix <prefix>
                  Include only models with this prefix. Can repeat.
  --compare-runs Include the run directory in the model dimension so repeated
                  PR x model captures from different reviewer versions can be
                  compared in one benchmark.
  --avg          Aggregate every capture by exact model and variant. Renders
                 one leaderboard row per model and omits PR-level tables.
`);
}

function findSummaryFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(root)) {
    if (entry === "runtime-live") {
      continue;
    }
    const file = join(root, entry);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...findSummaryFiles(file));
    } else if (entry === "summary.json") {
      files.push(file);
    }
  }
  return files;
}

function resultFreshness(result, summary) {
  return Date.parse(result.endedAt || summary.generatedAt || summary.run?.endedAt || summary.run?.startedAt || "") || 0;
}

function resultFailures(result) {
  const error = String(result.error || "").trim();
  if (error) {
    return [error];
  }
  return (result.hardFailures || [])
    .map((failure) => {
      const label = failure.label || failure.id || "";
      return failure.value ? `${label}: ${failure.value}` : label;
    })
    .filter(Boolean);
}

function normalizeResult(summaryFile, summary, result, options = {}) {
  const runDir = dirname(summaryFile);
  const run = relative(repoRoot, runDir).split("\\").join("/");
  const implementation = result.runner || summary.run?.runner || "unknown";
  const provider = result.provider || summary.run?.provider || "unknown";
  const model = options.compareRuns ? `${result.model} @ ${run}` : result.model;
  const scorePercent = typeof result.scorePercent === "number" ? result.scorePercent : null;
  const costUsd = optionalNumber(result.costUsd ?? result.reportedCostUsd ?? result.usage?.costUsd);
  const captureDurationMs = optionalNumber(result.captureDurationMs);
  const reviewerDurationMs = optionalNumber(result.reviewerDurationMs) ?? optionalNumber(result.durationMs);
  const questionScores = {};
  for (const question of result.questions || []) {
    if (question?.id && typeof question.score === "number") {
      questionScores[question.id] = question.score;
    }
  }
  return {
    key: `${result.pr}__${implementation}__${provider}__${model}`,
    pr: result.pr,
    label: result.label || "",
    implementation,
    provider,
    model,
    status: result.status,
    captureStatus: result.captureStatus || "",
    judgeStatus: result.judgeStatus || "",
    scorePercent,
    scoreLabel: result.scoreLabel || formatPercent(scorePercent),
    verdictKey: result.verdictKey || "",
    verdictLabel: result.verdictLabel || "n/a",
    cacheHit: Boolean(result.cacheHit),
    captureDurationMs,
    captureDurationLabel: result.captureDurationLabel || formatDuration(captureDurationMs),
    reviewerDurationMs,
    reviewerDurationLabel: result.reviewerDurationLabel || result.durationLabel || formatDuration(reviewerDurationMs),
    reviewerDurationBoundary: result.reviewerDurationBoundary || "legacy",
    durationMs: reviewerDurationMs,
    durationLabel: result.reviewerDurationLabel || result.durationLabel || formatDuration(reviewerDurationMs),
    producedComments: toNumber(result.producedComments),
    failures: resultFailures(result),
    usage: {
      totalTokens: toNumber(result.usage?.totalTokens),
      inputTokens: toNumber(result.usage?.inputTokens),
      outputTokens: toNumber(result.usage?.outputTokens),
      reasoningTokens: toNumber(result.usage?.reasoningTokens),
      cacheReadTokens: toNumber(result.usage?.cacheReadTokens),
      cacheWriteTokens: toNumber(result.usage?.cacheWriteTokens),
      costUsd,
    },
    costUsd,
    costLabel: result.costLabel || result.reportedCostLabel || formatCostLabel(costUsd),
    rawReportedCostUsd: toNumber(result.rawReportedCostUsd),
    reportedCostUsd: costUsd,
    reportedCostLabel: result.costLabel || result.reportedCostLabel || formatCostLabel(costUsd),
    questionScores,
    questionCount: Object.keys(questionScores).length,
    runDir,
    run,
    summaryFile: relative(repoRoot, summaryFile).split("\\").join("/"),
    generatedAt: summary.generatedAt || "",
    freshness: resultFreshness(result, summary),
    family: modelFamily(result.model),
  };
}

function loadResults(summaryFiles, options = {}) {
  const candidates = [];
  const ignored = [];
  for (const summaryFile of summaryFiles) {
    try {
      const summary = readJson(summaryFile);
      const runStatus = evalRunStatus({
        ...summary.run,
        jobs: (summary.results || []).map((result) => ({ status: result.captureStatus })),
      });
      if (runStatus !== "completed") {
        ignored.push({
          summaryFile: relative(repoRoot, summaryFile).split("\\").join("/"),
          error: `run status is ${runStatus}; only completed runs are benchmarkable`,
        });
        continue;
      }
      for (const result of summary.results || []) {
        candidates.push(normalizeResult(summaryFile, summary, result, options));
      }
    } catch (error) {
      ignored.push({
        summaryFile: relative(repoRoot, summaryFile).split("\\").join("/"),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (options.average) {
    return { results: candidates.sort(sortResults), ignored };
  }

  const byPair = new Map();
  for (const candidate of candidates) {
    const existing = byPair.get(candidate.key);
    const candidateRank = resultEvidenceRank(candidate);
    const existingRank = existing ? resultEvidenceRank(existing) : -1;
    if (!existing || candidateRank > existingRank || (candidateRank === existingRank && candidate.freshness > existing.freshness)) {
      if (existing) {
        ignored.push(existing);
      }
      byPair.set(candidate.key, candidate);
    } else {
      ignored.push(candidate);
    }
  }

  return {
    results: Array.from(byPair.values()).sort(sortResults),
    ignored,
  };
}

/** Keeps completed judged evidence ahead of newer diagnostic failures. */
function resultEvidenceRank(result) {
  if (result.status === "passed" && typeof result.scorePercent === "number") {
    return 3;
  }
  if (result.captureStatus === "completed" && result.status === "pending judge") {
    return 2;
  }
  if (result.captureStatus === "completed") {
    return 1;
  }
  return 0;
}

function sortResults(left, right) {
  return left.pr.localeCompare(right.pr) || left.model.localeCompare(right.model);
}

function buildModelRows(results) {
  const byModel = new Map();
  for (const result of results) {
    if (!byModel.has(result.model)) {
      byModel.set(result.model, []);
    }
    byModel.get(result.model).push(result);
  }

  return Array.from(byModel.entries())
    .map(([model, modelResults]) => {
      const scores = modelResults.map((result) => result.scorePercent);
      const averageScore = average(scores);
      const variance = scoreVariance(scores, averageScore);
      const completed = modelResults.filter((result) => result.status === "passed").length;
      const verdicts = modelResults.reduce(
        (counts, result) => {
          const key = result.verdictKey || "error";
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        },
        {},
      );
      const questionIds = new Set();
      for (const result of modelResults) {
        for (const id of Object.keys(result.questionScores)) {
          questionIds.add(id);
        }
      }

      return {
        model,
        family: modelFamily(model),
        implementations: [...new Set(modelResults.map((result) => result.implementation))].sort().join(", "),
        providers: [...new Set(modelResults.map((result) => result.provider))].sort().join(", "),
        runs: modelResults.length,
        passed: completed,
        averageScore,
        scoreVariance: variance,
        scoreVarianceLabel: formatVariance(variance),
        avgCaptureDurationMs: average(modelResults.map((result) => result.captureDurationMs)),
        captureDurationSamples: modelResults.filter((result) => result.captureDurationMs !== null).length,
        avgReviewerDurationMs: average(modelResults.map((result) => result.reviewerDurationMs)),
        avgComments: average(modelResults.map((result) => result.producedComments)),
        totalTokens: sumUsage(modelResults, "totalTokens"),
        avgTokens: average(modelResults.map((result) => result.usage.totalTokens)),
        totalCostUsd: sumKnownCosts(modelResults.map((result) => result.costUsd)),
        avgCostUsd:
          modelResults.every((result) => result.costUsd !== null)
            ? average(modelResults.map((result) => result.costUsd))
            : null,
        costSamples: modelResults.filter((result) => result.costUsd !== null).length,
        verdicts,
        failures: modelResults.reduce((sum, result) => sum + result.failures.length, 0),
        questionCoverage: questionIds.size,
      };
    })
    .sort((left, right) => (right.averageScore ?? -1) - (left.averageScore ?? -1) || left.model.localeCompare(right.model));
}

function buildQuestionRows(results) {
  const modelRows = [];
  const models = Array.from(new Set(results.map((result) => result.model))).sort();
  const questionIds = Array.from(
    results.reduce((ids, result) => {
      for (const id of Object.keys(result.questionScores)) {
        ids.add(id);
      }
      return ids;
    }, new Set()),
  ).sort();

  for (const model of models) {
    const modelResults = results.filter((result) => result.model === model);
    const scores = {};
    for (const id of questionIds) {
      scores[id] = average(modelResults.map((result) => result.questionScores[id]));
    }
    modelRows.push({ model, scores });
  }

  return { questionIds, modelRows };
}

function buildMatrix(results) {
  const prs = Array.from(new Set(results.map((result) => result.pr))).sort();
  const models = Array.from(new Set(results.map((result) => result.model))).sort();
  const cells = new Map(results.map((result) => [`${result.pr}__${result.model}`, result]));
  return { prs, models, cells };
}

function buildBenchmarkSummary({ summaryFiles, results, ignored, generatedAt = new Date().toISOString() }) {
  const usage = {
    totalTokens: sumUsage(results, "totalTokens"),
    inputTokens: sumUsage(results, "inputTokens"),
    outputTokens: sumUsage(results, "outputTokens"),
    reasoningTokens: sumUsage(results, "reasoningTokens"),
    cacheReadTokens: sumUsage(results, "cacheReadTokens"),
    cacheWriteTokens: sumUsage(results, "cacheWriteTokens"),
    costUsd: sumKnownCosts(results.map((result) => result.costUsd)),
  };
  const modelRows = buildModelRows(results);
  const matrix = buildMatrix(results);
  const questions = buildQuestionRows(results);

  return {
    generatedAt,
    sourceSummaries: summaryFiles.map((file) => relative(repoRoot, file).split("\\").join("/")).sort(),
    ignoredResults: ignored,
    totals: {
      results: results.length,
      prs: matrix.prs.length,
      models: matrix.models.length,
      averageScore: average(results.map((result) => result.scorePercent)),
      producedComments: results.reduce((sum, result) => sum + result.producedComments, 0),
      usage,
      usageLabels: {
        totalTokens: formatTokens(usage.totalTokens),
        inputTokens: formatTokens(usage.inputTokens),
        outputTokens: formatTokens(usage.outputTokens),
        reasoningTokens: formatTokens(usage.reasoningTokens),
        cacheReadTokens: formatTokens(usage.cacheReadTokens),
        reportedCostUsd: formatCostLabel(usage.costUsd),
      },
    },
    models: modelRows,
    matrix: {
      prs: matrix.prs,
      models: matrix.models,
    },
    questions,
    results,
  };
}

function scoreClass(score) {
  if (score === null || score === undefined) {
    return "missing";
  }
  if (score >= 85) {
    return "high";
  }
  if (score >= 70) {
    return "mid";
  }
  if (score >= 50) {
    return "low";
  }
  return "bad";
}

function sortValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return String(value).toLowerCase();
}

function kpi(label, value, subvalue = "") {
  return `<div class="kpi">
    <div class="kpi-label">${escapeHtml(label)}</div>
    <div class="kpi-value">${escapeHtml(value)}</div>
    ${subvalue ? `<div class="kpi-sub">${escapeHtml(subvalue)}</div>` : ""}
  </div>`;
}

function colorStyle(color) {
  return `--model-color: ${escapeHtml(color)}`;
}

function modelName(model, family = modelFamily(model)) {
  return `<span class="model-name" style="${colorStyle(family.color)}">
    <span class="model-swatch"></span>
    <code>${escapeHtml(modelLabel(model))}</code>
  </span>`;
}

function modelRows(models) {
  return models
    .map(
      (model) => `<tr>
        <td data-sort="${escapeHtml(model.model)}">${modelName(model.model, model.family)}</td>
        <td data-sort="${escapeHtml(model.implementations)}">${escapeHtml(model.implementations)}</td>
        <td data-sort="${escapeHtml(model.providers)}">${escapeHtml(model.providers)}</td>
        <td data-sort="${model.runs}">${formatTokens(model.runs)}</td>
        <td data-sort="${model.averageScore ?? -1}">${formatPercent(model.averageScore)}</td>
        <td data-sort="${model.scoreVariance?.width ?? -1}">${escapeHtml(model.scoreVarianceLabel)}</td>
        <td data-sort="${model.avgCaptureDurationMs ?? -1}">${formatDuration(model.avgCaptureDurationMs)} <span class="muted">(${model.captureDurationSamples}/${model.runs})</span></td>
        <td data-sort="${model.avgReviewerDurationMs ?? -1}">${formatDuration(model.avgReviewerDurationMs)}</td>
        <td data-sort="${model.avgComments ?? -1}">${model.avgComments === null ? "n/a" : model.avgComments.toFixed(1)}</td>
        <td data-sort="${model.totalTokens}">${formatTokens(model.totalTokens)}</td>
        <td data-sort="${model.totalCostUsd ?? -1}">${formatCostLabel(model.totalCostUsd)} <span class="muted">(${model.costSamples}/${model.runs})</span></td>
        <td data-sort="${model.failures}">${formatTokens(model.failures)}</td>
        <td data-sort="${model.questionCoverage}">${formatTokens(model.questionCoverage)}</td>
      </tr>`,
    )
    .join("\n");
}

function matrixTable(summary) {
  const cells = new Map(summary.results.map((result) => [`${result.pr}__${result.model}`, result]));
  return `<table class="matrix sortable">
    <thead>
      <tr>
        <th>PR</th>
        ${summary.matrix.models.map((model) => `<th>${modelName(model)}</th>`).join("")}
      </tr>
    </thead>
    <tbody>
      ${summary.matrix.prs
        .map(
          (pr) => `<tr>
            <th>${escapeHtml(pr)}</th>
            ${summary.matrix.models
              .map((model) => {
                const result = cells.get(`${pr}__${model}`);
                if (!result) {
                  return `<td class="score-cell missing" data-sort="-1">-</td>`;
                }
                return `<td class="score-cell ${scoreClass(result.scorePercent)}" style="${colorStyle(result.family.color)}" data-sort="${result.scorePercent ?? -1}">
                  <strong>${escapeHtml(result.scoreLabel)}</strong>
                  <span>${escapeHtml(result.verdictLabel)}</span>
                  <small>${escapeHtml(result.costLabel || result.reportedCostLabel)} / ${formatTokens(result.producedComments)} comments</small>
                </td>`;
              })
              .join("")}
          </tr>`,
        )
        .join("\n")}
    </tbody>
  </table>`;
}

function costScoreChartData(models) {
  const scored = models.filter(
    (model) => typeof model.averageScore === "number" && typeof model.totalCostUsd === "number",
  );
  const byFamily = new Map();

  for (const model of scored) {
    const family = model.family || modelFamily(model.model);
    if (!byFamily.has(family.id)) {
      byFamily.set(family.id, {
        label: family.label,
        borderColor: family.color,
        backgroundColor: family.color,
        data: [],
      });
    }

    byFamily.get(family.id).data.push({
      x: toNumber(model.totalCostUsd),
      y: toNumber(model.averageScore),
      model: model.model,
      label: modelLabel(model.model),
      scoreLabel: formatPercent(model.averageScore),
      costLabel: formatCostLabel(model.totalCostUsd),
      runs: model.runs,
      comments: model.avgComments === null ? "n/a" : model.avgComments.toFixed(1),
      tokens: formatTokens(model.totalTokens),
    });
  }

  return {
    datasets: Array.from(byFamily.values()).sort((left, right) => left.label.localeCompare(right.label)),
  };
}

function scatterPlot(models) {
  const scored = models.filter(
    (model) => typeof model.averageScore === "number" && typeof model.totalCostUsd === "number",
  );
  if (scored.length === 0) {
    return `<p class="muted">No model has both a score and a reliable reported or configured price.</p>`;
  }
  return `<div class="chart-canvas">
    <canvas id="costScoreChart" role="img" aria-label="Total cost versus average score"></canvas>
  </div>`;
}

function resultRows(results) {
  return results
    .map(
      (result) => `<tr>
        <td data-sort="${escapeHtml(sortValue(result.pr))}">${escapeHtml(result.pr)}${result.label ? `<div class="muted">${escapeHtml(result.label)}</div>` : ""}</td>
        <td data-sort="${escapeHtml(sortValue(result.implementation))}">${escapeHtml(result.implementation)}</td>
        <td data-sort="${escapeHtml(sortValue(result.provider))}">${escapeHtml(result.provider)}</td>
        <td data-sort="${escapeHtml(sortValue(result.model))}">${modelName(result.model, result.family)}</td>
        <td data-sort="${escapeHtml(sortValue(result.status))}">${escapeHtml(result.status)}</td>
        <td data-sort="${result.scorePercent ?? -1}">${escapeHtml(result.scoreLabel)}</td>
        <td data-sort="${escapeHtml(sortValue(result.verdictKey))}">${escapeHtml(result.verdictLabel)}</td>
        <td data-sort="${result.captureDurationMs ?? -1}">${escapeHtml(result.captureDurationLabel)}</td>
        <td data-sort="${result.reviewerDurationMs ?? -1}">${escapeHtml(result.reviewerDurationLabel)}</td>
        <td data-sort="${result.usage.totalTokens}">${formatTokens(result.usage.totalTokens)}</td>
        <td data-sort="${result.costUsd ?? -1}">${escapeHtml(result.costLabel || result.reportedCostLabel)}</td>
        <td data-sort="${result.failures.length}">${escapeHtml(result.failures.join(", "))}</td>
        <td data-sort="${result.producedComments}">${formatTokens(result.producedComments)}</td>
        <td data-sort="${escapeHtml(sortValue(result.run))}">${escapeHtml(result.run)}</td>
      </tr>`,
    )
    .join("\n");
}

function questionRows(summary) {
  if (summary.questions.questionIds.length === 0) {
    return `<p class="muted">No judge question scores found.</p>`;
  }
  return `<table class="sortable compact">
    <thead>
      <tr>
        <th>Model</th>
        ${summary.questions.questionIds.map((id) => `<th>${escapeHtml(id)}</th>`).join("")}
      </tr>
    </thead>
    <tbody>
      ${summary.questions.modelRows
        .map(
          (row) => `<tr>
            <td>${modelName(row.model)}</td>
            ${summary.questions.questionIds
              .map((id) => `<td data-sort="${row.scores[id] ?? -1}">${row.scores[id] === null ? "n/a" : row.scores[id].toFixed(1)}</td>`)
              .join("")}
          </tr>`,
        )
        .join("\n")}
    </tbody>
  </table>`;
}

function ignoredEvidence(items) {
  if (items.length === 0) {
    return "";
  }
  return `<details>
    <summary>Excluded evidence (${formatTokens(items.length)})</summary>
    <ul>${items
      .map((item) => {
        const label = item.summaryFile || [item.pr, item.model, item.status].filter(Boolean).join(" · ") || "result";
        const reason = item.error || item.ignoredReason || "superseded by stronger or newer equivalent evidence";
        return `<li><code>${escapeHtml(label)}</code>: ${escapeHtml(reason)}</li>`;
      })
      .join("")}</ul>
  </details>`;
}

function renderBenchmark(summary) {
  const averageOnly = Boolean(summary.filters?.average);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Nibble Review Eval Benchmark</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: Inter, ui-sans-serif, system-ui, sans-serif; margin: 0; color: #111827; background: #f8fafc; }
    main { max-width: 1440px; margin: 0 auto; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 28px 0 12px; font-size: 18px; letter-spacing: 0; }
    p { line-height: 1.5; }
    table { border-collapse: collapse; width: 100%; background: white; border: 1px solid #e5e7eb; table-layout: fixed; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 9px; text-align: left; vertical-align: top; font-size: 13px; overflow-wrap: anywhere; }
    th { background: #f3f4f6; color: #374151; font-weight: 700; cursor: pointer; user-select: none; }
    th.sort-asc::after { content: " asc"; color: #6b7280; font-weight: 500; }
    th.sort-desc::after { content: " desc"; color: #6b7280; font-weight: 500; }
    code { background: #f3f4f6; padding: 2px 4px; border-radius: 3px; white-space: normal; }
    details { margin: 18px 0; }
    summary { cursor: pointer; font-weight: 700; color: #0f766e; }
    .subtitle { margin: 0 0 20px; color: #4b5563; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 20px 0; }
    .kpi { background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px; }
    .kpi-label { color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .kpi-value { margin-top: 6px; font-size: 24px; font-weight: 700; }
    .kpi-sub { margin-top: 4px; color: #6b7280; font-size: 12px; }
    .muted { color: #6b7280; }
    .model-name { display: inline-grid; grid-template-columns: 10px minmax(0, 1fr); align-items: center; gap: 7px; max-width: 100%; min-width: 0; vertical-align: middle; }
    .model-name code { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
    .model-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 999px; background: var(--model-color); flex: 0 0 auto; }
    .matrix th:first-child { width: 180px; }
    .score-cell { min-width: 130px; }
    .score-cell strong, .score-cell span, .score-cell small { display: block; }
    .score-cell small { color: #4b5563; margin-top: 4px; }
    .score-cell.high { background: color-mix(in srgb, var(--model-color) 18%, white); }
    .score-cell.mid { background: color-mix(in srgb, var(--model-color) 12%, white); }
    .score-cell.low { background: color-mix(in srgb, var(--model-color) 8%, white); }
    .score-cell.bad { background: #fee2e2; }
    .score-cell.missing { color: #9ca3af; background: #f9fafb; text-align: center; }
    .chart { background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; max-width: 100%; overflow: hidden; box-sizing: border-box; }
    .chart-canvas { width: 100%; height: clamp(260px, 48vw, 360px); }
    .chart canvas { width: 100%; height: 100%; }
    .compact th, .compact td { font-size: 12px; padding: 7px; }
  </style>
</head>
<body>
  <main>
    <h1>Nibble Review Eval Benchmark</h1>
    <p class="subtitle">${averageOnly
      ? `Generated ${escapeHtml(summary.generatedAt)} from ${summary.sourceSummaries.length} run summaries. Every capture is grouped by exact model and variant.`
      : `Generated ${escapeHtml(summary.generatedAt)} from ${summary.sourceSummaries.length} run summaries. Duplicate PR/model pairs prefer completed judged evidence, then the newest equivalent result.`}</p>
    <p class="subtitle">Capture wall time is the uncached job boundary from input loading through the reviewer container; cache hits are excluded. Reviewer timing is diagnostic only: AML records its full in-memory workflow, while <code>src/</code> sums model phases.</p>
    <section class="kpis">
      ${kpi("Results", formatTokens(summary.totals.results), `${summary.totals.prs} PRs / ${summary.totals.models} models`)}
      ${kpi("Average score", formatPercent(summary.totals.averageScore))}
      ${kpi("Comments", formatTokens(summary.totals.producedComments))}
      ${kpi("Tokens", summary.totals.usageLabels.totalTokens, `${summary.totals.usageLabels.inputTokens} input / ${summary.totals.usageLabels.outputTokens} output`)}
      ${kpi("Reasoning", summary.totals.usageLabels.reasoningTokens, `${summary.totals.usageLabels.cacheReadTokens} cache read`)}
      ${kpi("Known cost", summary.totals.usageLabels.reportedCostUsd)}
      ${kpi("Excluded", formatTokens(summary.ignoredResults.length))}
    </section>

    <h2>Cost vs Score</h2>
    <div class="chart">${scatterPlot(summary.models)}</div>

    <h2>Model Leaderboard</h2>
    <table class="sortable">
      <thead>
        <tr>
          <th>Model</th>
          <th>Implementation</th>
          <th>Provider</th>
          <th>Runs</th>
          <th>Avg Score</th>
          <th>Variance</th>
          <th>Avg capture wall</th>
          <th>Avg reviewer timing</th>
          <th>Avg comments</th>
          <th>Total tokens</th>
          <th>Total cost</th>
          <th>Failures</th>
          <th>Questions</th>
        </tr>
      </thead>
      <tbody>${modelRows(summary.models)}</tbody>
    </table>

    ${averageOnly
      ? ""
      : `<h2>PR x Model Matrix</h2>
    ${matrixTable(summary)}

    <details>
      <summary>All Results</summary>
      <table class="sortable">
        <thead>
          <tr>
            <th>PR</th>
            <th>Implementation</th>
            <th>Provider</th>
            <th>Model</th>
            <th>Status</th>
            <th>Score</th>
            <th>Verdict</th>
            <th>Capture wall</th>
            <th>Reviewer timing</th>
            <th>Tokens</th>
            <th>Cost</th>
            <th>Failures</th>
            <th>Comments</th>
            <th>Run</th>
          </tr>
        </thead>
        <tbody>${resultRows(summary.results)}</tbody>
      </table>
    </details>

    <details>
      <summary>Question Averages</summary>
      ${questionRows(summary)}
    </details>`}

    <details>
      <summary>Source Summaries</summary>
      <ul>${summary.sourceSummaries.map((file) => `<li>${escapeHtml(file)}</li>`).join("")}</ul>
    </details>
    ${ignoredEvidence(summary.ignoredResults)}
  </main>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2"></script>
  <script>
    const costScoreChartData = ${escapeScriptJson(costScoreChartData(summary.models))};
    const costScoreCanvas = document.getElementById("costScoreChart");
    if (costScoreCanvas && window.Chart && costScoreChartData.datasets.length > 0) {
      const scores = costScoreChartData.datasets.flatMap((dataset) => dataset.data.map((point) => point.y));
      let yMin = Math.max(0, Math.floor(Math.min(...scores) / 10) * 10 - 5);
      let yMax = Math.min(100, Math.ceil(Math.max(...scores) / 10) * 10 + 5);
      if (yMin === yMax) {
        yMin = Math.max(0, yMin - 5);
        yMax = Math.min(100, yMax + 5);
      }

      new Chart(costScoreCanvas, {
        type: "scatter",
        data: costScoreChartData,
        plugins: window.ChartDataLabels ? [ChartDataLabels] : [],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          layout: {
            padding: { left: 28, right: 28, bottom: 32 },
          },
          plugins: {
            legend: {
              position: "bottom",
              labels: { usePointStyle: true },
            },
            datalabels: {
              align: "bottom",
              anchor: "center",
              offset: 8,
              clamp: true,
              clip: false,
              textAlign: "center",
              color(context) {
                return context.dataset.borderColor || "#374151";
              },
              font: {
                size: 10,
                weight: "600",
              },
              formatter(value) {
                return String(value?.label || "");
              },
            },
            tooltip: {
              callbacks: {
                label(context) {
                  const point = context.raw || {};
                  return String(point.model || "") + ": " + String(point.scoreLabel || "") + " / " + String(point.costLabel || "");
                },
                afterLabel(context) {
                  const point = context.raw || {};
                  return [
                    "runs: " + String(point.runs || 0),
                    "avg comments: " + String(point.comments || "n/a"),
                    "tokens: " + String(point.tokens || "0"),
                  ];
                },
              },
            },
          },
          elements: {
            point: {
              radius(context) {
                return Math.max(5, Math.min(14, 4 + Number(context.raw?.runs || 1)));
              },
              hoverRadius(context) {
                return Math.max(7, Math.min(16, 6 + Number(context.raw?.runs || 1)));
              },
            },
          },
          scales: {
            x: {
              beginAtZero: true,
              title: { display: true, text: "total reported cost" },
              ticks: {
                callback(value) {
                  return "$" + Number(value).toFixed(4);
                },
              },
            },
            y: {
              min: yMin,
              max: yMax,
              title: { display: true, text: "average score" },
              ticks: {
                callback(value) {
                  return String(Math.round(Number(value))) + "%";
                },
              },
            },
          },
        },
      });
    }

    function cellValue(row, index) {
      const cell = row.children[index];
      const value = cell && cell.dataset ? cell.dataset.sort : "";
      const number = Number(value);
      return Number.isFinite(number) && value.trim() !== "" ? number : String(value || cell.textContent).toLowerCase();
    }

    for (const table of document.querySelectorAll("table.sortable")) {
      for (const [index, header] of Array.from(table.tHead.rows[0].children).entries()) {
        header.addEventListener("click", () => {
          const direction = header.classList.contains("sort-asc") ? -1 : 1;
          for (const th of table.querySelectorAll("th")) {
            th.classList.remove("sort-asc", "sort-desc");
          }
          header.classList.add(direction === 1 ? "sort-asc" : "sort-desc");
          const rows = Array.from(table.tBodies[0].rows);
          rows.sort((left, right) => {
            const a = cellValue(left, index);
            const b = cellValue(right, index);
            if (typeof a === "number" && typeof b === "number") {
              return (a - b) * direction;
            }
            return String(a).localeCompare(String(b)) * direction;
          });
          table.tBodies[0].replaceChildren(...rows);
        });
      }
    }
  </script>
</body>
</html>
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const summaryFiles = options.runsDirs.flatMap(findSummaryFiles);
  if (summaryFiles.length === 0) {
    throw new Error(`no summary.json files found under ${options.runsDirs.join(", ")}`);
  }

  const loaded = loadResults(summaryFiles, { compareRuns: options.compareRuns, average: options.average });
  if (loaded.results.length === 0) {
    throw new Error("no completed run summary contains benchmarkable results");
  }
  const filteredResults =
    options.modelPrefixes.length === 0
      ? loaded.results
      : loaded.results.filter((result) => options.modelPrefixes.some((prefix) => result.model.startsWith(prefix)));
  const filteredOut = loaded.results.filter((result) => !filteredResults.includes(result));
  const summary = buildBenchmarkSummary({
    summaryFiles,
    results: filteredResults,
    ignored: [...loaded.ignored, ...filteredOut.map((result) => ({ ...result, ignoredReason: "model-prefix-filter" }))],
  });
  summary.filters = {
    modelPrefixes: options.modelPrefixes,
    compareRuns: options.compareRuns,
    average: options.average,
  };
  writeJson(options.jsonFile, summary);
  mkdirSync(dirname(options.outFile), { recursive: true });
  writeFileSync(options.outFile, renderBenchmark(summary));
  console.log(`benchmark: ${options.outFile}`);
  console.log(`summary: ${options.jsonFile}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
