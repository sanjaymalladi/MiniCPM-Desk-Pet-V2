"use strict";

// ── Video transcript summarizer (plan §6) ──
//
// Nearly free given what's already built: the browser hook detects a <video>
// element (no vision); Agent Reach / youtube-transcript-api fetches the
// transcript; MiniCPM5-1B summarizes. Transcript is fetched on start but NOT
// summarized until the `ended` event, so closing early wastes nothing. Stored
// to the personal container, surfaced only if the video looks work-related
// (task clustering) — unwind content is just kept ready if asked.

const { CONTAINER_TAGS } = require("./memory-constants");

class VideoTranscript {
  constructor(options = {}) {
    this.reach = options.reach;
    this.summarize = typeof options.summarize === "function"
      ? options.summarize
      : async (t) => (typeof t === "string" ? t.slice(0, 200) : "");
    this.store = typeof options.store === "function" ? options.store : async () => ({});
    this.isWorkRelated = typeof options.isWorkRelated === "function" ? options.isWorkRelated : () => true;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.logger = options.logger || (() => {});
    this._pending = null;
    this._videoId = null;
  }

  // Video started: fetch the transcript once and hold it. Fail silently if no
  // transcript is available (plan §6.4) — never block/delay the hook.
  async onVideoStart(videoIdOrUrl) {
    this._pending = null;
    this._videoId = null;
    if (!this.reach || typeof this.reach.youtubeTranscript !== "function") return false;
    try {
      const text = await this.reach.youtubeTranscript(videoIdOrUrl);
      if (text) {
        this._pending = text;
        this._videoId = videoIdOrUrl;
        return true;
      }
    } catch (err) {
      this.logger(`transcript fetch failed (silent): ${err && err.message}`);
    }
    return false;
  }

  // Video closed before finishing: drop the held transcript, store nothing.
  onCloseEarly() {
    this._pending = null;
    this._videoId = null;
  }

  // Video ended: summarize + maybe store. Returns a report.
  async onVideoEnd() {
    if (!this._pending) return { stored: false, reason: "no-transcript" };
    const transcript = this._pending;
    const videoId = this._videoId;
    const summary = await this.summarize(transcript);
    const work = this.isWorkRelated(videoId, summary);
    this._pending = null;
    this._videoId = null;
    if (!work) {
      return { stored: false, reason: "not-work-related", summary };
    }
    const res = await this.store({
      content: summary,
      category: CONTAINER_TAGS.PERSONAL,
      metadata: { tier: "video", videoId, endedAt: this.now() },
    });
    return { stored: true, summary, res };
  }

  // External read-path (plan §4 phase 10): a Claude Code / OpenCode plugin or
  // hook pushes a transcript it already has (e.g. a referenced screen recording
  // or meeting capture) straight into the same summarize → work-filter → store
  // pipeline. Skips the YouTube fetch. Fails silently if the transcript is
  // empty or not work-related.
  async ingestExternal({ url, title, transcript } = {}) {
    const text = typeof transcript === "string" ? transcript.trim() : "";
    if (!text) return { stored: false, reason: "empty" };
    const summary = await this.summarize(text);
    const work = this.isWorkRelated(url || title || "", summary);
    if (!work) return { stored: false, reason: "not-work-related", summary };
    const res = await this.store({
      content: summary,
      category: CONTAINER_TAGS.PERSONAL,
      metadata: {
        tier: "video",
        videoId: url || title || "",
        source: "agent-plugin",
        ingestedAt: this.now(),
      },
    });
    return { stored: true, summary, res };
  }

  // The transcript currently held in memory (fetched on video start, not yet
  // summarized). Lets the chat's `get_transcript` tool read what's playing now.
  getPendingTranscript() {
    return this._pending ? String(this._pending) : null;
  }
}

module.exports = { VideoTranscript };
