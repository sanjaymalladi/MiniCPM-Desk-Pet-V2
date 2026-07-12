"use strict";

// ── v3 Memory system: shared constants ──
//
// Single source of truth for the Supermemory integration. No Electron / HTTP
// dependencies here — pure data so it can be required by both the main process
// and the unit tests without side effects.

// Container "tags" map onto Supermemory's `category` field. The plan's two-store
// split (world-knowledge vs personal) is realized as two categories in one
// Supermemory instance, exactly as Obsidian's two-vault idea would have, minus a
// second system to run.
const CONTAINER_TAGS = Object.freeze({
  PERSONAL: "personal",
  WORLD_KNOWLEDGE: "world-knowledge",
});

const ALL_CONTAINER_TAGS = Object.freeze([
  CONTAINER_TAGS.PERSONAL,
  CONTAINER_TAGS.WORLD_KNOWLEDGE,
]);

// Supermemory self-hosted runs on :6767 by default (npx supermemory local).
const SUPERMEMORY_DEFAULT_PORT = 6767;
const SUPERMEMORY_DEFAULT_HOST = "127.0.0.1";
const SUPERMEMORY_HEALTH_PATH = "/health";

// REST endpoints (self-hosted speaks the same API as the hosted platform).
// Verified against https://supermemory.ai/llms.txt:
//   POST /v3/add      — add a memory (body: { content, category, metadata })
//   POST /v3/search   — hybrid search (body: { query, category, pageSize, page })
//   GET  /v4/profile  — stable facts + recent dynamic context
//   POST /v3/delete   — delete a memory by id (body: { id })
const ENDPOINTS = Object.freeze({
  ADD: "/v3/add",
  SEARCH: "/v3/search",
  PROFILE: "/v4/profile",
  DELETE: "/v3/delete",
});

// Where the Supermemory extraction/summarize step points its LLM. Default is the
// MiniCPM5-1B llama-server sidecar (OpenAI-compatible). Overridable via prefs so
// a user can point extraction at Ollama/LM Studio instead.
const DEFAULT_LLM_BASE_URL = "http://127.0.0.1:18766/v1";
const DEFAULT_LLM_API_KEY = "local";

// Default command used to launch the always-on sidecar. On this Windows/WSL
// box Supermemory's server is the WSL binary; set MINICPM_SUPERMEMORY_LAUNCH
// (e.g. "npx supermemory local") to override. macOS/Linux builds should export
// that env var to their platform-appropriate command.
const _envLaunch = process.env.MINICPM_SUPERMEMORY_LAUNCH;
const DEFAULT_SIDECAR_LAUNCH = Object.freeze(_envLaunch
  ? (() => { const p = _envLaunch.split(/\s+/); return { command: p[0], args: p.slice(1) }; })()
  : { command: "wsl", args: ["/root/.supermemory/bin/supermemory-server"] });

// Privacy exclude-list (plan §1.5): anything matching these app names / URLs is
// wrapped in Supermemory's <private> convention and never persisted.
const DEFAULT_EXCLUDE_LIST = Object.freeze([
  "bank",
  "chase",
  "amex",
  "paypal",
  "venmo",
  "coinbase",
  "incognito",
  "private browsing",
  "password",
  "1password",
  "bitwarden",
  "lastpass",
  "keychain",
  "onlyfans",
  "telehealth",
]);

// Keyword triggers for Tier 3 long-term "remember this" saves (plan §1.4).
const DEFAULT_REMEMBER_TRIGGERS = Object.freeze([
  "remember",
  "remember this",
  "remember that",
  "save this",
  "save that",
  "don't forget",
  "do not forget",
  "keep in mind",
  "note to self",
]);

// Idle-time world-knowledge research (plan §1.3).
const DEFAULT_WORLD_TOPICS = Object.freeze([
  "GenAI model releases",
  "LLM fine-tuning techniques",
  "local LLM inference (llama.cpp / Ollama)",
]);

