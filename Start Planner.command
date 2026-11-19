#!/bin/bash
# Double-click to run Planner's web version locally.
#
# Installs what the web app needs (first run only), starts it on
# http://localhost:5190 and opens it in your browser. Close this Terminal
# window, or press Ctrl+C, to stop it.

cd "$(dirname "$0")" || exit 1

# A double-clicked script does not get your shell profile, so add the usual
# places Node lives.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

fail() {
  echo
  echo "  $1"
  echo
  read -r -p "Press Return to close." _
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Get version 22 or newer (LTS) from https://nodejs.org, then double-click this file again."
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)'; then
  fail "Node.js $(node -v) is too old. Planner needs 22.5 or newer — get the LTS from https://nodejs.org."
fi

if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  PNPM=(corepack pnpm)
else
  PNPM=(npx --yes pnpm@11)
fi

if [ ! -d apps/web/node_modules ]; then
  echo "First run: installing dependencies (needs internet, takes a minute)…"
  "${PNPM[@]}" install --filter "@planner/web..." || fail "Installing dependencies failed — see the messages above."
fi

# Open the browser once the server answers.
(
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null http://localhost:5190; then
      open http://localhost:5190
      exit 0
    fi
    sleep 1
  done
) &

echo
echo "Starting Planner on http://localhost:5190 — close this window to stop it."
echo
"${PNPM[@]}" --filter @planner/web dev || fail "Planner stopped. If it says port 5190 is in use, another copy is already running."
