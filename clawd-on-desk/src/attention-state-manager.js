"use strict";

/**
 * @file attention-state-manager.js
 *
 * Core of the Attention Companion. Subscribes to the AttentionEventBus,
 * calls the MiniCPM5-1B sidecar for text-only classification, and escalates
 * to the vision tool only on AMBIGUOUS events.
 *
 * Classification states:
 *   SAME_TASK               — update timestamp, log silently
 *   TASK_SWITCH_CONFIDENT   — clear switch; ask user to confirm new hypothesis
 *   AMBIGUOUS               — escalate to vision tool (if available)
 *
 * Task hypothesis initialization strategy (per user decision):
 *   1. Collect first INIT_SAMPLE_SIZE focus events silently
 *   2. Ask MiniCPM to infer the task from those events
 *   3. If inference is low-confidence ("unclear"), ask the user directly
 *
 * Rate limit: minimum 500ms between LLM calls. Events arriving faster are
 * queued but only the *latest* is kept (no backlog buildup).
 */

const http = require("http");
const { EventEmitter } = require("events");
const { buildAttentionPolicy, createDwellFilter, createCluster } = require("./attention-policy");
const { BrowserScan } = require("./attention-browser-scan");

const INIT_SAMPLE_SIZE = 5;
const CALL_RATE_LIMIT_MS = 500;
const SIDECAR_TIMEOUT_MS = 8000;

const VALID_STATES = new Set(["SAME_TASK", "TASK_SWITCH_CONFIDENT", "AMBIGUOUS"]);

/**
 * Build the classification prompt for MiniCPM5-1B.
 *
 * @param {string|null} taskHypothesis
 * @param {import("./hook-source-interface").NormalizedEvent} event
 * @param {import("./hook-source-interface").NormalizedEvent[]} history
 * @returns {Array<{role:string, content:string}>}
 */
function buildClassificationMessages(taskHypothesis, event, history) {
  const historyText = history.slice(-5).map(e =>
    `  - app=${e.app} title="${e.title}"${e.url ? ` url=${e.url}` : ""}`
  ).join("\n") || "  (none yet)";

  const system = [
    "You are a focus classifier for a desktop attention companion.",
    "Given a task hypothesis and a new window/tab focus event, return ONLY valid JSON.",
    'Format: {"state":"SAME_TASK"|"TASK_SWITCH_CONFIDENT"|"AMBIGUOUS","reason":"<10 words max"}',
    "",
    "Rules:",
    "- SAME_TASK: new focus is clearly related to current task (same project, docs for it, terminal, editor, localhost dev server)",
    "- TASK_SWITCH_CONFIDENT: title/url alone makes it unambiguously unrelated (social media, games, YouTube during coding, news)",
    "- AMBIGUOUS: generic title (New Tab, localhost:3000, untitled), or plausibly related but unclear (Stack Overflow, Wikipedia)",
    "",
    "IMPORTANT: Respond with ONLY the JSON object. No markdown, no explanation.",
  ].join("\n");

  const userContent = [
    `Current task hypothesis: ${taskHypothesis || "(unknown — still initializing)"}`,
    `Recent focus history (last 5 events):`,
    historyText,
    ``,
    `New focus event:`,
    `  app=${event.app}`,
    `  title="${event.title}"`,
    event.url ? `  url=${event.url}` : null,
    event.project ? `  project=${event.project}` : null,
  ].filter(Boolean).join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];
}

/**
 * Build the classification prompt but enriched with the text-only DOM /
 * accessibility signals gathered before vision (Plan §2 step 3). Used when
 * the first pass came back AMBIGUOUS and the browser bridge supplied a
 * domHint / domSnippet / mediaSession — re-evaluating with that extra text
 * usually resolves the ambiguity without a screenshot.
 *
 * @param {string|null} taskHypothesis
 * @param {import("./hook-source-interface").NormalizedEvent} event
 * @param {import("./hook-source-interface").NormalizedEvent[]} history
 * @returns {Array<{role:string, content:string}>}
 */
