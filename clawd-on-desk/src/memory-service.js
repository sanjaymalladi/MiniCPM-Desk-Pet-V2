"use strict";

// ── Memory service orchestrator (main process) ──
//
// The single object the rest of the app talks to for v3 memory. It owns the
// Supermemory sidecar manager + REST client, launches the always-on sidecar on
// start(), and exposes high-level ops. Privacy is enforced at this single write
// path so nothing private can ever reach Supermemory (plan §1.5, §10).

const { SupermemoryClient } = require("./supermemory-client");
const { SupermemorySidecarManager } = require("./supermemory-sidecar-manager");
const { PersonalMemory } = require("./memory-personal");
const privacy = require("./memory-privacy");
const path = require("path");
const fs = require("fs");
const net = require("net");
const {
  SUPERMEMORY_DEFAULT_HOST,
  CONTAINER_TAGS,
  DEFAULT_EXCLUDE_LIST,
  DEFAULT_WORLD_RSS_URL,
  DEFAULT_WORLD_RSS_TOPIC,
} = require("./memory-constants");
const { AgentReachClient } = require("./agent-reach-client");
const { WorldResearch } = require("./memory-world-research");
const { GoalCountdown } = require("./memory-goal-countdown");
const { ProactiveMessenger } = require("./memory-proactive");
const { VideoTranscript } = require("./memory-video-transcript");
const memoryAugment = require("./minicpm-memory-augment");

