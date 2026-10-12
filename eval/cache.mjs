import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheEntryDir, copyExistingFile, readJsonFile, writeJsonFile } from "./lib/cache.mjs";
import { JudgeAttemptStore } from "./lib/judge-attempts.mjs";
import { judgeCacheKey } from "./lib/judge-cache-key.mjs";
import { evalJobKey } from "./lib/job-key.mjs";
import { REVIEW_CACHE_VERSION, reviewCacheKey } from "./lib/review-cache-key.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Cache seeding remains able to import pre-migration runs so the historical
// source-versus-AML benchmark does not disappear with the production runner.
const HISTORICAL_RUNTIME_ARTIFACTS = [
  "review_payload.json",
  "review_validated.json",
  "review_validation_context.json",
  "review_model_context.json",
  "audit_model_context.json",
  "review_queue.json",
  "pr.diff",
];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function parseArgs(argv) {
  const options = {
    runsDirs: [],
    reviewCacheDir: resolve(repoRoot, "eval", "cache", "reviews"),
    judgmentCacheDir: resolve(repoRoot, "eval", "cache", "judgments"),
    force: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runs") {
      options.runsDirs.push(resolve(argv[++index]));
    } else if (arg === "--review-cache-dir") {
      options.reviewCacheDir = resolve(argv[++index]);
    } else if (arg === "--judgment-cache-dir") {
      options.judgmentCacheDir = resolve(argv[++index]);
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (options.runsDirs.length === 0) {
    options.runsDirs.push(resolve(repoRoot, "eval", "runs"));
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node eval/cache.mjs [options]

Seed global eval caches from existing run artifacts without calling models.

Options:
  --runs <dir>              Directory containing eval runs. Can repeat. Default: eval/runs
  --review-cache-dir <dir>  Review cache dir. Default: eval/cache/reviews
  --judgment-cache-dir <dir>
                            Judgment cache dir. Default: eval/cache/judgments
  --force                   Replace existing cache entries
`);
}

function findRunFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(root)) {
    const file = join(root, entry);
    const stat = statSync(file);
    if (stat.isDirectory()) {
      files.push(...findRunFiles(file));
    } else if (entry === "run.json") {
      files.push(file);
    }
  }
  return files;
}

function jobKey(job) {
  return evalJobKey(job);
}

function artifactPath(runDir, file) {
  if (!file) {
    return "";
  }
  return file.startsWith("/") ? file : join(runDir, file);
}

function copyReviewArtifacts({ entryDir, runDir, job }) {
  const key = jobKey(job);
  const jobDir = join(runDir, "jobs", key);
  const artifacts = {
    "review.md": artifactPath(runDir, job.files?.review) || join(jobDir, "review.md"),
    "review_transcript.md": artifactPath(runDir, job.files?.transcript) || join(jobDir, "review_transcript.md"),
    "review_comments.json": artifactPath(runDir, job.files?.comments) || join(jobDir, "review_comments.json"),
    "review_stats.json": artifactPath(runDir, job.files?.stats) || join(jobDir, "review_stats.json"),
    "provider_completions.jsonl": artifactPath(runDir, job.files?.providerCompletions) || join(jobDir, "provider_completions.jsonl"),
    "reviewer.stdout.log": artifactPath(runDir, job.files?.stdout) || join(jobDir, "reviewer.stdout.log"),
    "reviewer.stderr.log": artifactPath(runDir, job.files?.stderr) || join(jobDir, "reviewer.stderr.log"),
  };
  for (const [target, source] of Object.entries(artifacts)) {
    copyExistingFile(source, join(entryDir, target));
  }
  for (const file of HISTORICAL_RUNTIME_ARTIFACTS) {
    copyExistingFile(join(jobDir, "artifacts", file), join(entryDir, "artifacts", file));
  }
}

function seedReviewCache({ runDir, run, job, cacheDir, force }) {
  const key = jobKey(job);
  const jobDir = join(runDir, "jobs", key);
  const contextFile = artifactPath(runDir, job.files?.context) || join(jobDir, "artifacts", "review_model_context.json");
  const diffFile = artifactPath(runDir, job.files?.diff) || join(jobDir, "artifacts", "pr.diff");
  const reviewFile = artifactPath(runDir, job.files?.review) || join(jobDir, "review.md");
  const commentsFile = artifactPath(runDir, job.files?.comments) || join(jobDir, "review_comments.json");
  const statsFile = artifactPath(runDir, job.files?.stats) || join(jobDir, "review_stats.json");
  const providerCompletionsFile =
    artifactPath(runDir, job.files?.providerCompletions) || join(jobDir, "provider_completions.jsonl");
  if (
    job.status !== "completed" ||
    !existsSync(contextFile) ||
    !existsSync(diffFile) ||
    !existsSync(reviewFile) ||
    !existsSync(commentsFile) ||
    !existsSync(statsFile) ||
    !existsSync(providerCompletionsFile)
  ) {
    return "skipped";
  }

  const context = readJson(contextFile);
  const diffText = readFileSync(diffFile, "utf8");
  const cacheKey = reviewCacheKey({
    runner: job.runner,
    provider: job.provider,
    model: job.model,
    // Runs without a reviewer identity remain seedable, but their cache keys
    // cannot collide with a live capture from an identified reviewer.
    reviewerId: run.reviewerId || null,
    input: job.input,
    context,
    diffText,
  });
  const entryDir = cacheEntryDir(cacheDir, cacheKey);
  if (!force && existsSync(join(entryDir, "cache.json"))) {
    return "existing";
  }

  copyReviewArtifacts({ entryDir, runDir, job });
  writeJsonFile(join(entryDir, "cache.json"), {
    version: REVIEW_CACHE_VERSION,
    capture: "review-dry-run",
    status: "completed",
    key: cacheKey,
    model: job.model,
    runner: job.runner || "src",
    provider: job.runner === "aml" ? job.provider || "opencode" : null,
    reviewerId: run.reviewerId || null,
    input: job.input,
    outputBytes: job.outputBytes || statSync(reviewFile).size,
    sourceRun: relative(repoRoot, runDir).split("\\").join("/"),
    createdAt: new Date().toISOString(),
  });
  return "seeded";
}

function seedJudgmentCache({ runDir, job, judgment, cacheDir, force }) {
  const key = jobKey(job);
  const jobDir = join(runDir, "jobs", key);
  const judgeFile = join(jobDir, "judge.json");
  if (job.status !== "completed" || judgment?.status !== "completed" || !judgment.model || !existsSync(judgeFile)) {
    return "skipped";
  }

  const cacheKey = judgeCacheKey({ repoRoot, model: judgment.model, jobDir, job });
  const entryDir = cacheEntryDir(cacheDir, cacheKey);
  if (!force && existsSync(join(entryDir, "judge.json"))) {
    return "existing";
  }

  const cached = new JudgeAttemptStore(jobDir).writeCache(entryDir, readJson(judgeFile));
  writeJsonFile(join(entryDir, "judge.json"), {
    ...cached,
    cache: {
      hit: false,
      key: cacheKey,
      sourceRun: relative(repoRoot, runDir).split("\\").join("/"),
    },
  });
  return "seeded";
}

function increment(counts, type, status) {
  counts[type][status] = (counts[type][status] || 0) + 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  mkdirSync(options.reviewCacheDir, { recursive: true });
  mkdirSync(options.judgmentCacheDir, { recursive: true });
  const counts = {
    review: {},
    judgment: {},
  };

  for (const runFile of options.runsDirs.flatMap(findRunFiles)) {
    const runDir = dirname(runFile);
    const run = readJson(runFile);
    const judgments =
      readJsonFile(join(runDir, "judgments.json"), { judgments: [] }).judgments?.filter(
        (judgment) => judgment && typeof judgment === "object",
      ) || [];
    const judgmentByJob = new Map(judgments.map((judgment) => [judgment.jobKey, judgment]));

    for (const job of run.jobs || []) {
      increment(
        counts,
        "review",
        seedReviewCache({ runDir, run, job, cacheDir: options.reviewCacheDir, force: options.force }),
      );
      increment(
        counts,
        "judgment",
        seedJudgmentCache({
          runDir,
          job,
          judgment: judgmentByJob.get(jobKey(job)),
          cacheDir: options.judgmentCacheDir,
          force: options.force,
        }),
      );
    }
  }

  console.log(`review cache: ${JSON.stringify(counts.review)}`);
  console.log(`judgment cache: ${JSON.stringify(counts.judgment)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
