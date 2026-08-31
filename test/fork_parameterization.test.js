import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

// Fork guard: consumer repos must be able to override the bot identity and
// image through repository variables, with nibble-review defaults. If an
// upstream sync drops one of these, this test fails before consumers break.
test("reusable review workflow keeps fork parameterization", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "review.yml"), "utf8")

  assert.match(workflow, /image: \$\{\{ vars\.REVIEW_IMAGE \|\| 'ghcr\.io\/adlrocha\/nibble-review:latest' \}\}/u)
  assert.match(workflow, /client-id: \$\{\{ vars\.REVIEW_APP_CLIENT_ID \|\| 'Iv23liVgvy1yaHapd0Wx' \}\}/u)
  assert.match(workflow, /REVIEW_COMMAND: \$\{\{ vars\.REVIEW_COMMAND \|\| '@nibble-review' \}\}/u)
  assert.match(workflow, /NIBBLE_REVIEW_INSTALL_DEPS/u)
})
