"use strict";

// ── Proactive messaging (plan §4) ──
//
// Delivery + the trust boundary: messages surface as a real OS notification or
// an in-app alert (not just a chat window waiting to be opened), and they
// always respect mute / quiet-hours. Content draws from the personal
// recent-context profile (check-ins) and world-knowledge ("here's something
// relevant") — never from raw Tier 1 state directly.

const { PROACTIVE_DEFAULTS } = require("./memory-constants");

function inQuietHours(now, start, end) {
  const h = new Date(now).getHours();
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  // wraps past midnight
  return h >= start || h < end;
}

class ProactiveMessenger {
  constructor(options = {}) {
    this.notify = typeof options.notify === "function" ? options.notify : async () => ({});
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    // Prefs can be a static object or a live getter (so Settings changes apply
    // without a restart). Fields: quietHoursStart, quietHoursEnd, muted.
    this.getPrefs = typeof options.getPrefs === "function"
      ? options.getPrefs
      : () => (options.prefs || {});
  }

  _readPrefs() {
    const p = this.getPrefs() || {};
    return {
      quietHoursStart: Number.isFinite(p.quietHoursStart) ? p.quietHoursStart : PROACTIVE_DEFAULTS.quietHoursStart,
      quietHoursEnd: Number.isFinite(p.quietHoursEnd) ? p.quietHoursEnd : PROACTIVE_DEFAULTS.quietHoursEnd,
      muted: p.muted === true,
    };
  }

  isQuiet(now = this.now()) {
    const p = this._readPrefs();
    return inQuietHours(now, p.quietHoursStart, p.quietHoursEnd);
  }

  shouldDeliver(now = this.now()) {
    const p = this._readPrefs();
    if (p.muted) return false;
    if (inQuietHours(now, p.quietHoursStart, p.quietHoursEnd)) return false;
    return true;
  }

  // Build a check-in from the personal recent-context profile.
  buildCheckIn(profile) {
    const recent = (profile && profile.recent) || (profile && profile.recentContext) || [];
    const items = Array.isArray(recent) ? recent : [];
    if (!items.length) return "Hey — how's it going? Anything you want me to remember?";
    const last = items[items.length - 1];
    const text = (last && (last.content || last.text)) || "";
    return text ? `Quick check-in: last time, ${text}` : "Quick check-in — how's progress?";
  }

  // Build a "here's something relevant" from world-knowledge entries.
  buildRelevant(entries) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) return null;
    const top = list.slice(0, 2).map((e) => (e && e.content) || "").filter(Boolean);
    if (!top.length) return null;
    return `Something relevant: ${top.join("  ·  ")}`;
  }

  async deliver(message, meta = {}) {
    if (!message) return { delivered: false, reason: "empty" };
    const now = meta && Number.isFinite(meta.now) ? meta.now : this.now();
    if (!this.shouldDeliver(now)) {
      const p = this._readPrefs();
      return { delivered: false, reason: p.muted ? "muted" : "quiet-hours" };
    }
    await this.notify(message, meta);
    return { delivered: true };
  }
}

module.exports = { ProactiveMessenger, inQuietHours };
