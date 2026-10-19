#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this check as root so it can read the service token." >&2
  exit 1
fi

CONFIG_FILE="${WS_TERMINAL_CONFIG_FILE:-/etc/ws-terminal/ws-terminal.env}"
INSTALL_DIR="${WS_TERMINAL_INSTALL_DIR:-/opt/ws-terminal}"

if [[ ! -r "$CONFIG_FILE" ]]; then
  echo "Cannot read $CONFIG_FILE" >&2
  exit 1
fi

ACCESS_TOKEN="$(sed -n 's/^WS_TERMINAL_TOKEN=//p' "$CONFIG_FILE" | head -n 1)"
if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "WS_TERMINAL_TOKEN is missing from $CONFIG_FILE" >&2
  exit 1
fi

export WS_TERMINAL_TEST_URL="${WS_TERMINAL_TEST_URL:-http://127.0.0.1:8002}"
export WS_TERMINAL_TEST_TOKEN="$ACCESS_TOKEN"
cd "$INSTALL_DIR"
exec npm run smoke:linux
