"use strict";

/**
 * @file attention-decision.js
 *
 * Takes the raw classifications from attention-state-manager and
 * applies smoothing (rolling window) and decision thresholds (e.g. 5 minutes distracted).
 */

const { EventEmitter } = require("events");
const { getAttentionStateManager } = require("./attention-state-manager");
const petInteractionIpc = require("./pet-interaction-ipc");
const { AttentionFeatures } = require("./attention-features");
const { AttentionTaskLifecycle } = require("./attention-task-lifecycle");
const { AttentionNudgeBudget } = require("./attention-nudge-budget");
const { AttentionRecap } = require("./attention-recap");
const { AttentionInsights } = require("./attention-insights");
const { shell } = require("electron");

// Minimum quiet period between distraction ("Focus Check") prompts, even when
// the distraction threshold is shorter. Prevents the prompt from looping when
// the user is repeatedly classified as switched-away (e.g. strict video mode).
const DISTRACTION_REPROMPT_COOLDOWN_MS = 5 * 60 * 1000;

// How long a previously-answered video-focus decision stays "sticky" for the
// same video context (same page/title), so we don't re-prompt when a new video
// on the same page/title starts after the previous one ended.
const VIDEO_DECISION_TTL_MS = 30 * 60 * 1000;

// Parse a deadline out of a free-text nudge contract ("finish report by 5pm").
// Returns a timestamp; falls back to end-of-today, then +4h if parsing fails.
function parseGoalDeadline(text, now) {
  const t = String(text || "").toLowerCase();
  const endOfToday = (() => {
    const d = new Date(now);
    d.setHours(23, 59, 0, 0);
    return d.getTime();
  })();
  // "by 5pm" / "at 17:00" / "5:30 pm"
  let m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const mer = m[3];
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1); // tomorrow if already passed
    return d.getTime();
  }
  // "17:00"
  m = t.match(/(\d{1,2}):(\d{2})/);
  if (m) {
    const d = new Date(now);
    d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // "in 2 hours" / "in 90 minutes"
  m = t.match(/in\s+(\d+)\s*(hour|hr|h|minute|min|m)/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2][0];
    const ms = unit === "h" ? n * 3600000 : n * 60000;
    return now + ms;
  }
  if (/tomorrow/.test(t)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(17, 0, 0, 0);
    return d.getTime();
  }
  return endOfToday;
}

class AttentionDecision extends EventEmitter {
  constructor(options = {}) {
    super();
    this.stateManager = getAttentionStateManager();
    this.defaultDistractionMs = 5 * 60 * 1000;
    this.distractionThresholdMs = this.defaultDistractionMs; // 5 minutes hardcoded default
    this.distractedStartTime = null;
    this.isDistracted = false;
    this.isAsking = false;
    this.strictVideoMode = false;

    // §3.8 / §4 observer features
    this.features = new AttentionFeatures();
    this.refocusHandler = options.refocusHandler || null;
    this._checkInEnabled = true;
    this._stuckEnabled = false;
    this._recapEnabled = true;
    this._patternsEnabled = false;
    this._stuckSurfaced = false;
    this._lastDocH1 = null;

    // Prompt de-duplication state (fixes repeated video / distraction prompts).
    this._lastVideoDecisionCtx = ""; // normalized title/url of the last video we asked about
    this._lastVideoDecisionAt = 0; // when we last asked (for the TTL window above)
    this._distractionCooldownUntil = 0; // suppress Focus Check re-prompt within cooldown

    // v2 feature modules (pure logic, unit-tested)
    this.taskLifecycle = new AttentionTaskLifecycle();
    this.nudgeBudget = new AttentionNudgeBudget();
    this.recap = new AttentionRecap();
    this.insights = new AttentionInsights();

    // confirmHandler(payload) -> Promise<number|null>
    // Shows a confirmation prompt and resolves with the chosen button index
    // (or null on timeout/dismiss). When provided, both the video-focus and
    // distraction prompts are routed through it (e.g. the always-on-top pet
    // bubble) instead of a native dialog that can hide behind other windows.
    this.confirmHandler = options.confirmHandler || null;
    // messageHandler(text) -> Promise — shows a non-interactive pet speech
    // bubble (used to acknowledge the user's choice after a prompt).
    this.messageHandler = options.messageHandler || null;

    this._onStateChange = this._onStateChange.bind(this);
    this._onTaskInferred = this._onTaskInferred.bind(this);
    this._memory = options.memoryService || null;
    this._getPrefs = typeof options.getPrefs === "function" ? options.getPrefs : () => ({});
    this._proactiveCooldownUntil = 0;
  }

