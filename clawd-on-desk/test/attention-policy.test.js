"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  isMeetingApp,
  isMediaApp,
  isMediaPlaying,
  matchesPrivacy,
  isIdle,
  splitList,
  createDwellFilter,
  createCluster,
  buildAttentionPolicy,
  DEFAULT_PRIVACY_LIST,
} = require("../src/attention-policy");

describe("attention-policy predicates", () => {
  it("detects meeting apps by id and title hint", () => {
    assert.strictEqual(isMeetingApp("zoom", ""), true);
    assert.strictEqual(isMeetingApp("googlemeet", ""), true);
    assert.strictEqual(isMeetingApp("code", ""), false);
    assert.strictEqual(isMeetingApp("chrome", "John's Zoom Meeting"), true);
    assert.strictEqual(isMeetingApp("chrome", "Quarterly sync"), false);
  });

  it("detects media apps", () => {
    assert.strictEqual(isMediaApp("video-streaming"), true);
    assert.strictEqual(isMediaApp("spotify"), true);
    assert.strictEqual(isMediaApp("code"), false);
  });

  it("detects media playing from enrichment signal", () => {
    assert.strictEqual(isMediaPlaying({ app: "chrome", videoPlaying: true }), true);
    assert.strictEqual(isMediaPlaying({ app: "chrome", mediaSession: { playbackState: "playing" } }), true);
    assert.strictEqual(isMediaPlaying({ app: "chrome", mediaSession: { playbackState: "paused" } }), false);
    assert.strictEqual(isMediaPlaying({ app: "spotify" }), true);
    assert.strictEqual(isMediaPlaying({ app: "code" }), false);
  });

  it("matches privacy list against app/title/url", () => {
    const list = ["incognito", "paypal", "1password"];
    assert.strictEqual(matchesPrivacy({ app: "chrome", title: "New Incognito Tab" }, list), true);
    assert.strictEqual(matchesPrivacy({ app: "chrome", title: "PayPal Checkout", url: "https://paypal.com" }, list), true);
    assert.strictEqual(matchesPrivacy({ app: "code", title: "main.ts" }, list), false);
    // no list => never suppresses
    assert.strictEqual(matchesPrivacy({ app: "chrome", title: "incognito" }, []), false);
  });

  it("idle gate treats negative/unsupported values as not idle", () => {
    assert.strictEqual(isIdle(-1, 120000), false);
    assert.strictEqual(isIdle(130, 120000), true);
    assert.strictEqual(isIdle(1, 120000), false);
    assert.strictEqual(isIdle(NaN, 120000), false);
  });

  it("splitList handles strings and arrays", () => {
    assert.deepStrictEqual(splitList("a, b ; c"), ["a", "b", "c"]);
    assert.deepStrictEqual(splitList(["x", "y"]), ["x", "y"]);
    assert.deepStrictEqual(splitList(""), []);
  });
});

describe("attention-policy dwell filter", () => {
  it("fires only after dwell elapses and cancels on a newer event", () => {
    const f = createDwellFilter(50);
    let fired = null;
    f.arm({ app: "a" }, (e) => { fired = e.app; });
    // a newer event before dwell cancels the first
    f.arm({ app: "b" }, (e) => { fired = e.app; });
    assert.strictEqual(fired, null);
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(fired, "b");
        resolve();
      }, 80);
    });
  });

  it("fires immediately when dwell is 0", () => {
    const f = createDwellFilter(0);
    let fired = null;
    f.arm({ app: "x" }, (e) => { fired = e.app; });
    assert.strictEqual(fired, "x");
  });
});

describe("attention-policy cluster", () => {
  it("records members and resets", () => {
    const c = createCluster();
    c.record("code");
    c.record("terminal");
    assert.strictEqual(c.contains("code"), true);
    assert.strictEqual(c.contains("slack"), false);
    c.reset();
    assert.strictEqual(c.contains("code"), false);
  });
});

describe("buildAttentionPolicy", () => {
  it("applies defaults", () => {
    const p = buildAttentionPolicy();
    assert.strictEqual(p.enabled, true);
    assert.strictEqual(p.idleEnabled, true);
    assert.strictEqual(p.idleMs, 120000);
    assert.strictEqual(p.dwellMs, 4000);
    assert.strictEqual(p.visionEnabled, false);
    assert.ok(p.privacyList.length >= DEFAULT_PRIVACY_LIST.length);
  });

  it("honors overrides", () => {
    const p = buildAttentionPolicy({
      enabled: false,
      idleEnabled: false,
      idleMs: 30000,
      dwellMs: 0,
      privacyList: "secret, confidential",
      visionEnabled: true,
    });
    assert.strictEqual(p.enabled, false);
    assert.strictEqual(p.idleEnabled, false);
    assert.strictEqual(p.idleMs, 30000);
    assert.strictEqual(p.dwellMs, 0);
    assert.strictEqual(p.visionEnabled, true);
    assert.deepStrictEqual(p.privacyList, ["secret", "confidential"]);
  });

  it("idles only when enabled and past threshold", () => {
    const p = buildAttentionPolicy({ idleEnabled: true, idleMs: 120000 });
    assert.strictEqual(p.isIdle(3 * 60), true);
    assert.strictEqual(p.isIdle(10), false);
    const off = buildAttentionPolicy({ idleEnabled: false, idleMs: 120000 });
    assert.strictEqual(off.isIdle(3 * 60), false);
  });
});
