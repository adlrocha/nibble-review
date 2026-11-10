import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const root = path.resolve(import.meta.dirname, "..")
const fallbackScript = path.join(root, "bin", "review-with-fallback.sh")
const action = fs.readFileSync(path.join(root, "action.yml"), "utf8")

/** Runs the fallback script against a fake runner that exits with the given codes in order. */
function runFallback(t, exitCodes, env = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nibble-fallback-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const log = path.join(directory, "calls.log")
  const runner = path.join(directory, "runner.sh")
  fs.writeFileSync(
    runner,
    `#!/usr/bin/env bash
codes=(${exitCodes.join(" ")})
count=$(wc -l < "${log}" 2>/dev/null || echo 0)
echo "$REVIEW_MODEL $*" >> "${log}"
echo "$NIBBLE_REVIEW_DEADLINE_SECONDS" > "${log}.deadline"
exit "\${codes[$count]}"
`
  )
  fs.chmodSync(runner, 0o755)
  const result = spawnSync("bash", [fallbackScript], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      NIBBLE_REVIEW_RUNNER: runner,
      REVIEW_MODEL: "primary/model",
      REVIEW_FALLBACK_MODEL: "fallback/model",
      TIMEOUT_MINUTES: "1",
      ...env
    }
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []
  const deadline = fs.existsSync(`${log}.deadline`) ? fs.readFileSync(`${log}.deadline`, "utf8").trim() : null
  return { status: result.status, calls, stdout: result.stdout, deadline }
}

test("a successful primary review does not retry", t => {
  const { status, calls } = runFallback(t, [0])
  assert.equal(status, 0)
  assert.deepEqual(calls, ["primary/model --publish"])
})

test("a pre-publication failure retries once with the fallback model", t => {
  const { status, calls, stdout } = runFallback(t, [2, 0])
  assert.equal(status, 0)
  assert.deepEqual(calls, ["primary/model --publish", "fallback/model --publish"])
  assert.match(stdout, /::warning title=Nibble Review::primary\/model failed before publication/u)
})

test("the runner gives up an unpublished review a minute before the attempt timeout", t => {
  assert.equal(runFallback(t, [0], { TIMEOUT_MINUTES: "20" }).deadline, "1140")
  assert.equal(runFallback(t, [0], { TIMEOUT_MINUTES: "1" }).deadline, "30")
})

test("other failures never retry, because something may already be published", t => {
  const { status, calls } = runFallback(t, [1, 0])
  assert.equal(status, 1)
  assert.deepEqual(calls, ["primary/model --publish"])
})

test("the fallback result is final", t => {
  const { status, calls } = runFallback(t, [2, 2])
  assert.equal(status, 2)
  assert.equal(calls.length, 2)
})

test("no retry when the fallback model is empty or identical", t => {
  for (const fallback of ["", "primary/model"]) {
    const { status, calls, stdout } = runFallback(t, [2, 0], { REVIEW_FALLBACK_MODEL: fallback })
    assert.equal(status, 2)
    assert.equal(calls.length, 1)
    assert.match(stdout, /no distinct fallback model is configured/u)
  }
})

test("the action only accepts *_API_KEY names so a key can never overwrite a GitHub token", () => {
  assert.match(action, /\^\[A-Z\]\[A-Z0-9_\]\*_API_KEY\$/u)
})

test("the action checks out the pull request without persisting credentials, after preflight", () => {
  assert.match(action, /persist-credentials: false/u)
  assert.ok(action.indexOf("id: preflight") < action.indexOf("name: Check out pull request"))
  assert.match(action, /ref: refs\/pull\/\$\{\{ inputs\.pr-number \}\}\/head/u)
})

test("the action forwards allow-skip to preflight, honoring skips by default", () => {
  assert.match(action, /allow-skip:\n(?:.*\n)*?\s+default: "true"/u)
  assert.match(action, /REVIEW_ALLOW_SKIP: \$\{\{ inputs\.allow-skip \}\}/u)
})