  start(options = {}) {
    if (options && options.confirmHandler) this.confirmHandler = options.confirmHandler;
    if (options && options.messageHandler) this.messageHandler = options.messageHandler;
    if (options && Number.isFinite(options.distractionThresholdMs) && options.distractionThresholdMs >= 0) {
      this.distractionThresholdMs = options.distractionThresholdMs;
    }

    // §3.8 / §4 hydration from prefs (passed by main.js)
    if (typeof options.checkInEnabled === "boolean") this._checkInEnabled = options.checkInEnabled;
    if (typeof options.stuckEnabled === "boolean") this._stuckEnabled = options.stuckEnabled;
    if (typeof options.recapEnabled === "boolean") this._recapEnabled = options.recapEnabled;
    if (typeof options.patternsEnabled === "boolean") this._patternsEnabled = options.patternsEnabled;
    if (options.contract) this.nudgeBudget.setContract(options.contract);
    if (Number.isFinite(options.wanderBudgetMin)) this.nudgeBudget.setBudget(options.wanderBudgetMin);

    // The task-lifecycle uses the same confirm/message handlers (pet bubble).
    this.taskLifecycle.confirmHandler = (p) => this._ask(p);
    this.taskLifecycle.messageHandler = (t) => this._say(t);
    if (options.taskLifecycle) this.taskLifecycle = options.taskLifecycle;

    // v3 memory: feed the unified memory store (plan §1.4, §4, §5). All calls
    // are fire-and-forget and no-op when the service is disabled / not ready.
    if (options.memoryService) this._memory = options.memoryService;
    if (typeof options.getPrefs === "function") this._getPrefs = options.getPrefs;
    if (this.taskLifecycle) {
      const self = this;
      this.taskLifecycle.onTaskCleared = (info) => self._memoryTaskCleared(info);
    }
    if (options.contract) this._mirrorGoal(options.contract);

    this.stateManager.on("state-change", this._onStateChange);
    this.stateManager.on("task-inferred", this._onTaskInferred);
  }

  /**
   * Show a short pet speech bubble (no buttons) to acknowledge something.
   * No-op if no messageHandler is wired.
   *
   * @param {string} text
   */
  async _say(text) {
    if (!text) return;
    if (typeof this.messageHandler === "function") {
      try { await this.messageHandler(text); } catch (err) {
        console.warn("[attention-decision] messageHandler failed:", err);
      }
    }
  }

  stop() {
    this.stateManager.off("state-change", this._onStateChange);
    this.stateManager.off("task-inferred", this._onTaskInferred);
  }

  async _onTaskInferred(task) {
    if (this.isAsking) return;

    // §4 restorative re-entry: remember the confirmed task fact.
    if (this._recapEnabled && task) this.recap.confirmTask(task);

    // Strict Video Focus Mode
    if (task && task.toLowerCase().includes("video")) {
      // Don't re-prompt for the same video context: when a video ends, focus is
      // lost, and a *new* video on the same page/title starts, only ask once per
      // context (within a reasonable window). Genuinely new videos still ask.
      const ev = this.stateManager && this.stateManager._lastFocusEvent;
      const ctxKey = ((ev && (ev.url || ev.title)) || "").toLowerCase().trim();
      const decidedRecently =
        ctxKey && ctxKey === this._lastVideoDecisionCtx &&
        Date.now() - this._lastVideoDecisionAt < VIDEO_DECISION_TTL_MS;
      if (decidedRecently) return;
      this._lastVideoDecisionCtx = ctxKey;
      this._lastVideoDecisionAt = Date.now();
      this.isAsking = true;
      try {
        const responseIndex = await this._ask({
          id: Date.now().toString(),
          prelude: "You started watching a video — want me to help you stay on track?",
          title: "Video Focus Mode",
          message: "Should I keep you focused while you watch, and check in if you drift off?",
          buttons: ["Yes, keep me focused", "No, I'm just browsing"],
        });

        if (responseIndex === 0) {
          this.strictVideoMode = true;
          this.distractionThresholdMs = 0; // Instant scold
          console.log("[attention-decision] Strict video mode ENABLED.");
          this._say("On it! I'll nudge you if you start to drift. 💪");
        } else {
          this.strictVideoMode = false;
          this.distractionThresholdMs = this.defaultDistractionMs;
          this._say("No worries — enjoy your video! 🍿");
        }
      } catch (err) {
        console.warn("[attention-decision] Video focus ask failed:", err);
      } finally {
        this.isAsking = false;
      }
    } else {
      this.strictVideoMode = false;
      this.distractionThresholdMs = this.defaultDistractionMs;
      // §3.8 task check-in — fires once per new (non-video) task cluster.
      if (this._checkInEnabled && task && !this.isAsking) {
        this._memoryTaskStart(task);
        this.isAsking = true;
        this.taskLifecycle.startTask(task)
          .catch((err) => console.warn("[attention-decision] check-in failed:", err))
          .finally(() => { this.isAsking = false; });
        this._maybeProactiveCheckIn(task);
      }
    }
  }

