"use strict";

/**
 * @file attention-event-bus.js
 *
 * In-process EventEmitter that carries NormalizedEvent objects from all
 * signal hooks (OS focus, browser, AI tool adapters) to the
 * AttentionStateManager.
 *
 * Maintains a rolling history of the last HISTORY_SIZE events for use
 * as context in the MiniCPM5-1B classification prompt.
 */

const EventEmitter = require("events");

const HISTORY_SIZE = 20;

class AttentionEventBus extends EventEmitter {
  constructor() {
    super();
    /** @type {import("./hook-source-interface").NormalizedEvent[]} */
    this._history = [];
  }

  /**
   * Publish a focus event. Adds to history and emits "focus".
   *
   * @param {import("./hook-source-interface").NormalizedEvent} event
   */
  publish(event) {
    if (!event || typeof event !== "object") return;

    // Deduplicate continuous events from the same URL/App so live polling doesn't flood history.
    // Include the title as a disambiguator when no URL is present, so a genuine focus switch
    // between two windows of the same app (or no URL) is not collapsed into one entry.
    const dedupKey = (e) => `${e.app}\u0000${e.url || e.title}`;
    const last = this._history[this._history.length - 1];
    if (last && dedupKey(last) === dedupKey(event)) {
      this._history[this._history.length - 1] = event; // update in place (e.g. for live video time)
      this.emit("focus", event);
      return;
    }

    this._history.push(event);
    if (this._history.length > HISTORY_SIZE) this._history.shift();
    this.emit("focus", event);
  }

  /**
   * Returns a copy of the rolling history (oldest first).
   *
   * @returns {import("./hook-source-interface").NormalizedEvent[]}
   */
  getHistory() {
    return [...this._history];
  }

  /**
   * Formats the recent history into a human-readable string for the LLM context.
   */
  getRecentSummary(limit = 20) {
    const events = this._history.slice(-limit);
    if (events.length === 0) return "No active windows found.";

    const active = events[events.length - 1];
    const background = events.slice(0, -1).reverse(); // most recent background first

    let summary = `[CURRENT ACTIVE WINDOW]\nApp: ${active.app}\nTitle: "${active.title}"\nURL: ${active.url || "N/A"}\n\n`;

    if (background.length > 0) {
      summary += `[BACKGROUND/RECENT TABS]\n`;
      background.forEach(e => {
        summary += `- App: ${e.app} | Title: "${e.title}"\n`;
      });
    }
    return summary;
  }

  /**
   * Clear history (e.g., when attention tracking is reset).
   */
  clearHistory() {
    this._history = [];
  }
}

// Singleton for the main process lifetime
const bus = new AttentionEventBus();

module.exports = { AttentionEventBus, bus };
