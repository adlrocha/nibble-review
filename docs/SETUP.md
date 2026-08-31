# Setup Guide — Running Your Own Code Review Bot

This guide takes you from a fork of `nibble-review` to a fully working **automated pull-request reviewer that runs as your own GitHub App identity**, on your own repos, with your own image.

It is written for the **fork-and-configure** workflow: the agent source stays in sync with upstream (Singular), and _all_ bot identity is driven by repository variables and secrets — so you can pull downstream changes without editing hard-coded values.

---

## How this fork stays independent (design overview)

Upstream hard-codes three identity values. This fork keeps those values as **defaults** and makes them **overridable at runtime** through repo variables / env vars:

| What                     | Where upstream hard-codes it        | How you override it (no source edit)      |
| ------------------------ | ----------------------------------- | ----------------------------------------- |
| App Client ID            | `.github/workflows/review.yml`      | repo variable **`REVIEW_APP_CLIENT_ID`**  |
| Command trigger (`@bot`) | `src/review/types.ts` (guard)       | repo variable **`REVIEW_COMMAND`**        |
| Bot login (`name[bot]`)  | `src/review/types.ts`               | **automatic** — derived from the App slug |
| Reviewer image           | `.github/workflows/review.yml`      | repo variable **`REVIEW_IMAGE`**          |
| App private key          | `secrets.NIBBLE_REVIEW_PRIVATE_KEY` | Actions **secret**                        |
| OpenCode API key         | `secrets.OPENCODE_API_KEY`          | Actions **secret**                        |

