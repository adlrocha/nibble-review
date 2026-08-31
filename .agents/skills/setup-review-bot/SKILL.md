---
name: setup-review-bot
description: Onboard a repository to the automated code-review bot. Drives scripts/setup-review-bot.sh to automate GitHub secrets, repository variables, and the consumer workflow; walks the user through GitHub App creation and OpenCode key setup; verifies the result. Use when setting up the bot on your fork or any consuming repo.
---

# Set up the Code Review bot

This skill onboards a repository (your agent fork, or any consuming repo) to run automated pull-request reviews as **the user's own GitHub App identity**. It maximizes automation via `scripts/setup-review-bot.sh` and only asks the human to do what genuinely cannot be scripted.

Paths below are **relative to the repository root** (the dir containing `scripts/`).

## What can be automated vs. what is manual

| Step                                           | Automated by the script?                                |
| ---------------------------------------------- | ------------------------------------------------------- |
| Create the GitHub App                          | ❌ manual (GitHub has no `gh` command for App creation) |
| Generate/download the App private key (`.pem`) | ❌ manual (GitHub web UI)                               |
| Obtain the OpenCode API key                    | ❌ manual (user's account)                              |
| Install the App on the target repo/org         | ❌ manual (GitHub web UI)                               |
| Set Actions secrets + repo variables           | ✅ `configure`                                          |
| Generate the consumer trigger workflow         | ✅ `configure` / `generate-workflow`                    |
| Verify the setup                               | ✅ `check`                                              |

Your job is to: gather the manual artifacts from the user, then drive the script for everything else.

## Prerequisites — verify before starting

```bash
command -v gh >/dev/null && gh auth status || echo "NEEDS: gh auth login"
```

If `gh` is missing or not authenticated, tell the user to run `gh auth login` and stop until it is fixed. The script cannot set secrets/variables without it.

Also confirm the user has a **fork of this repo** pushed to GitHub (it publishes its reviewer image to its own GHCR namespace automatically on push to `main`).

## Step 1 — Gather inputs

Collect these from the user (ask explicitly; do not guess):

- **Target repo** `OWNER/REPO` to receive reviews.
- **GitHub App Client ID** (starts with `Iv`) — or none yet (→ Step 2).
- **Private key file** path (the downloaded `*.pem`) — or none yet (→ Step 2).
- **OpenCode API key**.
- Optional: **command** (default `@nibble-review`; should match the App slug, e.g. `@code-review`), **image** (defaults to the fork's GHCR image), **agent-repo** (the repo owning `.github/workflows/review.yml`; usually the fork), **`--install-deps`** if the target repo needs dependency install.

## Step 2 — Create the GitHub App (only if the user hasn't)

If the user lacks a Client ID / private key, walk them through creation. The guide is maintained as an editable asset and printed by:

```bash
scripts/setup-review-bot.sh create-app           # personal App
scripts/setup-review-bot.sh create-app --org ORG # org App
```

Print its output verbatim to the user. It lists the **exact** permissions (`Contents: read`, `Issues: write`, `Pull requests: write`, `Metadata: read`), events (`pull_request`, `issue_comment`), and that the **webhook must stay inactive**. Wait for the user to return with the **Client ID** and the downloaded **`*.pem`**. Then remind them to **Install** the App on the target repo/org.

## Step 3 — Configure the repo (automated)

Always preview first with `--dry-run` (no GitHub writes, no `gh` required):

```bash
scripts/setup-review-bot.sh configure --repo OWNER/REPO \
  --app-client-id <Iv...> --private-key <path/to/key.pem> \
  --opencode-key <OpenCode key> \
  --command @your-bot \
  --image ghcr.io/<you>/<agent-repo>:latest \
  --agent-repo <you>/<agent-repo> \
  --dry-run
```

If the plan looks right, re-run **without** `--dry-run`. This:

- sets secrets `NIBBLE_REVIEW_PRIVATE_KEY`, `OPENCODE_API_KEY` (and `CONTEXT7_API_KEY` with `--context7-key`),
- sets variables `REVIEW_APP_CLIENT_ID`, `REVIEW_COMMAND`, and `REVIEW_IMAGE`,
- writes `.github/workflows/code-review.yml`.

The script never prints secret values (keys stream straight into `gh`). For many repos, use `--org ORG --org-repos "a,b"` for org-level secrets/variables.

After it writes the workflow, the user must commit it:

```bash
git add .github/workflows/code-review.yml
git commit -m "ci: add code review bot" && git push
```

## Step 4 — Verify

```bash
scripts/setup-review-bot.sh check --repo OWNER/REPO
```

All required secrets and variables must show ✓. If anything is MISSING, re-run the relevant `configure` flags.

## Step 5 — Trigger and confirm

Any of these starts a review — pick the easiest to validate:

- Open a **non-draft, same-repo** PR (fastest end-to-end check).
- Have an `OWNER`/`MEMBER`/`COLLABORATOR` comment the exact **command** (`@your-bot`) on a same-repo PR.
- GitHub → Actions → "Code Review" → Run workflow → enter a PR number.

Confirm a run appears in Actions and a review/comment lands on the PR. If the user uses a custom command, **mentioning must use that exact string** or the mention is ignored.

## Common failures

- **`gh is not authenticated`** → `gh auth login`.
- **`required asset not found`** → you're running the script from outside a checkout of the repo; copy `scripts/assets/` alongside it, or run in place.
- **`permission denied` / `Resource not accessible by integration`** → the App is missing a permission or isn't installed on the target repo.
- **Mention ignored but PR triggers work** → the `command` variable and the trigger workflow's `if:` string must match the bot's slug exactly.
- **Image pull fails** → the GHCR package is private. Keep it public (default), or see `docs/SETUP.md` → "Private images".

## Reference

- Full human guide (rationale, tables, fork-sync, rebrand checklist): [`docs/SETUP.md`](../../../docs/SETUP.md)
- Script options: `scripts/setup-review-bot.sh configure --help`
- Editable text assets: `scripts/assets/create-app-guide.md`, `scripts/assets/code-review.yml.tmpl`
