/**
 * MiniCPM Focus Bridge — Firefox MV2 Background Page
 *
 * Same logic as Chrome MV3 version, adapted for Firefox WebExtensions API
 * (MV2 background page, browser.* namespace).
 */

const DEFAULT_PORT = 23333;
const POST_TIMEOUT_MS = 1500;
const DEDUP_MS = 100;

// Injected (as code strings — Firefox MV2 has no scripting API) to detect
// whether a video is *actually playing* and to grab a DOM hint. We ignore
// paused/ended and muted autoplay previews so the pet only counts you as
// "watching" during real, unmuted playback — never on the bare YouTube page.
const DETECT_PLAYBACK_CODE = `(function(){
  var v = document.querySelector('video');
  if(!v) return {playing:false};
  return {
    playing: !v.paused && !v.ended && v.currentTime>0 && !v.muted,
    duration: (document.querySelector('.ytp-time-duration')||{}).innerText||'',
    current: (document.querySelector('.ytp-time-current')||{}).innerText||''
  };
})()`;

const COLLECT_DOMHINT_CODE = `(function(){
  try {
    var h1 = (document.querySelector('h1')||{}).innerText;
    h1 = h1 ? h1.trim().slice(0,160) : '';
    var ms = navigator.mediaSession && navigator.mediaSession.metadata;
    var mediaTitle = (ms && ms.title) ? String(ms.title).slice(0,160) : '';
    var mediaArtist = (ms && ms.artist) ? String(ms.artist).slice(0,160) : '';
    var media = [mediaTitle, mediaArtist].filter(Boolean).join(' ').trim();
    var playbackState = (navigator.mediaSession && navigator.mediaSession.playbackState) ? navigator.mediaSession.playbackState : '';
    // navigator.mediaSession is only valid in the page context (this code runs
    // via tabs.executeScript), never in the background page — so capture it here.
    var mediaSession = (mediaTitle || mediaArtist || playbackState) ? {playbackState: playbackState, title: mediaTitle, artist: mediaArtist} : null;
    var text = '';
    try {
      var body = document.body && document.body.innerText;
      if (body) text = body.replace(/\\s+/g,' ').trim().slice(0,200);
    } catch(e) {}
    return { h1: h1, media: media, mediaSession: mediaSession, text: text };
  } catch(e) { return {}; }
})()`;

let _port = DEFAULT_PORT;
let _lastEventKey = "";
let _lastEventAt = 0;

// Use browser.* (Firefox standard) with chrome.* fallback
const ext = typeof browser !== "undefined" ? browser : chrome;

async function loadPort() {
  try {
    const result = await ext.storage.local.get(["clawd_hook_port"]);
    if (result.clawd_hook_port) _port = Number(result.clawd_hook_port) || DEFAULT_PORT;
  } catch { /* use default */ }
}

ext.storage.onChanged.addListener((changes) => {
  if (changes.clawd_hook_port && changes.clawd_hook_port.newValue) {
    _port = Number(changes.clawd_hook_port.newValue) || DEFAULT_PORT;
  }
});

function classifyUrl(url) {
  if (!url) return "browser";
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    if (h.includes("youtube") || h.includes("twitch")) return "video-streaming";
    if (h.includes("github") || h.includes("gitlab")) return "code-hosting";
    if (h.includes("stackoverflow") || h.includes("docs.") || h.includes("developer.")) return "docs";
    if (h.includes("google") || h.includes("bing")) return "search";
    if (h.includes("slack") || h.includes("discord")) return "chat";
    if (h.includes("twitter") || h.includes("x.com") || h.includes("reddit") || h.includes("facebook") || h.includes("instagram")) return "social";
    return "browser";
  } catch { return "browser"; }
}

async function sendFocusEvent(tab) {
  if (!tab || !tab.url || tab.url.startsWith("about:") || tab.url.startsWith("moz-extension:")) return;

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
      finalApp = "browser";
    } else {
      try {
        const r = await ext.tabs.executeScript(tab.id, { code: DETECT_PLAYBACK_CODE });
        const data = r && r[0] && r[0].result;
        if (data && data.playing) {
          liveContext = ` [Playback: ${data.current || "0:00"} / ${data.duration || ""}]`;
          finalTitle = `${finalTitle}${liveContext}`;
          videoPlaying = true;
        } else {
          finalApp = "browser";
          videoPlaying = false;
        }
      } catch { finalApp = "browser"; }
    }
  }

  try {
    const h = await ext.tabs.executeScript(tab.id, { code: COLLECT_DOMHINT_CODE });
    const res = h && h[0] && h[0].result;
    if (res) {
      if (res.h1 || res.media) domHint = JSON.stringify({ h1: res.h1 || "", media: res.media || "" });
      if (res.text) domSnippet = res.text;
      // mediaSession was captured in the page context by COLLECT_DOMHINT_CODE —
      // do not re-read navigator.mediaSession here (it is empty in the background).
      if (res.mediaSession) {
        mediaSession = {
          playbackState: res.mediaSession.playbackState || "",
          title: (res.mediaSession.title || "").toString().slice(0, 160),
          artist: (res.mediaSession.artist || "").toString().slice(0, 160),
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
    source: "browser-firefox",
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
  } catch { /* fire-and-forget */ }
}

ext.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await ext.tabs.get(activeInfo.tabId);
    await sendFocusEvent(tab);
  } catch {}
});

ext.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.active) return;
  await sendFocusEvent(tab);
});

loadPort();
