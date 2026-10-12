import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { preparePullRequestWorkspace } from "../../eval/lib/github.mjs"

const HEAD = "2222222222222222222222222222222222222222"

function executable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 })
}

function commandFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-workspace-"))
  const commands = path.join(directory, "commands")
  const log = path.join(directory, "commands.log")
  fs.mkdirSync(commands)
  executable(
    path.join(commands, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gh|%s|%s\n' "$GH_TOKEN" "$*" >> "$COMMAND_LOG"
mkdir -p "$4/.git"
`
  )
  executable(
    path.join(commands, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'git|%s|%s|%s\n' "\${GIT_CONFIG_COUNT:-}" "\${GIT_CONFIG_KEY_0:-}" "$*" >> "$COMMAND_LOG"
if [[ "$*" == *"rev-parse HEAD"* ]]; then
  printf '%s\n' "\${FIXTURE_HEAD}"
fi
`
  )

  const previous = {
    COMMAND_LOG: process.env.COMMAND_LOG,
    FIXTURE_HEAD: process.env.FIXTURE_HEAD,
    PATH: process.env.PATH
  }
  process.env.COMMAND_LOG = log
  process.env.FIXTURE_HEAD = HEAD
  process.env.PATH = `${commands}:${process.env.PATH || ""}`
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })

  return { directory, log }
}

test("eval prepares the immutable pull-request checkout before starting the reviewer container", async t => {
  const fixture = commandFixture(t)
  const workspace = path.join(fixture.directory, "workspace")

  await preparePullRequestWorkspace(
    { repository: "owner/repository", number: 42, headSha: HEAD },
    workspace,
    "fixture-token"
  )

  const calls = fs.readFileSync(fixture.log, "utf8")
  assert.match(calls, /^gh\|fixture-token\|repo clone owner\/repository .* -- --filter=blob:none$/mu)
  assert.match(
    calls,
    /git\|1\|url\.https:\/\/x-access-token:fixture-token@github\.com\/\.insteadOf\|-C .* fetch origin pull\/42\/head:refs\/remotes\/eval\/pr-42/u
  )
  assert.match(calls, new RegExp(`git\\|\\|\\|-C .* checkout --detach ${HEAD}`, "u"))
})

test("eval rejects a checkout that does not match the configured head", async t => {
  const fixture = commandFixture(t)
  const workspace = path.join(fixture.directory, "workspace")
  process.env.FIXTURE_HEAD = "3333333333333333333333333333333333333333"

  await assert.rejects(
    preparePullRequestWorkspace(
      { repository: "owner/repository", number: 42, headSha: HEAD },
      workspace,
      "fixture-token"
    ),
    /checked out head .* does not match requested/u
  )
})

test("eval refuses to prepare a mutable pull-request ref", async t => {
  const fixture = commandFixture(t)
  const workspace = path.join(fixture.directory, "workspace")

  await assert.rejects(
    preparePullRequestWorkspace(
      { repository: "owner/repository", number: 42, headSha: null },
      workspace,
      "fixture-token"
    ),
    /requires a resolved 40-character pull-request head SHA/u
  )
  assert.equal(fs.existsSync(fixture.log), false)
})