function initMemory(ctx = {}) {
  const getPrefs = typeof ctx.getPrefs === "function"
    ? ctx.getPrefs
    : () => (ctx.prefs && typeof ctx.prefs === "object" ? ctx.prefs : {});
  const logger = typeof ctx.logger === "function" ? ctx.logger : (msg) => {};

  let manager = null;
  let client = null;
  let personal = null;
  let started = false;
  let mode = "off";

  // ── Composed sub-services (all transport injectable via ctx) ──
  const agentReach = new AgentReachClient({
    spawnImpl: typeof ctx.spawnImpl === "function" ? ctx.spawnImpl : undefined,
    pythonCmd: ctx.pythonCmd,
    logger,
  });
  const distill = typeof ctx.distill === "function"
    ? ctx.distill
    : async (raw) => (typeof raw === "string" ? raw.slice(0, 280) : "");
  const summarize = typeof ctx.summarize === "function"
    ? ctx.summarize
    : async (t) => (typeof t === "string" ? t.slice(0, 200) : "");

  const world = new WorldResearch({
    reach: agentReach,
    distill,
    store: (o) => rememberWorld(o),
    recall: (o) => recallWorld(o),
    fetchImpl: typeof ctx.fetchImpl === "function" ? ctx.fetchImpl : undefined,
    rssUrl: getPrefs().memoryWorldRssUrl || DEFAULT_WORLD_RSS_URL,
    rssTopic: DEFAULT_WORLD_RSS_TOPIC,
  });
  // Seed topics from prefs if the user has customized them (plan §1.3.2).
  const seededTopics = (getPrefs().memoryWorldTopics || []);
  if (Array.isArray(seededTopics) && seededTopics.length) world.setTopics(seededTopics);
  const goals = new GoalCountdown({
    store: (o) => add(Object.assign({ category: CONTAINER_TAGS.PERSONAL }, o)),
    recall: (o) => recallPersonal(o),
    del: (id) => deleteMemory(id),
  });
  const proactive = new ProactiveMessenger({
    notify: typeof ctx.notify === "function" ? ctx.notify : async () => ({}),
    getPrefs: () => ({
      quietHoursStart: getPrefs().memoryQuietStart,
      quietHoursEnd: getPrefs().memoryQuietEnd,
      muted: getPrefs().memoryMuted,
    }),
  });
  const video = new VideoTranscript({
    reach: agentReach,
    summarize,
    store: (o) => add(o),
  });

  function buildClient(baseUrl, apiKey) {
    return new SupermemoryClient({
      baseUrl,
      apiKey,
      fetchImpl: typeof ctx.fetchImpl === "function" ? ctx.fetchImpl : undefined,
    });
  }

  function _ensurePersonal() {
    if (!client) throw new Error("memory service is not ready");
    if (!personal) personal = new PersonalMemory({ client, privacy });
    return personal;
  }

  // Launch the backend. Respects `memoryEnabled` and `autoLaunch` prefs:
  //   - disabled                -> no-op
  //   - enabled + autoLaunch    -> spawn the sidecar, discover url/key from banner
  //   - enabled + !autoLaunch   -> attach to an already-running server (port/key pref)
  // Credentials written by the standalone startup script that owns the
  // Supermemory server (runs independently at login). Lets the pet attach
  // without spawning its own copy.
  function credsPath() {
    const base = typeof ctx.getUserData === "function"
      ? ctx.getUserData()
      : (process.env.APPDATA || ".");
    return path.join(base, "supermemory-credentials.json");
  }
  function readCredsApiKey() {
    try {
      const j = JSON.parse(fs.readFileSync(credsPath(), "utf8"));
      return (j && j.apiKey) ? j.apiKey : "";
    } catch (_) { return ""; }
  }
  // True if something is already listening on the port (e.g. the
  // startup-script-owned server), so we should attach rather than spawn.
  function isPortListening(port) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", (e) => resolve(e && e.code === "EADDRINUSE"));
      srv.once("listening", () => { srv.close(() => resolve(false)); });
      srv.listen(port, "127.0.0.1");
    });
  }
  // Attach to an already-running server. Probes health and flips `started`
  // once reachable, so a server that comes up slightly after the pet
  // (login ordering) still gets picked up.
  function attachExternal(url, apiKey) {
    client = buildClient(url, apiKey);
    mode = "external";
    const probe = setInterval(async () => {
      try { if (client && (await client.health())) { started = true; clearInterval(probe); } }
      catch (_) { /* not up yet */ }
    }, 3000);
    if (probe.unref) probe.unref();
    return client.health()
      .then((ok) => { if (ok) started = true; return { started: ok, mode, url, apiKey }; })
      .catch(() => ({ started: false, mode, url, apiKey, reason: "waiting" }));
  }

  async function start() {
    const prefs = getPrefs();
    if (!prefs || prefs.memoryEnabled !== true) {
      mode = "off";
      return { started: false, reason: "disabled" };
    }
    const port = prefs.memoryPort || 6767;
    const url = `http://${SUPERMEMORY_DEFAULT_HOST}:${port}`;
    // If a server is already listening (the startup script owns it), attach.
    if (await isPortListening(port)) {
      const apiKey = readCredsApiKey() || prefs.memoryApiKey || "";
      return attachExternal(url, apiKey);
    }
    if (prefs.memoryAutoLaunch !== true) {
      // External-only: the script must bring the server up; probe until it is.
      const apiKey = readCredsApiKey() || prefs.memoryApiKey || "";
      return attachExternal(url, apiKey);
    }
    manager = new SupermemorySidecarManager({
      llmBaseUrl: prefs.memoryLlmBaseUrl,
      llmApiKey: prefs.memoryLlmApiKey,
      dataDir: prefs.memoryDataDir || undefined,
      logger,
      fetchImpl: typeof ctx.fetchImpl === "function" ? ctx.fetchImpl : undefined,
    });
    const creds = await manager.start();
    client = buildClient(creds.url, creds.apiKey);
    started = true;
    mode = "launched";
    return { started: true, mode, url: creds.url, apiKey: creds.apiKey };
  }

  async function stop() {
    started = false;
    mode = "off";
    personal = null;
    client = null;
    if (manager) {
      try { await manager.stop(); } catch (e) { logger(`memory stop error: ${e && e.message}`); }
      manager = null;
    }
  }

  function isReady() {
    return started && !!client;
  }

  function ensureReady() {
    if (!isReady()) throw new Error("memory service is not ready");
    return client;
  }

  // ── Single write path: enforces privacy (plan §1.5) ──
  // Private content (exclude-list match) is refused rather than stored.
  async function add(opts = {}) {
    const c = ensureReady();
    const verdict = privacy.evaluate(opts.content, { excludeList: getPrefs().memoryExcludeList || DEFAULT_EXCLUDE_LIST });
    if (!verdict.store) {
      if (verdict.private && opts.redact) {
        return c.add(Object.assign({}, opts, { content: verdict.content, private: true }));
      }
      return { stored: false, private: true, reason: verdict.reason };
    }
    return c.add(opts);
  }

  function search(opts) { return ensureReady().search(opts); }
  function list(opts) { return ensureReady().list(opts); }
  function getProfile() { return ensureReady().getProfile(); }
  function deleteMemory(id) { return ensureReady().deleteMemory(id); }
  async function health() {
    if (!client) return false;
    return client.health();
  }

  // ── RAG retrieval for the chat model (plan §3) ──
  // Hybrid search across both containers, returns a bounded context string
  // plus the raw memories so the renderer can choose how to surface them.
  async function retrieveContext(query, options = {}) {
    const prefs = getPrefs();
    if (!prefs || prefs.memoryEnabled !== true) {
      return { enabled: false, ready: false, memories: [], text: "" };
    }
    if (!isReady()) return { enabled: true, ready: false, memories: [], text: "" };
    const opts = options || {};
    const limit = Number.isFinite(opts.limit) ? opts.limit : 5;
    try {
      const [personal, world] = await Promise.all([
        ensureReady().search({ query: query || "", category: CONTAINER_TAGS.PERSONAL, pageSize: limit }),
        ensureReady().search({ query: query || "", category: CONTAINER_TAGS.WORLD_KNOWLEDGE, pageSize: limit }),
      ]);
      const memories = [
        ...(personal || []).map((m) => Object.assign({}, m, { category: CONTAINER_TAGS.PERSONAL })),
        ...(world || []).map((m) => Object.assign({}, m, { category: CONTAINER_TAGS.WORLD_KNOWLEDGE })),
      ].slice(0, limit);
      const text = memoryAugment.buildMemoryContextText(memories, { maxChars: opts.maxChars });
      return { enabled: true, ready: true, memories, text };
    } catch (e) {
      return {
        enabled: true,
        ready: true,
        memories: [],
        text: "",
        error: String((e && e.message) || e),
      };
    }
  }

  // ── Dashboard snapshot (plan §7) ──
  async function dashboardSnapshot() {
    const prefs = getPrefs();
    const enabled = !!(prefs && prefs.memoryEnabled === true);
    if (!enabled) return { enabled: false, ready: false, mode };
    if (!isReady()) return { enabled: true, ready: false, mode };
    try {
      const [personalList, worldList, profile] = await Promise.all([
        ensureReady().list({ category: CONTAINER_TAGS.PERSONAL, pageSize: 200 }),
        ensureReady().list({ category: CONTAINER_TAGS.WORLD_KNOWLEDGE, pageSize: 200 }),
        ensureReady().getProfile().catch(() => ({})),
      ]);
      const staleWorld = world.flagStale(worldList || [], Date.now()).filter((x) => x.stale).length;
      return {
        enabled: true,
        ready: true,
        mode,
        counts: { personal: (personalList || []).length, world: (worldList || []).length },
        personal: personalList || [],
        world: worldList || [],
        staleWorld,
        profile: profile || {},
      };
    } catch (e) {
      return { enabled: true, ready: true, mode, error: String((e && e.message) || e) };
    }
  }

  // Most recent video memory (summary of a watched video) — surfaced as an
  // "interesting fact" and powers the chat's `get_transcript` tool fallback.
  async function getLastVideoMemory() {
    if (!isReady()) return null;
    try {
      const list = await ensureReady().list({ category: CONTAINER_TAGS.PERSONAL, pageSize: 200 });
      const videos = (list || []).filter(
        (m) => m && m.metadata && m.metadata.tier === "video"
      );
      if (!videos.length) return null;
      const top = videos[0];
      return { content: top.content, videoId: top.metadata && top.metadata.videoId, endedAt: top.metadata && top.metadata.endedAt };
    } catch (e) {
      return null;
    }
  }

  // Transcript of the video currently playing (held, not yet summarized) if any.
  function getPendingVideoTranscript() {
    return video.getPendingTranscript ? video.getPendingTranscript() : null;
  }

  // Goal countdown snapshot for the chat's `goal_countdown` tool: active goal
  // text + human-readable remaining time.
  function getGoalCountdown() {
    const goal = goals.getActive ? goals.getActive() : null;
    if (!goal) return { active: false };
    const remainingMs = typeof goal.remainingMs === "number" ? goal.remainingMs : null;
    return {
      active: true,
      text: goal.text || "",
      deadline: goal.deadline || null,
      remainingMs,
      remaining: remainingMs == null ? null : fmtDurationSafe(remainingMs),
    };
  }
  function fmtDurationSafe(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }

  // ── Personal memory (plan §1.4) ──
  function recordTaskStart(arg) { return _ensurePersonal().recordTaskStart(arg); }
  function recordTaskEnd(arg) { return _ensurePersonal().recordTaskEnd(arg); }
  function remember(arg) { return _ensurePersonal().remember(arg); }
  function recallPersonal(arg) { return _ensurePersonal().recall(arg); }
  function forget(arg) { return _ensurePersonal().forget(arg); }

  // ── World-knowledge (plan §1.3): store a distilled research result ──
  async function rememberWorld({ content, sourceUrl, fetchedAt, confidence = 1, metadata = {} } = {}) {
    const verdict = privacy.evaluate(content, { excludeList: getPrefs().memoryExcludeList || DEFAULT_EXCLUDE_LIST });
    if (!verdict.store) return { stored: false, private: true, reason: verdict.reason };
    return ensureReady().add({
      content,
      category: CONTAINER_TAGS.WORLD_KNOWLEDGE,
      metadata: Object.assign({ sourceUrl, fetchedAt: fetchedAt || Date.now(), confidence }, metadata),
    });
  }

  function recallWorld({ query, limit = 10 } = {}) {
    return ensureReady().search({ query: query || "", category: CONTAINER_TAGS.WORLD_KNOWLEDGE, pageSize: limit });
  }

  return {
    start,
    stop,
    isReady,
    health,
    add,
    search,
    list,
    getProfile,
    deleteMemory,
    retrieveContext,
    dashboardSnapshot,
    recordTaskStart,
    recordTaskEnd,
    remember,
    recallPersonal,
    forget,
    rememberWorld,
    recallWorld,
    // ── Composed sub-services (plan §1.3, §4, §5, §6) ──
    worldResearch: world,
    digestRss: (arg) => world.digestRss(arg),
    setRssUrl: (url) => { if (world && typeof world.setRssUrl === "function") world.setRssUrl(url); return { ok: true }; },
    goals,
    proactive,
    video,
    agentReach,
    // Convenience pass-throughs
    researchTick: async (arg) => {
      const web = await world.tick(arg);
      if (!arg || !arg.isIdle) return web;
      try {
        const rss = await world.digestRss(arg);
        return { web, rss };
      } catch (e) {
        return { web, rss: { skipped: "error", error: String((e && e.message) || e) } };
      }
    },
    resetResearchIdle: () => world.resetIdleSession(),
    setResearchTopics: (topics) => { world.setTopics(topics); return { ok: true }; },
    flagStaleWorld: (entries, now) => world.flagStale(entries, now),
    setGoal: (arg) => goals.setGoal(arg),
    loadActiveGoal: () => goals.loadActive(),
    goalDistraction: (ms, now) => goals.onDistraction(ms, now),
    resolveGoal: (sig) => goals.resolve(sig),
    getActiveGoal: () => goals.getActive(),
    deliverProactive: (msg, meta) => proactive.deliver(msg, meta),
    videoStart: (id) => video.onVideoStart(id),
    videoEnd: () => video.onVideoEnd(),
    videoClose: () => video.onCloseEarly(),
    ingestExternalVideo: (arg) => video.ingestExternal(arg || {}),
    getLastVideoMemory,
    getPendingVideoTranscript,
    getGoalCountdown,
    // Proactive message builders (plan §4) — used by attention-decision.
    buildProactiveCheckIn: (profile) => proactive.buildCheckIn(profile || {}),
    buildProactiveRelevant: (entries) => proactive.buildRelevant(entries || []),
    getClient: () => client,
    getMode: () => mode,
  };
}

module.exports = { initMemory };
