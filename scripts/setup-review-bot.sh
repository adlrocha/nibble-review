#!/usr/bin/env bash
#
# setup-review-bot.sh — configure a repository to use your own Code Review bot.
#
# This script is fork-friendly: it keeps the agent source in sync with upstream
# by driving ALL bot identity through repository variables + secrets instead of
# hard-coding anything. After your GitHub App exists, run this against any repo
# (your agent fork itself, or any consuming repo) to make reviews run as YOUR
# bot identity.
#
# What it configures on the target repo:
#   secrets:  NIBBLE_REVIEW_PRIVATE_KEY, OPENCODE_API_KEY, [CONTEXT7_API_KEY]
#   vars:     REVIEW_APP_CLIENT_ID, REVIEW_COMMAND, [REVIEW_IMAGE],
#             [OPENCODE_MODEL], [OPENCODE_GATE_MODEL]
#   file:     .github/workflows/code-review.yml (the consumer trigger workflow)
#
# Usage:
#   scripts/setup-review-bot.sh create-app [--org ORG]
#       Print step-by-step GitHub App creation guidance (permissions + events).
#
#   scripts/setup-review-bot.sh configure --repo OWNER/REPO \
#       --app-client-id <id> --private-key <path-to-.pem> \
#       --opencode-key <key|-> [--opencode-key-file <path>] \
#       [--command @your-bot] [--image ghcr.io/owner/name:tag] \
#       [--agent-repo owner/repo] [--agent-ref main] \
#       [--context7-key <key>] [--model <id>] [--gate-model <id>] \
#       [--install-deps] [--no-workflow] [--workflow-file .github/workflows/code-review.yml] \
#       [--dry-run]
#
#   scripts/setup-review-bot.sh check --repo OWNER/REPO
#       Verify that the required secrets and variables are present.
#
#   scripts/setup-review-bot.sh generate-workflow [--agent-repo owner/repo] [--agent-ref main] \
#       [--command @your-bot] [--install-deps] [--workflow-file PATH]
#       Write the consumer trigger workflow without touching any secrets.
#
# The script only depends on the GitHub CLI (`gh`) being installed and
# authenticated with permission to manage secrets/variables on the target repo.
#
# It never prints secret values. Private keys and API keys are streamed directly
# into `gh secret set` from files/stdin.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
COMMAND_DEFAULT="@nibble-review"
IMAGE_DEFAULT="ghcr.io/adlrocha/nibble-review:latest"
WORKFLOW_FILE_DEFAULT=".github/workflows/code-review.yml"
SECRET_PRIVATE_KEY="NIBBLE_REVIEW_PRIVATE_KEY"
SECRET_OPENCODE_KEY="OPENCODE_API_KEY"
SECRET_CONTEXT7_KEY="CONTEXT7_API_KEY"

# Resolve script-owned assets relative to this file so the script works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="${SCRIPT_DIR}/assets"
WORKFLOW_TEMPLATE="${ASSETS_DIR}/code-review.yml.tmpl"
CREATE_APP_GUIDE="${ASSETS_DIR}/create-app-guide.md"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
COLOR_RESET=""
COLOR_BOLD=""
COLOR_GREEN=""
COLOR_YELLOW=""
COLOR_RED=""
COLOR_CYAN=""
if [[ -t 2 ]]; then
  COLOR_RESET=$'\033[0m'
  COLOR_BOLD=$'\033[1m'
  COLOR_GREEN=$'\033[32m'
  COLOR_YELLOW=$'\033[33m'
  COLOR_RED=$'\033[31m'
  COLOR_CYAN=$'\033[36m'
fi

log()   { printf '%s==>%s %s\n' "${COLOR_BOLD}" "${COLOR_RESET}" "$*" >&2; }
info()  { printf '%s   %s%s\n' "${COLOR_CYAN}" "$*" "${COLOR_RESET}" >&2; }
ok()    { printf '%s   %s✓%s %s\n' "${COLOR_GREEN}" "" "${COLOR_RESET}" "$*" >&2; }
warn()  { printf '%s   %s!%s %s\n' "${COLOR_YELLOW}" "" "${COLOR_RESET}" "$*" >&2; }
die()   { printf '%s   %serror:%s %s\n' "${COLOR_RED}" "" "${COLOR_RESET}" "$*" >&2; exit 1; }

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"
}

