import { rmSync } from "node:fs"
import { join } from "node:path"

/** Same isolation the reviewer uses: nothing from the job directory can extend pi. */
const PI_ISOLATION_FLAGS = [
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
]

const CREDENTIAL_ENVIRONMENT = /^[A-Z][A-Z0-9_]*_API_KEY$/u

/**
 * Builds one non-interactive, read-only pi judge invocation. Attachments are
 * inlined with pi's @file syntax and the judge may re-read them from cwd.
 */
export function piJudgeCommand({ repoRoot, model, files, prompt, home, environment = process.env }) {
  return {
    command: process.execPath,
    args: [
      join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
      "-p",
      "--model",
      model,
      "--no-session",
      "--tools",
      "read,grep,find,ls",
      ...PI_ISOLATION_FLAGS,
      ...files.map((file) => `@${file}`),
      prompt,
    ],
    env: {
      PATH: environment.PATH || "",
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      ...Object.fromEntries(
        Object.entries(environment).filter(([key, value]) => CREDENTIAL_ENVIRONMENT.test(key) && String(value || "").trim()),
      ),
    },
  }
}

export function cleanupScratch(path, keepScratch) {
  if (!keepScratch) {
    rmSync(path, { recursive: true, force: true })
  }
}
