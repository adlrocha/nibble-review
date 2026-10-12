import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import {
  cacheEntryDir,
  readJsonFile,
  writeJsonFile,
} from "./lib/cache.mjs"
import { loadEvalConfig } from "./lib/config.mjs"
import { judgeCacheKey } from "./lib/judge-cache-key.mjs"
import { JudgeAttemptStore } from "./lib/judge-attempts.mjs"
import { buildJudgePrompt } from "./lib/judge-prompt.mjs"
import { JUDGE_RUBRIC } from "./lib/judge-rubric.mjs"
import { normalizeEvalModel } from "./lib/models.mjs"
import { cleanupScratch, piJudgeCommand } from "./lib/pi-judge.mjs"
import { evalJobKey } from "./lib/job-key.mjs"
import { completedJobArtifacts } from "./lib/job-artifacts.mjs"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function readJsonOr(file, fallback) {
  if (!existsSync(file)) {
    return fallback
  }
  return readJson(file)
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function writeText(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, value, { mode: 0o600 })
}

function parseArgs(argv) {
  const options = {
    runDir: "",
    configFile: "",
    model: "",
    timeoutMs: undefined,
    force: false,
    cacheDir: resolve(repoRoot, "eval", "cache", "judgments"),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--run") {
      options.runDir = resolve(argv[++index])
    } else if (arg === "--config") {
      options.configFile = resolve(argv[++index])
    } else if (arg === "--model") {
      options.model = argv[++index] || ""
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index])
    } else if (arg === "--force") {
      options.force = true
    } else if (arg === "--cache-dir") {
      options.cacheDir = resolve(argv[++index])
    } else if (arg === "--help" || arg === "-h") {
      options.help = true
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  return options
}

function printHelp() {
  console.log(`Usage: node eval/judge.mjs --run <dir> [options]

Options:
  --run <dir>         Eval run directory containing run.json
  --config <file>     Config for judge defaults. Default: run.json config, then eval/config.ts
  --model <model>     Judge model override
  --timeout-ms <ms>   Judge timeout override
  --force             Rejudge captures and bypass the global judgment cache
  --cache-dir <dir>   Global judgment cache. Default: eval/cache/judgments
`)
}

function resolveJudgeConfigFile(explicitConfigFile, run) {
  return resolve(explicitConfigFile || run?.configFile || join(repoRoot, "eval", "config.ts"))
}

function restoreJudgeCache({ cacheDir, key, jobDir, jobKey, model }) {
  const entryDir = cacheEntryDir(cacheDir, key)
  const cached = readJsonFile(join(entryDir, "judge.json"))
  if (!cached || cached.status !== "completed") {
    return null
  }

  const restored = new JudgeAttemptStore(jobDir).restoreCache(entryDir, cached)
  const judgment = {
    ...restored,
    jobKey,
    model,
    cache: {
      hit: true,
      key,
      dir: entryDir,
    },
  }
  writeJson(join(jobDir, "judge.json"), judgment)
  return judgment
}

function saveJudgeCache({ cacheDir, key, jobDir, judgment }) {
  if (judgment.status !== "completed") {
    return
  }
  const entryDir = cacheEntryDir(cacheDir, key)
  const cached = new JudgeAttemptStore(jobDir).writeCache(entryDir, judgment)
  writeJsonFile(join(entryDir, "judge.json"), {
    ...cached,
    cache: {
      hit: false,
      key,
    },
  })
}

function parseJudgeJson(text) {
  const trimmed = String(text || "").trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed)
  const source = fenced ? fenced[1] : trimmed
  try {
    return normalizeJudgeOutput(JSON.parse(source))
  } catch {
    const match = source.match(/\{[\s\S]*\}/u)
    if (!match) {
      throw new Error("judge output did not contain a JSON object")
    }
    return normalizeJudgeOutput(JSON.parse(match[0]))
  }
}

function scoreFromUnknown(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return null
  }
  const normalized = numeric > 10 ? numeric / 10 : numeric
  return Math.max(0, Math.min(10, Number(normalized.toFixed(1))))
}

