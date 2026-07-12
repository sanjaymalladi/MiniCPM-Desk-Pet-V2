"use strict";

/**
 * @file attention-recap.js
 *
 * Pure, side-effect-free accumulator for the Attention Companion v2 plan
 * (§4: Restorative re-entry + Honest session recap).
 *
 * It tracks how the user actually spent their session and, crucially, keeps
 * the last *confirmed* task-state fact so the pet can tell the user exactly
 * where they left off after a break. No scoring, no judgment framing.
 *
 * Nothing here touches Electron, the network, or the filesystem, so the whole
 * module is unit-testable in isolation.
 */

const ACTIVITY_TYPES = ["editor", "docs", "browser", "unrelated"];

function normalizeType(type) {
  return ACTIVITY_TYPES.includes(type) ? type : "unrelated";
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  return `${formatDuration(ms)} ago`;
}

class AttentionRecap {
  constructor(options = {}) {
    this._now = typeof options.now === "function" ? options.now : Date.now;
    this.reset();
  }

  reset() {
    this.editorMs = 0;
    this.docsMs = 0;
    this.browserMs = 0;
    this.unrelatedMs = 0;
    this.confirmedTask = null;
    this.lastTask = null;
    this.lastApp = null;
    this.lastType = null;
    this.lastActivityAt = null;
  }

  recordActivity({ type, app, task, ms } = {}) {
    const t = normalizeType(type);
    const amount = Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (t === "editor") this.editorMs += amount;
    else if (t === "docs") this.docsMs += amount;
    else if (t === "browser") this.browserMs += amount;
    else this.unrelatedMs += amount;

    if (typeof app === "string" && app) this.lastApp = app;
    if (typeof task === "string" && task) this.lastTask = task;
    this.lastType = t;
    this.lastActivityAt = this._now();
  }

  confirmTask(task) {
    if (typeof task === "string" && task) this.confirmedTask = task;
  }

  whereYouLeftOff() {
    if (!this.confirmedTask) {
      return "You stepped away — no task was confirmed yet, so I'll just wait for your next move.";
    }
    const where = this.lastApp
      ? `in ${this.lastApp}`
      : (this.lastType && this.lastType !== "unrelated"
        ? `in your ${this.lastType}`
        : "on your machine");
    const ago = this.lastActivityAt != null
      ? ` about ${formatAgo(this._now() - this.lastActivityAt)}`
      : "";
    return `You were working on "${this.confirmedTask}" — last activity ${where}${ago}.`;
  }

  sessionRecap() {
    const totalMs = this.editorMs + this.docsMs + this.browserMs + this.unrelatedMs;
    const recap = {
      editorMs: this.editorMs,
      docsMs: this.docsMs,
      browserMs: this.browserMs,
      unrelatedMs: this.unrelatedMs,
      task: this.confirmedTask,
      totalMs,
    };
    recap.summary = () => {
      const parts = [
        `You spent ${formatDuration(this.editorMs)} in your editor`,
        `${formatDuration(this.docsMs)} in docs`,
        `${formatDuration(this.browserMs)} in the browser`,
        `${formatDuration(this.unrelatedMs)} elsewhere`,
      ];
      return `${parts.join(", ")}.`;
    };
    return recap;
  }
}

module.exports = {
  AttentionRecap,
  ACTIVITY_TYPES,
  normalizeType,
  formatDuration,
};
