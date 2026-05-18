# minicpm-pet-bridge (uv edition)

This is a clone of `../minicpm-pet-bridge/` re-shaped around [uv](https://docs.astral.sh/uv/)
for installation. **Source code (`server.py`, `updater.py`) is byte-identical to the
original** — only the dependency-management surface changes.

The original `minicpm-pet-bridge/` is left untouched; both can co-exist.

## Why uv?

- **One-line install for friends**: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **10–100× faster** than `pip install` (resolution + wheel download in parallel)
- **Lockfile** (`uv.lock`) — friends get the exact same versions you tested with
- **No conda needed** — a `.venv/` is materialised next to the code on first run

## First-time setup

```bash
cd minicpm-pet-bridge-uv
uv sync           # creates .venv/, downloads deps (one-shot ~30s on first run)
./run.sh          # starts the server on 127.0.0.1:8765
```

That's it. No conda env, no manual `pip install`.

## Pointing the desktop pet at this folder

The Electron app picks the bridge directory via `MINICPM_BRIDGE_DIR` (and the
Python interpreter via `MINICPM_PYTHON`). To make it use the uv venv:

```bash
export MINICPM_BRIDGE_DIR="$(pwd)"          # absolute path to this folder
export MINICPM_PYTHON="$(pwd)/.venv/bin/python"

cd ../clawd-on-desk
npm start
```

The Electron app then spawns `<this folder>/.venv/bin/python server.py` directly,
bypassing conda entirely.

## Reverting to the original (conda/pip) flow

Just unset the env vars:

```bash
unset MINICPM_BRIDGE_DIR MINICPM_PYTHON
```

The Electron app will fall back to its built-in conda detection and the
original `../minicpm-pet-bridge/` folder.

## Updating dependencies

```bash
uv sync --upgrade               # bump within the version ranges in pyproject.toml
uv lock --upgrade-package torch # bump just one package
```

The lockfile is regenerated; commit it so other machines reproduce.

## Layout

```
minicpm-pet-bridge-uv/
├── pyproject.toml      # dep declarations (replaces requirements.txt)
├── .python-version     # uv reads this to pick a Python interpreter
├── .gitignore
├── run.sh              # convenience launcher: uv sync (if needed) + run server
├── server.py           # ← copy of original
└── updater.py          # ← copy of original
```

After first `uv sync` you'll also see `.venv/` and `uv.lock`.
