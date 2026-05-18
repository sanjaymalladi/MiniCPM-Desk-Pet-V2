#!/usr/bin/env node
// Clawd — Cursor Agent hook (stdin JSON, hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.cursor/hooks.json by hooks/cursor-install.js

const fs = require("fs");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const SESSION_TITLE_MAX = 32;
const LAST_SUMMARY_MAX = 110;

function _extractText(obj) {
  let text = "";
  const content = obj && obj.message && obj.message.content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  return text;
}

function _normalize(text) {
  return text
    .replace(/<[^>]+>/g, "")            // strip XML/HTML wrappers
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _readTranscriptLines(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  try {
    return fs.readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

// First user query → conversation "title".
function extractFirstUserQuery(transcriptPath) {
  const lines = _readTranscriptLines(transcriptPath);
  if (!lines) return null;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || obj.role !== "user") continue;
    let text = _extractText(obj);
    if (!text) continue;
    const m = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
    if (m) text = m[1];
    text = _normalize(text);
    if (!text) continue;
    if (text.length > SESSION_TITLE_MAX) {
      text = text.slice(0, SESSION_TITLE_MAX - 1) + "…";
    }
    return text;
  }
  return null;
}

// Last assistant message (truncated to first sentence / 110 chars). Gives
// the narrator a sense of *what was actually decided / done*, so the pet
// can summarise the outcome instead of just acknowledging the topic.
function extractLastAssistantSummary(transcriptPath) {
  const lines = _readTranscriptLines(transcriptPath);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    if (!obj || obj.role !== "assistant") continue;
    let text = _normalize(_extractText(obj));
    if (!text) continue;
    // Try to take just the first sentence (Chinese or English).
    const stop = text.search(/[。！？!?\n]/);
    if (stop > 0 && stop < LAST_SUMMARY_MAX) text = text.slice(0, stop + 1);
    if (text.length > LAST_SUMMARY_MAX) text = text.slice(0, LAST_SUMMARY_MAX - 1) + "…";
    return text;
  }
  return null;
}

const HOOK_TO_STATE = {
  sessionStart: { state: "idle", event: "SessionStart" },
  sessionEnd: { state: "sleeping", event: "SessionEnd" },
  beforeSubmitPrompt: { state: "thinking", event: "UserPromptSubmit" },
  preToolUse: { state: "working", event: "PreToolUse" },
  postToolUse: { state: "working", event: "PostToolUse" },
  postToolUseFailure: { state: "working", event: "PostToolUseFailure" },
  subagentStart: { state: "juggling", event: "SubagentStart" },
  subagentStop: { state: "working", event: "SubagentStop" },
  preCompact: { state: "sweeping", event: "PreCompact" },
  afterAgentThought: { state: "thinking", event: "AfterAgentThought" },
};

const config = getPlatformConfig({ extraTerminals: { win: ["cursor.exe"] } });
const resolve = createPidResolver({
  agentNames: { win: new Set(["cursor.exe"]), mac: new Set(["cursor"]), linux: new Set(["cursor"]) },
  platformConfig: config,
});

function stdoutForCursorHook(hookName) {
  // Only respond with continue for prompt submission; don't override Cursor's permission system
  if (hookName === "beforeSubmitPrompt") return JSON.stringify({ continue: true });
  return "{}";
}

/** Maps Cursor preToolUse/postToolUse tool_name to assets/svg basenames (see state.js DISPLAY_HINT_SVGS). */
function displaySvgFromToolHook(hookName, payload) {
  if (hookName !== "preToolUse" && hookName !== "postToolUse") return undefined;
  const name = payload && payload.tool_name;
  if (!name || typeof name !== "string") return undefined;
  if (name === "Shell" || name.startsWith("MCP:")) return "clawd-working-building.svg";
  if (name === "Task") return "clawd-headphones-groove.svg";
  if (name === "Write" || name === "Delete") return "clawd-working-typing.svg";
  if (name === "Read" || name === "Grep") return "clawd-idle-reading.svg";
  return undefined;
}

function resolveStateAndEvent(payload, hookName) {
  if (!hookName) return null;
  if (hookName === "stop") {
    const st = payload && payload.status;
    if (st === "error") return { state: "error", event: "StopFailure" };
    return { state: "attention", event: "Stop" };
  }
  return HOOK_TO_STATE[hookName] || null;
}

readStdinJson().then((payload) => {
  const argvOverride = process.argv[2];
  const hookNameResolved = argvOverride || (payload && payload.hook_event_name) || "";
  const mapped = resolveStateAndEvent(payload, hookNameResolved);
  if (!mapped) {
    process.stdout.write(stdoutForCursorHook(hookNameResolved) + "\n");
    process.exit(0);
    return;
  }

  const { state, event } = mapped;
  if (hookNameResolved === "sessionStart" && !process.env.CLAWD_REMOTE) resolve();

  const sessionId =
    (payload && (payload.conversation_id || payload.session_id)) || "default";
  let cwd = (payload && payload.cwd) || "";
  if (!cwd && payload && Array.isArray(payload.workspace_roots) && payload.workspace_roots[0]) {
    cwd = payload.workspace_roots[0];
  }

  const { stablePid, agentPid, detectedEditor, pidChain } = resolve();

  const body = { state, session_id: sessionId, event };
  body.agent_id = "cursor-agent";
  const hint = displaySvgFromToolHook(hookNameResolved, payload);
  if (hint !== undefined) body.display_svg = hint;
  if (cwd) body.cwd = cwd;
  // Attach conversation context so the narrator can summarise rather than
  // just acknowledge:
  //   session_title : first user message (the topic)
  //   last_summary  : last assistant message (what actually got done)
  if ((hookNameResolved === "stop" || hookNameResolved === "sessionEnd") && payload) {
    const title = extractFirstUserQuery(payload.transcript_path);
    if (title) body.session_title = title;
    const lastSummary = extractLastAssistantSummary(payload.transcript_path);
    if (lastSummary) body.last_summary = lastSummary;
  }
  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    body.source_pid = stablePid;
    body.editor = detectedEditor || "cursor";
    if (agentPid) {
      body.agent_pid = agentPid;
      body.cursor_pid = agentPid;
    }
    if (pidChain.length) body.pid_chain = pidChain;
  }

  const outLine = stdoutForCursorHook(hookNameResolved);
  postStateToRunningServer(JSON.stringify(body), { timeoutMs: 100 }, () => {
    process.stdout.write(outLine + "\n");
    process.exit(0);
  });
});
