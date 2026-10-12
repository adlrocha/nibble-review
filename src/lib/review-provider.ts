import { piAgent, type AgentProvider } from "@aml-jsx/sdk"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { PI_CLI_ENV, PI_FORWARD_ENV, PI_SESSION_DIR_ENV } from "./pi-env.js"

export type CreateReviewProviderOptions = {
  model: string
  workspace: string
  /** Where pi writes session logs, read afterwards for token usage and cost. */
  sessionDirectory?: string
  /** pi CLI entrypoint run by the isolated launcher; defaults to the installed pi package. */
  piCli?: string
  /** pi reasoning effort: off, minimal, low, medium, high, xhigh. pi's own default is medium. */
  thinkingLevel?: string
}

/** Provider credentials pi may need. Everything else, including GitHub tokens, stays out of its process. */
const CREDENTIAL_ENV =
  /^(?:[A-Z][A-Z0-9_]*_API_KEY|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|REGION|PROFILE)|AZURE_OPENAI_[A-Z_]+|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_LOCATION)$/u

/** Lists credential variable names present in `env` that pi may receive. */
export function credentialEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter(name => CREDENTIAL_ENV.test(name) && Boolean(env[name]))
    .toSorted()
}

/**
 * Finds an installed package file by walking up from this module, so the
 * reviewer works from a source checkout, an npm install, or a hoisted tree.
 */
export function resolvePackageFile(packageName: string, file: string, from = fileURLToPath(import.meta.url)): string {
  let directory = dirname(from)
  for (;;) {
    const candidate = join(directory, "node_modules", packageName, file)
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error(`cannot find ${packageName}/${file}; reinstall nibble-review dependencies`)
    }
    directory = parent
  }
}

/** Creates the AML pi provider with project resources disabled and a minimal child environment. */
export function createReviewProvider(
  options: CreateReviewProviderOptions,
  env: NodeJS.ProcessEnv = process.env
): AgentProvider {
  return piAgent({
    // Launch through Node so the adapter never depends on executable bits or PATH.
    command: process.execPath,
    args: [resolvePackageFile("pi-acp", "dist/index.js")],
    piCommand: fileURLToPath(new URL("../cli/pi-isolated.js", import.meta.url)),
    mcpAdapterPath: resolvePackageFile("pi-mcp-adapter", "index.ts"),
    env: {
      [PI_CLI_ENV]: options.piCli || resolvePackageFile("@earendil-works/pi-coding-agent", "dist/bundle/cli.js"),
      [PI_FORWARD_ENV]: credentialEnvNames(env).join(","),
      ...(options.sessionDirectory ? { [PI_SESSION_DIR_ENV]: options.sessionDirectory } : {}),
      // Reviews are ephemeral; never phone home for updates or install telemetry.
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0"
    },
    model: options.model,
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    workingDirectory: options.workspace
  })
}
