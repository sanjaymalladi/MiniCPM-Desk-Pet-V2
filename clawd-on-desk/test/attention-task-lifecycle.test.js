"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { AttentionTaskLifecycle } = require("../src/attention-task-lifecycle");

function makeFakeConfirm(responses) {
  let i = 0;
  return async () => {
    const r = responses[i];
    i += 1;
    return r;
  };
}

test("(a) check-in fires once per new task and not again for the same task", async () => {
  const seen = [];
  const confirmHandler = async (payload) => {
    seen.push(payload.message);
    return 0;
  };
  const lc = new AttentionTaskLifecycle({ confirmHandler });

  await lc.startTask("Writing a report");
  await lc.startTask("Writing a report");
  assert.strictEqual(seen.length, 1, "check-in should fire only once for same task");

  await lc.startTask("Reading email");
  assert.strictEqual(seen.length, 2, "check-in should fire for a new task");

  await lc.startTask("Reading email");
  assert.strictEqual(seen.length, 2, "check-in should not re-fire for repeated same task");

  assert.ok(seen[0].includes("Writing a report"));
  assert.ok(seen[1].includes("Reading email"));
});

test("(b) correcting the hypothesis records a correction and adopts it", async () => {
  const confirmHandler = makeFakeConfirm([1]);
  const lc = new AttentionTaskLifecycle({ confirmHandler });

  await lc.startTask("Writing a report");
  await lc.resolveCheckIn(1, "Drafting the Q3 report");

  const corrections = lc.getCorrections();
  assert.strictEqual(corrections.length, 1);
  assert.strictEqual(corrections[0].from, "Writing a report");
  assert.strictEqual(corrections[0].to, "Drafting the Q3 report");
  assert.strictEqual(corrections[0].corrected, true);
  assert.strictEqual(lc.wasCorrected(), true);
  assert.strictEqual(lc.getCurrentTask(), "Drafting the Q3 report");
});

test("(c) markComplete stops isActive()", () => {
  const lc = new AttentionTaskLifecycle();
  lc.startTask("Writing a report");
  assert.strictEqual(lc.isActive(), true);

  lc.markComplete({ reason: "commit+pr" });
  assert.strictEqual(lc.isActive(), false);

  const lc2 = new AttentionTaskLifecycle();
  lc2.startTask("Writing a report");
  lc2.markComplete({ reason: "explicit-done" });
  assert.strictEqual(lc2.isActive(), false);
});

test("(d) onSignal('done') completes", () => {
  const lc = new AttentionTaskLifecycle();
  lc.startTask("Writing a report");
  assert.strictEqual(lc.isActive(), true);

  lc.onSignal("done");
  assert.strictEqual(lc.isActive(), false);
});

test("(e) confirmHandler returning null (dismiss) does not crash and keeps task active", async () => {
  const confirmHandler = makeFakeConfirm([null]);
  const lc = new AttentionTaskLifecycle({ confirmHandler });

  await lc.startTask("Writing a report");
  await lc.resolveCheckIn(null);

  assert.strictEqual(lc.isActive(), true);
  assert.strictEqual(lc.wasCorrected(), false);
  assert.strictEqual(lc.getCurrentTask(), "Writing a report");
});

test("(f) commit+pr signal completes only once both seen", () => {
  const lc = new AttentionTaskLifecycle();
  lc.startTask("Writing a report");
  assert.strictEqual(lc.isActive(), true);

  lc.onSignal("commit");
  assert.strictEqual(lc.isActive(), true, "commit alone must not complete");

  lc.onSignal("pr");
  assert.strictEqual(lc.isActive(), false, "commit+pr together must complete");
});

test("(g) onTaskCleared fires on completion", () => {
  let cleared = null;
  const lc = new AttentionTaskLifecycle({
    onTaskCleared: (info) => { cleared = info; },
  });
  lc.startTask("Writing a report");
  lc.markComplete({ reason: "explicit-done" });
  assert.ok(cleared);
  assert.strictEqual(cleared.reason, "explicit-done");
});
