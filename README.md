<p align="center">
  <img src="assets/readme%20logo.png" alt="MiniCPM Desk Pet" width="760">
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg" alt="License"></a>
  <a href="https://huggingface.co/openbmb/MiniCPM5-1B-GGUF"><img src="https://img.shields.io/badge/Model-MiniCPM5--1B-green" alt="MiniCPM5-1B"></a>
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-lightgrey" alt="Platform">
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  A local-first desktop pet powered by MiniCPM. Download, complete the guided setup, and chat with a tiny companion that lives on your desktop.
</p>

---

## Highlights

- **Local by default** — after the model is downloaded, everyday chat runs on your machine.
- **Zero manual setup** — first launch guides you through environment check, model download, and warm-up.
- **Desktop companion** — open a floating chat bubble, talk with MiniCPM, and keep the pet on screen while you work.
- **Agent-aware reactions** — the pet can react to coding activity from tools such as Cursor, Claude Code, and Codex.
- **Task narration** — when a coding-agent session finishes, the pet summarizes what the AI just did in a speech bubble, so you can catch up at a glance.
- **Idle alerts** — if a coding agent has been waiting for your input, the pet plays a bell animation and sound to get your attention.
- **Auto-detect agents** — the app scans your machine for installed coding agents and prompts you to connect them in one click.
- **Smart model download** — the app can download from Hugging Face or ModelScope and choose the better source for your network.
- **Persona support** — switch or import character adapters from **Settings -> MiniCPM**.

## Getting Started

### System Requirements

| Item | Recommended |
| --- | --- |
| macOS | 14.0+, Apple Silicon (M1/M2/M3/M4), about 2 GB disk space |
| Windows | x64 with Vulkan support, about 2 GB disk space |
| Network | Required on first launch unless you already have a local model file |

> macOS Apple Silicon is the primary tested platform. A Windows installer is also available — feedback is welcome.

### Installation

**macOS**

1. Go to [Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases) and download the latest `MiniCPM Desk Pet-*-arm64.dmg`.
2. Open the DMG and drag **MiniCPM Desk Pet** into `Applications`.
3. Launch the app and follow the setup guide.

If macOS blocks the first launch, right-click the app and choose **Open**. If needed, remove the quarantine flag:

```bash
xattr -cr /Applications/MiniCPM\ Desk\ Pet.app
```

**Windows**

1. Go to [Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases) and download the latest `.exe` installer.
2. Run the installer and complete the wizard.
3. Launch the app and follow the setup guide.

### First Launch

MiniCPM Desk Pet includes a complete first-launch guide:

**Environment Check** -> **Model Download** -> **Model Warm-up** -> **Ready to Use**

