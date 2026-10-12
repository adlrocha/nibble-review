#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[nibble-review] %s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"
}

resolve_workspace() {
  if [[ -n "${WORKSPACE:-}" ]]; then
    printf '%s\n' "$WORKSPACE"
  elif [[ -n "${GITHUB_WORKSPACE:-}" ]]; then
    printf '%s\n' "$GITHUB_WORKSPACE"
  elif [[ -d /github/workspace ]]; then
    printf '%s\n' "/github/workspace"
  else
    pwd
  fi
}

install_dependencies() {
  local workspace="$1"
  local install_deps="${NIBBLE_REVIEW_INSTALL_DEPS:-false}"

  case "${install_deps,,}" in
    true|1|yes|on)
      ;;
    *)
      log "dependency install disabled; skipping package manager install"
      return
      ;;
  esac

  if [[ ! -f "$workspace/package.json" ]]; then
    log "no package.json found; skipping dependency install"
    return
  fi

  if [[ -f "$workspace/pnpm-lock.yaml" ]]; then
    require_tool corepack
    log "installing dependencies with pnpm"
    (cd "$workspace" && corepack enable && pnpm install --frozen-lockfile)
    return
  fi

  if [[ -f "$workspace/yarn.lock" ]]; then
    require_tool corepack
    log "installing dependencies with yarn"
    (cd "$workspace" && corepack enable && { yarn install --immutable || yarn install --frozen-lockfile; })
    return
  fi

  require_tool npm
  if [[ -f "$workspace/package-lock.json" || -f "$workspace/npm-shrinkwrap.json" ]]; then
    log "installing dependencies with npm ci"
    (cd "$workspace" && npm ci --dangerously-allow-all-scripts)
  else
    log "installing dependencies with npm install --no-package-lock"
    (cd "$workspace" && npm install --no-package-lock --dangerously-allow-all-scripts)
  fi
}

main() {
  require_tool git
  require_tool node

  local workspace
  workspace="$(resolve_workspace)"
  [[ -d "$workspace" ]] || die "workspace does not exist: $workspace"

  log "provisioning workspace: $workspace"
  git config --global --add safe.directory "$workspace" || true
  install_dependencies "$workspace"
}

main "$@"
