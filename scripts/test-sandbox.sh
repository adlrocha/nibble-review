#!/usr/bin/env bash
# Integration check for bin/fix-sandbox.sh: the allowlisted host is reachable
# through the egress proxy; every other host and any direct connection is not.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
workspace="$(mktemp -d)"
state="$(mktemp -d)"
git -C "$workspace" init -q
export SANDBOX_ID="selftest-$$" SANDBOX_ALLOW="api.github.com" NIBBLE_DIR="$root" WORKSPACE="$workspace" FIX_DIR="$state"
sandbox="$root/bin/fix-sandbox.sh"
trap 'bash "$sandbox" down; rm -rf "$workspace" "$state"' EXIT

bash "$sandbox" up
bash "$sandbox" run node --input-type=module -e '
const attempt = async url => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(10_000) })
    return true
  } catch {
    return false
  }
}
const direct = () =>
  new Promise(resolve => {
    import("node:net").then(({ connect }) => {
      const socket = connect(443, "1.1.1.1")
      socket.setTimeout(5_000)
      socket.on("connect", () => resolve(true))
      socket.on("error", () => resolve(false))
      socket.on("timeout", () => resolve(false))
    })
  })
const results = {
  allowed: await attempt("https://api.github.com/"),
  otherHost: await attempt("https://example.com/"),
  registry: await attempt("https://registry.npmjs.org/"),
  direct: await direct()
}
console.log(JSON.stringify(results))
if (!results.allowed || results.otherHost || results.registry || results.direct) {
  console.error("sandbox egress policy violated")
  process.exit(1)
}
'
echo "sandbox egress policy holds"