function buildEnrichedClassificationMessages(taskHypothesis, event, history) {
  const base = buildClassificationMessages(taskHypothesis, event, history);
  const signalBits = [];
  if (event.domHint) {
    try {
      const h = JSON.parse(event.domHint);
      if (h.h1) signalBits.push(`page heading: "${h.h1}"`);
      if (h.media) signalBits.push(`media session: "${h.media}"`);
    } catch {}
  }
  if (event.mediaSession) {
    const ms = [];
    if (event.mediaSession.title) ms.push(`title=${event.mediaSession.title}`);
    if (event.mediaSession.artist) ms.push(`artist=${event.mediaSession.artist}`);
    if (event.mediaSession.playbackState) ms.push(`playbackState=${event.mediaSession.playbackState}`);
    if (ms.length) signalBits.push(`media session metadata: ${ms.join(", ")}`);
  }
  if (typeof event.videoPlaying === "boolean") {
    signalBits.push(`video actually playing: ${event.videoPlaying}`);
  }
  if (event.domSnippet) signalBits.push(`page text sample: "${event.domSnippet}"`);
  if (!signalBits.length) return base;

  const user = base.find((m) => m.role === "user");
  if (user) {
    user.content += "\n\nAdditional text-only signals from the page (no screenshot):\n" +
      signalBits.map((b) => `  - ${b}`).join("\n");
  }
  return base;
}

/**
 * Build the task-inference prompt used during initialization.
 *
 * @param {import("./hook-source-interface").NormalizedEvent[]} events
 * @returns {Array<{role:string, content:string}>}
 */
function buildInferenceMessages(events) {
  const eventsText = events.map(e =>
    `  - app=${e.app} title="${e.title}"${e.url ? ` url=${e.url}` : ""}${e.project ? ` project=${e.project}` : ""}`
  ).join("\n");

  const system = [
    "You are a task inference assistant.",
    "Given a list of recently active windows/tabs, infer what task the user is currently working on.",
    'Return ONLY valid JSON: {"task":"<brief description, 5 words max>","confidence":"high"|"medium"|"low"}',
    "If you cannot determine the task, set confidence to low and task to unknown.",
    "IMPORTANT: Respond with ONLY the JSON object.",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: `Recent focus events:\n${eventsText}` },
  ];
}

/**
 * Extract JSON from an LLM response that may contain surrounding text.
 *
 * @param {string} text
 * @returns {object|null}
 */
