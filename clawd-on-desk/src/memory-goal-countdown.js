"use strict";

// ── Goal countdown (plan §5) ──
//
// A goal is a personal-container doc with an expiry = the deadline (no custom
// scheduler). A lightweight local clock tracks remaining time. The countdown
// only SURFACES on a real distraction that exceeds the threshold duration — it
// is tied to actual behavior, never random (plan §5.2). Goals resolve against a
// concrete signal (commit / file saved / "done"), not just the clock running out.

const { CONTAINER_TAGS, GOAL_COUNTDOWN_DEFAULTS } = require("./memory-constants");

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

class GoalCountdown {
  constructor(options = {}) {
    this.store = typeof options.store === "function" ? options.store : async () => ({});
    this.recall = typeof options.recall === "function" ? options.recall : async () => [];
    this.del = typeof options.del === "function" ? options.del : async () => ({});
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.caps = Object.assign({}, GOAL_COUNTDOWN_DEFAULTS, options.caps || {});

    this._activeId = null;
    this._text = null;
    this._deadline = null;
    this._surfaces = 0;
  }

  async setGoal({ text, deadline }) {
    if (!text || !Number.isFinite(deadline)) throw new Error("setGoal requires text + deadline");
    const res = await this.store({
      content: text,
      category: CONTAINER_TAGS.PERSONAL,
      metadata: { tier: "goal", deadline, createdAt: this.now() },
    });
    this._activeId = (res && res.data && res.data.id) || (res && res.id) || null;
    this._text = text;
    this._deadline = deadline;
    this._surfaces = 0;
    return res;
  }

  // Restore the active goal from storage (unexpired only).
  async loadActive() {
    const entries = await this.recall({ query: "", limit: 20 });
    const now = this.now();
    const goal = (Array.isArray(entries) ? entries : [])
      .filter((e) => e && e.metadata && e.metadata.tier === "goal")
      .map((e) => ({ e, deadline: e.metadata.deadline }))
      .filter((x) => x.deadline > now)
      .sort((a, b) => a.deadline - b.deadline)[0];
    if (goal) {
      this._activeId = goal.e.id || (goal.e.data && goal.e.data.id) || null;
      this._text = goal.e.content;
      this._deadline = goal.deadline;
      this._surfaces = 0;
      return this.getActive();
    }
    return null;
  }

  getActive() {
    if (!this._activeId || !this._deadline) return null;
    const now = this.now();
    if (this._deadline <= now) return null;
    return { text: this._text, deadline: this._deadline, remainingMs: this._deadline - now, remaining: fmtDuration(this._deadline - now) };
  }

  isExpired() {
    return !!this._deadline && this.now() >= this._deadline;
  }

  // Decision layer calls this when it confirms a GENUINE distraction (not doubt).
  // Returns { show, ... } — show:true only when threshold + budget allow.
  onDistraction(distractionMs, now = this.now()) {
    if (!this._activeId) return { show: false, reason: "no-goal" };
    if (this.isExpired()) return { show: false, reason: "expired" };
    if (!Number.isFinite(distractionMs) || distractionMs < this.caps.minDistractionMs) {
      return { show: false, reason: "below-threshold" };
    }
    if (this._surfaces >= this.caps.maxSurfacesPerGoal) return { show: false, reason: "budget" };
    this._surfaces += 1;
    return {
      show: true,
      text: this._text,
      remaining: fmtDuration(this._deadline - now),
      distractedFor: fmtDuration(distractionMs),
      surface: this._surfaces,
    };
  }

  // Resolve against a concrete completion signal (commit / file saved / "done").
  async resolve(signal) {
    if (!this._activeId) return null;
    const text = this._text;
    try { await this.del(this._activeId); } catch (_) { /* best-effort */ }
    this._activeId = null;
    this._text = null;
    this._deadline = null;
    return { resolved: true, text, signal };
  }
}

module.exports = { GoalCountdown, fmtDuration };
