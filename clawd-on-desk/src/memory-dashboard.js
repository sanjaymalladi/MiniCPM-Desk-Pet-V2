"use strict";

// ── Supermemory UI (plan §6) ──
//
// A standalone window that lets the user browse their personal + world-knowledge
// memory, see the Supermemory knowledge graph, search, add, and delete. Design
// language follows the Supermemory brand: blue #0562EF, Geist Pixel, dot-grid
// background, bento cards, uppercase mono eyebrows.
//
// All data access goes through the memory service (the single privacy-gated
// write path), so nothing here can bypass the exclude-list.

const { BrowserWindow, nativeTheme, ipcMain } = require("electron");
const path = require("path");
const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");

const DEFAULT_WIDTH = 920;
const DEFAULT_HEIGHT = 680;
const MIN_WIDTH = 440;
const MIN_HEIGHT = 480;
const LIGHT_BG = "#f4f7ff";
const DARK_BG = "#0b1220";

const PREFS_KEYS = [
  "memoryEnabled",
  "memoryAutoLaunch",
  "memoryMuted",
  "memoryQuietStart",
  "memoryQuietEnd",
  "memoryWorldEnabled",
  "memoryGoalEnabled",
  "memoryProactiveEnabled",
  "memoryVideoEnabled",
];

function buildPrefsSnapshot(source, keys = PREFS_KEYS) {
  const out = {};
  if (typeof source === "function") {
    for (const k of keys) out[k] = source(k);
    return out;
  }
  const prefs = source && typeof source === "object" ? source : {};
  for (const k of keys) out[k] = prefs[k];
  return out;
}

