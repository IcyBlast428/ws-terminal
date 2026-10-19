#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

SOURCE_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_DIR="/opt/ws-terminal"
CONFIG_DIR="/etc/ws-terminal"
CONFIG_FILE="$CONFIG_DIR/ws-terminal.env"
SERVICE_FILE="/etc/systemd/system/ws-terminal.service"
NGINX_FILE="/etc/nginx/conf.d/ws-terminal.conf"

for required_file in package.json server/src/index.js deploy/ws-terminal.service deploy/nginx-ws-terminal.conf; do
  if [[ ! -f "$SOURCE_DIR/$required_file" ]]; then
    echo "Invalid project directory: missing $required_file" >&2
    exit 1
  fi
done

if ! command -v nginx >/dev/null 2>&1; then
  echo "Nginx is not installed." >&2
  exit 1
fi

install -d -o root -g root -m 0755 "$INSTALL_DIR"
cp -a "$SOURCE_DIR/." "$INSTALL_DIR/"
chown -R root:root "$INSTALL_DIR"

install -d -o root -g root -m 0700 "$CONFIG_DIR"
if [[ -f "$CONFIG_FILE" ]]; then
  echo "Keeping the existing service configuration and access token."
  chown root:root "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
else
  ACCESS_TOKEN="$(openssl rand -hex 32)"
  TEMP_CONFIG="$(mktemp)"
  trap 'rm -f "$TEMP_CONFIG"' EXIT
  cp "$INSTALL_DIR/deploy/ws-terminal.env.example" "$TEMP_CONFIG"
  sed -i "s|^WS_TERMINAL_TOKEN=.*|WS_TERMINAL_TOKEN=$ACCESS_TOKEN|" "$TEMP_CONFIG"
  install -o root -g root -m 0600 "$TEMP_CONFIG" "$CONFIG_FILE"
fi

install -o root -g root -m 0644 "$INSTALL_DIR/deploy/ws-terminal.service" "$SERVICE_FILE"
install -o root -g root -m 0644 "$INSTALL_DIR/deploy/nginx-ws-terminal.conf" "$NGINX_FILE"

cd "$INSTALL_DIR"
node -e "require('node-pty')"
nginx -t
systemctl daemon-reload
systemctl enable nginx.service
systemctl restart nginx.service
systemctl enable ws-terminal.service
systemctl restart ws-terminal.service

echo "WS Terminal installed successfully."
echo "SHELL_USER=root"
echo "URL=http://localhost:8002"
echo "Access token is stored in $CONFIG_FILE (root only)."
