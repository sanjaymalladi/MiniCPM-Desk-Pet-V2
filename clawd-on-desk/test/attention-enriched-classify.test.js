"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  buildEnrichedClassificationMessages,
} = require("../src/attention-state-manager");

describe("buildEnrichedClassificationMessages", () => {
  const hypothesis = "writing a report";
  const event = { app: "chrome", title: "Netflix", url: "https://netflix.com" };
  const history = [];

  it("returns base messages when no enrichment is present", () => {
    const base = buildEnrichedClassificationMessages(hypothesis, event, history);
    const user = base.find((m) => m.role === "user");
    assert.ok(user, "has a user message");
    assert.ok(!/Additional text-only signals/.test(user.content));
  });

  it("appends domHint + mediaSession + videoPlaying + domSnippet signals", () => {
    const enriched = buildEnrichedClassificationMessages(hypothesis, {
      ...event,
      domHint: JSON.stringify({ h1: "Stranger Things", media: "Stranger Things — Netflix" }),
      mediaSession: { title: "Stranger Things", artist: "Netflix", playbackState: "playing" },
      videoPlaying: true,
      domSnippet: "Episode 4 of Stranger Things",
    }, history);
    const user = enriched.find((m) => m.role === "user");
    assert.ok(/Additional text-only signals/.test(user.content));
    assert.ok(/page heading: "Stranger Things"/.test(user.content));
    assert.ok(/media session metadata:/.test(user.content));
    assert.ok(/video actually playing: true/.test(user.content));
    assert.ok(/page text sample: "Episode 4/.test(user.content));
  });

  it("tolerates malformed domHint JSON without throwing", () => {
    const enriched = buildEnrichedClassificationMessages(hypothesis, {
      ...event,
      domHint: "not json",
      videoPlaying: false,
    }, history);
    const user = enriched.find((m) => m.role === "user");
    assert.ok(/video actually playing: false/.test(user.content));
  });
});
