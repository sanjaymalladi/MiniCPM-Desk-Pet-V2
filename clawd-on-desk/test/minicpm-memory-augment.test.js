"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { buildMemoryContextText, buildAugmentedMessages } = require("../src/minicpm-memory-augment");

test("buildMemoryContextText returns empty for no memories", () => {
  assert.strictEqual(buildMemoryContextText([]), "");
  assert.strictEqual(buildMemoryContextText(null), "");
  assert.strictEqual(buildMemoryContextText([{ content: "" }]), "");
});

test("buildMemoryContextText tags personal vs world", () => {
  const text = buildMemoryContextText([
    { content: "likes tea", category: "personal" },
    { content: "GPT-5 released", category: "world-knowledge" },
  ]);
  assert.ok(text.startsWith("Relevant memories"));
  assert.ok(text.includes("[personal] likes tea"));
  assert.ok(text.includes("[world] GPT-5 released"));
});

test("buildMemoryContextText respects maxChars", () => {
  const memories = Array.from({ length: 20 }, (_, i) => ({
    content: `fact number ${i} which is reasonably long to consume tokens`,
    category: "personal",
  }));
  const text = buildMemoryContextText(memories, { maxChars: 40 });
  assert.ok(text.length <= 40 + 30);
  assert.ok(text.startsWith("Relevant memories"));
});

test("buildAugmentedMessages leads with tool prompt then memory then history", () => {
  const out = buildAugmentedMessages({
    toolPrompt: "TOOL",
    memoryContext: "MEM",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepStrictEqual(out, [
    { role: "system", content: "TOOL" },
    { role: "system", content: "MEM" },
    { role: "user", content: "hi" },
  ]);
});

test("buildAugmentedMessages omits empty blocks", () => {
  const out = buildAugmentedMessages({
    toolPrompt: "",
    memoryContext: "",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepStrictEqual(out, [{ role: "user", content: "hi" }]);
});
