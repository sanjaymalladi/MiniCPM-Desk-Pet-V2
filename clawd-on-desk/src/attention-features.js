"use strict";

/**
 * @file attention-features.js
 *
 * The "observer" feature set from the v2 plan (§4) plus the §3.8 / §3.10
 * signals, implemented as pure, side-effect-free tracking logic so it can be
 * unit-tested without Electron. The decision layer (`attention-decision.js`)
 * feeds it events and decides when to surface a pet bubble.
 *
 * Features:
 *   - §3.8  Lightweight "looks like you're starting X — right?" check-in
 *   - §3.10 Task-completion signal (commit/PR) clears the task
 *   - §4    Wander budget, Nudge contract, Stuck-detection, Honest recap,
 *           Restorative re-entry, Pattern surfacing, Permission sharing
 *
 * The pet stays the observer — it never judges, it only tracks and surfaces
 * factual summaries the user can act on or share.
 */

function emptyTracker() {
  return {
    questions: new Map(),   // normalized question -> count
    lastQuestion: null,
    docReads: 0,            // tab/url re-reads without progress
    commits: 0,
    fileWrites: 0,
    prevFileWriteAt: null,
  };
}

class AttentionFeatures {
  /**
   * @param {object} [config]
   * @param {number} [config.wanderBudgetMinutes=0] - 0 disables the budget
   * @param {string} [config.nudgeContract=""] - user's stated session goal
   * @param {number} [config.stuckQuestionThreshold=3] - same question repeats
   * @param {number} [config.stuckIdleFileMs=60000] - file-thrash window
   */
  constructor(config = {}) {
    this.wanderBudgetMinutes = Number.isFinite(config.wanderBudgetMinutes) ? config.wanderBudgetMinutes : 0;
    this.nudgeContract = config.nudgeContract || "";
    this.stuckQuestionThreshold = config.stuckQuestionThreshold || 3;
    this.stuckIdleFileMs = config.stuckIdleFileMs || 60000;

    this.wanderSpentMs = 0;
    this._wanderAnnounced = false;

    this.distraction = { active: false, start: 0 };
    this.task = { current: null, start: null };

    this.timeOnTaskMs = 0;
    this.timeDistractedMs = 0;
    this.taskBuckets = new Map();   // task -> ms
    this.driftByHour = new Map();   // hour(0-23) -> ms distracted

    this.lastTaskFacts = null;      // for restorative re-entry
    this._stuck = emptyTracker();
    this.sessionStart = Date.now();
  }

  // ── §3.8 check-in ──────────────────────────────────────────────────────
  /**
   * Decide whether a freshly-inferred task warrants a confirming check-in.
   * We only check in once per distinct task to avoid nagging.
   *
   * @param {string} task
   * @returns {boolean}
   */
  shouldCheckIn(task) {
    if (!task) return false;
    if (this._checkedIn && this._checkedIn.has(task)) return false;
    return true;
  }
  markCheckedIn(task) {
    if (!this._checkedIn) this._checkedIn = new Set();
    if (task) this._checkedIn.add(task);
  }

  // ── task / distraction timing ────────────────────────────────────────────
  noteTaskStart(task, ts = Date.now()) {
    if (this.task.current && this.task.start != null) {
      const dur = ts - this.task.start;
      this.timeOnTaskMs += dur;
      this.taskBuckets.set(this.task.current, (this.taskBuckets.get(this.task.current) || 0) + dur);
    }
    this.task = { current: task, start: ts };
    this.lastTaskFacts = { task, at: ts };
    // a fresh task resets the stuck tracker (new context)
    this._stuck = emptyTracker();
  }

  noteDistractionStart(ts = Date.now()) {
    if (this.distraction.active) return;
    this.distraction = { active: true, start: ts };
  }

  noteDistractionEnd(ts = Date.now()) {
    if (!this.distraction.active) return;
    const dur = ts - this.distraction.start;
    this.timeDistractedMs += dur;
    this.wanderSpentMs += dur;
    const hour = new Date(this.distraction.start).getHours();
    this.driftByHour.set(hour, (this.driftByHour.get(hour) || 0) + dur);
    this.distraction = { active: false, start: 0 };
  }

  // ── §3.10 task completion ─────────────────────────────────────────────────
  noteCommit() {
    this._stuck.commits += 1;
  }

