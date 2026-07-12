"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { SupermemoryClient } = require("../src/supermemory-client");
const { CONTAINER_TAGS } = require("../src/memory-constants");

// Minimal fetch mock: records the request and returns a Response-like object.
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const call = { url, method: (opts.method || "GET").toUpperCase(), headers: opts.headers || {}, body: opts.body };
    calls.push(call);
    const res = await handler(call);
    return {
      ok: res.ok,
      status: res.status,
      async text() { return res.text; },
    };
  };
  return { fetchImpl, calls };
}

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: JSON.stringify(obj) };
}

describe("SupermemoryClient", () => {
  it("adds a memory scoped by category with auth + json body", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ success: true, data: { id: "m1" } }));
    const client = new SupermemoryClient({ baseUrl: "http://127.0.0.1:6767", apiKey: "sm_x", fetchImpl });
    const res = await client.add({ content: "hello", category: CONTAINER_TAGS.WORLD_KNOWLEDGE, metadata: { a: 1 } });
    assert.strictEqual(res.data.id, "m1");
    assert.strictEqual(calls.length, 1);
    const call = calls[0];
    assert.strictEqual(call.url, "http://127.0.0.1:6767/v3/add");
    assert.strictEqual(call.method, "POST");
    assert.strictEqual(call.headers["Authorization"], "Bearer sm_x");
    const sent = JSON.parse(call.body);
    assert.strictEqual(sent.content, "hello");
    assert.strictEqual(sent.category, "world-knowledge");
    assert.deepStrictEqual(sent.metadata, { a: 1 });
  });

  it("defaults category to personal when omitted", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ success: true }));
    const client = new SupermemoryClient({ fetchImpl });
    await client.add({ content: "x" });
    assert.strictEqual(JSON.parse(calls[0].body).category, "personal");
  });

  it("rejects empty content", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({}));
    const client = new SupermemoryClient({ fetchImpl });
    await assert.rejects(() => client.add({ content: "" }), /non-empty content/);
  });

  it("searches and returns the results array", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ success: true, results: [{ id: "r1", content: "a" }] }));
    const client = new SupermemoryClient({ fetchImpl });
    const results = await client.search({ query: "q", category: CONTAINER_TAGS.PERSONAL, pageSize: 5 });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, "r1");
    const sent = JSON.parse(calls[0].body);
    assert.strictEqual(sent.query, "q");
    assert.strictEqual(sent.category, "personal");
    assert.strictEqual(sent.pageSize, 5);
  });

  it("list() delegates to search with an empty query", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ results: [{ id: "l1" }] }));
    const client = new SupermemoryClient({ fetchImpl });
    const out = await client.list({ category: CONTAINER_TAGS.WORLD_KNOWLEDGE });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(JSON.parse(calls[0].body).query, "");
    assert.strictEqual(JSON.parse(calls[0].body).category, "world-knowledge");
  });

  it("getProfile hits /v4/profile and returns data", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ success: true, data: { stable: {}, recent: [] } }));
    const client = new SupermemoryClient({ fetchImpl });
    const profile = await client.getProfile();
    assert.strictEqual(calls[0].url, "http://127.0.0.1:6767/v4/profile");
    assert.strictEqual(calls[0].method, "GET");
    assert.ok(profile.stable !== undefined);
  });

  it("deleteMemory posts the id", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ success: true }));
    const client = new SupermemoryClient({ fetchImpl });
    await client.deleteMemory("id9");
    assert.strictEqual(calls[0].url, "http://127.0.0.1:6767/v3/delete");
    assert.strictEqual(JSON.parse(calls[0].body).id, "id9");
  });

  it("throws on non-ok responses with status", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ error: "bad" }, 500));
    const client = new SupermemoryClient({ fetchImpl });
    await assert.rejects(() => client.add({ content: "x" }), (e) => e.status === 500);
  });

  it("health returns true on 200 and false on failure", async () => {
    const ok = makeFetch(() => jsonResponse({}));
    const clientOk = new SupermemoryClient({ fetchImpl: ok.fetchImpl });
    assert.strictEqual(await clientOk.health(), true);

    const bad = makeFetch(() => { throw new Error("conn refused"); });
    const clientBad = new SupermemoryClient({ fetchImpl: bad.fetchImpl });
    assert.strictEqual(await clientBad.health(), false);
  });
});
