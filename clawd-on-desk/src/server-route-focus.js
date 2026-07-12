"use strict";

/**
 * @file server-route-focus.js
 *
 * Handler for POST /focus — receives NormalizedEvent objects from:
 *   - focus-hook-os.js  (OS-native window focus changes)
 *   - Browser extension (tab activated / updated)
 *   - AI tool adapters  (opencode, kilocode)
 *
 * Validates, deduplicates (50ms window), and calls ctx.onFocusEvent().
 */

const MAX_FOCUS_BODY_BYTES = 4 * 1024;
const DEDUP_WINDOW_MS = 50;

const { validateNormalizedEvent } = require("./hook-source-interface");

// Module-level dedup state (one per server lifetime)
let lastFocusEvent = null;
let lastFocusAt = 0;

/**
 * Reset dedup state (for tests).
 */
function _resetDedup() {
  lastFocusEvent = null;
  lastFocusAt = 0;
}

/**
 * Returns true if the incoming event is a duplicate of the last one
 * within the dedup window.
 *
 * @param {import("./hook-source-interface").NormalizedEvent} event
 * @param {number} now
 * @returns {boolean}
 */
function isDuplicate(event, now) {
  if (!lastFocusEvent) return false;
  if (now - lastFocusAt > DEDUP_WINDOW_MS) return false;
  return lastFocusEvent.app === event.app
    && lastFocusEvent.title === event.title
    && lastFocusEvent.url === event.url;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse}  res
 * @param {{ ctx: object, nowFn?: () => number }} options
 */
function handleFocusPost(req, res, options) {
  const { ctx, nowFn = Date.now } = options;
  let body = "";
  let bodySize = 0;
  let tooLarge = false;

  req.on("data", (chunk) => {
    if (tooLarge) return;
    bodySize += chunk.length;
    if (bodySize > MAX_FOCUS_BODY_BYTES) { tooLarge = true; return; }
    body += chunk;
  });

  req.on("end", () => {
    if (tooLarge) {
      res.writeHead(413);
      res.end("focus payload too large");
      return;
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }

    const event = validateNormalizedEvent(data);
    if (!event) {
      res.writeHead(400);
      res.end("missing required fields: app, title");
      return;
    }

    const now = nowFn();
    if (isDuplicate(event, now)) {
      res.writeHead(204);
      res.end();
      return;
    }

    lastFocusEvent = event;
    lastFocusAt = now;

    if (typeof ctx.onFocusEvent === "function") {
      try { ctx.onFocusEvent(event); } catch (err) {
        console.warn("[attention] onFocusEvent error:", err && err.message);
      }
    }

    res.writeHead(200);
    res.end("ok");
  });
}

module.exports = { handleFocusPost, _resetDedup, MAX_FOCUS_BODY_BYTES, DEDUP_WINDOW_MS };
