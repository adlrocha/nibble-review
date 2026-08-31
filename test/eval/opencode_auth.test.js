import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { stageOpenCodeAuth } from "../eval/lib/opencode-auth.mjs"

test("stages isolated OpenCode auth when no API key is configured", () => {
  const scratch = mkdtempSync(join(tmpdir(), "nibble-opencode-auth-"))
  const sourceData = join(scratch, "source")
  const sourceDirectory = join(sourceData, "opencode")
  const targetData = join(scratch, "target")
  mkdirSync(sourceDirectory, { recursive: true })
  writeFileSync(join(sourceDirectory, "auth.json"), "auth\n", { mode: 0o600 })
  writeFileSync(join(sourceDirectory, "account.json"), "account\n", { mode: 0o600 })

  try {
    const staged = stageOpenCodeAuth(targetData, { XDG_DATA_HOME: sourceData })

    assert.deepEqual(
      staged.map(file => file.split("/").pop()),
      ["auth.json", "account.json"]
    )
    assert.equal(readFileSync(staged[0], "utf8"), "auth\n")
    assert.equal(readFileSync(staged[1], "utf8"), "account\n")
    assert.equal(statSync(staged[0]).mode & 0o777, 0o600)
    assert.equal(statSync(staged[1]).mode & 0o777, 0o600)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("leaves host auth untouched when an API key is configured", () => {
  const scratch = mkdtempSync(join(tmpdir(), "nibble-opencode-auth-"))

  try {
    assert.deepEqual(stageOpenCodeAuth(join(scratch, "target"), { OPENCODE_API_KEY: "configured" }), [])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
