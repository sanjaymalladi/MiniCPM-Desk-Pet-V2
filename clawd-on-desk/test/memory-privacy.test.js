"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const privacy = require("../src/memory-privacy");
const { DEFAULT_EXCLUDE_LIST } = require("../src/memory-constants");

describe("memory-privacy", () => {
  it("flags exclude-list content", () => {
    assert.strictEqual(privacy.isPrivateText("I just logged into my bank", DEFAULT_EXCLUDE_LIST), true);
    assert.strictEqual(privacy.isPrivateText("checking the password manager", DEFAULT_EXCLUDE_LIST), true);
    assert.strictEqual(privacy.isPrivateText("looking at cat videos", DEFAULT_EXCLUDE_LIST), false);
  });

  it("wraps and unwraps the <private> tag", () => {
    const wrapped = privacy.wrapPrivate("secret");
    assert.strictEqual(wrapped, "<private>secret</private>");
    assert.strictEqual(privacy.unwrapPrivate(wrapped), "secret");
    assert.strictEqual(privacy.containsPrivateTag(wrapped), true);
  });

  it("refuses to store private content by default", () => {
    const v = privacy.evaluate("opened my 1password vault", { excludeList: DEFAULT_EXCLUDE_LIST });
    assert.strictEqual(v.store, false);
    assert.strictEqual(v.private, true);
  });

  it("can redact-and-store when asked", () => {
    const v = privacy.evaluate("opened my 1password vault", { excludeList: DEFAULT_EXCLUDE_LIST, redact: true });
    assert.strictEqual(v.store, true);
    assert.strictEqual(v.private, true);
    assert.ok(privacy.containsPrivateTag(v.content));
  });
});

describe("memory-service privacy gate", () => {
  // Recording fetch: captures every REST call the service makes. autoLaunch:false
  // means start() just builds a client (no spawn), so we exercise the real path.
  function makeService() {
    const { initMemory } = require("../src/memory-service");
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { id: "x1" } }),
      };
    };
    const svc = initMemory({
      getPrefs: () => ({ memoryEnabled: true, memoryAutoLaunch: false, memoryPort: 6767, memoryApiKey: "" }),
      fetchImpl,
    });
    return { svc, calls };
  }

  it("refuses to store private content through add()", async () => {
    const { svc, calls } = makeService();
    await svc.start();
    const res = await svc.add({ content: "my bank password is 1234", category: "personal" });
    assert.strictEqual(res.stored, false);
    assert.strictEqual(res.private, true);
    assert.strictEqual(calls.length, 0);
  });

  it("stores non-private content", async () => {
    const { svc, calls } = makeService();
    await svc.start();
    const res = await svc.add({ content: "learned about MiniCPM", category: "personal" });
    assert.ok(res.data && res.data.id);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/v3/add"));
  });
});