// Default AI-news RSS feed pulled during idle time and distilled into
// world-knowledge (plan §1.3). User-overridable via the memoryWorldRssUrl pref.
const DEFAULT_WORLD_RSS_URL = "https://rss-feed-aggrigator.onrender.com/rss";
const DEFAULT_WORLD_RSS_TOPIC = "AI news";

// Bounded scope so a long idle stretch can't turn into unbounded scraping.
const RESEARCH_DEFAULTS = Object.freeze({
  maxFetchesPerIdleSession: 3,
  maxFetchesPerDay: 12,
  // Max RSS items distilled per idle digest (the whole digest counts as one
  // idle unit; links already seen this day are skipped to avoid re-storing).
  maxRssItemsPerFetch: 15,
  // Staleness: a world-knowledge entry older than this (ms) is flagged for
  // refresh on the next idle cycle rather than served as current.
  worldStaleMs: 1000 * 60 * 60 * 24 * 30, // 30 days
  // Per-topic fetch cooldown so we don't re-fetch the same topic every idle tick.
  topicCooldownMs: 1000 * 60 * 60 * 6, // 6 hours
  // Cooldown between RSS digest runs.
  rssCooldownMs: 1000 * 60 * 60 * 6, // 6 hours
  // Retry an asleep/503 feed a few times with backoff so we eventually get
  // the data instead of giving up for that idle cycle.
  rssMaxAttempts: 3,
  rssRetryMs: 1000 * 2, // 2s between attempts
});

// Goal countdown (plan §5): default quiet budget before the countdown surfaces,
// and a hard cap so it can't nag every single distraction event.
const GOAL_COUNTDOWN_DEFAULTS = Object.freeze({
  // Distraction must persist at least this long before the countdown appears.
  minDistractionMs: 1000 * 60 * 2, // 2 minutes
  maxSurfacesPerGoal: 6,
});

// Proactive messaging (plan §4).
const PROACTIVE_DEFAULTS = Object.freeze({
  quietHoursStart: 22, // 22:00
  quietHoursEnd: 8, // 08:00
  muted: false,
});

// Always-on behaviour: the sidecar launches at program start and stays up.
const MEMORY_DEFAULTS = Object.freeze({
  enabled: true, // auto-launch the memory backend alongside the pet (one-command)
  autoLaunch: true,
  port: SUPERMEMORY_DEFAULT_PORT,
  apiKey: "", // filled from sidecar boot output when autoLaunch is on
  dataDir: "", // empty = Supermemory default (./.supermemory beside cwd)
  llmBaseUrl: DEFAULT_LLM_BASE_URL,
  llmApiKey: DEFAULT_LLM_API_KEY,
});

function isContainerTag(tag) {
  return typeof tag === "string" && ALL_CONTAINER_TAGS.includes(tag);
}

function normalizeContainerTag(tag, fallback) {
  return isContainerTag(tag) ? tag : (fallback || CONTAINER_TAGS.PERSONAL);
}

module.exports = {
  CONTAINER_TAGS,
  ALL_CONTAINER_TAGS,
  SUPERMEMORY_DEFAULT_PORT,
  SUPERMEMORY_DEFAULT_HOST,
  SUPERMEMORY_HEALTH_PATH,
  ENDPOINTS,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_API_KEY,
  DEFAULT_SIDECAR_LAUNCH,
  DEFAULT_EXCLUDE_LIST,
  DEFAULT_REMEMBER_TRIGGERS,
  DEFAULT_WORLD_TOPICS,
  DEFAULT_WORLD_RSS_URL,
  DEFAULT_WORLD_RSS_TOPIC,
  RESEARCH_DEFAULTS,
  GOAL_COUNTDOWN_DEFAULTS,
  PROACTIVE_DEFAULTS,
  MEMORY_DEFAULTS,
  isContainerTag,
  normalizeContainerTag,
};
