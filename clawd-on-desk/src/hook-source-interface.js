"use strict";

/**
 * @file hook-source-interface.js
 *
 * JSDoc contract for the HookSource / NormalizedEvent interfaces used by
 * the Attention Companion subsystem. Existing coding-agent adapters
 * (Cursor, Claude Code, Codex, etc.) post directly to POST /state and do
 * not need to implement this interface — they pre-date it and their
 * behaviour is unchanged.
 *
 * New adapters (OS focus, browser tab bridge, AI tool adapters) must
 * satisfy this contract so they can feed the AttentionEventBus.
 */

/**
 * @typedef {Object} NormalizedEvent
 * @property {string}  app        - Application name, lower-case, e.g. "chrome", "vscode", "cursor"
 * @property {string}  title      - Best available text signal (window/tab title)
 * @property {string}  [url]      - Present for browser tab events
 * @property {string}  [project]  - Present for editor/agent events (repo/workspace name)
 * @property {number}  timestamp  - Unix ms timestamp
 * @property {string}  [source]   - Hook source identifier, e.g. "os-focus", "browser-chrome"
 * @property {boolean} [videoPlaying] - True when a <video> is actually playing (extension signal)
 * @property {object}  [mediaSession] - navigator.mediaSession metadata + playbackState
 * @property {string}  [domHint]  - Compact JSON hint (h1 + media title) for the a11y layer
 * @property {string}  [domSnippet] - Short visible-text sample of the page (text-only signal)
 */

/**
 * @typedef {Object} HookSource
 * @property {string}   name        - Human-readable adapter name
 * @property {string[]} eventTypes  - List of event type strings this source can emit
 * @property {Function} parse       - (raw: unknown) => NormalizedEvent — must be pure, never throw
 */

/**
 * Validates that an object satisfies the NormalizedEvent shape.
 * Returns a sanitized copy or null if invalid.
 *
 * @param {unknown} raw
 * @returns {NormalizedEvent|null}
 */
function validateNormalizedEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const app = typeof raw.app === "string" && raw.app.trim() ? raw.app.trim().toLowerCase() : null;
  const title = typeof raw.title === "string" ? raw.title.slice(0, 512) : null;
  const timestamp = Number.isFinite(raw.timestamp) && raw.timestamp > 0 ? raw.timestamp : Date.now();
  if (!app || title === null) return null;
  const event = { app, title, timestamp };
  if (typeof raw.url === "string" && raw.url) event.url = raw.url.slice(0, 2048);
  if (typeof raw.project === "string" && raw.project) event.project = raw.project.slice(0, 256);
  if (typeof raw.source === "string" && raw.source) event.source = raw.source;
  if (typeof raw.domHint === "string" && raw.domHint) event.domHint = raw.domHint.slice(0, 1024);
  if (typeof raw.domSnippet === "string" && raw.domSnippet) event.domSnippet = raw.domSnippet.slice(0, 256);
  if (typeof raw.videoPlaying === "boolean") event.videoPlaying = raw.videoPlaying;
  if (raw.mediaSession && typeof raw.mediaSession === "object") {
    const ms = {};
    if (typeof raw.mediaSession.title === "string") ms.title = raw.mediaSession.title.slice(0, 160);
    if (typeof raw.mediaSession.artist === "string") ms.artist = raw.mediaSession.artist.slice(0, 160);
    if (typeof raw.mediaSession.playbackState === "string") ms.playbackState = raw.mediaSession.playbackState.slice(0, 32);
    if (Object.keys(ms).length) event.mediaSession = ms;
  }
  return event;
}

module.exports = { validateNormalizedEvent };
