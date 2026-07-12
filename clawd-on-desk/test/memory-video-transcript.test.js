"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { VideoTranscript } = require("../src/memory-video-transcript");

// Fake reach that returns a transcript for a known id, fails for others.
function fakeReach(ok = true) {
  return {
    youtubeTranscript: async (id) => {
      if (!ok) throw new Error("no transcript");
      return "this is the full transcript text";
    },
  };
}

describe("VideoTranscript", () => {
  it("holds the transcript on start, summarizes + stores on end", async () => {
    const stored = [];
    const v = new VideoTranscript({
      reach: fakeReach(true),
      summarize: async (t) => `summary: ${t.slice(0, 10)}`,
      store: async (o) => { stored.push(o); return { ok: true }; },
      isWorkRelated: () => true,
      now: () => 1_000_000,
    });
    await v.onVideoStart("dQw4w9WgXcQ");
    const r = await v.onVideoEnd();
    assert.strictEqual(r.stored, true);
    assert.ok(r.summary.startsWith("summary:"));
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].metadata.tier, "video");
  });

  it("fails silently when no transcript is available", async () => {
    const stored = [];
    const v = new VideoTranscript({
      reach: fakeReach(false),
      store: async (o) => { stored.push(o); return {}; },
    });
    const started = await v.onVideoStart("bad");
    assert.strictEqual(started, false);
    const r = await v.onVideoEnd();
    assert.strictEqual(r.stored, false);
    assert.strictEqual(r.reason, "no-transcript");
    assert.strictEqual(stored.length, 0);
  });

  it("does not surface unwind content (only stores work-related)", async () => {
    const stored = [];
    const v = new VideoTranscript({
      reach: fakeReach(true),
      summarize: async (t) => "fun video summary",
      store: async (o) => { stored.push(o); return {}; },
      isWorkRelated: () => false,
    });
    await v.onVideoStart("dQw4w9WgXcQ");
    const r = await v.onVideoEnd();
    assert.strictEqual(r.stored, false);
    assert.strictEqual(r.reason, "not-work-related");
    assert.strictEqual(stored.length, 0);
  });

  it("discards the held transcript if the video closes early", async () => {
    const stored = [];
    const v = new VideoTranscript({
      reach: fakeReach(true),
      store: async (o) => { stored.push(o); return {}; },
    });
    await v.onVideoStart("dQw4w9WgXcQ");
    v.onCloseEarly();
    const r = await v.onVideoEnd();
    assert.strictEqual(r.stored, false);
    assert.strictEqual(r.reason, "no-transcript");
  });

  it("ingestExternal stores a plugin-supplied transcript (plan §4 phase 10)", async () => {
    const stored = [];
    const v = new VideoTranscript({
      summarize: async (t) => `summary: ${t.slice(0, 8)}`,
      store: async (o) => { stored.push(o); return { ok: true }; },
      isWorkRelated: () => true,
      now: () => 1_000_000,
    });
    const r = await v.ingestExternal({
      url: "https://example.com/rec.mp4",
      title: "Sprint demo",
      transcript: "the agent built a new feature and shipped it",
    });
    assert.strictEqual(r.stored, true);
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].metadata.source, "agent-plugin");
    assert.strictEqual(stored[0].metadata.videoId, "https://example.com/rec.mp4");
  });

  it("ingestExternal rejects empty or non-work-related transcripts", async () => {
    const stored = [];
    const v = new VideoTranscript({
      store: async (o) => { stored.push(o); return {}; },
      isWorkRelated: () => false,
    });
    const empty = await v.ingestExternal({ transcript: "   " });
    assert.strictEqual(empty.stored, false);
    assert.strictEqual(empty.reason, "empty");
    const notWork = await v.ingestExternal({ transcript: "just for fun", url: "x" });
    assert.strictEqual(notWork.stored, false);
    assert.strictEqual(notWork.reason, "not-work-related");
    assert.strictEqual(stored.length, 0);
  });
});
