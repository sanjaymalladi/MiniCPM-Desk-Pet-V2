"use strict";

/**
 * @file opencode-focus-adapter.js
 *
 * Focus adapter for OpenCode CLI. Monitors OpenCode session state and emits
 * NormalizedEvent objects to the AttentionEventBus so the AttentionStateManager
 * knows when the user is working in an OpenCode session.
 *
 * Detection strategy: tail the opencode log file for session activity events
 * and extract the active workspace/project. Falls back gracefully if opencode
 * is not installed.
 *
 * This adapter does NOT replace the existing opencode-plugin integration that
 * drives pet animations — it runs alongside it, feeding only the attention bus.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const EventEmitter = require("events");

const POLL_INTERVAL_MS = 3000;
const LOG_TAIL_BYTES = 4096;

/** Candidate opencode log directories (in priority order). */
function getLogDirCandidates() {
  const home = os.homedir();
  return [
    path.join(home, ".opencode", "logs"),
    path.join(home, ".local", "share", "opencode", "logs"),
    process.env.OPENCODE_LOG_DIR || "",
  ].filter(Boolean);
}

function findLatestLogFile(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(".log") || f.endsWith(".jsonl"))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? path.join(dir, files[0].name) : null;
  } catch { return null; }
}

function extractProjectFromLogLine(line) {
  // OpenCode log lines often contain cwd or project info
  try {
    const obj = JSON.parse(line);
    if (obj.cwd) return path.basename(obj.cwd);
    if (obj.project) return obj.project;
    if (obj.workspace) return path.basename(obj.workspace);
  } catch {
    // Plain text log: look for a path-like segment
    const match = line.match(/(?:cwd|project|workspace)[=:]\s*["']?([^\s"']+)/i);
    if (match) return path.basename(match[1]);
  }
  return null;
}

class OpencodeFocusAdapter extends EventEmitter {
  constructor() {
    super();
    this._pollTimer = null;
    this._active = false;
    this._lastProject = null;
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
      const logFile = findLatestLogFile(dir);
      if (!logFile) continue;
      try {
        const stat = fs.statSync(logFile);
        // Only consider log files modified in the last 5 minutes (active session)
        if (Date.now() - stat.mtime.getTime() > 5 * 60 * 1000) continue;

        // Read the last LOG_TAIL_BYTES of the file
        const fd = fs.openSync(logFile, "r");
        const size = stat.size;
        const offset = Math.max(0, size - LOG_TAIL_BYTES);
        const buf = Buffer.alloc(Math.min(LOG_TAIL_BYTES, size));
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);

        const lines = buf.toString("utf8").split("\n").filter(Boolean);
        let project = null;
        // Scan lines from newest to oldest
        for (let i = lines.length - 1; i >= 0; i--) {
          project = extractProjectFromLogLine(lines[i]);
          if (project) break;
        }

        const now = Date.now();
        const eventProject = project || "opencode-session";
        if (eventProject === this._lastProject && now - this._lastEmitAt < POLL_INTERVAL_MS * 2) {
          return; // no change
        }
        this._lastProject = eventProject;
        this._lastEmitAt = now;

        /** @type {import("../src/hook-source-interface").NormalizedEvent} */
        const event = {
          app: "opencode",
          title: `OpenCode · ${eventProject}`,
          project: eventProject,
          timestamp: now,
          source: "opencode-adapter",
        };
        this.emit("focus", event);
        return; // found an active session, stop searching dirs
      } catch { /* skip this dir */ }
    }
  }
}

// Singleton
const adapter = new OpencodeFocusAdapter();
module.exports = adapter;
