#!/bin/bash
# Installs workspace dependencies so typecheck, tests and the Metro bundler work
# straight away in a Claude Code on the web session.
set -euo pipefail

# Local machines already have their own setup; only do this on the web.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# npm install rather than ci: the container image is cached after this runs, and
# install is a no-op when node_modules is already current.
npm install --no-audit --no-fund

# Expo's CLI reaches out to its API to check native module versions, which the
# sandbox blocks. Versions here are pinned from expo/bundledNativeModules.json.
echo 'export EXPO_NO_TELEMETRY=1' >> "${CLAUDE_ENV_FILE:-/dev/null}"