  /**
   * Show a confirmation prompt and resolve with the chosen button index
   * (or null on timeout/dismiss). Prefers the injected `confirmHandler`
   * (the always-on-top pet bubble); falls back to broadcasting the IPC to
   * every renderer as a last resort.
   *
   * @param {{id:string, title:string, message:string, buttons:string[]}} payload
   * @returns {Promise<number|null>}
   */
  async _ask(payload) {
    if (typeof this.confirmHandler === "function") {
      try {
        return await this.confirmHandler(payload);
      } catch (err) {
        console.warn("[attention-decision] confirmHandler failed:", err);
      }
    }
    // Fallback: broadcast to all renderers (legacy behavior).
    const { webContents, ipcMain } = require("electron");
    const wcs = webContents.getAllWebContents();
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; resolve(null); }
      }, 30000);
      ipcMain.once("minicpm:reply-confirmation", (event, id, responseIndex) => {
        if (id === payload.id && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(responseIndex);
        }
      });
      for (const wc of wcs) {
        try { wc.send("minicpm:ask-confirmation", payload); } catch {}
      }
    });
  }

  _onStateChange({ classification, reason, event }) {
    if (this.isAsking) return; // ignore updates while waiting for user

    if (classification === "TASK_SWITCH_CONFIDENT") {
      const ev = event || {};

      // §4 stuck-detection / pattern aggregation signal source.
      if (this._stuckEnabled) this.insights.recordDistraction(new Date().getHours());

      // §4 nudge contract + wander budget: resolve ambiguity at the source.
      if (this._nudgeActive()) {
        this.nudgeBudget.recordWander(this._wanderMinutes());
        const verdict = this.nudgeBudget.resolveAmbiguity(ev, {
          withinContract: this._contractWithin(ev),
        });
        if (verdict === "within-contract") {
          this.distractedStartTime = null;
          return; // explicitly held to the contract — not a distraction
        }
        if (verdict === "ambiguous") {
          return; // budget not yet spent — stay silent, keep the timer running
        }
      }

      if (!this.distractedStartTime) {
        this.distractedStartTime = Date.now();
      }

      // We check >= threshold. If threshold is 0, this triggers instantly.
      if (Date.now() - this.distractedStartTime >= this.distractionThresholdMs) {
        if (!this.isDistracted) {
          this.isDistracted = true;
          this.emit("distracted");
          // Don't re-prompt if we already asked recently (prevents looping
          // when the user keeps being classified as switched-away).
          if (Date.now() >= this._distractionCooldownUntil) {
            this._distractionCooldownUntil =
              Date.now() + Math.max(this.distractionThresholdMs, DISTRACTION_REPROMPT_COOLDOWN_MS);
            this._promptUserDistraction(this._memoryGoalOnDistraction());
            if (this._patternsEnabled) {
              const drift = this.insights.driftSummary();
              if (drift && drift.count >= 3) this._say(drift.message);
            }
          }
        }
      }
    } else if (classification === "SAME_TASK") {
      if (this._recapEnabled && event) {
        this.recap.recordActivity({
          type: this._activityType(event),
          app: event.app,
          task: this.stateManager.taskHypothesis,
          ms: this._wanderMs(),
        });
      }
      this.distractedStartTime = null;
      if (this.isDistracted) {
        this.isDistracted = false;
        this.emit("on_task");
        // §4 restorative re-entry: tell the user exactly where they left off.
        if (this._recapEnabled) this._say(this.recap.whereYouLeftOff());
      }
      this._stuckSurfaced = false; // returning to task resolves a stuck episode
    } else {
      // unclear - maintain current threshold timing, neither reset nor advance quickly
    }
  }

  async _promptUserDistraction(goalInfo) {
    this.isAsking = true;
    try {
      let msg = this.strictVideoMode
        ? "Hey! You're supposed to be watching your video! Are you distracted?"
        : "You seem to have been away from your task for a while. Still working on it?";
      // §5 goal countdown: factual, tied to the real distraction duration
      // (never random). Surfaced inside the focus prompt, not a separate nag.
      if (goalInfo && goalInfo.show) {
        msg += `\n\n⏳ ${goalInfo.text} — ${goalInfo.remaining} left (you've been off it ${goalInfo.distractedFor}).`;
      }

      const responseIndex = await this._ask({
        id: Date.now().toString(),
        prelude: this.strictVideoMode
          ? "You're supposed to be watching your video!"
          : "You've been away from your task for a bit…",
        title: "Focus Check",
        message: msg,
        buttons: ["Yep, still working", "Nope, I'm done", "Help me get back"],
      });

      if (responseIndex === 0) {
        this.distractedStartTime = null;
        this.isDistracted = false;
        this._say("Awesome, keep at it! 💪");
      } else if (responseIndex === 1) {
        this.stateManager.clearTask();
        this.strictVideoMode = false;
        this.distractionThresholdMs = this.defaultDistractionMs;
        this.distractedStartTime = null;
        this.isDistracted = false;
        this._distractionCooldownUntil = 0;
        // §3.10 task completion — explicit "done" stops evaluation.
        if (this.taskLifecycle) this.taskLifecycle.markComplete({ reason: "explicit-done" });
        this._memoryGoalResolve("done");
        if (this._recapEnabled) this.recap.reset();
        this._say("Got it — clearing your task. 👋");
      } else if (responseIndex === 2) {
        this.distractedStartTime = null;
        this.isDistracted = false;
        // "Help me get back" → focus the active session's terminal (or video tab).
        const target = (typeof this.refocusHandler === "function") ? this.refocusHandler() : null;
        if (target) {
          this._say(`On it — jumping to ${target}. 🚀`);
        } else {
          this._say("Let's get you back on track! 🚀");
        }
      }
    } catch (err) {
      console.warn("[attention-decision] ask failed:", err);
    } finally {
      this.isAsking = false;
    }
  }

  // ── v3 memory wiring helpers (plan §1.4, §4, §5) ──────────────────────────

  // True only when the memory store is enabled AND on. Prevents stray network
  // calls / OS notifications when memory is toggled off.
  _memoryOn() {
    if (!this._memory) return false;
    const prefs = this._getPrefs() || {};
    return prefs.memoryEnabled === true;
  }

  // Stable, privacy-safe id for a task so start/end pair on the same doc.
  _slug(task) {
    const s = String(task || "").trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s || "task";
  }

  _memoryTaskStart(task) {
    if (!this._memoryOn() || !task) return;
    this._memory.recordTaskStart({ taskId: this._slug(task), label: task }).catch(() => {});
  }

  _memoryTaskCleared(info) {
    if (!this._memoryOn() || !info) return;
    this._memory.recordTaskEnd({ taskId: this._slug(info.task), outcome: info.reason }).catch(() => {});
  }

  // Mirror the nudge-contract (the existing "goal" feature) into a Supermemory
  // goal doc with an expiry = parsed deadline (plan §5.1).
  _mirrorGoal(contract) {
    if (!this._memoryOn() || !contract) return;
    const prefs = this._getPrefs() || {};
    if (prefs.memoryGoalEnabled === false) return;
    const deadline = parseGoalDeadline(String(contract), Date.now());
    this._memory.setGoal({ text: String(contract).trim(), deadline }).catch(() => {});
  }

  // Runtime contract updates (Settings) keep the memory goal in sync.
  setContract(contract) {
    if (this.nudgeBudget) this.nudgeBudget.setContract(contract);
    this._mirrorGoal(contract);
  }

  // Called when a genuine (threshold-confirmed) distraction is detected.
  _memoryGoalOnDistraction() {
    if (!this._memoryOn()) return { show: false, reason: "no-memory" };
    const ms = this.distractedStartTime ? Date.now() - this.distractedStartTime : 0;
    try { return this._memory.goalDistraction(ms); } catch (e) { return { show: false }; }
  }

  _memoryGoalResolve(type) {
    if (!this._memoryOn()) return;
    this._memory.resolveGoal(type).catch(() => {});
  }

  // Proactive check-in (plan §4): a real OS notification drawn from the
  // personal recent-context profile. Gated by pref + cooldown so it can't nag.
  async _maybeProactiveCheckIn(task) {
    if (!this._memoryOn()) return;
    const prefs = this._getPrefs() || {};
    if (prefs.memoryProactiveEnabled === false) return;
    if (Date.now() < this._proactiveCooldownUntil) return;
    this._proactiveCooldownUntil = Date.now() + 30 * 60 * 1000;
    try {
      const profile = await this._memory.getProfile().catch(() => ({}));
      const msg = this._memory.buildProactiveCheckIn
        ? this._memory.buildProactiveCheckIn(profile)
        : "Quick check-in — how's your focus?";
      // Initiates talking: speak the check-in in the bubble, not just a toast.
      if (typeof this._say === "function") this._say(msg);
      await this._memory.deliverProactive(msg, { now: Date.now() });
    } catch (e) { /* best-effort */ }
  }

  // ── §3.8 / §4 helpers & signal seams ────────────────────────────────────────

  _nudgeActive() {
    const contract = (this.nudgeBudget.getContract() || "").trim();
    return contract.length > 0 || this.nudgeBudget.getBudgetMs() > 0;
  }

  _wanderMs() {
    return Math.max(1000, Math.round((this.distractionThresholdMs || 300000) / 5));
  }

  _wanderMinutes() {
    return Math.max(1, Math.round(this._wanderMs() / 60000));
  }

  _activityType(event) {
    const app = (event && event.app ? event.app : "").toLowerCase();
    if (/(code|idea|vim|xcode|terminal|cursor|studio|zed|neovim|windsurf|pycharm)/.test(app)) return "editor";
    if (/(docs|notion|obsidian|onenote|word|markdown|readme|pdf|notes)/.test(app)) return "docs";
    if (/(chrome|edge|firefox|brave|opera|safari|browser|arc|vivaldi)/.test(app)) return "browser";
    return "unrelated";
  }

  _contractWithin(event) {
    const contract = (this.nudgeBudget.getContract() || "").trim().toLowerCase();
    if (!contract) return false;
    const hay = `${event && event.app ? event.app : ""} ${event && event.title ? event.title : ""} ${event && event.url ? event.url : ""}`.toLowerCase();
    const words = contract.split(/\s+/).filter((w) => w.length > 3);
    if (!words.length) return false;
    return words.some((w) => hay.includes(w));
  }

  /**
   * §4 stuck-detection signal source. Call from AI-tool / agent hook handlers
   * (UserPromptSubmit, Read/Write, git commit). Surfaces an empathetic
   * "offer help" once per episode, never as a discipline flag.
   *
   * @param {{type:"query"|"doc"|"write"|"commit", tool?:string, question?:string, docId?:string, path?:string}} signal
   */
  recordAgentActivity(signal) {
    if (!this._stuckEnabled || !signal) return;
    if (signal.type === "query") this.insights.recordQuery({ tool: signal.tool, question: signal.question });
    else if (signal.type === "doc") this.insights.recordDocRead(signal.docId);
    else if (signal.type === "write") this.insights.recordFileWrite(signal.path);
    else if (signal.type === "commit") { this.insights.recordCommit(); this._stuckSurfaced = false; return; }

    const stuck = this.insights.getStuckSignal();
    if (stuck && !this._stuckSurfaced) {
      this._stuckSurfaced = true;
      const msg =
        stuck.kind === "repeated-question"
          ? "You've asked about this in a couple of tools — want a hand?"
          : stuck.kind === "doc-reread"
          ? "You've been re-reading the docs a lot — stuck on something?"
          : "Lots of edits without a commit — want to pair on this?";
      this._say(msg);
    }
  }

  /**
   * §3.10 task completion via real-world signals (commit+pr, explicit done).
   * @param {"commit"|"pr"|"done"} type
   */
  recordTaskCompletion(type) {
    if (this.taskLifecycle) this.taskLifecycle.onSignal(type);
    this._memoryGoalResolve(type);
  }

  /**
   * §4 permission-based sharing — build a factual session summary and, with
   * explicit consent, surface it. Delivery to a specific "pair" is app-specific;
   * here we surface it in the pet bubble. Never shares without the confirm step,
   * and the summary is factual only (no scoring / judgment).
   *
   * @returns {Promise<boolean>} true if the user chose to share
   */
  async shareRecapWithPair() {
    if (!this._recapEnabled) return false;
    const idx = await this._ask({
      id: Date.now().toString(),
      title: "Share session summary",
      message: "Share a factual summary of where your time went with your pair?",
      buttons: ["Share", "Not now"],
    });
    if (idx !== 0) return false;
    const recap = this.recap.sessionRecap();
    const text = recap ? recap.summary() : "No session data yet.";
    await this._say("Here's your session summary:\n" + text);
    return true;
  }
}

let _instance = null;
function getAttentionDecision() {
  if (!_instance) _instance = new AttentionDecision();
  return _instance;
}

module.exports = {
  getAttentionDecision,
};
