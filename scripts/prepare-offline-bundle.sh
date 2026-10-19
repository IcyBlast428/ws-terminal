#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Build the offline bundle on Linux, not on Windows or macOS." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "node_modules not found. Run npm install --omit=dev on a matching Linux machine first." >&2
  exit 1
fi

node -e "require('node-pty')" || {
  echo "node-pty native module is not usable. Run npm ci --omit=dev on this Linux machine." >&2
  exit 1
}

VERSION="$(node -p "require('./package.json').version")"
ARCH="$(uname -m)"
NODE_VERSION="$(node -p "process.versions.node")"
NODE_ABI="$(node -p "process.versions.modules")"
if ldd --version 2>&1 | grep -qi musl; then
  LIBC="musl"
  LIBC_VERSION="$(ldd --version 2>&1 | head -n 1)"
else
  LIBC="glibc"
  LIBC_VERSION="$(getconf GNU_LIBC_VERSION | awk '{print $2}')"
fi
OUT="ws-terminal-${VERSION}-linux-${ARCH}-${LIBC}-nodeabi${NODE_ABI}-offline.tgz"
BUILD_INFO="OFFLINE-BUILD-INFO.txt"

printf '%s\n' \
  "app_version=${VERSION}" \
  "architecture=${ARCH}" \
  "libc=${LIBC}" \
  "libc_version=${LIBC_VERSION}" \
  "node_version=${NODE_VERSION}" \
  "node_abi=${NODE_ABI}" \
  > "$BUILD_INFO"
trap 'rm -f "$BUILD_INFO"' EXIT

tar \
  --mode='go-w' \
  --exclude='.git' \
  --exclude='*.log' \
  --exclude='dist' \
  -czf "$OUT" \
  package.json \
  package-lock.json \
  server \
  public \
  scripts \
  deploy \
  test \
  README.md \
  SECURITY.md \
  Dockerfile \
  .dockerignore \
  "$BUILD_INFO" \
  .env.example \
  node_modules

sha256sum "$OUT" > "${OUT}.sha256"
echo "$OUT"
echo "${OUT}.sha256"
