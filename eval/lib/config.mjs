import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const EMPTY_EVAL_CONFIG = {
  models: [],
  input: [],
};

function positiveInteger(value, name) {
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`eval config ${name} must be a positive integer`);
  }
  return number;
}

function normalizeStringArray(value, name) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`eval config ${name} must be a string array`);
  }
  return value;
}

function normalizeInput(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("eval config input must be an array");
  }
  return value;
}

function normalizeConfig(value) {
  const config = value && typeof value === "object" ? value : {};
  const judge = config.judge && typeof config.judge === "object" ? config.judge : {};
  return {
    models: normalizeStringArray(config.models, "models"),
    input: normalizeInput(config.input),
    concurrency: positiveInteger(config.concurrency, "concurrency") ?? 1,
    targetDurationMs: positiveInteger(config.targetDurationMs, "targetDurationMs") ?? 600_000,
    reviewTimeoutMs: positiveInteger(config.reviewTimeoutMs, "reviewTimeoutMs") ?? 1_800_000,
    keepScratch: config.keepScratch === true,
    judge: {
      model: typeof judge.model === "string" ? judge.model : "",
      timeoutMs: positiveInteger(judge.timeoutMs, "judge.timeoutMs") ?? 120_000,
    },
  };
}

async function importJavaScriptConfig(file) {
  const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  return normalizeConfig(module.default || module.config || module);
}

async function importTypeScriptConfig(file) {
  const outDir = join(tmpdir(), "nibble-review-eval-config");
  mkdirSync(outDir, { recursive: true });
  const emitDir = join(outDir, `${basename(file, extname(file))}-${Date.now()}`);
  const compile = spawnSync(
    process.execPath,
    [
      "./node_modules/typescript/bin/tsc",
      "--ignoreConfig",
      file,
      "--outDir",
      emitDir,
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--esModuleInterop",
      "--skipLibCheck",
    ],
    { encoding: "utf8" },
  );
  if (compile.status !== 0) {
    throw new Error(`could not compile eval config: ${compile.stderr || compile.stdout}`);
  }

  try {
    return await importJavaScriptConfig(join(emitDir, `${basename(file, extname(file))}.js`));
  } finally {
    rmSync(emitDir, { recursive: true, force: true });
  }
}

export async function loadEvalConfig(file) {
  if (!file || !existsSync(file)) {
    return { ...EMPTY_EVAL_CONFIG };
  }

  const resolved = resolve(file);
  const ext = extname(resolved);
  if (ext === ".ts" || ext === ".tsx") {
    return importTypeScriptConfig(resolved);
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return importJavaScriptConfig(resolved);
  }
  if (ext === ".json") {
    return normalizeConfig(JSON.parse(readFileSync(resolved, "utf8")));
  }

  throw new Error(`unsupported eval config extension: ${ext || dirname(resolved)}`);
}