function extractJson(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * Post a chat request to the MiniCPM5-1B sidecar (non-streaming).
 *
 * @param {string} sidecarUrl
 * @param {Array<{role:string, content:string}>} messages
 * @param {number} maxTokens
 * @returns {Promise<string>} - response content text
 */
function callSidecar(sidecarUrl, messages, maxTokens = 64) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      messages,
      max_new_tokens: maxTokens,
      temperature: 0.1,
      stream: false,
      thinking: false,
      disable_adapter: true,
      silent: true,
    });

    const url = new URL(`${sidecarUrl}/api/chat`);
    const req = http.request({
      hostname: url.hostname,
      port: Number(url.port) || 80,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json.content || "");
        } catch {
          resolve(data);
        }
      });
    });

    req.setTimeout(SIDECAR_TIMEOUT_MS, () => { req.destroy(); reject(new Error("sidecar timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── AttentionStateManager class ──────────────────────────────────────────────

class AttentionStateManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {import("./attention-event-bus").AttentionEventBus} options.bus
   * @param {string} options.sidecarUrl - e.g. "http://127.0.0.1:18765"
   * @param {Function} [options.onClassification] - callback(classification, event, reason)
   * @param {Function} [options.onTaskInferred] - callback(taskHypothesis)
   * @param {Function} [options.onAmbiguous] - callback(event, taskHypothesis)
   * @param {Function} [options.onTaskSwitchConfident] - callback(event, inferredNewTask)
   * @param {Function} [options.askUserForTask] - callback() -> Promise<string|null>
   * @param {object}   [options.policy] - built via buildAttentionPolicy()
   * @param {Function} [options.accessibilityPull] - (event) -> Promise<state|null>
   *        Last-resort text-only enrichment (OS a11y tree / DOM signals) before
   *        the vision tool. Optional; when omitted AMBIGUOUS stays silent.
   * @param {Function} [options.visionClassify] - (event) -> Promise<state|null>
   *        MiniCPM-V 4.6 on-demand classification. Optional.
   * @param {Function} [options.log] - logging function
   */
  constructor(options = {}) {
    super();
    this.bus = options.bus;
    this.sidecarUrl = options.sidecarUrl || "http://127.0.0.1:18765";
    this.onClassification = options.onClassification || (() => {});
    this.onTaskInferred = (task) => {
      this.emit("task-inferred", task);
      if (options.onTaskInferred) options.onTaskInferred(task);
    };
    this.onAmbiguous = options.onAmbiguous || (() => {});
    this.onTaskSwitchConfident = options.onTaskSwitchConfident || (() => {});
    this.askUserForTask = options.askUserForTask || (() => Promise.resolve(null));
    this.policy = options.policy || buildAttentionPolicy();
    this._accessibilityPull = options.accessibilityPull || null;
    this.visionClassify = options.visionClassify || null;
    this.log = options.log || console.log;

    /** @type {string|null} */
    this.taskHypothesis = null;
    this._initSamples = [];
    this._initialized = false;
    this._initInFlight = false;

    this._lastCallAt = 0;
    this._pendingEvent = null;
    this._pendingTimer = null;
    this._callInFlight = false;

    // v2 policy state
    this._dwell = createDwellFilter(this.policy.dwellMs);
    this._cluster = createCluster();
    this._meetingActive = false;
    this._browserScan = new BrowserScan();
    this._lastFocusEvent = null;

    this._boundOnFocus = this._onFocus.bind(this);
    this._started = false;
    this._lastVideoAskedTitle = null;
  }

  _getIdleSeconds() {
    try {
      const { powerMonitor } = require("electron");
      if (powerMonitor && typeof powerMonitor.getSystemIdleTime === "function") {
        return powerMonitor.getSystemIdleTime();
      }
    } catch {}
    return -1;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this.bus.on("focus", this._boundOnFocus);
    this.log("[attention/state-manager] started");
  }

  stop() {
    this._started = false;
    this.bus.off("focus", this._boundOnFocus);
    if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }
    this.log("[attention/state-manager] stopped");
  }

  /**
   * Manually update the task hypothesis (called when user confirms a new task).
   *
   * @param {string} task
   */
  setTaskHypothesis(task) {
    this.taskHypothesis = task;
    this._initialized = true;
    this.log(`[attention/state-manager] task hypothesis set: "${task}"`);
  }

  /**
   * Forget the current task hypothesis and re-enter initialization so the
   * next focus samples trigger a fresh inference. Also clears the per-video
   * dedup so a previously-seen video can re-trigger the focus prompt.
   */
  clearTask() {
    this.taskHypothesis = null;
    this._initialized = false;
    this._initSamples = [];
    this._lastVideoAskedTitle = null;
    this.log("[attention/state-manager] task hypothesis cleared");
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _getBaseTitle(title) {
    if (!title) return "";
    // Remove the "[Playback: X:XX / Y:YY]" suffix added by the Chrome extension
    return title.replace(/\s*\[Playback:.*?\]\s*$/, "");
  }

  _onFocus(event) {
    // ── v2 gates (cheap, deterministic, before any model call) ──

    // 1. Master switch
    if (!this.policy.enabled) return;

    // Track the previous focus event (for the same-task-across-windows rule).
    const prevFocus = this._lastFocusEvent;
    this._lastFocusEvent = event;

    // 2. Idle / AFK gate — pause the entire pipeline while away.
    if (this.policy.idleEnabled && this.policy.isIdle(this._getIdleSeconds())) {
      this._dwell.cancel();
      this.log("[attention/state-manager] idle — skipping evaluation");
      return;
    }

    // 3. Privacy exclude-list — never evaluate or capture sensitive windows.
    if (this.policy.matchesPrivacy(event)) {
      this._dwell.cancel();
      this.log(`[attention/state-manager] privacy-suppressed (app=${event.app} title="${event.title}")`);
      return;
    }

    // 4. Meeting / call category — a valid task state, not a distraction.
    if (this.policy.isMeeting(event.app, event.title)) {
      this._dwell.cancel();
      if (!this._meetingActive) {
        this._meetingActive = true;
        this._cluster.reset();
        this.taskHypothesis = "In a meeting or call";
        this._initialized = true;
        this.log('[attention/state-manager] meeting detected — treated as a valid task, not distraction');
        this.onTaskInferred(this.taskHypothesis);
      }
      return;
    }
    // Any non-meeting event ends the meeting state and proceeds normally.
    if (this._meetingActive) this._meetingActive = false;

    // 5. Eager Video Focus bypass: skip the 5-event wait if we detect a video.
    //    Only prompt once per unique video title so we don't nag on tab switches.
    const baseTitle = this._getBaseTitle(event.title);
    if (event.app === "video-streaming" && this._lastVideoAskedTitle !== baseTitle) {
      this._lastVideoAskedTitle = baseTitle;
      this._dwell.cancel();
      this._cluster.reset();
      // Delay by 3 seconds to ensure the Electron renderer has finished loading its HTML on boot
      setTimeout(() => {
        this.taskHypothesis = "Watching a video";
        this._initialized = true;
        this.onTaskInferred(this.taskHypothesis);
      }, 3000);
      return;
    }

    // 6. Same-video re-fire guard: a playing video that's already our task
    //    hypothesis shouldn't re-classify itself every playback tick.
    if (event.app === "video-streaming" && this.taskHypothesis &&
        this.taskHypothesis.toLowerCase().includes("video")) {
      return;
    }

    // 7. App clustering: moving back to an app already seen this task is
    //    SAME_TASK without a model call (editor ↔ terminal ↔ docs).
    if (this._initialized && this._cluster.contains(event.app)) {
      this._dwell.cancel();
      this.log(`[attention/state-manager] SAME_TASK (cluster) — ${event.app}`);
      this.onClassification("SAME_TASK", event, "focus returned to a cluster app");
      this.emit("state-change", { classification: "SAME_TASK", reason: "focus returned to a cluster app", event });
      return;
    }

    // 7b. Same-task-across-windows heuristic (§3.1): a video in one browser and
    //     notes in another plausibly belong to the SAME task, so the first
    //     focus move between them must not read as "switched away". This is a
    //     task-state-manager rule, not a hook rule.
    if (prevFocus && this._browserScan.areSameTaskWindows(prevFocus, event)) {
      this._dwell.cancel();
      this.log(`[attention/state-manager] SAME_TASK (same-task-windows) — ${event.app}`);
      this.onClassification("SAME_TASK", event, "video + notes windows plausibly same task");
      this.emit("state-change", { classification: "SAME_TASK", reason: "video + notes windows plausibly same task", event });
      return;
    }

    // 8. Focus-dwell debounce: only evaluate once focus has held for dwellMs,
    //    dropping transient flicker (notification popups, fast alt-tab).
    this._dwell.arm(event, (settledEvent) => this._processEvent(settledEvent));
  }

  /**
   * Evaluate a *settled* focus event (passed the dwell gate). Routes to the
   * init sampler or the live classifier, and records the app in the cluster.
   *
   * @param {import("./hook-source-interface").NormalizedEvent} event
   */
  _processEvent(event) {
    this._cluster.record(event.app);
    if (!this._initialized) {
      this._collectInitSample(event);
      return;
    }
    this._scheduleClassification(event);
  }

  _collectInitSample(event) {
    this._initSamples.push(event);
    if (this._initSamples.length >= INIT_SAMPLE_SIZE && !this._initInFlight) {
      this._initInFlight = true;
      this._inferTaskFromSamples(this._initSamples).catch(err => {
        this.log("[attention/state-manager] init inference error:", err && err.message);
        this._initialized = true; // proceed with unknown hypothesis
      });
    }
  }

  async _inferTaskFromSamples(samples) {
    try {
      const messages = buildInferenceMessages(samples);
      const response = await callSidecar(this.sidecarUrl, messages, 48);
      const json = extractJson(response);
      if (json && json.task && json.task !== "unknown" && json.confidence !== "low") {
        this.taskHypothesis = json.task;
        this._initialized = true;
        this.log(`[attention/state-manager] task inferred: "${json.task}" (${json.confidence})`);
        this.onTaskInferred(json.task);
      } else {
        // Inference inconclusive — ask the user
        this.log("[attention/state-manager] task inference inconclusive, asking user");
        this._initialized = true; // allow classification to proceed while we wait
        const userInput = await this.askUserForTask();
        if (userInput && userInput.trim()) {
          this.taskHypothesis = userInput.trim();
          this.onTaskInferred(this.taskHypothesis);
          this.log(`[attention/state-manager] task from user: "${this.taskHypothesis}"`);
        }
      }
    } catch (err) {
      this.log("[attention/state-manager] task inference failed:", err && err.message);
      this._initialized = true;
    }
  }

  _scheduleClassification(event) {
    // Always keep the latest event as pending
    this._pendingEvent = event;

    const now = Date.now();
    const elapsed = now - this._lastCallAt;

    if (this._callInFlight) return; // will pick up pending after call returns
    if (elapsed >= CALL_RATE_LIMIT_MS) {
      this._runClassification();
    } else {
      if (this._pendingTimer) return; // already scheduled
      this._pendingTimer = setTimeout(() => {
        this._pendingTimer = null;
        this._runClassification();
      }, CALL_RATE_LIMIT_MS - elapsed);
    }
  }

  _runClassification() {
    const event = this._pendingEvent;
    this._pendingEvent = null;
    if (!event) return;

    this._callInFlight = true;
    this._lastCallAt = Date.now();

    const history = this.bus.getHistory();
    const messages = buildClassificationMessages(this.taskHypothesis, event, history);

    callSidecar(this.sidecarUrl, messages, 64)
      .then(response => this._handleClassificationResponse(response, event))
      .catch(err => {
        this.log("[attention/state-manager] classification error:", err && err.message);
      })
      .finally(() => {
        this._callInFlight = false;
        // If a new event arrived while we were calling, process it now
        if (this._pendingEvent) this._scheduleClassification(this._pendingEvent);
      });
  }

  _handleClassificationResponse(response, event) {
    const json = extractJson(response);
    if (!json || !VALID_STATES.has(json.state)) {
      // Treat bad response as AMBIGUOUS
      this.log(`[attention/state-manager] bad classification response, treating as AMBIGUOUS: ${response}`);
      this._escalate(event, "bad-response");
      return;
    }

    const { state, reason } = json;
    const urlLog = event.url ? ` url=${event.url}` : "";
    this.log(`[attention/state-manager] ${state} — ${reason} (app=${event.app} title="${event.title}"${urlLog})`);
    this.onClassification(state, event, reason);
    this.emit("state-change", { classification: state, reason, event });

    if (state === "SAME_TASK") {
      // Silent — no action
    } else if (state === "TASK_SWITCH_CONFIDENT") {
      // A genuine switch starts a fresh cluster; forget the old one.
      this._cluster.reset();
      this._meetingActive = false;
      this.onTaskSwitchConfident(event, reason);
    } else if (state === "AMBIGUOUS") {
      this._escalate(event, "text-ambiguous");
    }
  }

  /**
   * v2 escalation ladder (steps 2→4 in the plan): text-only signal is exhausted,
   * so try the accessibility/DOM pull, then the on-demand vision tool, before
   * giving up. Each step is optional; with no backends wired, AMBIGUOUS stays
   * silent (no action), exactly as before.
   *
   * @param {import("./hook-source-interface").NormalizedEvent} event
   * @param {string} source
   */
  async _escalate(event, source) {
    const hyp = this.taskHypothesis;

    // Step 3a (plan §2): accessibility/DOM pull — a cheap, fact-based quick
    // decision from the OS a11y tree + browser DOM hints. Returns a verdict
    // state when the facts are unambiguous, or null otherwise.
    if (this._accessibilityPull) {
      const enriched = await this._safeEscalate(this._accessibilityPull, event, hyp, "accessibility");
      if (enriched && VALID_STATES.has(enriched)) {
        this.log(`[attention/state-manager] resolved via accessibility pull (${source}): ${enriched}`);
        // A genuine switch starts a fresh cluster; clear the prior escalation
        // cluster so the next event doesn't bleed the old apps into it.
        if (enriched === "TASK_SWITCH_CONFIDENT") {
          this._cluster.reset();
          this._meetingActive = false;
          this.onTaskSwitchConfident(event, "resolved by accessibility/DOM signal");
        }
        this._routeVerdict(enriched, "resolved by accessibility/DOM signal", event);
        return;
      }
    }

    // Step 3b (plan §2): re-evaluate with the enriched text signal. The
    // browser bridge supplied a domHint/domSnippet/mediaSession; fold those
    // into the classifier prompt and ask MiniCPM5-1B again. Most ambiguity
    // (generic titles, fullscreen video, docs tabs) resolves here without a
    // screenshot. Only falls through to vision if still AMBIGUOUS.
    if (this._hasEnrichment(event)) {
      const reState = await this._reclassifyWithEnriched(event, hyp);
      if (reState && reState !== "AMBIGUOUS") {
        this.log(`[attention/state-manager] resolved via enriched re-evaluation (${source}): ${reState}`);
        // Same as the accessibility pull: a genuine switch must reset the
        // cluster and clear any prior escalation state so the next event starts
        // clean (the classification result itself is preserved).
        if (reState === "TASK_SWITCH_CONFIDENT") {
          this._cluster.reset();
          this._meetingActive = false;
          this.onTaskSwitchConfident(event, "re-evaluated with accessibility/DOM signal");
        }
        this._routeVerdict(reState, "re-evaluated with accessibility/DOM signal", event);
        return;
      }
    }

    // Step 4 (plan §2.1): MiniCPM-V vision sidecar — true last resort.
    if (this.policy.visionEnabled && this.visionClassify) {
      const vision = await this._safeEscalate(this.visionClassify, event, hyp, "vision");
      if (vision && VALID_STATES.has(vision)) {
        this.log(`[attention/state-manager] resolved via vision tool (${source}): ${vision}`);
        this._routeVerdict(vision, "resolved by MiniCPM-V", event);
        if (vision === "TASK_SWITCH_CONFIDENT") {
          this._cluster.reset();
          this._meetingActive = false;
          this.onTaskSwitchConfident(event, "resolved by MiniCPM-V");
        }
        return;
      }
    }

    // No backend resolved it — stay silent (no false distraction).
    this.log(`[attention/state-manager] AMBIGUOUS (${source}) — no escalation backend resolved it`);
    this.onAmbiguous(event, hyp);
  }

  /** True when the event carries any text-only enrichment worth re-evaluating with. */
  _hasEnrichment(event) {
    if (!event) return false;
    return !!(event.domHint || event.domSnippet || event.mediaSession || typeof event.videoPlaying === "boolean");
  }

  /**
   * Re-run the text classifier with the enriched DOM/accessibility signal
   * folded into the prompt. Returns a state, or null on failure / no signal.
   *
   * @param {import("./hook-source-interface").NormalizedEvent} event
   * @param {string|null} hyp
   * @returns {Promise<string|null>}
   */
  async _reclassifyWithEnriched(event, hyp) {
    const history = this.bus.getHistory ? this.bus.getHistory() : [];
    const messages = buildEnrichedClassificationMessages(hyp, event, history);
    try {
      const response = await callSidecar(this.sidecarUrl, messages, 64);
      const json = extractJson(response);
      if (json && VALID_STATES.has(json.state)) return json.state;
    } catch (err) {
      this.log("[attention/state-manager] enriched re-classification error:", err && err.message);
    }
    return null;
  }

  _routeVerdict(state, reason, event) {
    this.onClassification(state, event, reason);
    this.emit("state-change", { classification: state, reason, event });
  }

  async _safeEscalate(fn, event, hyp, label) {
    try {
      const r = await fn(event, hyp);
      return typeof r === "string" ? r : (r && r.classification) || null;
    } catch (err) {
      this.log(`[attention/state-manager] ${label} escalation failed: ${err && err.message}`);
      return null;
    }
  }
}

let _globalInstance = null;

function getAttentionStateManager() {
  return _globalInstance;
}

function startAttentionTracking(sidecarUrl, options = {}) {
  if (_globalInstance) return _globalInstance;
  const { bus } = require("./attention-event-bus");
  const policy = options.policy || buildAttentionPolicy(options.policyConfig || {});
  _globalInstance = new AttentionStateManager({
    bus,
    sidecarUrl,
    policy,
    accessibilityPull: options.accessibilityPull || null,
    visionClassify: options.visionClassify || null,
  });
  _globalInstance.start();

  // Also start the decision layer (confirm/message handlers, threshold, etc.)
  const { getAttentionDecision } = require("./attention-decision");
  getAttentionDecision().start(options);

  return _globalInstance;
}

function stopAttentionTracking() {
  if (_globalInstance) {
    _globalInstance.stop();
    _globalInstance = null;
  }
  const { getAttentionDecision } = require("./attention-decision");
  try {
    getAttentionDecision().stop();
  } catch (e) {}
}

module.exports = {
  AttentionStateManager,
  buildClassificationMessages,
  buildEnrichedClassificationMessages,
  buildInferenceMessages,
  extractJson,
  getAttentionStateManager,
  startAttentionTracking,
  stopAttentionTracking,
};
