#!/usr/bin/env bash
# Prints the commit of this reviewer's latest completed review on the PR, or
# nothing. It mirrors `latestBotReview` in src/lib/review-gate.ts: the review
# must come from REVIEW_BOT_LOGIN, and a shared login such as
# github-actions[bot] must also carry the reviewer marker
# (src/lib/review-authorship.ts). Other reviewers' commits are never returned.
#
# Never fails: any API or parse error prints nothing, and the gate then runs a
# full review as it does today.
#
# Env: GITHUB_REPOSITORY, PR_NUMBER, REVIEW_BOT_LOGIN, GH_TOKEN (for gh).
set -uo pipefail

repository="${GITHUB_REPOSITORY:-}"
pr_number="${PR_NUMBER:-}"
bot_login="${REVIEW_BOT_LOGIN:-}"
if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ || ! "$pr_number" =~ ^[1-9][0-9]*$ || -z "$bot_login" ]]; then
  echo "::notice title=Nibble Review::cannot identify the PR or reviewer; skipping the reviewed-commit fetch" >&2
  exit 0
fi

api_timeout="${LATEST_REVIEWED_COMMIT_TIMEOUT_SECONDS:-60}"
[[ "$api_timeout" =~ ^[1-9][0-9]*$ ]] || api_timeout=60

# Keep in sync with REVIEW_MARKER and SHARED_BOT_LOGINS (a test checks this).
marker="<!-- nibble-review -->"
shared_logins='["github-actions[bot]"]'

if ! pages=$(timeout -k 5 "$api_timeout" gh api "repos/${repository}/pulls/${pr_number}/reviews?per_page=100" --paginate 2>/dev/null); then
  echo "::notice title=Nibble Review::could not list previous reviews; skipping the reviewed-commit fetch" >&2
  exit 0
fi

# --paginate prints one JSON array per page; slurp and join them in order.
printf '%s' "$pages" | jq -rs --arg bot "$bot_login" --arg marker "$marker" --argjson shared "$shared_logins" '
  add // []
  | map(select(
      .user.login == $bot
      and (($shared | index($bot)) == null or ((.body // "") | contains($marker)))
      and ((.commit_id // "") | test("^([0-9a-f]{40}|[0-9a-f]{64})$"))
    ))
  | last
  | .commit_id // empty
' 2>/dev/null || true
