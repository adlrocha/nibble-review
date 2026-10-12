# Nibble Review — Integration Runbook

Personal ops checklist for wiring `adlrocha/nibble-review` up. Tracked in the repo so it survives sandbox teardowns. **Never** paste the `.pem` contents or API keys into this file.

> **Before killing the sandbox:** the App private key (`nibble-review.2026-09-02.private-key.pem`) currently exists ONLY inside the pi sandbox checkout. Copy it to the host first, or regenerate it later from the App page (General → Private keys → Generate a private key) and re-set the `NIBBLE_REVIEW_PRIVATE_KEY` secret everywhere.

## Current status snapshot (2026-09-02)

| # | Item | Status |
| --- | --- | --- |
| 1 | `origin/main` up to date (`15a04b7`+) | ✅ verified |
| 2 | Image `ghcr.io/adlrocha/nibble-review:latest` live, package public | ✅ verified |
| 3 | `.pem` valid RSA key, gitignored (`*.pem`), never committed | ✅ verified |
| 4 | App `.pem` + Client ID pair authenticates | ❌ **client ID `Iv23liVgvy1yaHapd0Wx` in `review.yml` is WRONG** (JWT `iss` rejected) — get the real one |
| 5 | App permissions: Contents R, Issues RW, PRs RW, Metadata R | ⏳ verify on App page |
| 6 | App events: Pull request + Issue comment; webhook OFF | ⏳ verify on App page |
| 7 | App installed on `adlrocha/nibble-review` (+ consumer repos) | ⏳ verify via probe after #4 |
| 8 | Secret `NIBBLE_REVIEW_PRIVATE_KEY` on the fork | ❌ missing |
| 9 | Secret `OPENCODE_API_KEY` on the fork | ❌ missing — user must provide key |
| 10 | Vars `REVIEW_APP_CLIENT_ID` + `REVIEW_COMMAND` on the fork | ❌ missing |
| 11 | Smoke test: bot reviews a real PR | ⏳ final step |

## Next actions (in order)

### A. Get the real Client ID

https://github.com/settings/apps → your app → General → **Client ID** (`Iv…`). While there, verify rows 5–6 (permissions, events, webhook **Active unchecked**).

### B. Verify the App pair + installation (no secrets printed)

```bash
node scripts/verify-app.mjs <REAL_CLIENT_ID> ./nibble-review.2026-09-02.private-key.pem
```

Prints: app name/slug, permissions, events, installations + repo lists. If `AUTH FAILED (401)` → client ID still wrong, or the `.pem` belongs to a different app (regenerate the key from the correct app's page).

### C. Fix the client ID default in `review.yml`

`.github/workflows/review.yml` line ~86 has the wrong default `Iv23liVgvy1yaHapd0Wx`. Replace with the real one and commit (`fix: correct default review app client id`). Push via SSH (see below).

### D. Set secrets + vars on the fork

```bash
cd <repo checkout>
gh secret set NIBBLE_REVIEW_PRIVATE_KEY --repo adlrocha/nibble-review < ./nibble-review.2026-09-02.private-key.pem
gh secret set OPENCODE_API_KEY --repo adlrocha/nibble-review --body "$OPENCODE_API_KEY"
gh variable set REVIEW_APP_CLIENT_ID --repo adlrocha/nibble-review --body "<REAL_CLIENT_ID>"
gh variable set REVIEW_COMMAND --repo adlrocha/nibble-review --body "@nibble-review"
```

(The private key streams from file; it is never printed.)

### E. Verify

```bash
scripts/setup-review-bot.sh check --repo adlrocha/nibble-review   # all green
```

### F. Smoke test

Open a non-draft, same-repo PR on the fork, or comment `@nibble-review` on one. Manual trigger: Actions → "Nibble Review" → Run workflow → PR number.

### G. Consumer repos (after the fork works end-to-end)

```bash
scripts/setup-review-bot.sh configure --repo adlrocha/REPO \
  --app-client-id <REAL_CLIENT_ID> \
  --private-key ./nibble-review.2026-09-02.private-key.pem \
  --opencode-key "$OPENCODE_API_KEY" \
  --agent-repo adlrocha/nibble-review --dry-run
# then for real; commit the generated .github/workflows/code-review.yml in that repo
scripts/setup-review-bot.sh check --repo adlrocha/REPO
```

## Pushing from a fresh sandbox (SSH recipe)

The OAuth `gh` token lacks the `workflow` scope → HTTPS pushes touching `.github/workflows/*` are rejected. SSH pushes are not scope-limited:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/pi-temp -N "" -C pi-temp -q
gh api user/keys -f title="pi-temp (revoke after push)" -f key="$(cat ~/.ssh/pi-temp.pub)" --jq .id
GIT_SSH_COMMAND="ssh -i ~/.ssh/pi-temp -o IdentitiesOnly=yes" git push origin main
gh api user/keys/<id-from-above> -X DELETE && rm -f ~/.ssh/pi-temp{,.pub}
```

Gotchas learned:

- `--force-with-lease` with an **explicit URL** fails with "stale info" (no tracking ref to compare). Push via configured `origin`, or use `--force-with-lease=refs/heads/main:<expected-sha>`.
- If the sandbox has no SSH remote: fetch/push via explicit HTTPS URL works for reads: `git fetch https://github.com/adlrocha/nibble-review.git +main:refs/remotes/origin/main`.

## Repo layout notes

- Fork: `adlrocha/nibble-review`; upstream: `we-are-singular/singular-code-review-agent` (remote `upstream`, HTTPS).
- Local `main` = upstream `a461f93` + fork commits (rebrand, gitignore, reconcile, this runbook).
- Self-review workflow: `.github/workflows/singular-code-review.yml` → `uses: adlrocha/nibble-review/...@main`, runs on `ubuntu-latest`. Fork only needs secrets/vars (Step D), no extra workflow file — do NOT run `configure` without `--no-workflow` on the fork.
- Safety branch `pre-rewrite-backup` exists in the sandbox clone (old pre-rewrite history).
- Host checkout `~/workspace/personal/nibble-review` was broken by the folder rename (no commits on `main`); re-clone if still needed:
  ```bash
  cd ~/workspace/personal && mv nibble-review nibble-review.broken
  git clone git@github.com:adlrocha/nibble-review.git
  # recover local-only files from nibble-review.broken (e.g. .pem), then delete it
  ```

## Reference

- Secrets: `NIBBLE_REVIEW_PRIVATE_KEY`, `OPENCODE_API_KEY`, optional `CONTEXT7_API_KEY`
- Vars: `REVIEW_APP_CLIENT_ID`, `REVIEW_COMMAND`; optional `REVIEW_IMAGE`, `OPENCODE_MODEL`, `OPENCODE_GATE_MODEL`
- Full guide: [docs/SETUP.md](docs/SETUP.md)
- Trigger: `@nibble-review` comment by OWNER/MEMBER/COLLABORATOR, or non-draft same-repo PR. Skip: title prefix `[skip]` or `@nibble-review skip` in the body.
