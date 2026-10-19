#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this command as root." >&2
  exit 1
fi

CONFIG_FILE="${WS_TERMINAL_CONFIG_FILE:-/etc/ws-terminal/ws-terminal.env}"
NEW_TOKEN="${1:-}"

if [[ -z "$NEW_TOKEN" ]]; then
  read -r -s -p "New access token: " NEW_TOKEN
  echo
fi

if [[ ${#NEW_TOKEN} -lt 24 ]]; then
  echo "The access token must contain at least 24 characters." >&2
  exit 1
fi
if [[ ! "$NEW_TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ ]]; then
  echo "Use only letters, numbers, and . _ ~ + / = - characters." >&2
  exit 1
fi
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Configuration file not found: $CONFIG_FILE" >&2
  exit 1
fi

TEMP_CONFIG="$(mktemp)"
trap 'rm -f "$TEMP_CONFIG"' EXIT
TOKEN_REPLACED=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == WS_TERMINAL_TOKEN=* ]]; then
    printf 'WS_TERMINAL_TOKEN=%s\n' "$NEW_TOKEN" >> "$TEMP_CONFIG"
    TOKEN_REPLACED=1
  else
    printf '%s\n' "$line" >> "$TEMP_CONFIG"
  fi
done < "$CONFIG_FILE"

if [[ "$TOKEN_REPLACED" -eq 0 ]]; then
  printf 'WS_TERMINAL_TOKEN=%s\n' "$NEW_TOKEN" >> "$TEMP_CONFIG"
fi

install -o root -g root -m 0600 "$TEMP_CONFIG" "$CONFIG_FILE"
systemctl restart ws-terminal.service
echo "Access token updated. Existing browser sessions have been revoked."
