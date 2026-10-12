import assert from "node:assert/strict"
import test from "node:test"

import {
  GITHUB_ACTIONS_BOT_LOGIN,
  REVIEW_MARKER,
  reviewAuthorship,
  withReviewMarker
} from "../../dist/lib/review-authorship.js"
import { REDACTED, redactSecrets, secretValues } from "../../dist/lib/secret-redaction.js"
import { createGitHubClient } from "../../dist/services/github/client.js"

test("review marker is appended once", () => {
  const marked = withReviewMarker("Looks good.")
  assert.equal(marked, `Looks good.\n\n${REVIEW_MARKER}`)
  assert.equal(withReviewMarker(marked), marked)
})

test("a dedicated App login identifies its content without a marker", () => {
  const own = reviewAuthorship("nibble-review[bot]")
  assert.equal(own.isOwn({ user: { login: "nibble-review[bot]" }, body: "Legacy review" }), true)
  assert.equal(own.isOwn({ user: { login: "someone" }, body: REVIEW_MARKER }), false)
  assert.equal(own.isOwn(undefined), false)
})

test("the shared github-actions login needs the marker", () => {
  const own = reviewAuthorship(GITHUB_ACTIONS_BOT_LOGIN)
  assert.equal(own.isOwn({ user: { login: GITHUB_ACTIONS_BOT_LOGIN }, body: "Coverage: 91%" }), false)
  assert.equal(own.isOwn({ user: { login: GITHUB_ACTIONS_BOT_LOGIN }, body: null }), false)
  assert.equal(own.isOwn({ user: { login: GITHUB_ACTIONS_BOT_LOGIN }, body: withReviewMarker("Review") }), true)
  assert.equal(own.isBotLogin(GITHUB_ACTIONS_BOT_LOGIN), true)
  assert.equal(own.isBotLogin(null), false)
})

test("the GitHub client marks every published body on the wire", async t => {
  const previousFetch = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } })
  }
  t.after(() => {
    globalThis.fetch = previousFetch
  })
  const client = createGitHubClient({ token: "test-token", repository: "owner/repo" })

  await client.createPullRequestComment(1, "Answer.")
  await client.submitReply(1, 2, "Reply.")
  await client.submitReview(1, "a".repeat(40), {
    body: "Summary.",
    event: "COMMENT",
    comments: [{ path: "src/a.ts", line: 1, side: "RIGHT", body: "Inline." }]
  })

  assert.equal(bodies[0].body, withReviewMarker("Answer."))
  assert.equal(bodies[1].body, withReviewMarker("Reply."))
  assert.equal(bodies[2].body, withReviewMarker("Summary."))
  assert.equal(bodies[2].comments[0].body, withReviewMarker("Inline."))
})

test("secret values are redacted from published bodies before the marker is added", async t => {
  const previousFetch = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } })
  }
  t.after(() => {
    globalThis.fetch = previousFetch
  })
  const client = createGitHubClient({ token: "t", repository: "owner/repo", secrets: ["sk-model-secret-1234"] })
  await client.createPullRequestComment(1, "The key is sk-model-secret-1234, twice: sk-model-secret-1234")
  assert.equal(bodies[0].body, withReviewMarker(`The key is ${REDACTED}, twice: ${REDACTED}`))
})

test("secret values come from secret-looking env names, longest first, ignoring short values", () => {
  assert.deepEqual(
    secretValues({
      OPENCODE_API_KEY: "short-key-123",
      GH_TOKEN: "ghs_much_longer_token_value",
      ACTIONS_RUNTIME_TOKEN: "ghs_much_longer_token_value",
      DB_PASSWORD: "tiny",
      HOME: "/home/runner/not-a-secret-path"
    }),
    ["ghs_much_longer_token_value", "short-key-123"]
  )
  assert.equal(redactSecrets("abc", []), "abc")
})
