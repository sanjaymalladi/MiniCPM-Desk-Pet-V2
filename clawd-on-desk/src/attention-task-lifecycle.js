"use strict";

/**
 * @file attention-task-lifecycle.js
 *
 * Pure task lifecycle for the Attention Companion (v2 plan §3.8, §3.10).
 * Tracks the current task hypothesis, fires a frictionless check-in when a
 * NEW task is first detected, records corrections, and lets a task be marked
 * complete so evaluation stops. No electron, no network, no fs.
 */

const VALID_COMPLETE_REASONS = new Set(["commit+pr", "explicit-done"]);
const VALID_SIGNALS = new Set(["commit", "pr", "done"]);

class AttentionTaskLifecycle {
  /**
   * @param {object} [options]
   * @param {Function} [options.confirmHandler] - (payload) => Promise<number|null>
   *        Mirrors AttentionDecision._ask. Resolves with the clicked button
   *        index (0 = yes, 1 = correct) or null on dismiss/timeout.
   * @param {Function} [options.messageHandler] - (text) => Promise
   *        Shows a non-interactive pet speech bubble.
   * @param {Function} [options.onTaskCleared] - (info) => void
   *        Called when the active task transitions to completed/inactive.
   */
  constructor({ confirmHandler, messageHandler, onTaskCleared } = {}) {
    this.confirmHandler = typeof confirmHandler === "function" ? confirmHandler : null;
    this.messageHandler = typeof messageHandler === "function" ? messageHandler : null;
    this.onTaskCleared = typeof onTaskCleared === "function" ? onTaskCleared : null;

    this._currentTask = null;
    this._completed = false;
    this._corrections = [];
    this._checkedInTasks = new Set();
    this._pendingCheckIn = null;

    this._seenCommit = false;
    this._seenPr = false;
  }

  /**
   * Set the current task. When a NEW task identity is detected (different from
   * the previous one and not already completed), fire a one-time check-in
   * prompt via confirmHandler. The check-in stays "pending" until resolved.
   *
   * @param {string} hypothesis
   * @returns {Promise<void>}
   */
  async startTask(hypothesis) {
    if (!hypothesis || typeof hypothesis !== "string") return;
    if (this._completed) return;

    const normalized = hypothesis.trim();
    if (!normalized) return;

    const isNew = this._currentTask !== normalized;
    this._currentTask = normalized;

    if (isNew && !this._checkedInTasks.has(normalized)) {
      this._checkedInTasks.add(normalized);
      await this._fireCheckIn(normalized);
    }
  }

  async _fireCheckIn(hypothesis) {
    if (typeof this.confirmHandler !== "function") return;

    this._pendingCheckIn = {
      hypothesis,
      corrected: false,
    };

    try {
      const responseIndex = await this.confirmHandler({
        id: `task-checkin-${Date.now()}`,
        title: "Task Check-in",
        message: `Looks like you're starting: "${hypothesis}". Right?`,
        buttons: ["Yep, that's it", "No — it's actually…"],
      });

      if (responseIndex === null || responseIndex === undefined) {
        this._pendingCheckIn = null;
        return;
      }

      if (responseIndex === 1) {
        this._pendingCheckIn = { ...this._pendingCheckIn, awaitingCorrection: true };
      } else {
        this._pendingCheckIn = null;
      }
    } catch (err) {
      this._pendingCheckIn = null;
    }
  }

  /**
   * Resolve a pending check-in. When the user corrects (index 1), record the
   * correction (flagged corrected:true) and adopt the corrected hypothesis as
   * the new current task. Corrections MUST NOT be logged as distraction or
   * counted against any budget by the decision layer.
   *
   * @param {number} responseIndex
   * @param {string} [correctedHypothesis]
   * @returns {Promise<void>}
   */
  async resolveCheckIn(responseIndex, correctedHypothesis) {
    if (!this._pendingCheckIn) return;

    if (responseIndex === 1) {
      const corrected = (correctedHypothesis && correctedHypothesis.trim()) || null;
      const from = this._pendingCheckIn.hypothesis;
      if (corrected && corrected !== from) {
        this._corrections.push({ from, to: corrected, corrected: true });
        this._currentTask = corrected;
        this._checkedInTasks.add(corrected);
      } else if (corrected) {
        this._corrections.push({ from, to: corrected, corrected: true });
      }
    }

    this._pendingCheckIn = null;
  }

  /**
   * Mark the current task complete. Evaluation (isActive) stops afterwards.
   *
   * @param {object} [opts]
   * @param {"commit+pr"|"explicit-done"} [opts.reason]
   */
  markComplete({ reason } = {}) {
    const safeReason = VALID_COMPLETE_REASONS.has(reason) ? reason : "explicit-done";
    if (this._completed) return;
    this._completed = true;
    this._pendingCheckIn = null;
    if (typeof this.onTaskCleared === "function") {
      try {
        this.onTaskCleared({ reason: safeReason, task: this._currentTask });
      } catch (err) {}
    }
  }

  /**
   * Convenience signal mapping for real-world events.
   *  - "commit" / "pr": tracked; completes with "commit+pr" once BOTH seen.
   *  - "done": completes immediately with "explicit-done".
   *
   * @param {"commit"|"pr"|"done"} type
   */
  onSignal(type) {
    if (!VALID_SIGNALS.has(type)) return;
    if (this._completed) return;

    if (type === "done") {
      this.markComplete({ reason: "explicit-done" });
      return;
    }

    if (type === "commit") this._seenCommit = true;
    if (type === "pr") this._seenPr = true;

    if (this._seenCommit && this._seenPr) {
      this.markComplete({ reason: "commit+pr" });
    }
  }

  isActive() {
    return !this._completed;
  }

  getCurrentTask() {
    return this._currentTask;
  }

  getCorrections() {
    return this._corrections.slice();
  }

  wasCorrected() {
    return this._corrections.length > 0;
  }
}

module.exports = {
  AttentionTaskLifecycle,
  VALID_COMPLETE_REASONS,
  VALID_SIGNALS,
};
