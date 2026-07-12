"use strict";

/**
 * @file attention-vision-client.js
 *
 * The MiniCPM‑V 4.6 *vision* classifier — the true last resort in the
 * escalation ladder (Plan §2 step 4). Called only when the text signal
 * (hooks → accessibility/DOM pull) is still AMBIGUOUS.
 *
 * It screenshots ONLY the focused window that triggered the event (never the
 * full screen), discards the pixels in memory immediately after
 * classification, and returns a closed‑form verdict:
 *   { classification: "SAME_TASK" | "TASK_SWITCH_CONFIDENT" | "AMBIGUOUS",
 *     reason: string }
 *
 * The screenshot is sent to the dedicated vision sidecar (default :18766),
 * which runs llama-server with the MiniCPM‑V GGUF + mmproj and
 * `--reasoning off`. We ask for strict JSON only.
 */

const { desktopCapturer } = require("electron");
const http = require("http");
const { VisionSidecarLifecycle } = require("./attention-vision-lifecycle");

const VISION_TIMEOUT_MS = 60000; // cold-start + first inference can be slow

/**
 * Capture ONLY the focused window that triggered the event (never the full
 * screen) and return a base64 PNG, or null. The thumbnail is held in memory
 * and converted to a base64 string; it is never written to disk and is
 * discarded as soon as the caller's request resolves.
 *
 * @param {import("./hook-source-interface").NormalizedEvent} event
 * @returns {Promise<string|null>}
 */
async function captureTargetWindow(event) {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 1280, height: 720 },
    });
    let match = sources.find((s) => event.title && (s.name.includes(event.title) || event.title.includes(s.name)));
    if (!match && event.app) {
      match = sources.find((s) => s.name.toLowerCase().includes(event.app));
    }
    if (!match) return null; // no reliable window match — stay silent rather than screenshot a wrong window
    if (match && !match.thumbnail.isEmpty()) {
      return match.thumbnail.toPNG().toString("base64");
    }
    return null;
  } catch (err) {
    console.warn("[attention/vision] capture error:", err && err.message);
    return null;
  }
}

/**
 * Send the screenshot + narrow prompt to the vision sidecar and parse the
 * closed‑form verdict.
 *
 * @param {string} sidecarUrl
 * @param {string} screenshotB64
 * @param {string} taskHypothesis
 * @returns {Promise<{classification:string, reason:string}>}
 */
