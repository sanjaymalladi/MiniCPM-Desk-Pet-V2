"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { ProactiveMessenger, inQuietHours } = require("../src/memory-proactive");

describe("inQuietHours", () => {
  it("handles a normal window", () => {
    assert.strictEqual(inQuietHours(new Date(2026, 0, 1, 23).getTime(), 22, 8), true);
    assert.strictEqual(inQuietHours(new Date(2026, 0, 1, 12).getTime(), 22, 8), false);
  });
  it("handles wrap past midnight", () => {
    assert.strictEqual(inQuietHours(new Date(2026, 0, 1, 3).getTime(), 22, 8), true);
    assert.strictEqual(inQuietHours(new Date(2026, 0, 1, 9).getTime(), 22, 8), false);
  });
});

describe("ProactiveMessenger", () => {
  function build(prefs) {
    const sent = [];
    const m = new ProactiveMessenger({
      notify: async (msg) => { sent.push(msg); },
      getPrefs: () => prefs,
    });
    return { m, sent };
  }

  it("delivers when not muted and not quiet", async () => {
    const { m, sent } = build({ muted: false, quietHoursStart: 22, quietHoursEnd: 8 });
    const now = new Date(2026, 0, 1, 12).getTime(); // noon
    const r = await m.deliver("hi", { now });
    assert.strictEqual(r.delivered, true);
    assert.strictEqual(sent.length, 1);
  });

  it("does not deliver while muted", async () => {
    const { m, sent } = build({ muted: true, quietHoursStart: 22, quietHoursEnd: 8 });
    const now = new Date(2026, 0, 1, 12).getTime();
    const r = await m.deliver("hi", { now });
    assert.strictEqual(r.delivered, false);
    assert.strictEqual(r.reason, "muted");
    assert.strictEqual(sent.length, 0);
  });

  it("does not deliver during quiet hours", async () => {
    const { m, sent } = build({ muted: false, quietHoursStart: 22, quietHoursEnd: 8 });
    const now = new Date(2026, 0, 1, 23).getTime(); // 23:00
    const r = await m.deliver("hi", { now });
    assert.strictEqual(r.delivered, false);
    assert.strictEqual(r.reason, "quiet-hours");
  });

  it("builds a check-in from the profile", () => {
    const { m } = build({});
    const msg = m.buildCheckIn({ recent: [{ content: "shipped the parser" }] });
    assert.ok(msg.includes("shipped the parser"));
  });

  it("builds a relevant message from world entries", () => {
    const { m } = build({});
    const msg = m.buildRelevant([{ content: "GPT-5 released" }, { content: "new fine-tune method" }]);
    assert.ok(msg.includes("GPT-5 released"));
  });
});
