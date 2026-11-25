import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { main } from "../../dist/cli/land.js"
import { createGitHubClient } from "../../dist/services/github/client.js"

const sha = "a".repeat(40)

/** Serves canned GitHub REST responses by path, and fails on anything else. */
function mockRest(t, routes) {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async input => {
    const url = new URL(String(input))
    const route = routes[decodeURIComponent(url.pathname)]
    const response = new Response(JSON.stringify(route ?? {}), {
      status: route === undefined ? 404 : 200,
      headers: { "content-type": "application/json" }
    })
    // Pagination reads the URL, which a constructed response leaves empty.
    return Object.defineProperty(response, "url", { value: url.href })
  }
  t.after(() => {
    globalThis.fetch = previousFetch
  })
  return createGitHubClient({ token: "test-token", repository: "o/r" })
}

test("checks combine runs and the newest status of each context", async t => {
  const run = (name, status, conclusion) => ({ name, status, conclusion })
  const github = mockRest(t, {
    [`/repos/o/r/commits/${sha}/check-runs`]: {
      total_count: 5,
      check_runs: [
        run("test", "completed", "success"),
        run("optional", "completed", "skipped"),
        run("info", "completed", "neutral"),
        run("lint", "completed", "failure"),
        run("e2e", "in_progress", null)
      ]
    },
    [`/repos/o/r/commits/${sha}/statuses`]: [
      { context: "deploy", state: "success" },
      { context: "deploy", state: "failure" },
      { context: "scan", state: "pending" },
      { context: "legacy", state: "error" }
    ]
  })
  const check = (name, state, source = "run") => ({ name, state, source })
  assert.deepEqual(await github.listCommitChecks(sha), [
    check("test", "success"),
    check("optional", "skipped"),
    check("info", "skipped"),
    check("lint", "failure"),
    check("e2e", "pending"),
    check("deploy", "success", "status"),
    check("scan", "pending", "status"),
    check("legacy", "failure", "status")
  ])
})

test("an App's threads carry the login REST gives its bot", async t => {
  const thread = author => ({ id: "t", isResolved: false, comments: { nodes: [{ body: "x", author }] } })
  const github = mockRest(t, {
    "/graphql": {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                thread({ login: "github-actions", __typename: "Bot" }),
                thread({ login: "nibble[bot]", __typename: "Bot" }),
                thread({ login: "ana", __typename: "User" }),
                thread(null)
              ],
              pageInfo: { hasNextPage: false }
            }
          }
        }
      }
    }
  })
  const { threads } = await github.listReviewThreads(1)
  assert.deepEqual(
    threads.map(({ comments }) => comments[0].user.login),
    ["github-actions[bot]", "nibble[bot]", "ana", null]
  )
})

test("base drift lists both names of a rename and flags a partial list", async t => {
  const compared = files => mockRest(t, { [`/repos/o/r/compare/${sha}...main`]: files === null ? {} : { files } })
  assert.deepEqual(
    await compared([{ filename: "b.ts", previous_filename: "a.ts" }, { filename: "c.ts" }]).getBaseDrift("main", sha),
    { files: ["b.ts", "a.ts", "c.ts"], truncated: false }
  )
  assert.deepEqual(await compared(null).getBaseDrift("main", sha), { files: [], truncated: false })
  const many = Array.from({ length: 300 }, (_, index) => ({ filename: `${index}.ts` }))
  assert.equal((await compared(many).getBaseDrift("main", sha)).truncated, true)
})

test("the json entry point prints one bundle, reading a replacement policy from disk", async t => {
  const config = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "land-")), "sdlc.toml")
  fs.writeFileSync(config, '[land]\nmode = "off"\n')
  t.after(() => fs.rmSync(path.dirname(config), { recursive: true }))
  mockRest(t, { "/repos/o/r": { default_branch: "main" } })
  const out = []
  t.mock.method(process.stdout, "write", chunk => out.push(chunk))
  await main(["--json", "--config", config], { GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r", PR_NUMBER: "1" })
  t.mock.restoreAll()
  assert.deepEqual(JSON.parse(out.join("")), { version: 1, mode: "off" })
})
