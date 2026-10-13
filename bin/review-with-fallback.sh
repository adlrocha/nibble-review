#!/usr/bin/env bash
# Runs one publishing review and retries once with REVIEW_FALLBACK_MODEL when
# the primary model fails before anything was published (runner exit code 2).
set -euo pipefail

runner="${NIBBLE_REVIEW_RUNNER:-node ${GITHUB_ACTION_PATH:?}/dist/cli/review.js}"
timeout_minutes="${TIMEOUT_MINUTES:-20}"
# The runner abandons an unpublished review a minute before the hard timeout and
# exits 2, so a slow primary model still hands over to the fallback.
deadline_seconds=$((timeout_minutes * 60 - 60))
if [[ "$deadline_seconds" -lt 30 ]]; then
  deadline_seconds=30
fi
export NIBBLE_REVIEW_DEADLINE_SECONDS="$deadline_seconds"

run_review() {
  # shellcheck disable=SC2086 # the runner command is intentionally word-split
  timeout "${timeout_minutes}m" $runner --publish
}

set +e
run_review
status=$?
set -e

if [[ "$status" -eq 0 || "$status" -ne 2 ]]; then
  exit "$status"
fi
if [[ -z "${REVIEW_FALLBACK_MODEL:-}" || "${REVIEW_FALLBACK_MODEL}" == "${REVIEW_MODEL:-}" ]]; then
  echo "::error title=Nibble Review::${REVIEW_MODEL:-the primary model} failed before publication and no distinct fallback model is configured"
  exit "$status"
fi

echo "::warning title=Nibble Review::${REVIEW_MODEL:-the primary model} failed before publication; retrying with ${REVIEW_FALLBACK_MODEL}"
REVIEW_MODEL="$REVIEW_FALLBACK_MODEL" run_review