  // ── §4 stuck-detection ────────────────────────────────────────────────────
  noteQuestion(q, ts = Date.now()) {
    const key = String(q || "").trim().toLowerCase().slice(0, 120);
    if (!key) return;
    this._stuck.lastQuestion = key;
    this._stuck.questions.set(key, (this._stuck.questions.get(key) || 0) + 1);
  }
  noteDocRead() {
    this._stuck.docReads += 1;
  }
  noteFileWrite(ts = Date.now()) {
    this._stuck.fileWrites += 1;
    // thrash = many writes with no commit in a short window
    if (this._stuck.prevFileWriteAt != null && ts - this._stuck.prevFileWriteAt < this.stuckIdleFileMs) {
      this._stuck._thrash = (this._stuck._thrash || 0) + 1;
    }
    this._stuck.prevFileWriteAt = ts;
  }
  /**
   * @returns {"stuck"|null}
   */
  stuckSignal() {
    let repeated = false;
    for (const c of this._stuck.questions.values()) {
      if (c >= this.stuckQuestionThreshold) { repeated = true; break; }
    }
    const thrash = (this._stuck._thrash || 0) >= 5;
    const rereads = this._stuck.docReads >= 4;
    const noProgress = this._stuck.commits === 0;
    if (noProgress && (repeated || thrash || rereads)) return "stuck";
    return null;
  }
  resetStuck() { this._stuck = emptyTracker(); }

  // ── §4 wander budget ──────────────────────────────────────────────────────
  /** @returns {boolean} true exactly once when the budget is first exceeded */
  wanderExceeded() {
    if (!this.wanderBudgetMinutes || this.wanderBudgetMinutes <= 0) return false;
    if (this._wanderAnnounced) return false;
    if (this.wanderSpentMs >= this.wanderBudgetMinutes * 60000) {
      this._wanderAnnounced = true;
      return true;
    }
    return false;
  }

  // ── §4 nudge contract ─────────────────────────────────────────────────────
  contractActive() {
    return !!this.nudgeContract && this.nudgeContract.trim().length > 0;
  }

  // ── §4 restorative re-entry ───────────────────────────────────────────────
  /**
   * @returns {string|null} a factual "where you left off" line, or null
   */
  buildReentry() {
    if (!this.lastTaskFacts) return null;
    const mins = Math.max(1, Math.round((Date.now() - this.lastTaskFacts.at) / 60000));
    return `Last task: "${this.lastTaskFacts.task}" — you stepped away ${mins} min ago.`;
  }

  // ── §4 pattern surfacing ──────────────────────────────────────────────────
  /**
   * @returns {{hour:number, mins:number}|null} the hour with the most drift
   */
  driftPeakHour() {
    let best = null;
    for (const [h, ms] of this.driftByHour) {
      if (!best || ms > best.mins * 60000) best = { hour: h, mins: Math.round(ms / 60000) };
    }
    return best && best.mins >= 5 ? best : null;
  }

  // ── §4 honest recap ───────────────────────────────────────────────────────
  buildRecap() {
    const taskLines = [];
    for (const [t, ms] of this.taskBuckets) {
      taskLines.push({ task: t, mins: Math.round(ms / 60000) });
    }
    return {
      sessionMins: Math.round((Date.now() - this.sessionStart) / 60000),
      onTaskMins: Math.round(this.timeOnTaskMs / 60000),
      distractedMins: Math.round(this.timeDistractedMs / 60000),
      tasks: taskLines.sort((a, b) => b.mins - a.mins),
    };
  }

  // ── §4 permission-based sharing ───────────────────────────────────────────
  /**
   * Build a factual, judgment-free summary string the user can copy/share.
   * The pet never sends it — the user decides.
   *
   * @returns {string}
   */
  buildShareableSummary() {
    const r = this.buildRecap();
    const lines = [
      "Focus session summary (factual, no judgment):",
      `- Session length: ${r.sessionMins} min`,
      `- Time on task: ${r.onTaskMins} min`,
      `- Time drifted: ${r.distractedMins} min`,
    ];
    for (const t of r.tasks) {
      if (t.mins > 0) lines.push(`- ${t.task}: ${t.mins} min`);
    }
    if (this.contractActive()) lines.push(`- Session goal: ${this.nudgeContract}`);
    const peak = this.driftPeakHour();
    if (peak) lines.push(`- Most drift around ${peak.hour}:00 (${peak.mins} min)`);
    return lines.join("\n");
  }
}

module.exports = { AttentionFeatures, emptyTracker };
