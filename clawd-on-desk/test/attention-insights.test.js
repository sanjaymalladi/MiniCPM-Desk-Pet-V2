"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AttentionInsights } = require("../src/attention-insights");

function makeNow(start) {
  let t = start;
  return () => t;
}

test("repeated identical question across 2 tools within window -> stuck signal", () => {
  let t = 1000;
  const insights = new AttentionInsights({
    now: () => t,
    windowMs: 10 * 60 * 1000,
  });
  insights.recordQuery({ tool: "claude", question: "How do I fix this error?" });
  insights.recordQuery({ tool: "codex", question: "how do i fix this error?" });
  const sig = insights.getStuckSignal();
  assert.ok(sig);
  assert.equal(sig.kind, "repeated-question");
  assert.equal(sig.detail, "how do i fix this error?");
  assert.deepEqual(sig.tools.sort(), ["claude", "codex"]);
});

test("same question same tool only -> not stuck", () => {
  let t = 1000;
  const insights = new AttentionInsights({
    now: () => t,
    windowMs: 10 * 60 * 1000,
  });
  insights.recordQuery({ tool: "claude", question: "Why won't this compile?" });
  insights.recordQuery({ tool: "claude", question: "why won't this compile?" });
  assert.equal(insights.getStuckSignal(), null);
});

test("doc re-read >=3 within window -> stuck", () => {
  let t = 1000;
  const insights = new AttentionInsights({
    now: () => t,
    windowMs: 10 * 60 * 1000,
    docRereadThreshold: 3,
  });
  const doc = "api-reference.md";
  insights.recordDocRead(doc);
  insights.recordDocRead(doc);
  assert.equal(insights.getStuckSignal(), null);
  insights.recordDocRead(doc);
  const sig = insights.getStuckSignal();
  assert.ok(sig);
  assert.equal(sig.kind, "doc-reread");
  assert.equal(sig.detail, doc);
  assert.equal(sig.count, 3);
});

test("file thrash >=8 writes without commit -> stuck", () => {
  let t = 1000;
  const insights = new AttentionInsights({
    now: () => t,
    windowMs: 10 * 60 * 1000,
    thrashWriteThreshold: 8,
  });
  for (let i = 0; i < 7; i++) insights.recordFileWrite("src/a.js");
  assert.equal(insights.getStuckSignal(), null);
  insights.recordFileWrite("src/a.js");
  const sig = insights.getStuckSignal();
  assert.ok(sig);
  assert.equal(sig.kind, "file-thrash");
  assert.equal(sig.writes, 8);
});

test("a commit resets the thrash counter", () => {
  let t = 1000;
  const insights = new AttentionInsights({
    now: () => t,
    windowMs: 10 * 60 * 1000,
    thrashWriteThreshold: 8,
  });
  for (let i = 0; i < 8; i++) insights.recordFileWrite("src/a.js");
  assert.ok(insights.getStuckSignal());
  insights.recordCommit();
  assert.equal(insights.getStuckSignal(), null);
});

test("recordDistraction + driftSummary returns the peak hour", () => {
  const insights = new AttentionInsights();
  insights.recordDistraction(15);
  insights.recordDistraction(15);
  insights.recordDistraction(9);
  const summary = insights.driftSummary();
  assert.ok(summary);
  assert.equal(summary.hour, 15);
  assert.equal(summary.count, 2);
  assert.match(summary.message, /3pm/);
});

test("reset clears all signals and aggregations", () => {
  let t = 1000;
  const insights = new AttentionInsights({
    now: () => t,
    windowMs: 10 * 60 * 1000,
    thrashWriteThreshold: 8,
  });
  insights.recordQuery({ tool: "claude", question: "stuck query?" });
  insights.recordQuery({ tool: "codex", question: "stuck query?" });
  insights.recordDocRead("d.md");
  insights.recordDocRead("d.md");
  insights.recordDocRead("d.md");
  for (let i = 0; i < 8; i++) insights.recordFileWrite("f.js");
  insights.recordDistraction(14);
  assert.ok(insights.getStuckSignal());
  assert.ok(insights.driftSummary());

  insights.reset();
  assert.equal(insights.getStuckSignal(), null);
  assert.equal(insights.driftSummary(), null);
});

test("window expiry clears older signals", () => {
  let t = 1000;
  const insights = new AttentionInsights({
    now: () => t,
    windowMs: 10 * 60 * 1000,
  });
  insights.recordQuery({ tool: "claude", question: "old repeated question?" });
  insights.recordQuery({ tool: "codex", question: "old repeated question?" });
  assert.ok(insights.getStuckSignal());
  t += 11 * 60 * 1000;
  assert.equal(insights.getStuckSignal(), null);
});
