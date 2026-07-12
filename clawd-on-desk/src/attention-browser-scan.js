"use strict";

/**
 * @file attention-browser-scan.js
 *
 * Pure, side-effect-free browser-discovery and "same task across windows"
 * heuristics for the Attention Companion v2 (plan §3.1 — Multi-browser blind
 * spot).
 *
 * Goal: installing the tab-tracking extension (extensions/focus-bridge-*)
 * in only one browser degrades the other browser to window-title-only signal
 * (still functional — falls back to AMBIGUOUS, costs one vision call — but
 * weaker). Onboarding should scan installed browsers the same way it already
 * scans for installed coding agents, and prompt extension install PER BROWSER,
 * not once.
 *
 * This module is deliberately free of Electron, the network, and the
 * filesystem so it is unit-testable in isolation. The OS probe that produces
 * the discovered app ids is injected by the caller (onboarding / a detector),
 * exactly like agent-installation-detector injects `homeDir`.
 *
 * The "two windows plausibly part of the same task" rule (e.g. a video in
 * Chrome + notes in Firefox) is a pure heuristic that mirrors the policy's
 * createCluster: co-occurring apps are treated as one task. A task state
 * manager rule, NOT a hook rule.
 */

// ── Known browser catalogue ──────────────────────────────────────────────────
//
// Each entry lists the canonical `id` plus the executable / display names that
// an OS probe might report for it. Matching is case-insensitive and tolerant of
// spaces / dashes so a probe returning "Google Chrome" or "google-chrome"
// resolves to the same id.

const KNOWN_BROWSERS = [
  {
    id: "chrome",
    names: ["chrome", "google-chrome", "googlechrome", "google chrome", "chrome.exe"],
  },
  {
    id: "edge",
    names: ["edge", "msedge", "microsoft edge", "microsoft-edge", "msedge.exe", "microsoftedge"],
  },
  {
    id: "firefox",
    names: ["firefox", "firefoxdeveloperedition", "firefox developer edition", "firefox.exe"],
  },
  {
    id: "brave",
    names: ["brave", "brave-browser", "brave browser", "brave.exe"],
  },
  {
    id: "opera",
    names: ["opera", "opera stable", "opera-stable", "opera.exe"],
  },
  {
    id: "arc",
    names: ["arc", "arc browser"],
  },
  {
    id: "vivaldi",
    names: ["vivaldi", "vivaldi-stable", "vivaldi stable", "vivaldi.exe"],
  },
  {
    id: "chromium",
    names: ["chromium", "chromium-browser", "chromium.exe"],
  },
  {
    id: "safari",
    names: ["safari", "safari.exe"],
  },
  {
    id: "tor",
    names: ["tor browser", "torbrowser", "tor-browser"],
  },
];

// ── Same-task heuristics ──────────────────────────────────────────────────────
//
// Minimal, deterministic categorization. A media/video window alongside a
// notes/doc window is treated as plausibly the same task so that focus moving
// between them does not read as "switched away".

const VIDEO_TITLE_HINTS = [
  "youtube", "netflix", "twitch", "[playback:", "bilibili", "vimeo",
];

const VIDEO_URL_HINTS = [
  "youtube.com", "netflix.com", "bilibili.com", "vimeo.com", "twitch.tv",
];

const NOTES_APP_IDS = new Set([
  "notes", "notion", "obsidian", "onenote", "evernote", "apple-notes",
  "bear", "typora", "simplenote", "google-docs", "docs", "word",
  "mattermost", "notion.exe", "obsidian.exe",
]);

const NOTES_TITLE_HINTS = [
  "notes", "notion", "obsidian", "onenote", "google docs", "docs.google",
  "markdown", "writing", "todo", "journal",
];

function _norm(value) {
  return (value || "").toString().toLowerCase().trim();
}

