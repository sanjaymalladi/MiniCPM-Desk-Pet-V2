/**
 * MiniCPM Focus Bridge — Chrome MV3 Service Worker
 *
 * Listens for tab activation and URL changes, then POSTs NormalizedEvent
 * objects to the Electron app's POST /focus endpoint at 127.0.0.1:<port>.
 *
 * Port is read from chrome.storage.local["clawd_hook_port"]. The Electron
 * app writes this value on startup (same runtime port used by coding-agent
 * hooks). Default fallback: 23333.
 */

const DEFAULT_PORT = 23333;
const POST_TIMEOUT_MS = 1500;

let _port = DEFAULT_PORT;
let _lastEventKey = "";
let _lastEventAt = 0;
const DEDUP_MS = 100;

// ── Port management ──────────────────────────────────────────────────────────

async function loadPort() {
  try {
    const result = await chrome.storage.local.get(["clawd_hook_port"]);
    if (result.clawd_hook_port && Number.isFinite(Number(result.clawd_hook_port))) {
      _port = Number(result.clawd_hook_port);
    }
  } catch { /* use default */ }
}

// Reload port whenever it changes (Electron app restarts / port changes)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.clawd_hook_port && changes.clawd_hook_port.newValue) {
    _port = Number(changes.clawd_hook_port.newValue) || DEFAULT_PORT;
  }
});

// ── Event posting ────────────────────────────────────────────────────────────

function classifyUrl(url) {
  if (!url) return "browser";
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, "");
    if (h.includes("youtube") || h.includes("twitch")) return "video-streaming";
    if (h.includes("github") || h.includes("gitlab") || h.includes("bitbucket")) return "code-hosting";
    if (h.includes("stackoverflow") || h.includes("docs.") || h.includes("developer.")) return "docs";
    if (h.includes("google") || h.includes("bing") || h.includes("duckduckgo")) return "search";
    if (h.includes("slack") || h.includes("discord") || h.includes("teams.microsoft")) return "chat";
    if (h.includes("twitter") || h.includes("x.com") || h.includes("reddit") || h.includes("facebook") || h.includes("instagram")) return "social";
    return "browser";
  } catch { return "browser"; }
}

// Injected into the page: report whether a video is *actually playing* (not
// just present). We ignore paused/ended videos and muted autoplay previews
// (YouTube home/channel thumbnail loops), so the pet only treats you as
// "watching a video" while a real, unmuted video is running — never on the
// bare YouTube page (home, search, channel).
function detectPlayback() {
  const v = document.querySelector("video");
  if (!v) return { playing: false };
  const playing = !v.paused && !v.ended && v.currentTime > 0 && !v.muted;
  const dur = document.querySelector(".ytp-time-duration")?.innerText || "";
  const cur = document.querySelector(".ytp-time-current")?.innerText || "";
  return { playing, duration: dur, current: cur };
}

// Lightweight DOM hint for the accessibility/DOM signal layer: the page's
// first heading + any media-session metadata + a short visible-text sample,
// so a text-only ambiguous event can be resolved without a screenshot
// (plan §2 step 2). `text` is truncated hard so the POST stays small.
function collectDomHint() {
  try {
    const h1 = document.querySelector("h1")?.innerText?.trim().slice(0, 160) || "";
    // navigator.mediaSession is only populated in the page context (this
    // function runs via chrome.scripting.executeScript), never in the
    // background service worker — so read it here, not in sendFocusEvent.
    const ms = navigator.mediaSession && navigator.mediaSession.metadata;
    const mediaTitle = ms && ms.title ? String(ms.title).slice(0, 160) : "";
    const mediaArtist = ms && ms.artist ? String(ms.artist).slice(0, 160) : "";
    const media = [mediaTitle, mediaArtist].filter(Boolean).join(" ").trim();
    const playbackState = navigator.mediaSession && navigator.mediaSession.playbackState
      ? navigator.mediaSession.playbackState
      : "";
    const mediaSession = (mediaTitle || mediaArtist || playbackState)
      ? { playbackState, title: mediaTitle, artist: mediaArtist }
      : null;
    let text = "";
    try {
      const body = document.body && document.body.innerText;
      if (body) text = body.replace(/\s+/g, " ").trim().slice(0, 200);
    } catch {}
    return { h1, media, mediaSession, text };
  } catch {
    return {};
  }
}

async function sendFocusEvent(tab) {
  if (!tab || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("about:")) return;

  const appType = classifyUrl(tab.url);
  let finalApp = appType;
  let finalTitle = tab.title || tab.url;
  let liveContext = "";
  let domHint = "";
  let domSnippet = "";
  let videoPlaying = null;
  let mediaSession = null;

  if (appType === "video-streaming") {
    const isWatchPage = tab.url.includes("youtube.com/watch") || tab.url.includes("twitch.tv");
    if (!isWatchPage) {
      // Browsing YouTube/Twitch but not on a watch page — not "watching".
      finalApp = "browser";
    } else {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: detectPlayback
        });
        const data = results?.[0]?.result;
        if (data && data.playing) {
          liveContext = ` [Playback: ${data.current || "0:00"} / ${data.duration || ""}]`;
          finalTitle = `${finalTitle}${liveContext}`;
          videoPlaying = true;
        } else {
          // A watch URL is open but nothing is actually playing.
          finalApp = "browser";
          videoPlaying = false;
        }
      } catch {
        finalApp = "browser";
      }
    }
  }

  // Collect a DOM hint for every page to enrich ambiguity resolution.
  try {
    const hints = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectDomHint
    });
    const h = hints?.[0]?.result;
    if (h) {
      if (h.h1 || h.media) domHint = JSON.stringify({ h1: h.h1 || "", media: h.media || "" });
      if (h.text) domSnippet = h.text;
      // mediaSession was captured in the page context by collectDomHint() —
      // do not re-read navigator.mediaSession here (it is empty in the SW).
      if (h.mediaSession) {
        mediaSession = {
          playbackState: h.mediaSession.playbackState || "",
          title: (h.mediaSession.title || "").toString().slice(0, 160),
          artist: (h.mediaSession.artist || "").toString().slice(0, 160),
        };
      }
    }
  } catch { /* ignore */ }

  const eventKey = `${tab.url}||${finalTitle}${liveContext}`;
  const now = Date.now();
  if (eventKey === _lastEventKey && now - _lastEventAt < DEDUP_MS) return;
  _lastEventKey = eventKey;
  _lastEventAt = now;

  const event = {
    app: finalApp,
    title: finalTitle,
    url: tab.url,
    timestamp: now,
    source: "browser-chrome",
  };
  if (domHint) event.domHint = domHint;
  if (domSnippet) event.domSnippet = domSnippet;
  if (videoPlaying === true || videoPlaying === false) event.videoPlaying = videoPlaying;
  if (mediaSession) event.mediaSession = mediaSession;

  const body = JSON.stringify(event);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    await fetch(`http://127.0.0.1:${_port}/focus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch { /* fire-and-forget, never fail */ }
}

// ── Tab event listeners ──────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    await sendFocusEvent(tab);
  } catch { /* tab may have been closed */ }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    if (!tab.active) return;
    await sendFocusEvent(tab);
  }
});

// Live Polling for active tab (captures video playback progress without tab switches)
setInterval(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await sendFocusEvent(tab);
  } catch {}
}, 5000);

// Load port on startup
loadPort();
