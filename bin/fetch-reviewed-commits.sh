#!/usr/bin/env bash
# Fetches previously reviewed commits that a force-push removed from the PR
# head's history, so the review gate can compare a rebase instead of falling
# back to a full review. GitHub keeps serving those commits by SHA.
#
# Usage: fetch-reviewed-commits.sh <workspace> <sha>...
#
# Only full object IDs are accepted, so no argument can become a git option or
# refspec. A commit that cannot be fetched is reported and skipped: the gate
# already treats a missing commit as "run the full review".
#
# GIT_FETCH_TOKEN, when set, authenticates the fetch through per-process git
# config (GIT_CONFIG_COUNT), never argv or .git/config. Run this before any
# repository code (dependency install scripts) can modify the checkout.
set -euo pipefail

workspace="${1:?usage: fetch-reviewed-commits.sh <workspace> <sha>...}"
shift

for sha in "$@"; do
  if [[ ! "$sha" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    echo "fetch-reviewed-commits: not a full commit SHA: ${sha}" >&2
    exit 64
  fi
done

max_fetches="${FETCH_REVIEWED_COMMITS_MAX:-5}"
fetch_timeout="${FETCH_REVIEWED_COMMITS_TIMEOUT_SECONDS:-30}"
# Both knobs reach arithmetic and `timeout`; accept only positive integers.
[[ "$max_fetches" =~ ^[1-9][0-9]*$ ]] || max_fetches=5
[[ "$fetch_timeout" =~ ^[1-9][0-9]*$ ]] || fetch_timeout=30

export GIT_TERMINAL_PROMPT=0
if [[ -n "${GIT_FETCH_TOKEN:-}" ]]; then
  header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GIT_FETCH_TOKEN" | base64 | tr -d '\n')"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::add-mask::${header#AUTHORIZATION: basic }"
  fi
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="http.${GITHUB_SERVER_URL:-https://github.com}/.extraheader"
  export GIT_CONFIG_VALUE_0="$header"
  unset header
fi
# git needs no other credential; keep every token variable out of its environment.
unset GIT_FETCH_TOKEN GH_TOKEN GITHUB_TOKEN

# Hooks never run for these git calls, whatever the checkout contains, and no
# background maintenance outlives the timeout.
git_cmd=(git -C "$workspace" -c core.hooksPath=/dev/null -c maintenance.auto=false -c gc.auto=0)

fetched=0
for sha in "$@"; do
  if "${git_cmd[@]}" cat-file -e "${sha}^{commit}" 2>/dev/null; then
    continue
  fi
  if [[ "$fetched" -ge "$max_fetches" ]]; then
    echo "::notice title=Nibble Review::skipped fetching older reviewed commits after ${max_fetches}"
    break
  fi
  fetched=$((fetched + 1))
  if timeout -k 5 "$fetch_timeout" "${git_cmd[@]}" fetch \
    --quiet --no-tags --no-recurse-submodules --no-write-fetch-head origin "$sha" 2>/dev/null; then
    echo "fetched reviewed commit ${sha}"
  else
    echo "::notice title=Nibble Review::reviewed commit ${sha} is not fetchable; the gate will run a full review"
  fi
done
