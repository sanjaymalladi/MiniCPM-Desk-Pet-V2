"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  CONTAINER_TAGS,
  ALL_CONTAINER_TAGS,
  ENDPOINTS,
  MEMORY_DEFAULTS,
  RESEARCH_DEFAULTS,
  isContainerTag,
  normalizeContainerTag,
} = require("../src/memory-constants");

describe("memory-constants", () => {
  it("exposes the two container tags", () => {
    assert.strictEqual(CONTAINER_TAGS.PERSONAL, "personal");
    assert.strictEqual(CONTAINER_TAGS.WORLD_KNOWLEDGE, "world-knowledge");
    assert.deepStrictEqual(ALL_CONTAINER_TAGS, ["personal", "world-knowledge"]);
  });

  it("maps endpoints to the verified Supermemory API", () => {
    assert.strictEqual(ENDPOINTS.ADD, "/v3/add");
    assert.strictEqual(ENDPOINTS.SEARCH, "/v3/search");
    assert.strictEqual(ENDPOINTS.PROFILE, "/v4/profile");
    assert.strictEqual(ENDPOINTS.DELETE, "/v3/delete");
  });

  it("validates container tags", () => {
    assert.strictEqual(isContainerTag("personal"), true);
    assert.strictEqual(isContainerTag("nope"), false);
    assert.strictEqual(isContainerTag(null), false);
  });

  it("normalizes unknown tags to a fallback", () => {
    assert.strictEqual(normalizeContainerTag("personal"), "personal");
    assert.strictEqual(normalizeContainerTag("bogus", "world-knowledge"), "world-knowledge");
    assert.strictEqual(normalizeContainerTag(null), "personal");
  });

  it("keeps memory enabled by default so it launches with the pet (one-command)", () => {
    assert.strictEqual(MEMORY_DEFAULTS.enabled, true);
    assert.strictEqual(MEMORY_DEFAULTS.autoLaunch, true);
    assert.strictEqual(MEMORY_DEFAULTS.port, 6767);
  });

  it("bounds idle research with fetch caps and staleness", () => {
    assert.ok(RESEARCH_DEFAULTS.maxFetchesPerIdleSession > 0);
    assert.ok(RESEARCH_DEFAULTS.worldStaleMs > 0);
  });
});