module.exports = function initMemoryDashboard(ctx) {
  let win = null;
  const scheduleLater = typeof ctx.setTimeout === "function" ? ctx.setTimeout : setTimeout;

  function getService() {
    return typeof ctx.getMemoryService === "function" ? ctx.getMemoryService() : null;
  }

  function getPrefsSnapshot() {
    if (typeof ctx.getPref === "function") return buildPrefsSnapshot(ctx.getPref);
    if (typeof ctx.getPrefs === "function") return buildPrefsSnapshot(ctx.getPrefs());
    return buildPrefsSnapshot({});
  }

  function bgColor() {
    return nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG;
  }

  // ── IPC bridge ──
  function registerHandlers() {
    ipcMain.handle("memory-dashboard:get-state", async () => {
      const svc = getService();
      return {
        ready: !!(svc && typeof svc.isReady === "function" && svc.isReady()),
        mode: svc && typeof svc.getMode === "function" ? svc.getMode() : "off",
        prefs: getPrefsSnapshot(),
      };
    });

    ipcMain.handle("memory-dashboard:get-graph", async () => {
      const svc = getService();
      if (!svc || typeof svc.isReady !== "function" || !svc.isReady()) {
        return { nodes: [], edges: [], error: "memory-disabled" };
      }
      try {
        // Supermemory's profile endpoint carries the knowledge graph.
        const profile = await svc.getProfile();
        const nodes = Array.isArray(profile && profile.nodes) ? profile.nodes : [];
        const edges = Array.isArray(profile && profile.edges) ? profile.edges : [];
        if (nodes.length) return { nodes, edges };
        // Fallback: build a small graph from recent personal + world memories.
        const [personal, world] = await Promise.all([
          svc.recallPersonal({ query: "", limit: 24 }),
          svc.recallWorld({ query: "", limit: 24 }),
        ]);
        return buildFallbackGraph(personal, world);
      } catch (err) {
        return { nodes: [], edges: [], error: err && err.message ? String(err.message) : "graph-failed" };
      }
    });

    ipcMain.handle("memory-dashboard:search", async (_evt, { query = "", category, limit = 50 } = {}) => {
      const svc = getService();
      if (!svc || typeof svc.isReady !== "function" || !svc.isReady()) return [];
      try {
        const res = await svc.search({ query, category, pageSize: limit });
        return Array.isArray(res) ? res : (res && res.results) || [];
      } catch (err) {
        return [];
      }
    });

    ipcMain.handle("memory-dashboard:add", async (_evt, { content, category = "personal" } = {}) => {
      const svc = getService();
      if (!svc) return { stored: false, reason: "no-service" };
      return svc.add({ content, category });
    });

    ipcMain.handle("memory-dashboard:delete", async (_evt, { id } = {}) => {
      const svc = getService();
      if (!svc || !id) return { ok: false };
      try {
        await svc.deleteMemory(id);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err && err.message };
      }
    });

    // Live toggle of a memory pref. memoryEnabled drives start/stop of the
    // backend so the user sees the effect without a full restart.
    ipcMain.handle("memory-dashboard:set-pref", async (_evt, { key, value } = {}) => {
      if (!PREFS_KEYS.includes(key)) return { ok: false, reason: "unknown-key" };
      const setPref = ctx.setPref || ctx.applyUpdate;
      if (typeof setPref !== "function") return { ok: false, reason: "no-setter" };
      setPref(key, value);
      if (key === "memoryEnabled") {
        const svc = getService();
        try {
          if (value === true && svc && typeof svc.start === "function") await svc.start();
          else if (value !== true && svc && typeof svc.stop === "function") await svc.stop();
        } catch (err) {
          console.warn("[memory-dashboard] start/stop on toggle failed:", err && err.message);
        }
      }
      return { ok: true, value: getPrefsSnapshot()[key] };
    });
  }

  function buildFallbackGraph(personal, world) {
    const nodes = [{ id: "personal", label: "personal", kind: "hub" },
      { id: "world-knowledge", label: "world-knowledge", kind: "hub" }];
    const edges = [];
    const list = (arr) => (Array.isArray(arr) ? arr : (arr && arr.results) || []);
    for (const m of list(personal)) {
      const id = m.id || `p-${nodes.length}`;
      nodes.push({ id, label: snippet(m.content), kind: "personal" });
      edges.push({ source: "personal", target: id });
    }
    for (const m of list(world)) {
      const id = m.id || `w-${nodes.length}`;
      nodes.push({ id, label: snippet(m.content), kind: "world" });
      edges.push({ source: "world-knowledge", target: id });
    }
    return { nodes, edges };
  }

  function snippet(text, n = 28) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function createWindow() {
    const scale = clampTextScale(typeof ctx.getTextScale === "function" ? ctx.getTextScale() : 1);
    const width = scaleWidth(DEFAULT_WIDTH, scale);
    const height = scaleHeight(DEFAULT_HEIGHT, scale);
    const bounds = typeof ctx.getPetWindowBounds === "function"
      ? ctx.getPetWindowBounds()
      : { x: 0, y: 0 };
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(bounds.x, bounds.y)
      : { x: 0, y: 0, width: 1280, height: 800 };
    const w = Math.min(width, workArea.width);
    const h = Math.min(height, workArea.height);
    const x = Math.round(workArea.x + (workArea.width - w) / 2);
    const y = Math.round(workArea.y + (workArea.height - h) / 2);

    const opts = {
      x, y, width: w, height: h,
      minWidth: scaleWidth(MIN_WIDTH, scale),
      minHeight: scaleHeight(MIN_HEIGHT, scale),
      show: false,
      frame: true,
      transparent: false,
      resizable: true,
      minimizable: true,
      maximizable: true,
      skipTaskbar: false,
      alwaysOnTop: false,
      title: typeof ctx.t === "function" ? ctx.t("memoryWindowTitle") : "Supermemory",
      backgroundColor: bgColor(),
      webPreferences: {
        preload: path.join(__dirname, "preload-memory-dashboard.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    };
    if (ctx.iconPath) opts.icon = ctx.iconPath;

    win = new BrowserWindow(opts);
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, "memory-dashboard.html"));

    if (nativeTheme && typeof nativeTheme.on === "function") {
      nativeTheme.on("updated", syncBg);
    }

    win.once("ready-to-show", () => {
      if (!win || win.isDestroyed()) return;
      win.show();
      win.focus();
    });
    win.on("closed", () => {
      win = null;
      if (nativeTheme && typeof nativeTheme.removeListener === "function") {
        nativeTheme.removeListener("updated", syncBg);
      }
    });
    return win;
  }

  function syncBg() {
    if (win && !win.isDestroyed()) win.setBackgroundColor(bgColor());
  }

  function show() {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return win;
    }
    return createWindow();
  }

  registerHandlers();

  return {
    show,
    getWindow: () => win,
  };
};

module.exports.buildPrefsSnapshot = buildPrefsSnapshot;
module.exports.PREFS_KEYS = PREFS_KEYS;
