#!/usr/bin/env bash
set -euo pipefail

rm -rf dist
tsc -p tsconfig.json
cp -R src/instructions dist/instructions
chmod +x dist/cli/pi-isolated.js dist/cli/review.js dist/cli/preflight.js
chmod +x dist/cli/fix.js dist/sandbox/egress-proxy.js