slugify() {
  printf '%s' "$1" | tr -cd '[:alnum:]._-' | tr '[:upper:]' '[:lower:]'
}

# ---------------------------------------------------------------------------
# Asset rendering — large text blocks live in scripts/assets/ for maintainability.
# ---------------------------------------------------------------------------
escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[&\\]/\\&/g'
}

require_asset() {
  [[ -f "$1" ]] || die "required asset not found: $1 (run this script from a checkout of the repo)"
}

render_workflow() {
  local agent_repo="$1" agent_ref="$2" command="$3" install_deps="$4"
  local npm_line=""
  if [[ "$install_deps" == "true" ]]; then
    npm_line="      npm_install: true"
  fi
  local r_repo r_ref r_cmd r_npm
  r_repo=$(escape_sed_replacement "$agent_repo")
  r_ref=$(escape_sed_replacement "$agent_ref")
  r_cmd=$(escape_sed_replacement "$command")
  r_npm=$(escape_sed_replacement "$npm_line")
  require_asset "$WORKFLOW_TEMPLATE"
  sed \
    -e "s|__AGENT_REPO__|${r_repo}|g" \
    -e "s|__AGENT_REF__|${r_ref}|g" \
    -e "s|__COMMAND__|${r_cmd}|g" \
    -e "s|__NPM_INSTALL_LINE__|${r_npm}|g" \
    "$WORKFLOW_TEMPLATE"
}

render_create_app_guide() {
  local create_url="$1"
  local r_url
  r_url=$(escape_sed_replacement "$create_url")
  require_asset "$CREATE_APP_GUIDE"
  sed -e "s|__CREATE_URL__|${r_url}|g" "$CREATE_APP_GUIDE"
}

ensure_gh() {
  require_tool gh
  if ! gh auth status >/dev/null 2>&1; then
    die "gh is not authenticated. Run: gh auth login"
  fi
}

# `gh secret set` with a repo or org target.
gh_secret_set() {
  local name="$1"
  shift
  if [[ -n "${OPT_ORG:-}" ]]; then
    # shellcheck disable=SC2086
    gh secret set "$name" --org "$OPT_ORG" ${OPT_ORG_REPOS:+--repos "$OPT_ORG_REPOS"} "$@"
  else
    # shellcheck disable=SC2086
    gh secret set "$name" --repo "$OPT_REPO" "$@"
  fi
}

gh_variable_set() {
  local name="$1" value="$2"
  if [[ -n "${OPT_ORG:-}" ]]; then
    # shellcheck disable=SC2086
    gh variable set "$name" --org "$OPT_ORG" --body "$value" ${OPT_ORG_VISIBILITY:+--visibility "$OPT_ORG_VISIBILITY"} >/dev/null
  else
    gh variable set "$name" --repo "$OPT_REPO" --body "$value" >/dev/null
  fi
}

# ---------------------------------------------------------------------------
# Subcommand: create-app
# ---------------------------------------------------------------------------
cmd_create_app() {
  local org=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --org) org="$2"; shift 2 ;;
      -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "unknown option for create-app: $1" ;;
    esac
  done

  local create_url
  if [[ -n "$org" ]]; then
    create_url="https://github.com/organizations/${org}/settings/apps/new"
  else
    create_url="https://github.com/settings/apps/new"
  fi

  render_create_app_guide "$create_url" >&2
}

# ---------------------------------------------------------------------------
# Subcommand: generate-workflow
# ---------------------------------------------------------------------------
generate_workflow_text() {
  local agent_repo="$1" agent_ref="$2" command="$3" install_deps="$4"
  render_workflow "$agent_repo" "$agent_ref" "$command" "$install_deps"
}

