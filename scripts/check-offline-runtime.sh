#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_INFO="$ROOT_DIR/OFFLINE-BUILD-INFO.txt"

if [[ ! -f "$BUILD_INFO" ]]; then
  echo "OFFLINE-BUILD-INFO.txt not found; this check is intended for an extracted offline bundle." >&2
  exit 1
fi

read_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$BUILD_INFO"
}

EXPECTED_ARCH="$(read_value architecture)"
EXPECTED_LIBC="$(read_value libc)"
EXPECTED_LIBC_VERSION="$(read_value libc_version)"
EXPECTED_NODE_ABI="$(read_value node_abi)"
CURRENT_ARCH="$(uname -m)"
CURRENT_NODE_ABI="$(node -p "process.versions.modules")"

if [[ "$CURRENT_ARCH" != "$EXPECTED_ARCH" ]]; then
  echo "Architecture mismatch: bundle=$EXPECTED_ARCH current=$CURRENT_ARCH" >&2
  exit 1
fi

if [[ "$CURRENT_NODE_ABI" != "$EXPECTED_NODE_ABI" ]]; then
  echo "Node ABI mismatch: bundle=$EXPECTED_NODE_ABI current=$CURRENT_NODE_ABI" >&2
  exit 1
fi

if ldd --version 2>&1 | grep -qi musl; then
  CURRENT_LIBC="musl"
else
  CURRENT_LIBC="glibc"
fi

if [[ "$CURRENT_LIBC" != "$EXPECTED_LIBC" ]]; then
  echo "libc mismatch: bundle=$EXPECTED_LIBC current=$CURRENT_LIBC" >&2
  exit 1
fi

if [[ "$CURRENT_LIBC" == "glibc" ]]; then
  CURRENT_LIBC_VERSION="$(getconf GNU_LIBC_VERSION | awk '{print $2}')"
  OLDEST_VERSION="$(printf '%s\n%s\n' "$EXPECTED_LIBC_VERSION" "$CURRENT_LIBC_VERSION" | sort -V | head -n 1)"
  if [[ "$OLDEST_VERSION" != "$EXPECTED_LIBC_VERSION" ]]; then
    echo "glibc is too old: bundle requires $EXPECTED_LIBC_VERSION, current=$CURRENT_LIBC_VERSION" >&2
    exit 1
  fi
fi

node -e "require('node-pty')"
if [[ ! -x /usr/bin/mv ]] || ! /usr/bin/mv --version | head -n 1 | grep -q 'GNU coreutils'; then
  echo 'GNU /usr/bin/mv is required for exclusive copy and move operations.' >&2
  exit 1
fi
echo "Offline runtime is compatible."
