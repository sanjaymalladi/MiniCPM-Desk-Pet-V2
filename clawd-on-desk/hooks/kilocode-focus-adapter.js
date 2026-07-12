"use strict";

/**
 * @file kilocode-focus-adapter.js
 *
 * Focus adapter for Kilo Code CLI. Emits NormalizedEvent objects to the
 * AttentionEventBus based on Kilo Code's session log files.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const EventEmitter = require("events");

const POLL_INTERVAL_MS = 3000;

function getLogDirCandidates() {
  const home = os.homedir();
  return [
    path.join(home, ".kilocode", "logs"),
    process.env.KILOCODE_LOG_DIR || "",
  ].filter(Boolean);
}

class KilocodeFocusAdapter extends EventEmitter {
  constructor() {
    super();
    this._pollTimer = null;
    this._active = false;
    this._lastEmitAt = 0;
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._poll();
  }

  stop() {
    this._active = false;
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
  }

  _poll() {
    if (!this._active) return;
    this._checkLogFiles();
    this._pollTimer = setTimeout(() => this._poll(), POLL_INTERVAL_MS);
  }

  _checkLogFiles() {
    for (const dir of getLogDirCandidates()) {
      try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".log"));
        if (!files.length) continue;
        const latest = files
          .map(f => ({ name: f, stat: fs.statSync(path.join(dir, f)) }))
          .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];

        // Active if modified in last 5 mins
        if (Date.now() - latest.stat.mtimeMs > 5 * 60 * 1000) continue;

        const now = Date.now();
        if (now - this._lastEmitAt < POLL_INTERVAL_MS * 2) return;
        this._lastEmitAt = now;

        /** @type {import("../src/hook-source-interface").NormalizedEvent} */
        const event = {
          app: "kilocode",
          title: "Kilo Code Session",
          project: "kilocode-workspace",
          timestamp: now,
          source: "kilocode-adapter",
        };
        this.emit("focus", event);
        return;
      } catch { /* skip */ }
    }
  }
}

const adapter = new KilocodeFocusAdapter();
module.exports = adapter;