The default model is [MiniCPM5-1B-GGUF](https://huggingface.co/openbmb/MiniCPM5-1B-GGUF). You can let the app download it automatically, or choose an existing local `.gguf` file.

## Features

### Chat With a Local Pet

Use the floating chat bubble to talk with MiniCPM from your desktop. Once setup is complete, your normal conversations do not need a remote inference service.

Useful shortcuts (macOS uses `Cmd`, Windows uses `Ctrl`):

- `Cmd/Ctrl+Shift+M` — open or close the MiniCPM chat bubble
- `Cmd/Ctrl+Shift+T` — show or hide thinking mode
- `Esc` — close the bubble when input is focused

### Reactions While You Work

MiniCPM Desk Pet can stay beside your workspace and react to coding-agent activity: thinking, working, finishing tasks, waiting for attention, or going idle.

### Model Management

The MiniCPM settings page lets you:

- download the default model or choose a local model file
- rerun onboarding
- manage character/persona adapters
- restart the local model runtime when needed

### Persona Adapters

The app includes a neko-style persona adapter. You can switch adapters or import your own from **Settings -> MiniCPM**.

## Attention Companion (v2)

The pet watches your focused window and uses MiniCPM to tell whether you're
working or drifting off — then reacts with a pet bubble instead of a native
dialog. The pipeline is a 4-step escalation ladder that stays cheap and
private by default:

1. **Hook / log signals** — coding-agent events and the browser tab-tracking
   extension (title, URL, media-session, heading hints).
2. **Accessibility / DOM pull** — when the text signal is ambiguous, the
   bridge's `domHint` (media-session + heading) is used to resolve it before
   any screenshot. (OS-level accessibility tree is a future backend.)
3. **Re-evaluate** — if still ambiguous, the cheap gates below run.
4. **Vision verification (MiniCPM-V 4.6)** — only as a true last resort, a
   second on-demand llama-server screenshots *just the focused window* and
   returns `on_task` / `distraction` / `unclear`. See
   [Vision model setup](#vision-model-setup) — it needs an extra download.

### Cheap front-line gates (always on)

These reduce noise before any model call and are pure, unit-tested logic:

- **Idle / AFK gate** — pause evaluation while you've been away
  (`Pause when idle / AFK`).
- **Privacy exclude-list** — never evaluate or capture windows whose
  app/title/URL matches a substring (bank, 1password, incognito, …).
- **Meeting / call category** — a valid task state, not a distraction.
- **Focus-dwell debounce** — only judge after focus holds for a moment
  (drops alt-tab flicker).
- **App clustering** — editor ↔ terminal ↔ docs read as one task.
- **Multi-browser same-task** — a video in one browser + notes in another
  don't read as "switched away".

### Observer features (Settings → Attention)

| Setting | What it does |
| --- | --- |
| **Task check-in** | When a new task is detected, confirm it's right instead of assuming. Corrections are never logged as distraction. |
| **Nudge contract** | Free text: what to hold you to this session. Anything clearly within it is *not* a distraction. |
| **Wander budget** | Per-session tangent allowance (minutes). The pet tracks silently and only speaks up once it's spent. `0` = off. |
| **Stuck detection** | If you repeat a question across tools or thrash files without a commit, the pet *offers help* (not a scold). |
| **Session recap** | Tracks where time went and tells you exactly where you left off after a break. |
| **Pattern surfacing** | Occasionally notes when you tend to drift (e.g. around 3pm). |
| **Enable Vision Verification** | Turns on the MiniCPM-V screenshot step (requires the model below). |

> **Prompt behavior:** the *Video Focus Mode* prompt shows at most once per
> video session, and the *Focus Check* prompt will not re-ask within a 5-minute
> cooldown after you dismiss it — so neither loops.

### Vision model setup

The vision classifier needs two files that are **not** bundled:

- `MiniCPM-V-4_6-Q4_K_M.gguf`
- `MiniCPM-V-4_6-mmproj-F16.gguf`

Download them once (they're large) into `clawd-on-desk/models/` (dev) or the
app's `userData/models/` folder:

```bash
# macOS / Linux
./go.sh fetch-vision
# or directly:
cd clawd-on-desk && ./scripts/fetch-vision-model.sh

# Windows (PowerShell)
cd clawd-on-desk
pwsh ./scripts/fetch-vision-model.ps1
```

Then enable **Settings → Attention → Enable Vision Verification (MiniCPM-V)**.
The sidecar cold-starts on the first ambiguous event and shuts down when idle.
Until these files are present, vision verification silently no-ops and the
pipeline stops at step 3.

### Remaining gaps (step-by-step)

These pieces are scaffolded but need assets/permissions or hook wiring:

- **OS accessibility tree (step 2):** implement per-OS AXUIElement
  (macOS) / UI Automation (Windows) / AT-SPI2 (Linux) in
  `src/attention-state-manager.js` `accessibilityPull`, returning
  `SAME_TASK` / `TASK_SWITCH_CONFIDENT` from real element roles/text. The
  browser-bridge `domHint` path is already wired.
- **Stuck-detection & commit/PR completion signals (step 4 §3.10):** feed
  agent events into the decision layer from your hook handlers, e.g.
  `global.__attentionDecision.recordAgentActivity({ type: "query", tool: "claude", question })`
  on `UserPromptSubmit`, `recordAgentActivity({ type: "write", path })` on
  Edit/Write, `recordAgentActivity({ type: "commit" })` on a git commit, and
  `recordTaskCompletion("pr")` when a PR opens. Today these seams exist but
  aren't called from hooks.
- **Per-browser onboarding prompt (§3.1):** `src/attention-browser-scan.js`
  already detects installed browsers and builds a per-browser extension
  install plan. Wire `BrowserScan.detectInstalled` + `buildInstallPlan` into
  `src/minicpm-onboarding.js` to prompt once per browser (currently only a
  single global extension prompt exists).
- **Permission-based sharing (§4):** the honest recap is generated, but the
  user-confirmed "share this summary with my pair" flow is not built yet.

## Roadmap

- Broader Linux validation.
- More persona presets.
- Clearer model download diagnostics and retry guidance.
- Faster first launch and smaller app footprint.
- Richer desktop-pet narration for long-running coding sessions.

## Known Limitations

- The primary tested release target is macOS Apple Silicon. Windows is supported with a bundled installer; report issues if something does not work on your setup.
- First launch requires an internet connection unless you provide a local model file.
- Response speed depends on your chip, memory pressure, and selected model.
- Coding-agent reactions depend on each tool's integration behavior and may vary by version.

## Developer Notes

For development setup, packaging, and repository layout, see [`docs/development.md`](docs/development.md).

## Acknowledgments

- Desktop pet UI is based on [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk). Full attribution is listed in [`NOTICE.md`](./NOTICE.md).
- Model weights come from the OpenBMB MiniCPM model family and are downloaded separately.
- The bundled neko persona uses the **neko30k** dataset ([liumindmind/NekoQA-30K](https://huggingface.co/datasets/liumindmind/NekoQA-30K)) for fine-tuning data.

## License

This repository is distributed under [GNU AGPL-3.0-only](./LICENSE).

MiniCPM model weights are downloaded separately and governed by the [OpenBMB MiniCPM Model License](https://github.com/OpenBMB/MiniCPM/blob/main/MiniCPM%20Model%20License.md). Artwork, third-party code, and datasets keep their own notices; see [`NOTICE.md`](./NOTICE.md) and [`clawd-on-desk/NOTICE.md`](clawd-on-desk/NOTICE.md).
