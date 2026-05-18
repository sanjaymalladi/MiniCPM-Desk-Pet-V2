#!/usr/bin/env bash
# Convenience launcher: activates the conda env and starts the chat server.
set -euo pipefail

ENV_NAME="${MINICPM_CONDA_ENV:-minicpm-pet}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_DIR="${MINICPM_MODEL:-$HERE/../models/minicpm5-0.9b}"

if ! command -v conda >/dev/null 2>&1; then
  echo "[error] conda not found in PATH; install Miniconda/Anaconda first." >&2
  exit 1
fi

# `conda activate` requires sourcing the conda hook in non-login shells.
eval "$(conda shell.bash hook)"
conda activate "$ENV_NAME"

exec python "$HERE/server.py" --model "$MODEL_DIR" "$@"
