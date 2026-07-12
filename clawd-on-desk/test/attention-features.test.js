"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { AttentionFeatures } = require("../src/attention-features");

describe("AttentionFeatures wander budget", () => {
  it("exceeds exactly once when budget crossed", () => {
    const f = new AttentionFeatures({ wanderBudgetMinutes: 1 });
    f.noteDistractionStart(0); f.noteDistractionEnd(40000); // 40s
    assert.strictEqual(f.wanderExceeded(), false);
    f.noteDistractionStart(40000); f.noteDistractionEnd(70000); // +30s => 70s > 60s
    assert.strictEqual(f.wanderExceeded(), true);
    // second call must not re-announce
    assert.strictEqual(f.wanderExceeded(), false);
  });
  it("disabled when budget is 0", () => {
    const f = new AttentionFeatures({ wanderBudgetMinutes: 0 });
    f.noteDistractionStart(0); f.noteDistractionEnd(99999999);
    assert.strictEqual(f.wanderExceeded(), false);
  });
});

describe("AttentionFeatures stuck-detection", () => {
  it("flags stuck on repeated identical question with no commits", () => {
    const f = new AttentionFeatures();
    for (let i = 0; i < 4; i++) f.noteQuestion("how do I fix the build?");
    assert.strictEqual(f.stuckSignal(), "stuck");
  });
  it("does not flag when commits exist", () => {
    const f = new AttentionFeatures();
    for (let i = 0; i < 4; i++) f.noteQuestion("how do I fix the build?");
    f.noteCommit();
    assert.strictEqual(f.stuckSignal(), null);
  });
  it("flags stuck on file thrash without commits", () => {
    const f = new AttentionFeatures();
    let t = 0;
    for (let i = 0; i < 6; i++) { f.noteFileWrite(t); t += 1000; }
    assert.strictEqual(f.stuckSignal(), "stuck");
  });
});

describe("AttentionFeatures recap / reentry / sharing", () => {
  it("builds a factual recap", () => {
    const f = new AttentionFeatures();
    f.noteTaskStart("Writing report", 0);
    f.noteDistractionStart(10000); f.noteDistractionEnd(30000); // 20s drift -> rounds to 0 min
    f.noteTaskStart("Writing report", 30000);
    const r = f.buildRecap();
    assert.strictEqual(r.distractedMins, 0);
    assert.ok(r.tasks.length >= 1);
  });
  it("builds re-entry line from last task facts", () => {
    const f = new AttentionFeatures();
    f.noteTaskStart("Refactor auth", Date.now() - 5 * 60000);
    const line = f.buildReentry();
    assert.ok(line && line.includes("Refactor auth"));
  });
  it("builds a shareable summary without judgment words", () => {
    const f = new AttentionFeatures({ nudgeContract: "finish the report" });
    f.noteTaskStart("report", 0);
    f.noteDistractionStart(0); f.noteDistractionEnd(300000);
    const s = f.buildShareableSummary();
    assert.ok(s.includes("Session goal: finish the report"));
    assert.ok(!/\b(lazy|bad|should)\b/i.test(s));
  });
});

describe("AttentionFeatures check-in + pattern + contract", () => {
  it("check-in fires once per distinct task", () => {
    const f = new AttentionFeatures();
    assert.strictEqual(f.shouldCheckIn("Write tests"), true);
    f.markCheckedIn("Write tests");
    assert.strictEqual(f.shouldCheckIn("Write tests"), false);
    assert.strictEqual(f.shouldCheckIn("Write docs"), true);
  });
  it("surfaces drift peak hour", () => {
    const f = new AttentionFeatures();
    // simulate 10 min drift at hour 15
    const base = new Date(); base.setHours(15, 0, 0, 0);
    f.noteDistractionStart(base.getTime());
    f.noteDistractionEnd(base.getTime() + 10 * 60000);
    const peak = f.driftPeakHour();
    assert.ok(peak && peak.hour === 15 && peak.mins >= 5);
  });
  it("contractActive reflects the goal", () => {
    assert.strictEqual(new AttentionFeatures({}).contractActive(), false);
    assert.strictEqual(new AttentionFeatures({ nudgeContract: "ship v2" }).contractActive(), true);
  });
});
