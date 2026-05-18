#!/usr/bin/env bash
# Convenience launcher for the uv-managed bridge.
#
# First run: `uv sync` resolves and installs everything into ./.venv (~30s
# the first time, ~0.5s thereafter — uv caches downloads globally).
# Subsequent runs: `uv run` reuses the existing venv, so startup is fast.
#
# This script is the recommended way to launch standalone (without the
# Electron pet driving it). The pet itself can also point at this folder
# via `MINICPM_BRIDGE_DIR` + `MINICPM_PYTHON=$(pwd)/.venv/bin/python`.

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found. Install with:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

# Sync the venv only when needed — uv is idempotent and very fast even
# on no-op syncs, but skipping the call entirely cuts ~150ms off launches.
if [[ ! -d .venv ]]; then
  echo "[uv] first-time setup, installing deps..." >&2
  uv sync
fi

exec uv run python server.py "$@"