Because the defaults still match upstream, merging upstream changes into your fork produces **no conflicts on identity lines** — your identity lives entirely in variables/secrets, not in the source. Cosmetic strings (log prefixes like `[nibble-review]`, internal paths like `/tmp/.nibble-review`) are left as upstream on purpose; they don't affect the bot's identity and renaming them only creates merge friction. See [Full rebrand](#full-rebrand-optional) for when you eventually stop tracking upstream.

> **Note on the secret name:** the secret is still called `NIBBLE_REVIEW_PRIVATE_KEY` to avoid churn in the reusable workflow's `workflow_call` interface. It is just a label — it holds _your_ App's key. You can rename it in one pass later (see [Full rebrand](#full-rebrand-optional)).

---

## Prerequisites

- A fork of this repo pushed to your GitHub account/org (e.g. `you/code-review-agent`).
- The [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated:
  ```bash
  gh auth login
  ```
- An **OpenCode Go API key** (the reviewer backend). You provide this; the runner reads it from `OPENCODE_API_KEY`.
- (Optional) A **Context7 API key** for higher rate limits.

---

## Step 1 — Create your GitHub App

`gh` cannot create Apps, so this one step is manual. Everything after it is automated by `scripts/setup-review-bot.sh`.

**Easiest:** run the helper that prints exact click-by-click instructions:

```bash
scripts/setup-review-bot.sh create-app           # personal app
scripts/setup-review-bot.sh create-app --org NAME # org app
```

**Summary of what the App needs:**

- **Repository permissions:** `Contents: Read-only`, `Issues: Read & write`, `Pull requests: Read & write`, `Metadata: Read-only`. Do **not** grant Administration or `Contents: write`.
- **Subscribe to events:** `Pull request`, `Issue comment`.
- **Webhook:** leave **Active unchecked** — the workflow is event-driven; the App never receives webhooks.
- **Install scope:** "Only on this account" for personal use, or "Any account" if other orgs will install it.

After creating the App:

1. On the App's **General** page, copy the **Client ID** (starts with `Iv`).
2. Under **Private keys → Generate a private key** — a `*.pem` downloads. Keep it safe; you'll feed it to the setup script.

---

## Step 2 — Install the App

On the App page, click **Install App** and install it on:

- the repos you want reviewed, **and**
- the repo that _runs_ the review workflow (usually the same repos).

For an org, pick "Selected repositories" (recommended) or "All repositories".

---

## Step 3 — Publish the reviewer image (your fork)

Your fork already publishes to its **own** GHCR namespace automatically — `.github/workflows/publish-image.yml` uses `ghcr.io/${GITHUB_REPOSITORY}` with no hard-coded owner. So once you push to `main` (or tag a release), the image is published as:

```
ghcr.io/<your-user-or-org>/<your-agent-repo>:latest
ghcr.io/<your-user-or-org>/<your-agent-repo>:sha-<commit>
```

Verify after a push:

```bash
gh api /users/<you>/packages/container/<your-agent-repo>
```

> **Keep the package public** (the GHCR default). If you make it private, the reusable workflow can't pull it without extra configuration — see [Private images](#private-images-optional) below.

---

## Step 4 — Configure a repository to receive reviews

From inside a checkout of the repo you want reviewed, run the setup script. It sets the secrets + variables and writes the consumer trigger workflow:

```bash
cd path/to/repo-i-want-reviewed

/path/to/code-review-agent/scripts/setup-review-bot.sh configure \
  --repo YOU/REPO-I-WANT-REVIEWED \
  --app-client-id Iv1...                                  `# from Step 1` \
  --private-key ~/Downloads/your-app.private-key.pem      `# from Step 1` \
  --opencode-key "$OPENCODE_API_KEY"                       `# your OpenCode Go key` \
  --command '@your-bot'                                    `# optional; default @nibble-review` \
  --image ghcr.io/you/code-review-agent:latest             `# optional; from Step 3` \
  --agent-repo you/code-review-agent                       `# the repo that owns review.yml`
```

Then commit the generated workflow:

```bash
git add .github/workflows/code-review.yml
git commit -m "ci: add code review bot"
git push
```

The script:

- sets secrets `NIBBLE_REVIEW_PRIVATE_KEY`, `OPENCODE_API_KEY` (and `CONTEXT7_API_KEY` if `--context7-key` is given),
- sets variables `REVIEW_APP_CLIENT_ID`, `REVIEW_COMMAND`, and `REVIEW_IMAGE` (only when non-default),
- writes `.github/workflows/code-review.yml` with the correct `uses:` line and command.

**Preview without changing anything** with `--dry-run`. **Skip the workflow file** with `--no-workflow`. See all options:

```bash
scripts/setup-review-bot.sh configure --help
```

---

## Step 5 — (Optional) Make the agent repo review itself

Run Step 4 against the agent fork too (`--repo you/code-review-agent`). This lets the bot review PRs on the agent repo itself, which is how upstream operates.

---

## Step 6 — Trigger a review and verify

Open a **non-draft, same-repo** pull request, or have an `OWNER` / `MEMBER` / `COLLABORATOR` comment **`@your-bot`** on a same-repo PR. (Use the exact string you passed to `--command`.)

To verify the configuration is complete without opening a PR:

```bash
scripts/setup-review-bot.sh check --repo YOU/REPO
```

To run a review **manually** for testing: GitHub → Actions → "Code Review" → Run workflow → enter a PR number.

To **skip** a review on a specific PR: start the title with `[skip]`, or add a line `<your-command> skip` to the PR body.

---

## Reference: variables & secrets

### Required

| Type     | Name                        | Purpose                                               |
| -------- | --------------------------- | ----------------------------------------------------- |
| secret   | `NIBBLE_REVIEW_PRIVATE_KEY` | Your App's private key (mints the installation token) |
| secret   | `OPENCODE_API_KEY`          | OpenCode Go API key                                   |
| variable | `REVIEW_APP_CLIENT_ID`      | Your App's Client ID                                  |
| variable | `REVIEW_COMMAND`            | Trigger string (e.g. `@your-bot`)                     |

### Optional

| Type     | Name                  | Purpose                                              |
| -------- | --------------------- | ---------------------------------------------------- |
| secret   | `CONTEXT7_API_KEY`    | Higher rate limits                                   |
| variable | `REVIEW_IMAGE`        | Reviewer image (defaults to upstream's)              |
| variable | `OPENCODE_MODEL`      | Review model (default `opencode-go/minimax-m2.7`)    |
| variable | `OPENCODE_GATE_MODEL` | Gate model (default `opencode-go/deepseek-v4-flash`) |

### Manual equivalents (no script)

```bash
# secrets (repo-level)
gh secret set --repo YOU/REPO NIBBLE_REVIEW_PRIVATE_KEY < app-private-key.pem
gh secret set --repo YOU/REPO OPENCODE_API_KEY --body "$OPENCODE_API_KEY"
gh secret set --repo YOU/REPO CONTEXT7_API_KEY --body "$CONTEXT7_API_KEY"   # optional

# variables (repo-level)
gh variable set --repo YOU/REPO REVIEW_APP_CLIENT_ID --body "Iv1..."
gh variable set --repo YOU/REPO REVIEW_COMMAND       --body "@your-bot"
gh variable set --repo YOU/REPO REVIEW_IMAGE         --body "ghcr.io/you/code-review-agent:latest"
```

For many repos, prefer **organization** secrets/variables scoped to the selected repos (the script supports this with `--org ORG --org-repos "a,b"`).

---

## Private images (optional)

The reusable workflow pulls the image at the `container:` level. A **public** GHCR package needs no extra setup. If you make the package private, the consuming workflow's `GITHUB_TOKEN` must be able to read it; add `packages: read` to the permissions block of **both** the reusable workflow (`.github/workflows/review.yml`) and the consumer trigger workflow, and ensure the package's access settings grant the consuming repo's token. Keeping the image public is strongly recommended.

---

## Keeping your fork in sync with upstream

Because all identity is config-driven, syncing is just a normal merge/rebase:

```bash
git remote add upstream https://github.com/we-are-singular/nibble-review.git
git fetch upstream
git merge upstream/main      # or: git rebase upstream/main
# resolve any conflicts (expected only where upstream touched the small
# parameterization lines you added) and push
git push
```

Pushing to `main` republishes your image (Step 3).

---

## Rebrand

This fork is already fully rebranded to **nibble-review**: the secret (`NIBBLE_REVIEW_PRIVATE_KEY`), env vars (`NIBBLE_REVIEW_*`), mention command (`@nibble-review`), bot login (`nibble-review[bot]`), internal paths (`/tmp/.nibble-review`, `/usr/local/{lib,share}/nibble-review`), and log prefix (`[nibble-review]`). If you fork _this_ fork and want your own brand, do a case-sensitive sweep of `nibble-review` / `NIBBLE_REVIEW` / `Nibble Review` across the repo and rename `opencode/skills/nibble-review/` accordingly.

---

## Troubleshooting

- **Bot never triggers:** run `scripts/setup-review-bot.sh check --repo YOU/REPO`. Ensure the PR is non-draft and from the **same repo** (fork PRs are blocked by design), and that a human OWNER/MEMBER/COLLABORATOR issued the mention.
- **`permission denied` / `Resource not accessible by integration`:** the App lacks a permission (check Contents/Issues/Pull requests in Step 1) or isn't installed on the repo.
- **Image pull fails:** the package is private. See [Private images](#private-images-optional).
- **`@your-bot` is ignored but `@nibble-review` works:** you forgot to set `REVIEW_COMMAND` to your command (or used a different string in the trigger workflow's `if:` block). They must match exactly.
- **Reviews post as the wrong name:** the bot login is derived automatically from the App slug. To change the name, rename the App in its settings.