test("the action posts as github-actions[bot] unless an App token is configured", () => {
  assert.match(action, /default: \$\{\{ github\.token \}\}/u)
  assert.match(
    action,
    /REVIEW_BOT_LOGIN: \$\{\{ steps\.app-token\.outputs\.app-slug && format\('\{0\}\[bot\]', steps\.app-token\.outputs\.app-slug\) \|\| 'github-actions\[bot\]' \}\}/u
  )
})

const fixAction = fs.readFileSync(path.join(root, "fix", "action.yml"), "utf8")

/** Splits a composite action into its steps, keyed by step name. */
function steps(yaml) {
  return Object.fromEntries(
    yaml
      .split(/\n    - name: /u)
      .slice(1)
      .map(block => [block.split("\n")[0].trim(), block])
  )
}

test("the fix action exposes the model key only to the sandboxed Agent step", () => {
  const byName = steps(fixAction)
  const withKey = Object.entries(byName)
    .filter(([, block]) => block.includes("inputs.api-key }}"))
    .map(([name]) => name)
  assert.deepEqual(withKey, ["Validate inputs", "Fix in sandbox"])
  assert.match(byName["Fix in sandbox"], /fix-sandbox\.sh" run/u)
})

test("the fix action keeps GitHub tokens away from every step that runs repository code", () => {
  const byName = steps(fixAction)
  for (const name of ["Install repository dependencies", "Fix in sandbox", "Verify in sandbox"]) {
    assert.doesNotMatch(byName[name], /GH_TOKEN|github-token|app-token/u, name)
  }
  assert.match(byName["Check out pull request"], /persist-credentials: false/u)
})

test("the fix action mints the App token after the sandbox stops and only publishes with it", () => {
  const order = Object.keys(steps(fixAction))
  const index = name => order.indexOf(name)
  assert.ok(index("Keep a pristine copy before any repository code runs") < index("Install repository dependencies"))
  assert.ok(index("Start sandbox") < index("Install repository dependencies"))
  assert.ok(index("Stop sandbox") < index("Create GitHub App token"))
  assert.ok(index("Create GitHub App token") < index("Publish fix"))
  assert.equal(order.at(-1), "Publish fix")
  const tokenUsers = Object.entries(steps(fixAction))
    .filter(([, block]) => block.includes("steps.app-token.outputs.token"))
    .map(([name]) => name)
  assert.deepEqual(tokenUsers, ["Publish fix"])
})

test("neither action asks setup-node to cache files outside the caller's workspace", () => {
  // setup-node only resolves cache-dependency-path inside GITHUB_WORKSPACE; the action's
  // own lockfile lives in the action path, so caching it fails the job before review.
  for (const yaml of [action, fixAction]) {
    assert.doesNotMatch(yaml, /cache-dependency-path/u)
  }
})

test("land is opt-in and runs only after an accepted review", () => {
  assert.match(action, /\n  land:\n[\s\S]*?default: "false"/u)
  assert.match(
    action,
    /Report land decision\n\s+if: steps\.preflight\.outputs\.should_review == 'true' && inputs\.land == 'true'/u
  )
  assert.match(action, /REVIEW_LAND: \$\{\{ inputs\.land \}\}/u)
  const byName = steps(action)
  assert.match(byName["Report land decision"], /land\.js" --publish/u)
  const login = block => /REVIEW_BOT_LOGIN: (.+)/u.exec(block)[1]
  assert.equal(login(byName["Report land decision"]), login(byName["Review pull request"]))
})

const fetchScript = path.join(root, "bin", "fetch-reviewed-commits.sh")

/** Runs the reviewed-commit fetch against a fake git that records argv and git env. */
function runFetchWithFakeGit(t, shas, env = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nibble-fetch-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const log = path.join(directory, "git.log")
  fs.writeFileSync(
    path.join(directory, "git"),
    `#!/usr/bin/env bash
{ printf 'ARGV %s\\n' "$*"; env | grep -E '^(GIT_(CONFIG|FETCH|TERMINAL)|GH_TOKEN|GITHUB_TOKEN)' | sort; } >> "${log}"
[[ " $* " == *" cat-file "* ]] && exit 1
[[ -n "\${FAKE_GIT_SLEEP:-}" ]] && sleep "\${FAKE_GIT_SLEEP}"
exit 0
`
  )
  fs.chmodSync(path.join(directory, "git"), 0o755)
  const result = spawnSync("bash", [fetchScript, directory, ...shas], {
    encoding: "utf8",
    env: { PATH: `${directory}:${process.env.PATH}`, ...env }
  })
  return { status: result.status, stdout: result.stdout, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" }
}

test("the reviewed-commit fetch passes the token only through per-process git config", t => {
  const sha = "a".repeat(40)
  const token = "ghs_secretTokenValue"
  const { status, log, stdout } = runFetchWithFakeGit(t, [sha], {
    GIT_FETCH_TOKEN: token,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GITHUB_ACTIONS: "true"
  })
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64")

  assert.equal(status, 0)
  assert.doesNotMatch(log, new RegExp(`ARGV .*(?:${token}|${encoded})`, "u"), "the token must never reach argv")
  assert.doesNotMatch(log, /^(?:GIT_FETCH_TOKEN|GH_TOKEN|GITHUB_TOKEN)=/mu, "no raw token variable may reach git")
  assert.match(log, /GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader/u)
  assert.match(log, new RegExp(`GIT_CONFIG_VALUE_0=AUTHORIZATION: basic ${encoded}`, "u"))
  assert.match(log, /GIT_TERMINAL_PROMPT=0/u)
  assert.match(
    log,
    /ARGV .*-c core\.hooksPath=\/dev\/null -c maintenance\.auto=false -c gc\.auto=0 fetch --quiet --no-tags --no-recurse-submodules/u
  )
  assert.ok(stdout.includes(`::add-mask::${encoded}`), "the encoded header is masked in Actions logs")
})

test("the reviewed-commit fetch caps how many missing commits it fetches", t => {
  const shas = ["1", "2", "3"].map(digit => digit.repeat(40))
  const { status, log, stdout } = runFetchWithFakeGit(t, shas, { FETCH_REVIEWED_COMMITS_MAX: "2" })

  assert.equal(status, 0)
  assert.equal(log.match(/ARGV .* fetch /gu)?.length, 2)
  assert.match(stdout, /skipped fetching older reviewed commits after 2/u)
})

test("the action fetches reviewed commits after checkout and before any repository code runs", () => {
  const checkout = action.indexOf("- name: Check out pull request")
  const fetch = action.indexOf("- name: Fetch previously reviewed commits")
  const install = action.indexOf("- name: Install repository dependencies")
  assert.ok(checkout >= 0 && fetch > checkout && install > fetch)

  const step = action.slice(fetch, install)
  assert.match(step, /continue-on-error: true/u)
  assert.match(step, /bin\/latest-reviewed-commit\.sh/u)
  assert.match(step, /REVIEW_BOT_LOGIN: \$\{\{ steps\.app-token\.outputs\.app-slug/u)
  assert.match(step, /GIT_FETCH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \|\| inputs\.github-token \}\}/u)
  assert.doesNotMatch(step.slice(step.indexOf("run: |")), /\$\{\{/u, "the run script takes inputs only from env")
})

test("the reviewed-commit fetch scopes the header to GITHUB_SERVER_URL and sets none without a token", t => {
  const sha = "b".repeat(40)
  const enterprise = runFetchWithFakeGit(t, [sha], {
    GIT_FETCH_TOKEN: "tok",
    GITHUB_SERVER_URL: "https://ghe.example.com"
  })
  assert.match(enterprise.log, /GIT_CONFIG_KEY_0=http\.https:\/\/ghe\.example\.com\/\.extraheader/u)

  const anonymous = runFetchWithFakeGit(t, [sha])
  assert.equal(anonymous.status, 0)
  assert.doesNotMatch(anonymous.log, /GIT_CONFIG/u)
  assert.doesNotMatch(anonymous.stdout, /add-mask/u)
})

test("the reviewed-commit fetch ignores invalid knobs and survives a hanging fetch", t => {
  const shas = ["c", "d"].map(digit => digit.repeat(64))
  const invalid = runFetchWithFakeGit(t, shas, { FETCH_REVIEWED_COMMITS_MAX: "a[$(touch /tmp/pwned)]" })
  assert.equal(invalid.status, 0)
  assert.equal(invalid.log.match(/ARGV .* fetch /gu)?.length, 2, "an invalid cap falls back to the default")

  const started = Date.now()
  const hung = runFetchWithFakeGit(t, [shas[0]], { FAKE_GIT_SLEEP: "30", FETCH_REVIEWED_COMMITS_TIMEOUT_SECONDS: "1" })
  assert.equal(hung.status, 0)
  assert.ok(Date.now() - started < 15_000, "the per-fetch timeout bounds a hanging fetch")
  assert.match(hung.stdout, /is not fetchable; the gate will run a full review/u)
})

const latestScript = path.join(root, "bin", "latest-reviewed-commit.sh")

/** Runs the latest-reviewed-commit lookup against a fake gh that prints the given output. */
function runLatestWithFakeGh(t, ghOutput, env = {}, ghStatus = 0) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nibble-latest-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, "gh.out"), ghOutput)
  fs.writeFileSync(
    path.join(directory, "gh"),
    `#!/usr/bin/env bash\necho "$*" > "${directory}/gh.args"\ncat "${directory}/gh.out"\nexit ${ghStatus}\n`
  )
  fs.chmodSync(path.join(directory, "gh"), 0o755)
  const result = spawnSync("bash", [latestScript], {
    encoding: "utf8",
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "owner/repo",
      PR_NUMBER: "42",
      REVIEW_BOT_LOGIN: "github-actions[bot]",
      ...env
    }
  })
  const args = fs.existsSync(path.join(directory, "gh.args"))
    ? fs.readFileSync(path.join(directory, "gh.args"), "utf8").trim()
    : null
  return { status: result.status, stdout: result.stdout.trim(), args }
}

const marked = "Review body\n\n<!-- nibble-review -->"
const review = (login, commitId, body = marked) => ({ user: { login }, body, commit_id: commitId })

test("the latest reviewed commit is this reviewer's newest marked review across pages", t => {
  const [older, latest, human, unmarked] = ["1", "2", "3", "4"].map(digit => digit.repeat(40))
  const page1 = [review("github-actions[bot]", older), review("octocat", human, "LGTM")]
  const page2 = [
    review("github-actions[bot]", latest),
    review("github-actions[bot]", unmarked, "Lint passed"),
    review("octocat", human),
    review("github-actions[bot]", null),
    { user: null, body: marked, commit_id: human }
  ]
  const { status, stdout, args } = runLatestWithFakeGh(t, JSON.stringify(page1) + JSON.stringify(page2))

  assert.equal(status, 0)
  assert.equal(stdout, latest)
  assert.equal(args, "api repos/owner/repo/pulls/42/reviews?per_page=100 --paginate")
})

test("a dedicated App login does not need the marker", t => {
  const sha = "5".repeat(40)
  const { stdout } = runLatestWithFakeGh(t, JSON.stringify([review("nibble[bot]", sha, "no marker")]), {
    REVIEW_BOT_LOGIN: "nibble[bot]"
  })
  assert.equal(stdout, sha)
})

test("the latest reviewed commit lookup prints nothing and succeeds on any failure", t => {
  assert.deepEqual(
    [runLatestWithFakeGh(t, "", {}, 1).status, runLatestWithFakeGh(t, "", {}, 1).stdout],
    [0, ""],
    "a gh failure is not a job failure"
  )
  assert.equal(runLatestWithFakeGh(t, "not json").stdout, "")
  assert.equal(runLatestWithFakeGh(t, "[]").stdout, "")
  const badInput = runLatestWithFakeGh(t, "[]", { PR_NUMBER: "42; rm -rf /" })
  assert.equal(badInput.status, 0)
  assert.equal(badInput.args, null, "an invalid PR number never reaches gh")
})

test("the lookup's marker and shared logins match the reviewer's authorship rules", async () => {
  const { REVIEW_MARKER, SHARED_BOT_LOGINS } = await import("../dist/lib/review-authorship.js")
  const script = fs.readFileSync(latestScript, "utf8")
  assert.ok(script.includes(`marker="${REVIEW_MARKER}"`))
  assert.ok(script.includes(`shared_logins='${JSON.stringify([...SHARED_BOT_LOGINS])}'`))
})
