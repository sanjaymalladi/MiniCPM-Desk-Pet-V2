"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { GoalCountdown, fmtDuration } = require("../src/memory-goal-countdown");

function fakeStore() {
  const stored = [];
  let n = 0;
  return {
    stored,
    store: async (o) => { const id = `g${++n}`; stored.push(Object.assign({ id }, o)); return { data: { id } }; },
    recall: async () => stored.map((s) => ({ id: s.id, content: s.content, metadata: s.metadata })),
    del: async (id) => { for (let i = stored.length - 1; i >= 0; i--) if (stored[i].id === id) stored.splice(i, 1); return { ok: true }; },
  };
}

describe("fmtDuration", () => {
  it("formats hours + minutes", () => {
    assert.strictEqual(fmtDuration(1000 * 60 * 134), "2h 14m");
    assert.strictEqual(fmtDuration(1000 * 60 * 9), "9m");
  });
});

describe("GoalCountdown", () => {
  it("stores a goal with a deadline and reports remaining time", async () => {
    const f = fakeStore();
    const g = new GoalCountdown({ store: f.store, recall: f.recall, del: f.del, now: () => 1_000_000 });
    await g.setGoal({ text: "finish report", deadline: 1_000_000 + 1000 * 60 * 120 });
    const active = g.getActive();
    assert.ok(active);
    assert.strictEqual(active.text, "finish report");
    assert.strictEqual(active.remaining, "2h 0m");
  });

  it("does NOT surface below the distraction threshold (not random)", async () => {
    const f = fakeStore();
    const g = new GoalCountdown({ store: f.store, recall: f.recall, del: f.del, now: () => 1_000_000, caps: { minDistractionMs: 1000 * 60 * 2 } });
    await g.setGoal({ text: "report", deadline: 1_000_000 + 1000 * 60 * 120 });
    const below = g.onDistraction(1000 * 30); // 30s < 2min
    assert.strictEqual(below.show, false);
    assert.strictEqual(below.reason, "below-threshold");
    const above = g.onDistraction(1000 * 60 * 6); // 6min
    assert.strictEqual(above.show, true);
  });

  it("respects the surface budget", async () => {
    const f = fakeStore();
    const g = new GoalCountdown({ store: f.store, recall: f.recall, del: f.del, now: () => 1_000_000, caps: { minDistractionMs: 0, maxSurfacesPerGoal: 2 } });
    await g.setGoal({ text: "report", deadline: 1_000_000 + 1000 * 60 * 120 });
    assert.strictEqual(g.onDistraction(10_000).show, true);
    assert.strictEqual(g.onDistraction(10_000).show, true);
    assert.strictEqual(g.onDistraction(10_000).reason, "budget");
  });

  it("resolves against a completion signal and clears the goal", async () => {
    const f = fakeStore();
    const g = new GoalCountdown({ store: f.store, recall: f.recall, del: f.del, now: () => 1_000_000 });
    await g.setGoal({ text: "report", deadline: 1_000_000 + 1000 * 60 * 120 });
    const res = await g.resolve("commit");
    assert.strictEqual(res.resolved, true);
    assert.strictEqual(g.getActive(), null);
    assert.strictEqual(f.stored.length, 0);
  });

  it("treats an expired goal as inactive", async () => {
    const f = fakeStore();
    const g = new GoalCountdown({ store: f.store, recall: f.recall, del: f.del, now: () => 5_000_000 });
    await g.setGoal({ text: "report", deadline: 1_000_000 + 1000 }); // already past
    assert.strictEqual(g.getActive(), null);
    assert.strictEqual(g.onDistraction(10_000).reason, "expired");
  });
});
