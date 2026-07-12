"use strict";

/**
 * @file attention-policy.js
 *
 * Pure, side-effect-free policy layer for the Attention Companion v2.
 *
 * This is the "gates, filters and rules" tier that sits *in front of* the
 * MiniCPM5-1B classifier (and, eventually, the MiniCPM-V vision tool). It
 * answers cheap, deterministic questions from structured signal facts so
 * that most ambiguity is resolved before any model call:
 *
 *   - idle / AFK gate            (pause the whole pipeline when away)
 *   - privacy exclude-list      (never evaluate / capture sensitive windows)
 *   - meeting / call category   (a valid task state, not "distraction")
 *   - background-media rule      (unfocused media is not a competing signal)
 *   - focus-dwell debounce       (drop transient focus flicker)
 *   - app clustering             (moving between co-occurring apps is SAME_TASK)
 *
 * Nothing here touches Electron, the network, or the filesystem, so the whole
 * module is unit-testable in isolation.
 */

// ── Static categorization tables ─────────────────────────────────────────────

// Apps that represent an active meeting/call. Treated as their own valid task
// state, hard-excluded from distraction evaluation and (later) vision.
const MEETING_APP_IDS = new Set([
  "zoom", "zoomus", "meet", "googlemeet", "teams", "msteams", "skype",
  "webex", "facetime", "gotomeeting", "whereby", "jitsi", "bluejeans",
  "hangouts",
]);

// Title fragments that strongly imply a live call even for a generic app id.
const MEETING_TITLE_HINTS = [
  "zoom meeting", "google meet", "microsoft teams meeting", "skype call",
  "webex", "live caption", "is presenting", "started a call", "huddle",
];

// Apps whose mere presence implies media playback (not a "task" and, when
// unfocused, must not generate any signal at all).
const MEDIA_APP_IDS = new Set([
  "video-streaming", "audio-streaming", "spotify", "music", "youtube",
  "netflix", "twitch", "vlc", "musicbee", "apple-music", "plex",
]);

// Default privacy substrings. A window whose app/title/url contains any of
// these is suppressed from evaluation and capture.
const DEFAULT_PRIVACY_LIST = [
  // private browsing
  "incognito", "inprivate", "private browsing", "private window", "new private",
  // finance / banking
  "bank", "chase", "paypal", "venmo", "amex", "american express",
  "wellsfargo", "citibank", "schwab", "fidelity", "coinbase", "mint",
  // password managers / secrets
  "1password", "bitwarden", "lastpass", "dashlane", "keeper", "keychain",
  // health
  "medical", "patient portal",
];

// ── Pure predicates ──────────────────────────────────────────────────────────

function isMeetingApp(app, title) {
  const a = (app || "").toLowerCase();
  if (MEETING_APP_IDS.has(a)) return true;
  const t = (title || "").toLowerCase();
  return MEETING_TITLE_HINTS.some((h) => t.includes(h));
}

function isMediaApp(app) {
  return MEDIA_APP_IDS.has((app || "").toLowerCase());
}

/**
 * True when the event reports live media playback (Plan §3.4 / §2 step 2).
 * The browser extension sets `videoPlaying`, and `mediaSession.playbackState`
 * is "playing" for OS-level media. Distinguishes a genuinely-running video
 * from a paused/background tab, which must NOT generate a distraction signal.
 *
 * @param {{app?:string, videoPlaying?:boolean, mediaSession?:object}} event
 */
function isMediaPlaying(event) {
  if (event && event.videoPlaying === true) return true;
  const ms = event && event.mediaSession;
  if (ms && typeof ms.playbackState === "string" && ms.playbackState.toLowerCase() === "playing") {
    return true;
  }
  // A focused media app with no explicit "not playing" signal is treated as
  // playing (e.g. Spotify foreground) — the background-media rule only
  // suppresses UNFOCUSED media, and an unfocused window emits no event at all.
  return isMediaApp(event && event.app);
}

