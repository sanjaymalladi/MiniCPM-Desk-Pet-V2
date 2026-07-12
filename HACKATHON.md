# MiniCPM Desk Pet — Hackathon Guide

## What to show

MiniCPM Desk Pet is a local-first Electron companion: a pixel pet reacts to
coding-agent activity and provides a floating MiniCPM chat interface without
requiring a hosted inference service after the initial model download.

The hackathon additions are intentionally opt-in:

- Attention Companion: detects focused-work context using lightweight signals
  first, then optionally verifies ambiguous cases with an on-demand vision
  model.
- Memory Companion: optional local Supermemory-backed recall and proactive
  assistance. It is disabled by default and uses the MiniCPM text gateway.

## Demo path

1. Run `./go.sh` and complete the first-launch model setup.
2. Open the pet chat with `Ctrl/Cmd+Shift+M` and ask a local MiniCPM question.
3. Start a supported coding agent; the pet reflects its working/waiting/done
   state.
4. In **Settings → Attention**, enable attention features and, if desired,
   explicitly consent to vision verification.
5. In **Settings → Memory**, explicitly enable local memory to demonstrate
   saved context and the dashboard.

## Architecture

```text
Agent hooks / browser bridge
          ↓
Electron host → state machine → floating pet / chat bubble
          ↓                         ↓
 Attention policy              FastAPI gateway :18765
          ↓                         ↓
  optional vision process       llama.cpp / MiniCPM model
          ↓
 optional local memory service (explicit opt-in)
```

## Validation

```bash
cd clawd-on-desk && npm test
cd minicpm-sidecar && uv run pytest -q
```

Generated models, sidecars, local memory databases, and working-session notes
are ignored by Git. This keeps the submission source-focused and reproducible.
