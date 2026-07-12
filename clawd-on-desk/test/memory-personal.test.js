"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { PersonalMemory, distillTaskEvent, detectRememberIntent } = require("../src/memory-personal");
const { DEFAULT_REMEMBER_TRIGGERS } = require("../src/memory-constants");

// Fake Supermemory client: records calls, returns deterministic ids.
function fakeClient() {
  const calls = [];
  let n = 0;
  return {
    calls,
    add: async (opts) => { calls.push({ op: "add", opts }); return { data: { id: `m${++n}` } }; },
    search: async (opts) => { calls.push({ op: "search", opts }); return [{ id: "r1" }]; },
    getProfile: async () => ({ calls: true }),
    deleteMemory: async (id) => { calls.push({ op: "delete", id }); return { ok: true }; },
  };
}

describe("distillTaskEvent", () => {
  it("condenses a raw event into a short label", () => {
    const out = distillTaskEvent({ agent: "claude-code", type: "Stop", summary: "wrote parser" });
    assert.ok(out.includes("claude-code"));
    assert.ok(out.includes("wrote parser"));
  });
  it("returns empty for null and a minimal label for an empty object", () => {
    assert.strictEqual(distillTaskEvent(null), "");
    assert.ok(distillTaskEvent({}).includes("task"));
  });
});

describe("detectRememberIntent", () => {
  it("matches keyword triggers", () => {
    assert.strictEqual(detectRememberIntent("remember this for later", DEFAULT_REMEMBER_TRIGGERS), true);
    assert.strictEqual(detectRememberIntent("don't forget the deploy steps", DEFAULT_REMEMBER_TRIGGERS), true);
    assert.strictEqual(detectRememberIntent("what time is it", DEFAULT_REMEMBER_TRIGGERS), false);
  });
});

describe("PersonalMemory tiers + auto-forget", () => {
  it("Tier 1 on start, distills to Tier 2 on end, and auto-forgets the ephemeral doc", async () => {
    const client = fakeClient();
    const pm = new PersonalMemory({ client, ttlMs: 1000 });
    await pm.recordTaskStart({ taskId: "t1", label: "refactor auth" });
    const startAdd = client.calls.find((c) => c.op === "add");
    assert.strictEqual(startAdd.opts.metadata.tier, "tier1");
    assert.strictEqual(startAdd.opts.metadata.taskId, "t1");

    const endRes = await pm.recordTaskEnd({ taskId: "t1", outcome: "done" });
    assert.ok(endRes.summary.includes("done"));
    const endAdd = client.calls.filter((c) => c.op === "add")[1];
    assert.strictEqual(endAdd.opts.metadata.tier, "tier2");
    // The ephemeral Tier 1 doc must have been deleted (auto-forget).
    const del = client.calls.find((c) => c.op === "delete");
    assert.ok(del, "expected an auto-forget delete");
  });

  it("Tier 3 remember requires confirmation when flagged", async () => {
    const client = fakeClient();
    const pm = new PersonalMemory({ client });
    const needs = await pm.remember({ content: "I prefer dark mode", requiresConfirm: true, confirmed: false });
    assert.strictEqual(needs.needsConfirm, true);
    assert.strictEqual(client.calls.filter((c) => c.op === "add").length, 0);

    const ok = await pm.remember({ content: "I prefer dark mode", requiresConfirm: true, confirmed: true });
    assert.ok(ok.stored && ok.stored.data.id);
    const add = client.calls.find((c) => c.op === "add");
    assert.strictEqual(add.opts.metadata.tier, "tier3");
  });

  it("recall delegates to personal container search", async () => {
    const client = fakeClient();
    const pm = new PersonalMemory({ client });
    const res = await pm.recall({ query: "auth" });
    assert.strictEqual(res.length, 1);
    assert.strictEqual(client.calls.find((c) => c.op === "search").opts.category, "personal");
  });
});
