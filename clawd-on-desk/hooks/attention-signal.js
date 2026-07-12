"use strict";

// Sends Attention Companion signals (stuck-detection, commit/PR completion)
// from an agent hook subprocess to the running Clawd HTTP server. Fire-and-forget
// and never throws — a missing/dead server must never block the agent.

const http = require("http");
const { readRuntimePort } = require("./server-config");

function postSignal(port, signal) {
  const data = JSON.stringify(signal);
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: "/attention-signal",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    },
    (res) => { res.resume(); }
  );
  req.setTimeout(500, () => req.destroy());
  req.on("error", () => {});
  req.write(data);
  req.end();
}

function sendAttentionSignal(signal) {
  try {
    const port = readRuntimePort();
    if (!port || !signal || !signal.kind) return;
    postSignal(port, signal);
  } catch (e) {}
}

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "NotebookRead"]);

// Map a Claude Code hook event to an Attention Companion signal, or null.
function signalFromClaudeEvent(event, payload) {
  if (!payload || typeof payload !== "object") return null;
  if (event === "UserPromptSubmit") {
    const q = payload.prompt;
    if (typeof q === "string" && q) return { kind: "query", tool: "claude-code", question: q.slice(0, 2000) };
  }
  if (event === "PostToolUse" && typeof payload.tool_name === "string") {
    const tool = payload.tool_name;
    const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
    if (WRITE_TOOLS.has(tool)) {
      const p = input.file_path || input.notebook_path;
      if (p) return { kind: "write", path: String(p) };
    }
    if (READ_TOOLS.has(tool)) {
      const p = input.file_path || input.notebook_path;
      if (p) return { kind: "doc", docId: String(p) };
    }
    if (tool === "Bash" && typeof input.command === "string" && /\bgit\s+commit\b/.test(input.command)) {
      return { kind: "commit" };
    }
  }
  return null;
}

module.exports = { sendAttentionSignal, signalFromClaudeEvent };