/**
 * Returns true if the event should be suppressed for privacy reasons.
 *
 * @param {{app?:string, title?:string, url?:string}} event
 * @param {string[]} list - lowercase substrings to match against
 */
function matchesPrivacy(event, list) {
  if (!list || !list.length) return false;
  const hay = [event.app, event.title, event.url]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return list.some((s) => hay.includes(String(s).toLowerCase()));
}

/**
 * Idle gate helper. `idleSeconds` comes from powerMonitor.getSystemIdleTime()
 * (Electron). Negative/unsupported values are treated as "not idle".
 *
 * @param {number} idleSeconds
 * @param {number} idleMs
 */
function isIdle(idleSeconds, idleMs) {
  if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return false;
  return idleSeconds * 1000 >= idleMs;
}

function splitList(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Stateful helpers ──────────────────────────────────────────────────────────

/**
 * Focus-dwell debouncer. On every focus change call `arm(event, onSettled)`.
 * `onSettled` fires only once focus has held for `dwellMs` without another
 * change. Transient flicker (notification popups, alt-tab under threshold) is
 * dropped because a newer event cancels the pending timer.
 */
function createDwellFilter(dwellMs) {
  let timer = null;
  let pending = null;
  return {
    arm(event, onSettled) {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = event;
      if (dwellMs <= 0) {
        pending = null;
        onSettled(event);
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        const e = pending;
        pending = null;
        if (e) onSettled(e);
      }, dwellMs);
    },
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = null;
    },
  };
}

/**
 * App cluster for the current task. As the user moves focus, record each app.
 * Moving back to an app already in the cluster is considered SAME_TASK (not a
 * switch). The cluster resets whenever a genuine task switch is confirmed.
 */
function createCluster() {
  let members = new Set();
  return {
    record(app) {
      if (app) members.add(app);
    },
    contains(app) {
      return members.has(app);
    },
    reset() {
      members = new Set();
    },
    size() {
      return members.size;
    },
  };
}

// ── Configured policy object ──────────────────────────────────────────────────

/**
 * Build a configured policy from the user's preferences.
 *
 * @param {object} [config]
 * @param {boolean} [config.enabled=true]
 * @param {boolean} [config.idleEnabled=true]
 * @param {number}  [config.idleMs=120000]
 * @param {number}  [config.dwellMs=4000]
 * @param {string|string[]} [config.privacyList]
 * @param {boolean} [config.visionEnabled=false]
 */
function buildAttentionPolicy(config = {}) {
  const enabled = config.enabled !== false;
  const idleEnabled = config.idleEnabled !== false;
  const idleMs = Number.isFinite(config.idleMs) ? config.idleMs : 120000;
  const dwellMs = Number.isFinite(config.dwellMs) ? config.dwellMs : 4000;
  const privacyList = splitList(
    config.privacyList === undefined || config.privacyList === null
      ? DEFAULT_PRIVACY_LIST
      : config.privacyList
  );
  const visionEnabled = !!config.visionEnabled;

  return {
    enabled,
    idleEnabled,
    idleMs,
    dwellMs,
    privacyList,
    visionEnabled,

    isEnabled: () => enabled,
    isIdle: (idleSeconds) => idleEnabled && isIdle(idleSeconds, idleMs),
    isMeeting: (app, title) => isMeetingApp(app, title),
    isMedia: (app) => isMediaApp(app),
    matchesPrivacy: (event) => matchesPrivacy(event, privacyList),
    createDwellFilter: () => createDwellFilter(dwellMs),
    createCluster: () => createCluster(),
  };
}

module.exports = {
  MEETING_APP_IDS,
  MEETING_TITLE_HINTS,
  MEDIA_APP_IDS,
  DEFAULT_PRIVACY_LIST,
  isMeetingApp,
  isMediaApp,
  isMediaPlaying,
  matchesPrivacy,
  isIdle,
  splitList,
  createDwellFilter,
  createCluster,
  buildAttentionPolicy,
};
