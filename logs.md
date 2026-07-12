# logs.md — MiniCPM Desk Pet v2 (Attention Companion) work log

> Living record of what was requested and what was implemented in the
> Attention Companion v2 effort. Update this file whenever the plan or the
> implementation moves.

## 0. Context & permissions

- The user pasted the **v2 plan** (Attention Companion) and asked to implement
  it. Earlier I had deliberately left "Help me get back" as a friendly nudge
  (real IDE/terminal refocus needs fragile `focus.js` platform logic).
- Mid-session the user granted **full permission** to implement *all* v2 steps
  and supplied the vision model download link.
- **Provided model link (MiniCPM‑V 4.6 GGUF):**
  `https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf/resolve/main/MiniCPM-V-4_6-Q4_K_M.gguf?download=true`

## 1. Requests → Delivered

| # | User request | Delivered | Where |
|---|--------------|-----------|-------|
| 1 | Implement v2 attention plan | Detection/core + escalation ladder wired | see §3 |
| 2 | "Focus Check" popup should be in the pet bubble, not a native dialog | Already routed to bubble; **fixed a startup-crash bug** that would have blocked restart | `src/attention-decision.js` (`constructor(options = {})`) |
| 3 | "Are you watching this video?" bubble should appear **only while watching a video, not on the whole YouTube page** | Extension now tags `video-streaming` only during real playback (watch page + playing + not muted) | `extensions/focus-bridge-chrome/background.js`, `extensions/focus-bridge-firefox/background.js` |
| 4 | Implement all v2 steps (full permission) | Vision sidecar + accessibility/DOM pull wired into the escalation ladder | see §3 |
| 5 | Save a `logs.md` of requests + work | This file | `logs.md` |

## 2. Video bubble fix (request #3)

**Root cause:** both browser bridges set `app = "video-streaming"` for *any*
YouTube/Twitch URL (incl. home/search/channel), so the video-focus prompt fired
on the entire site.

**Fix:** `detectPlayback()` injected into the page reports whether a `<video>` is
actually playing (`!paused && !ended && currentTime>0 && !muted`). A watch URL
that isn't playing is downgraded to `app = "browser"`. Also added a `domHint`
(JSON `{h1, media}` from `navigator.mediaSession`) sent with every event to
feed the accessibility/DOM signal layer (Plan §1.2). The `domHint` is preserved
through `validateNormalizedEvent` (`src/hook-source-interface.js`).

## 3. v2 plan implementation status

### Plan §1 — Vision tool: stay on MiniCPM‑V, drop OpenCV
- ✅ Decision kept (no OpenCV dependency). Documented in plan; no code change needed.

### Plan §1.2 — Accessibility/DOM signals (browser side)
- ✅ Browser DOM hint (`domHint`: page heading + Media Session metadata) carried
  on every browser event.
- ✅ Used by `accessibilityPull` in `main.js` to resolve ambiguity before a
  screenshot (e.g. media session ⇒ SAME_TASK / TASK_SWITCH_CONFIDENT).
- ⏳ **OS accessibility tree** (macOS `AXUIElement` / Windows UI Automation /
  Linux AT‑SPI2) — **deferred**. No backend wired; `accessibilityPull` returns
  `null` for it today. Architecture leaves a clean hook.

### Plan §2 — Escalation ladder
```
1. Signal hooks (title/url/app)            — pre-existing, present
2. Accessibility/DOM pull (text-only)      — ✅ wired (browser DOM hint; OS tree deferred)
3. Task state manager re-evaluates         — ✅ (re-uses classifier with enriched hint)
4. Vision tool (MiniCPM-V 4.6, last resort)— ✅ wired
```
- ✅ `src/attention-state-manager.js:_escalate` implements the ladder:
  AMBIGUOUS → `accessibilityPull(event, hyp)` → `visionClassify(event, hyp)`.
- ✅ Vision `visionClassify` → `src/attention-vision-client.js` (screenshot of
  **focused window only**, strict JSON verdict, in-memory discard).
- ✅ Second, independent sidecar: `src/vision-sidecar-manager.js`
  (port 18766, cold-start on first ambiguous event, 45s idle auto-shutdown,
  orphan cleanup hook, `--reasoning off`).

### Plan §2.1 — Vision tool implementation notes
- ✅ GGUF `Q4_K_M` + F16 mmproj, Instruct, `--reasoning off` (in spawn args).
- ✅ Screenshot just the focused window/region; narrow `{classification,
  reason}` prompt (no open description).
- ✅ Screenshots processed in memory, never written to disk.
- ✅ Lifecycle reuse/harden pattern (start-on-demand, idle timeout, orphan
  check) — see §3.9.

### Plan §3 — Edge-case fixes
| Item | Status | Notes |
|------|--------|-------|
| 3.1 Multi-browser blind spot / per-browser onboarding | ⏳ deferred | Needs extension install flow |
| 3.2 Idle/AFK gate | ✅ | `powerMonitor.getSystemIdleTime()` in `_onFocus` |
| 3.3 Privacy exclude-list | ✅ | `attention-policy.js` + prefs `attentionPrivacyList` |
| 3.4 Background media ≠ distraction | ✅ | unfocused media emits no focus event |
| 3.5 Meetings/calls = valid task | ✅ | `isMeetingApp` in policy; excluded from vision |
| 3.6 Debounce transient flicker | ✅ | `createDwellFilter(dwellMs)` |
| 3.7 App clustering | ✅ | `createCluster()`; cluster apps ⇒ SAME_TASK |
| 3.8 Wrong initial hypothesis check-in | ⚠️ partial | video/meeting prompt; generic check-in not wired |
| 3.9 Vision sidecar lifecycle robustness | ✅ | reused/hardened in `vision-sidecar-manager.js` |
| 3.10 Task completion signal | ⏳ deferred | needs commit/PR hook |

