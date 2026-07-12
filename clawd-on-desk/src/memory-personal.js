"use strict";

// ── Personal memory (plan §1.4) ──
//
// Maps the v2 tiers onto Supermemory's personal container:
//   Tier 1 — task-scoped ephemeral (auto-forgotten when the task ends)
//   Tier 2 — daily rolling recent-context (the dynamic half of the profile)
//   Tier 3 — long-term durable facts (keyword-triggered saves / confirmations)
//
// Distillation rule (plan §1.4, §10): only DISTILLED output ever reaches
// Supermemory. recordTaskStart/recordTaskEnd take a raw event, distill it, and
// store the summary — never the raw hook payload.

const { CONTAINER_TAGS, DEFAULT_REMEMBER_TRIGGERS } = require("./memory-constants");

// Pure: condense a raw task-state event into one short line. Keeps only the
// fields that are useful as memory; drops raw transcripts, tool I/O, secrets.
function distillTaskEvent(event) {
  if (!event || typeof event !== "object") return "";
  const agent = event.agent || event.agentId || "agent";
  const kind = event.type || event.kind || "task";
  const label = event.label || event.summary || event.task || "";
  const status = event.status || (event.done ? "done" : event.error ? "error" : "");
  const parts = [`${agent}: ${kind}`];
  if (label) parts.push(label);
  if (status) parts.push(`(${status})`);
  return parts.join(" — ");
}

// Pure: detect an explicit "remember this" intent in free text.
function detectRememberIntent(text, triggers) {
  const list = Array.isArray(triggers) ? triggers : DEFAULT_REMEMBER_TRIGGERS;
  const n = String(text || "").toLowerCase();
  return list.some((t) => n.includes(String(t).toLowerCase()));
}

class PersonalMemory {
  constructor({ client, privacy, ttlMs = 1000 * 60 * 60 * 4 } = {}) {
    this.client = client;
    this.privacy = privacy || require("./memory-privacy");
    this.ttlMs = ttlMs;
    // taskId -> ephemeral Supermemory doc id (for auto-forget on task end)
    this._ephemeral = new Map();
  }

  _now() {
    return Date.now();
  }

  // Tier 1: mark a task as started. Stores an ephemeral doc we delete on end.
  async recordTaskStart({ taskId, label } = {}) {
    if (!taskId) throw new Error("recordTaskStart requires taskId");
    const content = distillTaskEvent({ type: "task-start", label, taskId });
    const res = await this.client.add({
      content,
      category: CONTAINER_TAGS.PERSONAL,
      metadata: { tier: "tier1", taskId, expiresAt: this._now() + this.ttlMs },
    });
    const id = (res && res.data && res.data.id) || (res && res.id) || null;
    if (id) this._ephemeral.set(taskId, id);
    return res;
  }

  // Tier 2: on task end, distill into recent-context and auto-forget Tier 1.
  // Returns the distilled summary so callers can surface it (honest recap).
  async recordTaskEnd({ taskId, outcome = "done" } = {}) {
    if (!taskId) throw new Error("recordTaskEnd requires taskId");
    const summary = distillTaskEvent({ type: "task-end", taskId, status: outcome });
    const res = await this.client.add({
      content: summary,
      category: CONTAINER_TAGS.PERSONAL,
      metadata: { tier: "tier2", taskId, endedAt: this._now() },
    });
    // Auto-forget the ephemeral Tier 1 doc for this task.
    const ephemeralId = this._ephemeral.get(taskId);
    if (ephemeralId) {
      try { await this.client.deleteMemory(ephemeralId); } catch (_) { /* best-effort */ }
      this._ephemeral.delete(taskId);
    }
    return { summary, stored: res };
  }

  // Tier 3: explicit long-term save. `requiresConfirm` + `confirmed` implement
  // the "model-flagged durable facts still get a confirmation" rule — the
  // caller owns the UI; this module just enforces it.
  async remember({ content, requiresConfirm = false, confirmed = false } = {}) {
    if (!content || typeof content !== "string") throw new Error("remember requires content");
    if (requiresConfirm && !confirmed) {
      return { needsConfirm: true };
    }
    const res = await this.client.add({
      content,
      category: CONTAINER_TAGS.PERSONAL,
      metadata: { tier: "tier3", savedAt: this._now() },
    });
    return { stored: res };
  }

  async recall({ query, limit = 10 } = {}) {
    return this.client.search({ query: query || "", category: CONTAINER_TAGS.PERSONAL, pageSize: limit });
  }

  async getProfile() {
    return this.client.getProfile();
  }

  // Remove a stored long-term fact (Tier 3 correction, plan §8).
  async forget(id) {
    if (!id) throw new Error("forget requires id");
    return this.client.deleteMemory(id);
  }
}

module.exports = { PersonalMemory, distillTaskEvent, detectRememberIntent };
