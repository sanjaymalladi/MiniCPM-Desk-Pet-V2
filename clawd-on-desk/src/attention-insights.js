"use strict";

/**
 * @file attention-insights.js
 *
 * Pure (no electron / network / fs) signal aggregator for the Attention
 * Companion v2 "Stuck-detection + Pattern surfacing" feature (plan §4).
 *
 * This is a DIFFERENT detection path from distraction: rather than treating
 * repeated friction as a discipline flag, it reads it as "stuck, offer help."
 * It also keeps factual, non-nagging aggregations (per-hour distraction
 * counts) for later "you tend to drift around 3pm" style surfacing.
 *
 * All time windows and counters are injectable for testing.
 */

class AttentionInsights {
  constructor(options = {}) {
    this.windowMs =
      Number.isFinite(options.windowMs) && options.windowMs >= 0
        ? options.windowMs
        : 10 * 60 * 1000;
    this.docRereadThreshold =
      Number.isInteger(options.docRereadThreshold) && options.docRereadThreshold > 0
        ? options.docRereadThreshold
        : 3;
    this.thrashWriteThreshold =
      Number.isInteger(options.thrashWriteThreshold) && options.thrashWriteThreshold > 0
        ? options.thrashWriteThreshold
        : 8;

    this._now = typeof options.now === "function" ? options.now : () => Date.now();

    this._queries = [];
    this._docReads = [];
    this._fileWrites = 0;
    this._lastCommitAt = null;
    this._distractionByHour = new Map();
  }

  static _normalizeQuestion(q) {
    return String(q || "").toLowerCase().trim();
  }

  _pruneByWindow(list) {
    const cutoff = this._now() - this.windowMs;
    return list.filter((entry) => entry.t >= cutoff);
  }

  recordQuery({ tool, question }) {
    const norm = AttentionInsights._normalizeQuestion(question);
    if (!norm || !tool) return;
    this._queries = this._pruneByWindow(this._queries);
    this._queries.push({ tool, norm, t: this._now() });
  }

  recordDocRead(docId) {
    if (!docId) return;
    this._docReads = this._pruneByWindow(this._docReads);
    this._docReads.push({ docId, t: this._now() });
  }

  recordFileWrite(path) {
    if (!path) return;
    this._fileWrites += 1;
  }

  recordCommit() {
    this._lastCommitAt = this._now();
    this._fileWrites = 0;
  }

  getStuckSignal() {
    this._queries = this._pruneByWindow(this._queries);
    this._docReads = this._pruneByWindow(this._docReads);

    const queryTools = new Map();
    for (const q of this._queries) {
      if (!queryTools.has(q.norm)) queryTools.set(q.norm, new Set());
      queryTools.get(q.norm).add(q.tool);
    }
    for (const [norm, tools] of queryTools) {
      if (tools.size >= 2) {
        return {
          kind: "repeated-question",
          detail: norm,
          tools: Array.from(tools),
        };
      }
    }

    const docCounts = new Map();
    for (const d of this._docReads) {
      docCounts.set(d.docId, (docCounts.get(d.docId) || 0) + 1);
    }
    for (const [docId, count] of docCounts) {
      if (count >= this.docRereadThreshold) {
        return {
          kind: "doc-reread",
          detail: docId,
          count,
        };
      }
    }

    if (this._fileWrites >= this.thrashWriteThreshold) {
      return {
        kind: "file-thrash",
        detail: "editing without progress",
        writes: this._fileWrites,
      };
    }

    return null;
  }

  recordDistraction(hourOfDay) {
    if (!Number.isInteger(hourOfDay) || hourOfDay < 0 || hourOfDay > 23) return;
    this._distractionByHour.set(
      hourOfDay,
      (this._distractionByHour.get(hourOfDay) || 0) + 1
    );
  }

  _peakDistractionHour() {
    let peakHour = null;
    let peakCount = 0;
    for (const [hour, count] of this._distractionByHour) {
      if (count > peakCount) {
        peakCount = count;
        peakHour = hour;
      }
    }
    return peakCount > 0 ? { hour: peakHour, count: peakCount } : null;
  }

  driftSummary() {
    const peak = this._peakDistractionHour();
    if (!peak) return null;
    const hourLabel =
      peak.hour === 0
        ? "12am"
        : peak.hour < 12
        ? `${peak.hour}am`
        : peak.hour === 12
        ? "12pm"
        : `${peak.hour - 12}pm`;
    return {
      hour: peak.hour,
      count: peak.count,
      message: `You've tended to drift around ${hourLabel}`,
    };
  }

  weeklyPattern() {
    const peak = this._peakDistractionHour();
    if (!peak) return null;
    return { hour: peak.hour, count: peak.count };
  }

  reset() {
    this._queries = [];
    this._docReads = [];
    this._fileWrites = 0;
    this._lastCommitAt = null;
    this._distractionByHour = new Map();
  }
}

module.exports = { AttentionInsights };