function normalizeVerdict(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_")
  if (["lgtm", "good", "pass", "passed", "approve", "approved"].includes(normalized)) {
    return "lgtm"
  }
  if (["request_changes", "request_change", "changes", "block", "blocked", "fail", "failed"].includes(normalized)) {
    return "request_changes"
  }
  return "error"
}

function normalizeQuestion(raw, fallback) {
  const question = raw && typeof raw === "object" ? raw : {}
  return {
    id: String(question.id || fallback.id).trim(),
    question: String(question.question || fallback.question).trim(),
    score: scoreFromUnknown(question.score) ?? 0,
    reason: String(question.reason || question.answer || question.evidence || question.notes || question.rationale || "").trim(),
  }
}

function normalizeQuestions(value) {
  const rawQuestions = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value).map(([id, item]) => ({
          id,
          ...(item && typeof item === "object" ? item : { score: item }),
        }))
      : []
  const byId = new Map(rawQuestions.map((item) => [String(item?.id || ""), item]))
  return JUDGE_RUBRIC.map((rubricItem) => normalizeQuestion(byId.get(rubricItem.id), rubricItem))
}

function averageQuestionScore(questions) {
  if (questions.length === 0) {
    return 0
  }
  return Number((questions.reduce((sum, question) => sum + question.score, 0) / questions.length).toFixed(1))
}

function normalizeStringList(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 5) : []
}

function normalizeJudgeOutput(value) {
  const raw = value && typeof value === "object" ? value : {}
  const questions = normalizeQuestions(raw.questions || raw.answers || raw.rubric || raw.scores)
  const score = questions.length > 0 ? averageQuestionScore(questions) : (scoreFromUnknown(raw.score) ?? 0)
  const notes = String(raw.notes || raw.summary || "").trim()
  return {
    score,
    verdict: normalizeVerdict(raw.verdict),
    reason: String(raw.reason || notes).trim(),
    questions,
    strengths: normalizeStringList(raw.strengths),
    risks: normalizeStringList(raw.risks),
    notes,
  }
}

