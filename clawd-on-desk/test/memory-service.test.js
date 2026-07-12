"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { initMemory } = require("../src/memory-service");

function response(json) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(json),
  };
}

describe("memory-service integration", () => {
  it("uses memory-pref names when attaching to an external Supermemory server", async () => {
    const calls = [];
    const svc = initMemory({
      getPrefs: () => ({
        memoryEnabled: true,
        memoryAutoLaunch: false,
        memoryPort: 9999,
        memoryApiKey: "secret-key",
      }),
      fetchImpl: async (url, opts) => {
        calls.push({ url, opts });
        return response({ data: { id: "m1" } });
      },
    });

    const started = await svc.start();
    assert.strictEqual(started.mode, "external");
    assert.strictEqual(started.url, "http://127.0.0.1:9999");
    assert.strictEqual(started.apiKey, "secret-key");

    await svc.add({ content: "remember a non-private fact", category: "personal" });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.startsWith("http://127.0.0.1:9999/"));
    assert.strictEqual(calls[0].opts.headers.Authorization, "Bearer secret-key");
  });

  it("builds a dashboard snapshot without leaking stale variable names", async () => {
    const svc = initMemory({
      getPrefs: () => ({ memoryEnabled: true, memoryAutoLaunch: false, memoryPort: 6767 }),
      fetchImpl: async (url) => {
        if (url.endsWith("/v4/profile")) return response({ data: { nodes: [] } });
        return response({ results: [{ id: "x", content: "stored", metadata: { fetchedAt: Date.now() } }] });
      },
    });

    await svc.start();
    const snap = await svc.dashboardSnapshot();
    assert.strictEqual(snap.enabled, true);
    assert.strictEqual(snap.ready, true);
    assert.strictEqual(snap.counts.personal, 1);
    assert.strictEqual(snap.counts.world, 1);
    assert.strictEqual(snap.staleWorld, 0);
  });

  it("retrieves RAG context across personal and world containers", async () => {
    const svc = initMemory({
      getPrefs: () => ({ memoryEnabled: true, memoryAutoLaunch: false, memoryPort: 6767 }),
      fetchImpl: async (url, opts) => {
        const body = JSON.parse(opts.body || "{}");
        const cat = body.category;
        return response({ results: [{ id: cat, content: `${cat} memory`, metadata: {} }] });
      },
    });

    await svc.start();
    const rag = await svc.retrieveContext("MiniCPM", { limit: 4 });
    assert.strictEqual(rag.enabled, true);
    assert.strictEqual(rag.ready, true);
    assert.strictEqual(rag.memories.length, 2);
    assert.ok(rag.text.includes("personal memory"));
    assert.ok(rag.text.includes("world-knowledge memory"));
  });
});