cmd_generate_workflow() {
  local agent_repo="" agent_ref="main" command="$COMMAND_DEFAULT" install_deps="false"
  local workflow_file="$WORKFLOW_FILE_DEFAULT"

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --agent-repo) agent_repo="$2"; shift 2 ;;
      --agent-ref) agent_ref="$2"; shift 2 ;;
      --command) command="$2"; shift 2 ;;
      --install-deps) install_deps="true"; shift ;;
      --workflow-file) workflow_file="$2"; shift 2 ;;
      -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "unknown option for generate-workflow: $1" ;;
    esac
  done

  [[ -n "$agent_repo" ]] || die "--agent-repo OWNER/REPO is required (the repo that owns .github/workflows/review.yml)"

  mkdir -p "$(dirname "$workflow_file")"
  generate_workflow_text "$agent_repo" "$agent_ref" "$command" "$install_deps" > "$workflow_file"
  ok "wrote ${workflow_file}"
  info "review it, then: git add ${workflow_file} && git commit -m 'ci: add code review bot' && git push"
}

# ---------------------------------------------------------------------------
# Subcommand: configure
# ---------------------------------------------------------------------------
cmd_configure() {
  local OPT_REPO="" OPT_ORG="" OPT_ORG_REPOS="" OPT_ORG_VISIBILITY=""
  local app_client_id="" private_key_file="" opencode_key="" opencode_key_file=""
  local context7_key="" command="$COMMAND_DEFAULT" image="$IMAGE_DEFAULT"
  local agent_repo="" agent_ref="main"
  local model="" gate_model=""
  local install_deps="false" write_workflow="true" workflow_file="$WORKFLOW_FILE_DEFAULT"
  local dry_run="false"

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --repo) OPT_REPO="$2"; shift 2 ;;
      --org) OPT_ORG="$2"; shift 2 ;;
      --org-repos) OPT_ORG_REPOS="$2"; shift 2 ;;
      --org-visibility) OPT_ORG_VISIBILITY="$2"; shift 2 ;;
      --app-client-id) app_client_id="$2"; shift 2 ;;
      --private-key) private_key_file="$2"; shift 2 ;;
      --opencode-key) opencode_key="$2"; shift 2 ;;
      --opencode-key-file) opencode_key_file="$2"; shift 2 ;;
      --context7-key) context7_key="$2"; shift 2 ;;
      --command) command="$2"; shift 2 ;;
      --image) image="$2"; shift 2 ;;
      --agent-repo) agent_repo="$2"; shift 2 ;;
      --agent-ref) agent_ref="$2"; shift 2 ;;
      --model) model="$2"; shift 2 ;;
      --gate-model) gate_model="$2"; shift 2 ;;
      --install-deps) install_deps="true"; shift ;;
      --no-workflow) write_workflow="false"; shift ;;
      --workflow-file) workflow_file="$2"; shift 2 ;;
      --dry-run) dry_run="true"; shift ;;
      -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "unknown option for configure: $1" ;;
    esac
  done

  # --- validation ---------------------------------------------------------
  if [[ -z "$OPT_ORG" ]]; then
    [[ -n "$OPT_REPO" ]] || die "--repo OWNER/REPO is required (or use --org ORG for org-level secrets)."
  fi
  [[ -n "$app_client_id" ]] || die "--app-client-id <id> is required (the App Client ID, starts with 'Iv')."
  [[ -n "$private_key_file" ]] || die "--private-key <path> is required (the downloaded *.pem file)."
  [[ -f "$private_key_file" ]] || die "private key file not found: $private_key_file"

  if [[ -z "$opencode_key" && -z "$opencode_key_file" ]]; then
    die "provide --opencode-key <key> (or '-' for stdin) or --opencode-key-file <path>."
  fi
  # Reject accidental shell-flag values.
  [[ "$opencode_key" != -* || "$opencode_key" == "-" ]] || die "--opencode-key value looks like a flag: $opencode_key"

  local target_desc
  if [[ -n "$OPT_ORG" ]]; then
    target_desc="org ${OPT_ORG}"
    if [[ -z "$OPT_ORG_REPOS" && -z "$OPT_ORG_VISIBILITY" ]]; then
      warn "--org set without --org-repos or --org-visibility; secret scope defaults to 'private' repos in ${OPT_ORG}."
      OPT_ORG_VISIBILITY="private"
    fi
  else
    target_desc="repo ${OPT_REPO}"
  fi

  if [[ "$dry_run" == "true" ]]; then
    log "DRY RUN — no changes will be made to ${target_desc}"
    info "would set secret: ${SECRET_PRIVATE_KEY} (from ${private_key_file})"
    info "would set secret: ${SECRET_OPENCODE_KEY}"
    [[ -n "$context7_key" ]] && info "would set secret: ${SECRET_CONTEXT7_KEY} (optional)"
    info "would set var: REVIEW_APP_CLIENT_ID = ${app_client_id}"
    info "would set var: REVIEW_COMMAND = ${command}"
    [[ "$image" != "$IMAGE_DEFAULT" ]] && info "would set var: REVIEW_IMAGE = ${image}"
    [[ -n "$model" ]] && info "would set var: OPENCODE_MODEL = ${model}"
    [[ -n "$gate_model" ]] && info "would set var: OPENCODE_GATE_MODEL = ${gate_model}"
  else
    ensure_gh
  fi

  log "Configuring Code Review bot for ${target_desc}"

  if [[ "$dry_run" != "true" ]]; then
    log "Setting secrets"
    gh_secret_set "$SECRET_PRIVATE_KEY" < "$private_key_file" && ok "${SECRET_PRIVATE_KEY}"
    if [[ -n "$opencode_key_file" ]]; then
      gh_secret_set "$SECRET_OPENCODE_KEY" < "$opencode_key_file" && ok "${SECRET_OPENCODE_KEY}"
    elif [[ "$opencode_key" == "-" ]]; then
      printf 'Reading %s from stdin... ' "$SECRET_OPENCODE_KEY" >&2
      gh_secret_set "$SECRET_OPENCODE_KEY" && ok "${SECRET_OPENCODE_KEY}"
    else
      printf '%s' "$opencode_key" | gh_secret_set "$SECRET_OPENCODE_KEY" && ok "${SECRET_OPENCODE_KEY}"
    fi
    if [[ -n "$context7_key" ]]; then
      printf '%s' "$context7_key" | gh_secret_set "$SECRET_CONTEXT7_KEY" && ok "${SECRET_CONTEXT7_KEY} (optional)"
    fi
  fi

  # --- variables ----------------------------------------------------------
  if [[ "$dry_run" != "true" ]]; then
    log "Setting variables"
    gh_variable_set "REVIEW_APP_CLIENT_ID" "$app_client_id" && ok "REVIEW_APP_CLIENT_ID"
    gh_variable_set "REVIEW_COMMAND" "$command" && ok "REVIEW_COMMAND = ${command}"
    if [[ "$image" != "$IMAGE_DEFAULT" ]]; then
      gh_variable_set "REVIEW_IMAGE" "$image" && ok "REVIEW_IMAGE = ${image}"
    else
      info "REVIEW_IMAGE left at default (${IMAGE_DEFAULT})"
    fi
    if [[ -n "$model" ]]; then
      gh_variable_set "OPENCODE_MODEL" "$model" && ok "OPENCODE_MODEL = ${model}"
    fi
    if [[ -n "$gate_model" ]]; then
      gh_variable_set "OPENCODE_GATE_MODEL" "$gate_model" && ok "OPENCODE_GATE_MODEL = ${gate_model}"
    fi
  fi

  # --- workflow -----------------------------------------------------------
  if [[ "$write_workflow" == "true" ]]; then
    if [[ -z "$agent_repo" ]]; then
      if [[ -n "$OPT_REPO" ]]; then
        agent_repo="$OPT_REPO"
        warn "--agent-repo not given; defaulting the trigger workflow's 'uses:' to ${agent_repo} (the repo that owns .github/workflows/review.yml)."
      else
        warn "--no-workflow implied: --org target without --agent-repo cannot write a local workflow."
        write_workflow="false"
      fi
    fi
  fi

  if [[ "$write_workflow" == "true" ]]; then
    log "Writing consumer trigger workflow"
    mkdir -p "$(dirname "$workflow_file")"
    generate_workflow_text "$agent_repo" "$agent_ref" "$command" "$install_deps" > "$workflow_file"
    ok "wrote ${workflow_file}"
    info "next: git add ${workflow_file} && git commit -m 'ci: add code review bot' && git push"
  fi

  echo >&2
  log "${COLOR_GREEN}Done.${COLOR_RESET} Configuration summary for ${target_desc}:"
  info "client id : ${app_client_id}"
  info "command   : ${command}"
  info "image     : ${image}"
  if [[ "$install_deps" == "true" ]]; then info "install-deps: enabled"; fi
  echo >&2
  info "Trigger a review by opening a non-draft same-repo PR, or by commenting"
  info "${command} on a same-repo PR (OWNER/MEMBER/COLLABORATOR only)."
  if [[ "$command" != "$COMMAND_DEFAULT" ]]; then
    echo >&2
    warn "You set a custom command. Make sure the GitHub App's install covers this repo"
    warn "and that the App can act as a bot named after its slug."
  fi
}