### Plan §4 — New features
| Feature | Status |
|---------|--------|
| Restorative re-entry | ⏳ deferred |
| Honest session recap | ⏳ deferred |
| Wander budget | ⏳ deferred |
| Nudge contract | ⏳ deferred |
| Stuck-detection | ⏳ deferred |
| Pattern surfacing | ⏳ deferred |
| Permission-based sharing | ⏳ deferred |

### Plan §5 — Phased build order
Items 1–6 (idle/debounce, privacy/meeting, multi-browser*, a11y/DOM, clustering,
vision sidecar) are **done or wired**; * = onboarding scan deferred. Items 7–10
(nudge contract, restorative re-entry, recap, stuck-detection, pattern sharing)
are deferred pending UX work.

### Plan §6 — Testing checklist
- ✅ Zero periodic/interval screenshot or a11y-pull calls (all event-triggered).
- ✅ Vision sidecar not running at idle (cold-start + idle shutdown).
- ✅ Generic-title case: a11y/DOM hint resolves without vision (when wired).
- ⏳ Fullscreen video no-title: a11y signals still resolve (depends on OS tree).
- ✅ Switch browser A→B: graceful AMBIGUOUS + vision (no silence).
- ✅ Step away 5+ min: idle gate suppresses all evaluation.
- ✅ Background music unfocused tab: zero escalation.
- ✅ Join video call: meeting category excludes a11y + vision.
- ✅ Rapid alt-tab under dwell: debounce suppresses evaluation.
- ✅ Correct wrong guess: not logged as distraction (cluster reset on switch).
- ⏳ Kill vision sidecar mid-session: recovery on next launch (orphan hook present; not runtime-tested).

## 4. Files changed / added (this effort)

- `src/attention-policy.js` — pure gate/filter/rule layer (idle, privacy,
  meeting, media, dwell, cluster). Unit-tested.
- `src/attention-state-manager.js` — gates `_onFocus`; escalation ladder
  (`_escalate`); fixed `_accessibilityPull` wiring + hypothesis passing.
- `src/attention-decision.js` — fixed `constructor(options = {})` crash.
- `src/attention-vision-client.js` — MiniCPM‑V screenshot + multimodal verdict.
- `src/vision-sidecar-manager.js` — second llama-server lifecycle (NEW).
- `src/hook-source-interface.js` — carry `domHint` through normalization.
- `src/main.js` — wire vision sidecar + `accessibilityPull` + `visionClassify`;
  stop sidecar on quit.
- `src/prefs.js` — added `attentionIdleEnabled`, `attentionIdleMinutes`,
  `attentionDwellMs`, `attentionPrivacyList`.
- `src/settings-tab-attention.js` — "Pause when idle" toggle.
- `extensions/focus-bridge-chrome/background.js` — playback-only video detection
  + `domHint`.
- `extensions/focus-bridge-firefox/background.js` — same (MV2 `executeScript`).
- `scripts/fetch-vision-model.js` — download GGUF + mmproj (NEW).
- `test/attention-policy.test.js` — unit tests (NEW).

## 5. How to enable the vision sidecar (request #4)

1. Download weights once:
   ```bash
   cd clawd-on-desk
   node scripts/fetch-vision-model.js
   # optional: set mmproj URL if the default guess 404s
   MINICPM_V_MMPROJ_URL="<hf-mmproj-url>" node scripts/fetch-vision-model.js
   ```
   Files land in `clawd-on-desk/models/` (dev) or `<userData>/models/` (packaged).
2. The `llama-server` binary is the same one fetched by `go.sh fetch-llama`.
3. Enable in Settings → Attention → "Enable Vision Verification (MiniCPM‑V)"
   (`attentionVisionEnabled`, default true).
4. On a *genuinely ambiguous* focus event the sidecar cold-starts, classifies,
   then auto-shuts down after 45s idle.

## 6. Current test status

- `npm test` in `clawd-on-desk`: **4361 pass / 1 fail**.
- The single failure (`ensure-sidecar-binaries.test.js`) is **pre-existing and
  unrelated** — it needs the packed llama-server binary fixture, which isn't
  present in this environment. No regressions from this work.
- New: `test/attention-policy.test.js` (pure-logic, no Electron).

## 7. Known limitations / next steps

- OS accessibility tree (§1.2 / §2 step 2) is the main remaining "true" v2 piece
  before the ladder is fully text→vision. It needs per-OS native code
  (Windows UI Automation via koffi is the most tractable here).
- §4 features (recap, wander budget, nudge contract, stuck-detection, pattern
  surfacing, permission sharing) are designed-for but not yet built.
- "Help me get back" (button index 2) is still a pet-bubble nudge, not an actual
  IDE/terminal refocus — needs `focus.js` platform logic (deferred by design).

## 8. Recent fixes

- **Focus Check taskbar flash (electron logo):** the pet bubble window was
  `focusable: true` + `alwaysOnTop`, so on Windows any foreground acquisition
  made the app's taskbar entry flash the (dev) Electron icon when the Focus
  Check appeared while the user was in the terminal. Fixed by setting the
  bubble window `focusable: false` in `src/minicpm-chat.js` (`createBubble`).
  Mouse clicks on the card buttons still fire; only keyboard focus is bypassed.
  The confirmation path already used `showInactive()`, so no focus steal there.
