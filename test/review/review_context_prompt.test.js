import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { Agent, AmlRuntime, localWorkspace, Workspace } from "@aml-jsx/sdk"
import { jsx } from "@aml-jsx/sdk/jsx-runtime"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

import { ReviewContextPrompt } from "../dist/components/review-context-prompt.js"

function materializeContext(t, diff) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "review-context-prompt-"))
  const directory = path.join(workspace, ".nibble-review")
  fs.mkdirSync(directory)
  fs.writeFileSync(
    path.join(directory, "pr.md"),
    "# Pull request #42: Keep review context composable\n\nExplain the intended change.\n\n## Changed files\n\nsrc/example.ts\n"
  )
  fs.writeFileSync(path.join(directory, "pr.diff"), diff)
  fs.writeFileSync(path.join(directory, "history.md"), "# Pull request history\n\n(No history.)\n")
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  return workspace
}

async function render(workspace, props, inspectPrompt) {
  const provider = new DeterministicAgentProvider({
    async respond(request) {
      await inspectPrompt?.(request.prompt)
      return { text: request.prompt }
    }
  })
  const runtime = new AmlRuntime({
    agentProvider: provider,
    workspaceProvider: localWorkspace({ directory: workspace })
  })
  const output = await runtime.evaluate(
    jsx(Workspace, {
      id: "review-context-prompt-test",
      load: false,
      lock: false,
      save: false,
      children: jsx(Agent, {
        permissions: { filesystem: "read-only", network: false, shell: false },
        children: jsx(ReviewContextPrompt, props)
      })
    })
  )

  return { output, request: provider.calls[0].request }
}

test("ReviewContextPrompt includes selected materialized files in tagged sections", async t => {
  const workspace = materializeContext(t, "one two\nthree")
  const { output, request } = await render(workspace, { diff: true, history: true })

  assert.deepEqual(request.skills, [])
  assert.match(output, /<pull-request-context>/u)
  assert.match(output, /### File: `\.nibble-review\/pr\.md` — pull-request context and changed files/u)
  assert.match(
    output,
    /Use the PR description, refs, commits, and changed-file inventory as intent and scope evidence/u
  )
  assert.match(output, /Do not fetch the same pull-request data again\./u)
  assert.match(output, /Explain the intended change\./u)
  assert.match(output, /src\/example\.ts/u)
  assert.match(output, /<pull-request-diff>/u)
  assert.match(output, /### File: `\.nibble-review\/pr\.diff` — pull-request diff/u)
  assert.match(output, /one two\nthree/u)
  assert.match(output, /<pull-request-history>/u)
  assert.match(output, /### File: `\.nibble-review\/history\.md` — pull-request history/u)
  assert.doesNotMatch(output, /exceeding the 32768-byte inline limit/u)
})

test("ReviewContextPrompt reads each materialized file live for every evaluation", async t => {
  const workspace = materializeContext(t, "one two\nthree")
  const historyPath = path.join(workspace, ".nibble-review", "history.md")

  const { output: first } = await render(workspace, { history: true })
  fs.writeFileSync(historyPath, "# Pull request history\n\nA new decision was recorded.\n")
  const { output: second } = await render(workspace, { history: true })

  assert.doesNotMatch(first, /A new decision was recorded/u)
  assert.match(second, /A new decision was recorded/u)
})

test("ReviewContextPrompt keeps an empty materialized file inline", async t => {
  const workspace = materializeContext(t, "")
  const { output } = await render(workspace, { diff: true })

  assert.match(output, /<pull-request-diff>/u)
  assert.match(output, /### File: `\.nibble-review\/pr\.diff` — pull-request diff/u)
  assert.doesNotMatch(output, /exceeding the 32768-byte inline limit/u)
  assert.doesNotMatch(output, /\(Empty\.\)/u)
})

test("ReviewContextPrompt gives its Agent a readable path for oversized materialized files", async t => {
  const largeDiff = `${"changed line\n".repeat(4_000)}private-tail-marker`
  const workspace = materializeContext(t, largeDiff)
  let stagedContent
  const { output } = await render(workspace, { diff: true }, prompt => {
    const stagedPath = prompt.match(/Read it at `([^`]+)`\./u)?.[1]
    assert.ok(stagedPath, "AML did not provide a staged path for the oversized diff")
    stagedContent = fs.readFileSync(stagedPath, "utf8")
  })

  assert.match(
    output,
    new RegExp(`The file is ${Buffer.byteLength(largeDiff)} bytes, exceeding the 32768-byte inline limit`, "u")
  )
  assert.match(output, /read it completely before staging findings/u)
  assert.doesNotMatch(output, /private-tail-marker/u)
  assert.match(stagedContent, /private-tail-marker$/u)
  assert.match(output, /changed-file inventory/u)
  assert.doesNotMatch(output, /pull-request history/u)
})
