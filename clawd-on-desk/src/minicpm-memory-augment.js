"use strict";

// ── MiniCPM ↔ Supermemory RAG augmentation (pure, UMD) ──
//
// Builds the memory-context block that gets prepended to the chat system
// prompt and the augmented message list sent to llama-server. Kept pure
// (no Electron / fetch) so it's unit-testable from both CJS (tests) and the
// renderer (<script> global). Test coverage: test/minicpm-memory-augment.test.js

(function initMemoryAugment(root) {
  // Stable canonical tag so the model can tell personal facts from
  // world-knowledge research results.
  const WORLD_TAG = "world-knowledge";

  function categoryLabel(category) {
    return category === WORLD_TAG ? "[world]" : "[personal]";
  }

  // Render retrieved memories into a compact, token-bounded context string.
  // Bounds the TOTAL output (prefix + lines) to `maxChars`. Returns "" only
  // when there are no memories at all; when memories exist but none fit
  // fully, the first line is truncated into the remaining room so the block
  // is never silently dropped.
  function buildMemoryContextText(memories, options) {
    if (!Array.isArray(memories) || memories.length === 0) return "";
    const opts = options || {};
    const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 1200;
    const prefix = "Relevant memories about the user and the world:\n";
    const lines = [];
    let total = prefix.length;
    let sawContent = false;
    for (const m of memories) {
      if (!m) continue;
      const content = typeof m.content === "string" ? m.content : "";
      if (!content) continue;
      sawContent = true;
      const line = `${categoryLabel(m.category)} ${content}`;
      if (total + line.length + 1 > maxChars) {
        // Can't fit another full line. If nothing has been added yet, truncate
        // this line into the remaining room so we still surface something.
        if (lines.length === 0) {
          const room = maxChars - total;
          if (room > 0) lines.push(line.slice(0, room));
        }
        break;
      }
      lines.push(line);
      total += line.length + 1;
    }
    if (!sawContent) return "";
    if (lines.length === 0) return prefix.trimEnd();
    return prefix + lines.join("\n");
  }

  // Compose the final message list. The tool-instruction system prompt always
  // leads (the model needs it to emit tool calls), then the memory context,
  // then the (trimmed) conversation history.
  function buildAugmentedMessages(params) {
    const p = params || {};
    const messages = Array.isArray(p.messages) ? p.messages : [];
    const out = [];
    if (typeof p.toolPrompt === "string" && p.toolPrompt) {
      out.push({ role: "system", content: p.toolPrompt });
    }
    if (typeof p.memoryContext === "string" && p.memoryContext) {
      out.push({ role: "system", content: p.memoryContext });
    }
    for (const m of messages) out.push(m);
    return out;
  }

  const api = { WORLD_TAG, buildMemoryContextText, buildAugmentedMessages };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) root.ClawdMinicpmMemoryAugment = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