function analyzeWithVision(sidecarUrl, screenshotB64, taskHypothesis) {
  const prompt =
    "You are a strict focus classifier for a desktop productivity pet. " +
    "Given the screenshot of the user's CURRENT window and their stated task, " +
    'classify into exactly one of: "on_task" (window content matches the task), ' +
    '"distraction" (clearly unrelated leisure/social/media, not the task), ' +
    'or "unclear" (cannot tell from the image). ' +
    "Respond with ONLY a JSON object, no prose: " +
    '{"classification":"on_task|distraction|unclear","reason":"<10 words>"}. ' +
    "Stated task: " + (taskHypothesis || "unknown");

  const body = JSON.stringify({
    model: "minicpm-v",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/png;base64,${screenshotB64}` } },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 128,
  });

  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(`${sidecarUrl}/v1/chat/completions`); } catch (e) { return reject(e); }
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port) || 80,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
            const parsed = extractVerdict(text);
            if (parsed) return resolve(parsed);
            reject(new Error("no verdict in vision response"));
          } catch (e) {
            reject(new Error("invalid json from vision sidecar: " + e.message));
          }
        });
      }
    );
    req.setTimeout(VISION_TIMEOUT_MS, () => { req.destroy(); reject(new Error("vision sidecar timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function extractVerdict(text) {
  if (!text) return null;
  const m = text.match(/\{[^}]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    const c = (obj.classification || "").toLowerCase();
    if (c === "on_task") return { classification: "SAME_TASK", reason: obj.reason || "vision: on task" };
    if (c === "distraction") return { classification: "TASK_SWITCH_CONFIDENT", reason: obj.reason || "vision: distraction" };
    if (c === "unclear") return { classification: "AMBIGUOUS", reason: obj.reason || "vision: unclear" };
  } catch {}
  return null;
}

/**
 * Orchestrates capture + analysis. Returns null if capture fails or the
 * sidecar is unavailable, so the caller can gracefully stay silent.
 *
 * @param {import("./hook-source-interface").NormalizedEvent} event
 * @param {string} taskHypothesis
 * @param {string} sidecarUrl
 * @returns {Promise<{classification:string, reason:string}|null>}
 */
async function performVisionCheck(event, taskHypothesis, sidecarUrl = "http://127.0.0.1:18766") {
  const b64 = await captureTargetWindow(event);
  if (!b64) return null;
  try {
    return await analyzeWithVision(sidecarUrl, b64, taskHypothesis);
  } catch (err) {
    console.warn("[attention/vision] analyze error:", err && err.message);
    return null;
  }
}

/**
 * ── CONFIG SEAM ────────────────────────────────────────────────────────────
 * Where the MiniCPM‑V 4.6 GGUF assets plug in (Plan §2.1). Do NOT fetch these
 * here; they are provided at runtime by the user / on‑disk model download and
 * handed to the sidecar launcher. The default launch args are:
 *   --model  <modelPath>          (openbmb/MiniCPM-V-4.6-gguf, GGUF Q4_K_M)
 *   --mmproj <mmprojPath>         (F16 mmproj)
 *   --reasoning off               (passed EXPLICITLY, per §2.1)
 * The sidecar runs as a SECOND, independently‑lifecycled llama‑server
 * (default :18766), cold‑started on the first ambiguous event and idle‑
 * shutdown by VisionSidecarLifecycle.
 */

/**
 * Vision classifier that owns the cold‑start / idle‑shutdown lifecycle and
 * the focused‑window capture path. Wraps the pure VisionSidecarLifecycle
 * state machine (src/attention-vision-lifecycle.js) so the Electron side can
 * trigger a real llama‑server spawn without the state machine knowing about
 * electron or the network.
 */
class VisionClassifier {
  /**
   * @param {object} [options]
   * @param {string} [options.sidecarUrl] - vision sidecar base url (default :18766).
   * @param {boolean} [options.enabled] - master switch for this classifier.
   * @param {string} [options.modelPath] - GGUF Q4_K_M path (config seam, not fetched).
   * @param {string} [options.mmprojPath] - F16 mmproj path (config seam, not fetched).
   * @param {boolean} [options.reasoningOff] - force --reasoning off (default true).
   * @param {object} [options.lifecycle] - passed through to VisionSidecarLifecycle.
   */
  constructor(options = {}) {
    this.sidecarUrl = options.sidecarUrl || "http://127.0.0.1:18766";
    this.enabled = options.enabled !== false;
    this.lifecycle = new VisionSidecarLifecycle(options.lifecycle || {});

    // CONFIG SEAM (do not fetch): plugged in at runtime, never here.
    this.modelPath = options.modelPath || null;
    this.mmprojPath = options.mmprojPath || null;
    this.reasoningOff = options.reasoningOff !== false;

    this._idleWatcher = null;
  }

  isSidecarRunning() {
    return this.lifecycle.isRunning();
  }

  /**
   * Build the narrow, closed‑form classification prompt. The model must reply
   * with ONLY {classification, reason} — never an open description.
   *
   * @param {string} taskHypothesis
   * @returns {string}
   */
  _buildPrompt(taskHypothesis) {
    return (
      "You are a strict focus classifier for a desktop productivity pet. " +
      "Given the screenshot of the user's CURRENT window and their stated task, " +
      'classify into exactly one of: "on_task" (window content matches the task), ' +
      '"distraction" (clearly unrelated leisure/social/media, not the task), ' +
      'or "unclear" (cannot tell from the image). ' +
      "Respond with ONLY a JSON object, no prose: " +
      '{"classification":"on_task|distraction|unclear","reason":"<10 words>"}. ' +
      "Stated task: " + (taskHypothesis || "unknown")
    );
  }

  /**
   * Classify a genuinely‑ambiguous event via the vision sidecar.
   *
   * Flow:
   *   1. cold‑start the sidecar on the first call (VisionSidecarLifecycle)
   *   2. screenshot ONLY the focused window/region (never full screen) — done
   *      in memory via desktopCapturer; pixels are never written to disk and
   *      are discarded immediately after the request resolves
   *   3. send the narrow prompt + base64 PNG to the sidecar over http
   *   4. mark used so the idle timer resets
   *
   * Guards: returns null (safe no‑op) if disabled or if the sidecar could not
   * be cold‑started, so the caller can stay silent on failure.
   *
   * @param {import("./hook-source-interface").NormalizedEvent} event
   * @param {string} [taskHypothesis]
   * @returns {Promise<{classification:string, reason:string}|null>}
   */
  async classify(event, taskHypothesis = "") {
    if (!this.enabled) return null;

    // Cold start on first genuinely‑still‑ambiguous event.
    if (!this.lifecycle.isRunning()) {
      this.lifecycle.coldStart();
    }
    if (!this.lifecycle.isRunning()) {
      // Sidecar could not be (re)started — no‑op safely.
      return null;
    }
    this._ensureIdleWatcher();

    // Focused‑window capture only; processed entirely in memory, never to disk.
    const b64 = await captureTargetWindow(event);
    if (!b64) return null;

    try {
      const verdict = await analyzeWithVision(this.sidecarUrl, b64, taskHypothesis);
      this.lifecycle.markUsed();
      return verdict;
    } catch (err) {
      console.warn("[attention/vision] classify error:", err && err.message);
      return null;
    }
  }

  _ensureIdleWatcher() {
    if (this._idleWatcher) return;
    const tick = () => {
      if (this.lifecycle.shutdownAfterIdle()) {
        this._stopIdleWatcher();
      }
    };
    this._idleWatcher = setInterval(tick, 5000);
    if (this._idleWatcher && typeof this._idleWatcher.unref === "function") {
      this._idleWatcher.unref();
    }
  }

  _stopIdleWatcher() {
    if (this._idleWatcher) {
      clearInterval(this._idleWatcher);
      this._idleWatcher = null;
    }
  }

  /**
   * Force‑stop the sidecar and the idle watcher (e.g. on app quit).
   */
  dispose() {
    this._stopIdleWatcher();
    this.lifecycle.shutdownNow();
  }

  checkOrphans(pids, options) {
    return this.lifecycle.checkOrphans(pids, options);
  }
}

module.exports = {
  performVisionCheck,
  captureTargetWindow,
  analyzeWithVision,
  extractVerdict,
  VisionClassifier,
};
