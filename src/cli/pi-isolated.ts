#!/usr/bin/env node
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { PI_CLI_ENV, PI_FORWARD_ENV, PI_SESSION_DIR_ENV } from "../lib/pi-env.js"

/** Flags that stop pi from loading anything the reviewed repository controls. */
export const PI_ISOLATION_FLAGS = [
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files"
] as const

/** Runtime, AML-owned pi state, and network plumbing that pi needs regardless of provider. */
const BASE_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_SKIP_VERSION_CHECK",
  "PI_OFFLINE",
  "PI_TELEMETRY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE"
]

/**
 * Builds pi's environment from an allowlist. pi's read tool can open
 * /proc/self/environ, so GitHub and Actions runtime tokens must never be here.
 */
export function isolatedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const forwarded = (env[PI_FORWARD_ENV] || "")
    .split(",")
    .map(name => name.trim())
    .filter(Boolean)
  const isolated: Record<string, string> = Object.fromEntries(
    [...BASE_ENV, ...forwarded].flatMap(name => {
      const value = env[name]
      return value === undefined ? [] : [[name, value]]
    })
  )
  // AML points sessions at its own temporary state; the runner needs them to
  // survive long enough to read pi's per-message usage.
  const sessionDirectory = env[PI_SESSION_DIR_ENV]
  return sessionDirectory ? { ...isolated, PI_CODING_AGENT_SESSION_DIR: sessionDirectory } : isolated
}

/** Builds the argv for the real pi CLI. */
export function isolatedArgs(cli: string, args: readonly string[]): string[] {
  return [cli, ...PI_ISOLATION_FLAGS, ...args]
}

function main(): void {
  const cli = process.env[PI_CLI_ENV]
  if (!cli) {
    process.stderr.write(`pi-isolated: ${PI_CLI_ENV} is not set\n`)
    process.exit(1)
  }
  const child = spawn(process.execPath, isolatedArgs(cli, process.argv.slice(2)), {
    env: isolatedEnv(process.env),
    stdio: "inherit"
  })
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal))
  }
  child.on("error", error => {
    process.stderr.write(`pi-isolated: cannot start pi: ${error.message}\n`)
    process.exit(1)
  })
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 128 : 1))
  })
}

const entrypoint = process.argv[1]
if (entrypoint && realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}
