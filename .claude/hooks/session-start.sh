#!/bin/bash
# Installs dependencies so typecheck, tests and bundlers work straight away in a
# Claude Code on the web session. Local machines have their own setup, so this is a
# no-op there.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# npm install rather than ci: the container image is cached after this runs, and
# install is a no-op when node_modules is already current.
npm install --no-audit --no-fund

# Expo's CLI reaches out to its API to check native module versions, which the
# sandbox blocks; versions are pinned from expo/bundledNativeModules.json instead.
if [ -d node_modules/expo ]; then
  echo 'export EXPO_NO_TELEMETRY=1' >> "${CLAUDE_ENV_FILE:-/dev/null}"
fi
