#!/usr/bin/env bash
# Runs fixer commands in a Docker sandbox whose only network route is an
# allowlist proxy to the model API.
#
#   fix-sandbox.sh up              create the internal network and egress proxy
#   fix-sandbox.sh install CMD…    run a dependency install in the sandbox image with
#                                  open network but no secrets (same ABI as the sandbox)
#   fix-sandbox.sh run CMD [ARG…]  run one command inside the sandbox
#   fix-sandbox.sh down            remove the proxy and network
#
# Environment:
#   SANDBOX_ENGINE   docker (default) or podman
#   SANDBOX_ID       unique id for this job's network and proxy (required)
#   SANDBOX_IMAGE    image with node and the repository's toolchain (default node:26-bookworm)
#   SANDBOX_ALLOW    comma-separated hosts the proxy may reach (required for up)
#   SANDBOX_ENV      space-separated variable names passed into run (values are never printed)
#   WORKSPACE        repository checkout, mounted read-write; its .git is mounted read-only
#   NIBBLE_DIR       built nibble-review, mounted read-only
#   FIX_DIR          fixer state directory, mounted read-write
set -euo pipefail

engine="${SANDBOX_ENGINE:-docker}"
[[ "$engine" == docker || "$engine" == podman ]] || { echo "fix-sandbox: SANDBOX_ENGINE must be docker or podman" >&2; exit 1; }
image="${SANDBOX_IMAGE:-node:26-bookworm}"
id="${SANDBOX_ID:?SANDBOX_ID is required}"
[[ "$id" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "fix-sandbox: invalid SANDBOX_ID" >&2; exit 1; }
network="nibble-fix-${id}"
egress_network="nibble-fix-egress-${id}"
proxy="nibble-fix-proxy-${id}"
user="$(id -u):$(id -g)"
userns=()
# Rootless podman remaps ids; keep the caller's id so mounted files stay theirs.
if [[ "$engine" == podman ]]; then
  userns=(--userns keep-id)
fi

up() {
  local allow="${SANDBOX_ALLOW:?SANDBOX_ALLOW is required}"
  [[ "$allow" =~ ^[A-Za-z0-9.,-]+$ ]] || { echo "fix-sandbox: invalid SANDBOX_ALLOW" >&2; exit 1; }
  "$engine" network create --internal "$network" >/dev/null
  # Only the proxy joins a network with a route out.
  "$engine" network create "$egress_network" >/dev/null
  "$engine" run -d --rm --name "$proxy" --network "$egress_network" --user "$user" "${userns[@]}" \
    --volume "${NIBBLE_DIR:?}:/nibble:ro" \
    "$image" node /nibble/dist/sandbox/egress-proxy.js --allow "$allow" --port 3128 >/dev/null
  "$engine" network connect --alias egress "$network" "$proxy"
  # Wait until the proxy listens; Node needs a moment to start.
  for _ in $(seq 1 50); do
    if "$engine" logs "$proxy" 2>&1 | grep -q "allowing"; then
      return 0
    fi
    sleep 0.2
  done
  echo "fix-sandbox: egress proxy did not start" >&2
  "$engine" logs "$proxy" >&2 || true
  exit 1
}

run() {
  local workspace="${WORKSPACE:?}" args=()
  for name in ${SANDBOX_ENV:-}; do
    [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "fix-sandbox: invalid SANDBOX_ENV name" >&2; exit 1; }
    args+=(--env "$name")
  done
  "$engine" run --rm --network "$network" --user "$user" "${userns[@]}" \
    --cap-drop ALL --security-opt no-new-privileges \
    --env HOME=/tmp/home \
    --env HTTPS_PROXY=http://egress:3128 --env HTTP_PROXY=http://egress:3128 --env NODE_USE_ENV_PROXY=1 \
    "${args[@]}" \
    --volume "${workspace}:${workspace}" \
    --volume "${workspace}/.git:${workspace}/.git:ro" \
    --volume "${NIBBLE_DIR:?}:${NIBBLE_DIR}:ro" \
    --volume "${FIX_DIR:?}:${FIX_DIR}" \
    --workdir "$workspace" \
    "$image" "$@"
}

install() {
  local workspace="${WORKSPACE:?}"
  "$engine" run --rm --network "$egress_network" --user "$user" "${userns[@]}" \
    --cap-drop ALL --security-opt no-new-privileges \
    --env HOME=/tmp/home --env NIBBLE_REVIEW_INSTALL_DEPS=true --env WORKSPACE="$workspace" \
    --volume "${workspace}:${workspace}" \
    --volume "${NIBBLE_DIR:?}:${NIBBLE_DIR}:ro" \
    --workdir "$workspace" \
    "$image" "$@"
}

down() {
  # A timed-out run can leave its container attached; remove it before the network.
  "$engine" ps -aq --filter "network=$network" | xargs -r "$engine" rm -f >/dev/null 2>&1 || true
  "$engine" rm -f "$proxy" >/dev/null 2>&1 || true
  "$engine" network rm "$network" "$egress_network" >/dev/null 2>&1 || true
}

case "${1:-}" in
  up) up ;;
  install) shift; install "$@" ;;
  run) shift; run "$@" ;;
  down) down ;;
  *) echo "usage: fix-sandbox.sh up|install CMD…|run CMD…|down" >&2; exit 2 ;;
esac
