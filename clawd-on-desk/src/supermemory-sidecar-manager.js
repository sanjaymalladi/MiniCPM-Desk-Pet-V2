"use strict";

// ── Supermemory sidecar manager (main process) ──
//
// Launches and supervises the always-on Supermemory binary as a fourth local
// sidecar (plan §1.2, new requirement: "backend always running"). The Electron
// app is the parent, so lifecycle is owned directly here (no separate PID-file
// watchdog like the Python inference sidecar needs).
//
// On first boot `supermemory-server` prints a banner:
//     url       http://localhost:6767
//     database  ./.supermemory
//     api key   sm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// We scrape the url + api key from that banner so the REST client can be wired
// up without manual config.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const {
  DEFAULT_SIDECAR_LAUNCH,
  SUPERMEMORY_DEFAULT_HOST,
  SUPERMEMORY_DEFAULT_PORT,
  MEMORY_DEFAULTS,
} = require("./memory-constants");

// Pure: pull url / apiKey / database out of the boot banner. Returns
// { url, apiKey, database } with nulls for anything not yet seen.
function parseBootOutput(text) {
  const out = { url: null, apiKey: null, database: null };
  if (!text || typeof text !== "string") return out;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const urlM = line.match(/url\s+(https?:\/\/[^\s]+)/i);
    if (urlM && !out.url) out.url = urlM[1].replace(/\/+$/, "");
    const keyM = line.match(/api\s*key\s+(sm_[^\s]+)/i);
    if (keyM && !out.apiKey) out.apiKey = keyM[1];
    const dbM = line.match(/database\s+(\S+)/i);
    if (dbM && !out.database) out.database = dbM[1];
  }
  return out;
}

// Build the env for the child: point Supermemory's extraction/summarize LLM at
// the MiniCPM5-1B sidecar (OpenAI-compatible) and optionally set the data dir.
function buildSidecarEnv({ llmBaseUrl, llmApiKey, dataDir, baseEnv } = {}) {
  const env = baseEnv || process.env;
  const next = Object.assign({}, env);
  if (llmBaseUrl) next.OPENAI_BASE_URL = llmBaseUrl;
  if (llmApiKey) next.OPENAI_API_KEY = llmApiKey;
  if (dataDir) next.SUPERMEMORY_DATA_DIR = dataDir;
  return next;
}

// On Windows the Electron child process can't resolve bare `npx` / `supermemory`
// (only the `*.cmd` shims exist, and the npm global bin may be absent from its
// PATH). Resolve the Supermemory shim to an absolute path so we can launch it
// via `cmd /c`. Returns `{ command, args }` for spawn, or null if unresolved.
function resolveWindowsLaunch(command, args) {
  const base = command === "npx" ? "supermemory" : command;
  const candidates = [];
  const dirs = [];
  for (const d of (process.env.PATH || "").split(path.delimiter)) {
    if (d) dirs.push(d);
  }
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
  for (const d of dirs) {
    candidates.push(path.join(d, `${base}.cmd`), path.join(d, `${base}.ps1`),
      path.join(d, `${base}.bat`), path.join(d, base));
  }
  let shim = null;
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { shim = c; break; } } catch (_) { /* noop */ }
  }
  if (!shim) {
    // Fall back to running through cmd so PATHEXT/Path can resolve it.
    return { command: "cmd.exe", args: ["/c", command, ...args] };
  }
  return { command: "cmd.exe", args: ["/c", shim, ...args.slice(1)] };
}

class SupermemorySidecarManager {
  constructor(options = {}) {
    const launch = options.launch || DEFAULT_SIDECAR_LAUNCH;
    this.command = options.command || launch.command;
    this.args = Array.isArray(options.args) ? options.args : launch.args;
    this.llmBaseUrl = options.llmBaseUrl || MEMORY_DEFAULTS.llmBaseUrl;
    this.llmApiKey = options.llmApiKey || MEMORY_DEFAULTS.llmApiKey;
    this.dataDir = options.dataDir || "";
    this.cwd = options.cwd || null;
    // Injectable so tests can fake the process + a fetch for health checks.
    this.spawnImpl = typeof options.spawnImpl === "function" ? options.spawnImpl : spawn;
    this.fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : null;
        this.healthIntervalMs = Number.isFinite(options.healthIntervalMs) ? options.healthIntervalMs : 5000;
        this.bootTimeoutMs = Number.isFinite(options.bootTimeoutMs) ? options.bootTimeoutMs : 30000;
        // Retry the boot a few times with backoff. The Supermemory sidecar
        // needs the llama-server (OPENAI_BASE_URL) to be up; at app launch the
        // inference sidecar may still be loading its weights, so the first boot
        // attempt can exit before it's ready.
        this.bootRetries = Number.isFinite(options.bootRetries) ? options.bootRetries : 6;
        this.bootRetryDelayMs = Number.isFinite(options.bootRetryDelayMs) ? options.bootRetryDelayMs : 8000;
    this.logger = options.logger || (() => {});

    this.child = null;
    this.baseUrl = null;
    this.apiKey = null;
    this.database = null;
    this._healthTimer = null;
    this._bootTimer = null;
    this._onCredentials = typeof options.onCredentials === "function" ? options.onCredentials : null;
    this._stdoutBuf = "";
  }

  isRunning() {
    return !!(this.child && !this.child.killed && this.child.exitCode === null);
  }

  getBaseUrl() {
    return this.baseUrl || `http://${SUPERMEMORY_DEFAULT_HOST}:${SUPERMEMORY_DEFAULT_PORT}`;
  }