# ---------------------------------------------------------------------------
# Subcommand: check
# ---------------------------------------------------------------------------
cmd_check() {
  local OPT_REPO="" OPT_ORG=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --repo) OPT_REPO="$2"; shift 2 ;;
      --org) OPT_ORG="$2"; shift 2 ;;
      -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "unknown option for check: $1" ;;
    esac
  done
  if [[ -z "$OPT_ORG" ]]; then
    [[ -n "$OPT_REPO" ]] || die "--repo OWNER/REPO is required (or --org ORG)."
  fi

  ensure_gh

  local scope_args=()
  if [[ -n "$OPT_ORG" ]]; then
    scope_args=(--org "$OPT_ORG")
    log "Checking org ${OPT_ORG}"
  else
    scope_args=(--repo "$OPT_REPO")
    log "Checking repo ${OPT_REPO}"
  fi

  local missing=0

  check_secret() {
    local name="$1"
    if gh secret list "${scope_args[@]}" 2>/dev/null | awk '{print $1}' | grep -qx "$name"; then
      ok "secret: ${name}"
    else
      warn "MISSING secret: ${name}"
      missing=1
    fi
  }

  check_var() {
    local name="$1"
    if gh variable list "${scope_args[@]}" 2>/dev/null | awk -F'\t' '{print $1}' | grep -qx "$name"; then
      ok "var:    ${name}"
    else
      warn "MISSING var:    ${name}"
      missing=1
    fi
  }

  check_secret "$SECRET_PRIVATE_KEY"
  check_secret "$SECRET_OPENCODE_KEY"
  check_var "REVIEW_APP_CLIENT_ID"
  check_var "REVIEW_COMMAND"

  echo >&2
  if [[ "$missing" -eq 0 ]]; then
    log "${COLOR_GREEN}All required secrets and variables are present.${COLOR_RESET}"
  else
    die "one or more required entries are missing (see above)."
  fi
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
main() {
  local subcommand="${1:-}"
  [[ -n "$subcommand" ]] || { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }
  shift

  case "$subcommand" in
    create-app)       cmd_create_app "$@" ;;
    configure)        cmd_configure "$@" ;;
    check)            cmd_check "$@" ;;
    generate-workflow) cmd_generate_workflow "$@" ;;
    -h|--help|help)   sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' ;;
    *) die "unknown subcommand: $subcommand (try: create-app | configure | check | generate-workflow)" ;;
  esac
}

main "$@"