function runJudge({ model, jobDir, job, timeoutMs, files }) {
  return new Promise((resolveJudge) => {
    const scratchRoot = join(tmpdir(), "nibble-review-eval-judge", `${Date.now()}-${job.input.slug}`)
    const home = join(scratchRoot, "home")
    mkdirSync(home, { recursive: true })

    const rawFile = files.raw
    const stderrFile = files.stderr
    const prompt = buildJudgePrompt({ repoRoot, job })
    const attachedFiles = [
      join(jobDir, "artifacts", "review_model_context.json"),
      join(jobDir, "artifacts", "pr.diff"),
      join(jobDir, "artifacts", "review_queue.json"),
      join(jobDir, "artifacts", "review_payload.json"),
      join(jobDir, "artifacts", "review_validated.json"),
      join(jobDir, "artifacts", "review_validation_context.json"),
      join(jobDir, "artifacts", "audit_model_context.json"),
      join(jobDir, "review.md"),
      join(jobDir, "review_comments.json"),
      join(jobDir, "review_stats.json"),
      join(jobDir, "review_transcript.md"),
    ].filter((file) => existsSync(file))
    const judge = piJudgeCommand({ repoRoot, model, files: attachedFiles, prompt, home })
    let stdout = ""
    let stderr = ""
    let settled = false
    // Every judge attachment lives under the job directory; cwd keeps pi's
    // read tools pointed there rather than at the source checkout.
    const child = spawn(judge.command, judge.args, {
      cwd: jobDir,
      env: judge.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })

    const finish = (result) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (killTimer) {
        clearTimeout(killTimer)
      }
      writeText(rawFile, stdout)
      writeText(stderrFile, stderr)
      cleanupScratch(scratchRoot, false)
      resolveJudge({
        ...result,
        files: {
          raw: rawFile,
          stderr: stderrFile,
        },
      })
    }

    let killTimer = null
    const killGroup = (signal) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal)
        } catch (error) {
          if (error?.code !== "ESRCH") {
            child.kill(signal)
          }
        }
      }
    }
    const timer = setTimeout(() => {
      killGroup("SIGTERM")
      // A provider child can outlive the judge. Bound cleanup so a judge
      // timeout cannot hold the sequential evaluator forever.
      killTimer = setTimeout(() => {
        killGroup("SIGKILL")
        finish({ status: "failed", error: `judge timed out after ${timeoutMs}ms` })
      }, 5_000)
      killTimer.unref()
    }, timeoutMs).unref()

    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      finish({ status: "failed", error: error.message })
    })
    child.on("close", (status) => {
      if (status !== 0) {
        finish({ status: "failed", error: `judge exited ${status}` })
        return
      }
      // `pi -p` prints only the final assistant text.
      const rendered = stdout.trim()
      try {
        finish({ status: "completed", judgment: parseJudgeJson(rendered), error: null })
      } catch (error) {
        finish({ status: "failed", error: error instanceof Error ? error.message : String(error), rendered })
      }
    })
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (!options.runDir) {
    throw new Error("--run is required")
  }

  // Captures retain the config that defined their judge model and timeout. Reuse
  // it by default so a later judge invocation cannot silently change semantics.
  const run = readJson(join(options.runDir, "run.json"))
  const config = await loadEvalConfig(resolveJudgeConfigFile(options.configFile, run))
  const model = normalizeEvalModel(options.model || config.judge.model, "judge model")
  if (!model) {
    throw new Error("judge model is required; set config.judge.model or pass --model")
  }
  const timeoutMs = options.timeoutMs || config.judge.timeoutMs
  const existingJudgments =
    readJsonOr(join(options.runDir, "judgments.json"), { judgments: [] }).judgments?.filter(
      (judgment) => judgment && typeof judgment === "object",
    ) || []
  const existingByJob = new Map(existingJudgments.map((judgment) => [judgment.jobKey, judgment]))
  const judgments = []

  for (const job of run.jobs || []) {
    const jobKey = evalJobKey(job)
    const jobDir = join(options.runDir, "jobs", jobKey)
    if (job.status !== "completed" || !completedJobArtifacts(jobDir)) {
      judgments.push({ jobKey, status: "skipped", error: "capture did not complete" })
      continue
    }
    const cacheKey = judgeCacheKey({ repoRoot, model, jobDir, job })
    const existing = existingByJob.get(jobKey)
    if (!options.force && existing?.status === "completed" && existing.model === model && existing.cache?.key === cacheKey) {
      judgments.push(existing)
      console.log(`skipping existing judgment ${jobKey}`)
      continue
    }
    if (!options.force) {
      const cached = restoreJudgeCache({ cacheDir: options.cacheDir, key: cacheKey, jobDir, jobKey, model })
      if (cached) {
        judgments.push(cached)
        console.log(`judgment cache hit ${jobKey}`)
        continue
      }
    }
    console.log(`judging ${jobKey} with ${model}`)
    const attemptStore = new JudgeAttemptStore(jobDir)
    const attempt = attemptStore.start()
    const startedAt = new Date().toISOString()
    const result = await runJudge({ model, jobDir, job, timeoutMs, files: attempt.files })
    const endedAt = new Date().toISOString()
    const judgment = {
      jobKey,
      model,
      status: result.status,
      startedAt,
      endedAt,
      error: result.error || null,
      ...(result.judgment || {}),
      files: result.files,
      cache: {
        hit: false,
        key: cacheKey,
        dir: cacheEntryDir(options.cacheDir, cacheKey),
      },
    }
    const recordedJudgment = attemptStore.record(attempt, judgment)
    judgments.push(recordedJudgment)
    saveJudgeCache({ cacheDir: options.cacheDir, key: cacheKey, jobDir, judgment: recordedJudgment })
  }

  writeJson(join(options.runDir, "judgments.json"), {
    generatedAt: new Date().toISOString(),
    judgeModel: model,
    judgments,
  })
  console.log(
    `judged ${judgments.filter((judgment) => judgment.status === "completed").length}/${judgments.length} captures`,
  )
}

export { resolveJudgeConfigFile }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}