function _isVideoLike(event) {
  if (!event) return false;
  // Reuse the policy's media categorization when the app id matches a known
  // media app (spotify, video-streaming, youtube, netflix, ...).
  try {
    const { isMediaApp } = require("./attention-policy");
    if (isMediaApp(event.app)) return true;
  } catch {}
  const title = _norm(event.title);
  if (VIDEO_TITLE_HINTS.some((h) => title.includes(h))) return true;
  const url = _norm(event.url);
  if (VIDEO_URL_HINTS.some((h) => url.includes(h))) return true;
  return false;
}

function _isNotesLike(event) {
  if (!event) return false;
  if (NOTES_APP_IDS.has(_norm(event.app))) return true;
  const hay = `${_norm(event.title)} ${_norm(event.url)}`;
  return NOTES_TITLE_HINTS.some((h) => hay.includes(h));
}

// ── BrowserScan ───────────────────────────────────────────────────────────────

class BrowserScan {
  /**
   * @param {Array<{id:string, names?:string[]}>} [knownBrowsers]
   */
  constructor(knownBrowsers = KNOWN_BROWSERS) {
    this.knownBrowsers = knownBrowsers;
  }

  /**
   * From a list of discovered app ids (produced by an injected OS probe),
   * return the subset of KNOWN_BROWSERS that are present.
   *
   * @param {string[]} detectedAppIds
   * @returns {Array<{id:string, names:string[]}>} matching browser entries
   */
  detectInstalled(detectedAppIds) {
    const detected = Array.isArray(detectedAppIds)
      ? detectedAppIds.map(_norm).filter(Boolean)
      : [];
    const present = [];
    const seen = new Set();
    for (const browser of this.knownBrowsers) {
      if (seen.has(browser.id)) continue;
      const names = (browser.names && browser.names.length
        ? browser.names
        : [browser.id]).map(_norm);
      const matched = detected.some((d) => {
        if (d === _norm(browser.id)) return true;
        return names.some((n) => n === d || n.includes(d) || d.includes(n));
      });
      if (matched) {
        seen.add(browser.id);
        present.push({ id: browser.id, names: browser.names || [browser.id] });
      }
    }
    return present;
  }

  /**
   * Build a per-browser extension-install plan so onboarding can PROMPT PER
   * BROWSER instead of once. Every installed browser gets an entry; the
   * `needsInstall` flag is true unless the browser is already known to have
   * the extension installed (passed via `alreadyInstalled`).
   *
   * @param {Array<string|{id:string}>} installedBrowsers - output of detectInstalled (ids or entries)
   * @param {string[]} [alreadyInstalled] - browser ids already carrying the extension
   * @returns {Array<{browser:string, needsInstall:boolean}>}
   */
  buildInstallPlan(installedBrowsers = [], alreadyInstalled = []) {
    const done = new Set(alreadyInstalled.map(_norm));
    const list = Array.isArray(installedBrowsers) ? installedBrowsers : [];
    return list.map((entry) => {
      const id = typeof entry === "string" ? entry : (entry && entry.id);
      return { browser: id, needsInstall: !done.has(_norm(id)) };
    });
  }

  /**
   * Decide whether two focus events plausibly belong to the same task. Used so
   * that moving focus between, say, a video in one browser and notes in another
   * does NOT read as "switched away". Pure heuristic; returns a reason string
   * or null.
   *
   * @param {{app?:string, title?:string, url?:string}} winA
   * @param {{app?:string, title?:string, url?:string}} winB
   * @param {object} [opts] - reserved for future weighting
   * @returns {string|null}
   */
  areSameTaskWindows(winA, winB, opts) {
    const aVideo = _isVideoLike(winA);
    const bVideo = _isVideoLike(winB);
    const aNotes = _isNotesLike(winA);
    const bNotes = _isNotesLike(winB);
    if ((aVideo && bNotes) || (bVideo && aNotes)) {
      return "video and notes/doc windows plausibly belong to the same task";
    }
    return null;
  }
}

module.exports = {
  KNOWN_BROWSERS,
  BrowserScan,
  _norm,
  _isVideoLike,
  _isNotesLike,
};