  getApiKey() {
    return this.apiKey || "";
  }

  _ingestStdout(chunk) {
    const text = chunk.toString();
    this._stdoutBuf += text;
    const creds = parseBootOutput(this._stdoutBuf);
    let changed = false;
    if (creds.url && creds.url !== this.baseUrl) { this.baseUrl = creds.url; changed = true; }
    if (creds.apiKey && creds.apiKey !== this.apiKey) { this.apiKey = creds.apiKey; changed = true; }
    if (creds.database && creds.database !== this.database) { this.database = creds.database; changed = true; }
    if (changed && typeof this._onCredentials === "function") {
      this._onCredentials({ url: this.baseUrl, apiKey: this.apiKey, database: this.database });
      if (this.baseUrl && this._bootTimer) {
        clearTimeout(this._bootTimer);
        this._bootTimer = null;
      }
    }
  }

  // Spawn the sidecar. Resolves once the boot banner (url) is observed, or after
  // bootTimeoutMs (so callers don't hang if the banner format changes). Rejects
  // if the process can't be spawned or exits before booting.
  start() {
    if (this.isRunning()) return Promise.resolve({ url: this.getBaseUrl(), apiKey: this.getApiKey() });
    const attempt = () => new Promise((resolve, reject) => {
      const env = buildSidecarEnv({
        llmBaseUrl: this.llmBaseUrl,
        llmApiKey: this.llmApiKey,
        dataDir: this.dataDir,
      });
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        if (this._bootTimer) { clearTimeout(this._bootTimer); this._bootTimer = null; }
        if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
        fn();
      };

      // Resolve a runnable command (Windows can't spawn bare `npx`/`supermemory`).
      let cmd = this.command;
      let cmdArgs = this.args;
      if (process.platform === "win32" && (cmd === "npx" || cmd === "supermemory")) {
        const resolved = resolveWindowsLaunch(cmd, cmdArgs);
        if (resolved) { cmd = resolved.command; cmdArgs = resolved.args; }
      }

      let child;
      try {
        child = this.spawnImpl(cmd, cmdArgs, {
          env,
          cwd: this.cwd || undefined,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        return reject(err);
      }
      this.child = child;

      child.stdout.on("data", (chunk) => { this.logger(`[supermemory stdout] ${chunk.toString().trim()}`); this._ingestStdout(chunk); });
      child.stderr.on("data", (chunk) => this.logger(`[supermemory stderr] ${chunk.toString().trim()}`));

      child.on("error", (err) => {
        this.logger(`[supermemory spawn error] ${err && err.message}`);
        finish(() => reject(err));
      });
      child.on("exit", (code, signal) => {
        this.child = null;
        this._stopHealth();
        if (!settled) {
          finish(() => reject(new Error(`supermemory sidecar exited before boot (code=${code}, signal=${signal})`)));
        }
      });

      // Resolve as soon as the url shows up in the banner.
      const watch = setInterval(() => {
        if (this.baseUrl) {
          clearInterval(watch);
          this._watchTimer = null;
          finish(() => resolve({ url: this.baseUrl, apiKey: this.apiKey }));
        }
      }, 200);
      this._watchTimer = watch;

      this._bootTimer = setTimeout(() => {
        clearInterval(watch);
        // If we at least have a url, treat as booted; otherwise give up.
        if (this.baseUrl) {
          finish(() => resolve({ url: this.baseUrl, apiKey: this.apiKey }));
        } else {
          finish(() => reject(new Error("supermemory sidecar boot timed out")));
        }
      }, this.bootTimeoutMs);
    });

    // Retry the boot with backoff so a transient failure (e.g. the
    // llama-server isn't ready yet at app launch) doesn't permanently
    // disable the always-on memory backend.
    const maxAttempts = this.bootRetries;
    const delayMs = this.bootRetryDelayMs;
    const run = async () => {
      let lastErr;
      for (let i = 1; i <= maxAttempts; i++) {
        try { return await attempt(i); }
        catch (err) {
          lastErr = err;
          this.logger(`[supermemory] boot attempt ${i}/${maxAttempts} failed: ${err && err.message}`);
          if (i < maxAttempts) await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      throw lastErr;
    };
    return run();
  }

  _startHealth(healthFn) {
    this._stopHealth();
    this._healthTimer = setInterval(() => {
      if (!this.isRunning()) { this._stopHealth(); return; }
      Promise.resolve(healthFn()).catch(() => {});
    }, this.healthIntervalMs);
    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  _stopHealth() {
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
  }

  // Stop the sidecar (e.g. on app quit). Returns a promise that resolves once
  // the process has actually exited.
  stop() {
    this._stopHealth();
    if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
    if (this._bootTimer) { clearTimeout(this._bootTimer); this._bootTimer = null; }
    if (!this.child) return Promise.resolve(false);
    return new Promise((resolve) => {
      const child = this.child;
      const onExit = () => { this.child = null; resolve(true); };
      child.once("exit", onExit);
      try {
        child.kill("SIGTERM");
      } catch (e) {
        // already gone
        this.child = null;
        resolve(false);
      }
      // Hard kill fallback.
      setTimeout(() => {
        if (child.exitCode === null) {
          try { child.kill("SIGKILL"); } catch (_) { /* noop */ }
        }
      }, 5000);
    });
  }
}

module.exports = { SupermemorySidecarManager, parseBootOutput, buildSidecarEnv };
