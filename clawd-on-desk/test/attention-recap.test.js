"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AttentionRecap, normalizeType, formatDuration } = require("../src/attention-recap");

function fixedNow(start) {
  let t = start;
  return () => t;
}

test("normalizeType maps known types and falls back to unrelated", () => {
  assert.equal(normalizeType("editor"), "editor");
  assert.equal(normalizeType("docs"), "docs");
  assert.equal(normalizeType("browser"), "browser");
  assert.equal(normalizeType("unrelated"), "unrelated");
  assert.equal(normalizeType("video"), "unrelated");
  assert.equal(normalizeType(null), "unrelated");
});

test("formatDuration renders h/m/s", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(5 * 1000), "5s");
  assert.equal(formatDuration(20 * 60 * 1000), "20m");
  assert.equal(formatDuration((1 * 3600 + 12 * 60) * 1000), "1h 12m");
});

test("recordActivity accumulates ms per type", () => {
  const recap = new AttentionRecap({ now: fixedNow(1000) });
  recap.recordActivity({ type: "editor", app: "vscode", ms: 1000 });
  recap.recordActivity({ type: "editor", ms: 2000 });
  recap.recordActivity({ type: "docs", ms: 500 });
  recap.recordActivity({ type: "browser", ms: 300 });
  recap.recordActivity({ type: "unknown-thing", ms: 999 });

  const r = recap.sessionRecap();
  assert.equal(r.editorMs, 3000);
  assert.equal(r.docsMs, 500);
  assert.equal(r.browserMs, 300);
  assert.equal(r.unrelatedMs, 999);
  assert.equal(r.totalMs, 4799);
});

test("confirmTask sets the fact used by whereYouLeftOff", () => {
  const recap = new AttentionRecap({ now: fixedNow(1000) });
  recap.recordActivity({ type: "editor", app: "vscode", task: "refactor parser", ms: 1000 });
  recap.confirmTask("refactor parser");
  assert.equal(recap.confirmedTask, "refactor parser");
});

test("whereYouLeftOff returns a non-judgmental factual string referencing the confirmed task", () => {
  const recap = new AttentionRecap({ now: fixedNow(10 * 60 * 1000) });
  recap.recordActivity({ type: "editor", app: "vscode", ms: 1000 });
  recap.confirmTask("fix the login bug");

  const msg = recap.whereYouLeftOff();
  assert.match(msg, /fix the login bug/);
  assert.match(msg, /vscode/);
  assert.match(msg, /ago/);

  const low = msg.toLowerCase();
  for (const bad of ["good", "bad", "great", "poor", "lazy", "productive", "score", "wasted", "should"]) {
    assert.ok(!low.includes(bad), `string must not contain judgment word "${bad}": ${msg}`);
  }
});

test("whereYouLeftOff returns a neutral default when nothing confirmed", () => {
  const recap = new AttentionRecap({ now: fixedNow(1000) });
  const msg = recap.whereYouLeftOff();
  assert.equal(msg, "You stepped away — no task was confirmed yet, so I'll just wait for your next move.");
});

test("sessionRecap returns correct totals and a factual summary", () => {
  const recap = new AttentionRecap({ now: fixedNow(1000) });
  recap.recordActivity({ type: "editor", ms: 12 * 60 * 1000 });
  recap.recordActivity({ type: "docs", ms: 20 * 60 * 1000 });
  recap.recordActivity({ type: "browser", ms: 8 * 60 * 1000 });
  recap.recordActivity({ type: "unrelated", ms: 5 * 60 * 1000 });
  recap.confirmTask("write the report");

  const r = recap.sessionRecap();
  const summary = r.summary();
  assert.equal(r.editorMs, 12 * 60 * 1000);
  assert.equal(r.docsMs, 20 * 60 * 1000);
  assert.equal(r.browserMs, 8 * 60 * 1000);
  assert.equal(r.unrelatedMs, 5 * 60 * 1000);
  assert.equal(r.totalMs, 45 * 60 * 1000);
  assert.equal(r.task, "write the report");
  assert.match(summary, /in your editor/);
  assert.match(summary, /in docs/);
  assert.match(summary, /in the browser/);
  assert.match(summary, /elsewhere/);

  const low = summary.toLowerCase();
  for (const bad of ["good", "bad", "great", "poor", "lazy", "productive", "score", "wasted", "should"]) {
    assert.ok(!low.includes(bad), `summary must not contain judgment word "${bad}": ${summary}`);
  }
});

test("reset clears all accumulated data", () => {
  const recap = new AttentionRecap({ now: fixedNow(1000) });
  recap.recordActivity({ type: "editor", app: "vscode", task: "x", ms: 5000 });
  recap.confirmTask("x");
  recap.reset();

  const r = recap.sessionRecap();
  assert.equal(r.editorMs, 0);
  assert.equal(r.docsMs, 0);
  assert.equal(r.browserMs, 0);
  assert.equal(r.unrelatedMs, 0);
  assert.equal(r.totalMs, 0);
  assert.equal(r.task, null);
  assert.equal(recap.confirmedTask, null);
  assert.equal(recap.lastApp, null);
  assert.equal(recap.whereYouLeftOff(), "You stepped away — no task was confirmed yet, so I'll just wait for your next move.");
});

test("now function is injectable for deterministic time math", () => {
  let t = 0;
  const recap = new AttentionRecap({ now: () => t });
  recap.recordActivity({ type: "editor", app: "vscode", ms: 1000 });
  t = 90 * 1000;
  recap.confirmTask("task A");
  const msg = recap.whereYouLeftOff();
  assert.match(msg, /1m ago/);
});
