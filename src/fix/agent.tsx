import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Agent, AmlRuntime, Block, Include, localWorkspace, type AgentProvider } from "@aml-jsx/sdk"

import { readPiUsage, type PiUsageTotals } from "../lib/pi-usage.js"
import { quarantineProjectPiConfig } from "../lib/project-pi-config.js"
import { createReviewProvider, type CreateReviewProviderOptions } from "../lib/review-provider.js"
import { REVIEW_POLICY_INCLUDE_LIMIT_BYTES } from "../prompt-limits.js"
import { FixResultSchema, type FixResult } from "./types.js"

export type FixAgentOptions = {
  workspace: string
  /** Rendered fix context; untrusted evidence. */
  context: string
  /** Commands the Agent must get passing, e.g. `npm run lint`. */
  verifyCommands: readonly string[]
  model: string
  thinkingLevel?: string
  signal?: AbortSignal
}

export type FixAgentRun = { result: FixResult; usage: PiUsageTotals }

/**
 * Runs one fixer Agent with read, write, and shell tools in the PR checkout.
 * It must run inside the fix sandbox: the shell is real, and only the
 * sandbox's network and credential boundary contains it.
 */
export async function runFixAgent(
  options: FixAgentOptions,
  createProvider: (options: CreateReviewProviderOptions) => AgentProvider = createReviewProvider
): Promise<FixAgentRun> {
  const restoreProjectPiConfig = quarantineProjectPiConfig(options.workspace)
  const sessionDirectory = mkdtempSync(join(tmpdir(), "nibble-fix-pi-sessions-"))
  try {
    const runtime = new AmlRuntime({
      agentProvider: createProvider({
        model: options.model,
        workspace: options.workspace,
        sessionDirectory,
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {})
      }),
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      maxConcurrentAgents: 1,
      toolPrefix: "fix",
      workspaceProvider: localWorkspace({ directory: options.workspace })
    })
    const verify = options.verifyCommands.length
      ? options.verifyCommands.map(command => `- \`${command}\``).join("\n")
      : "- (none configured; run the project's own lint and test commands for the files you change)"
    // A schema-bearing Agent contributes canonical JSON text; validate it again at this boundary.
    const text = await runtime.evaluate(
      <Agent
        name="fixer"
        permissions={{ filesystem: "read-write", network: false, shell: true }}
        schema={FixResultSchema}
      >
        <Block tag="fix-policy">
          <Include src="./instructions/fix.md" maxBytes={REVIEW_POLICY_INCLUDE_LIMIT_BYTES} title={false} />
        </Block>
        <Block tag="verify-commands">{verify}</Block>
        <Block tag="fix-context">{options.context}</Block>
      </Agent>,
      { ...(options.signal ? { signal: options.signal } : {}) }
    )
    return { result: FixResultSchema.parse(JSON.parse(text)), usage: readPiUsage(sessionDirectory) }
  } finally {
    restoreProjectPiConfig()
    rmSync(sessionDirectory, { recursive: true, force: true })
  }
}
