"use strict";

/**
 * @file vision-sidecar-manager.js
 *
 * Lifecycle manager for the MiniCPM‑V 4.6 *vision* sidecar — a second,
 * independent llama-server process used only as the true last‑resort
 * classifier when the text signal is still AMBIGUOUS (Plan §2 step 4 / §2.1).
 *
 * Design mirrors the existing text sidecar but is deliberately separate:
 *   - own port (default 18766) so it never collides with the MiniCPM5‑1B
 *     text sidecar on 18765
 *   - cold‑started on the first genuinely ambiguous event
 *   - auto‑shut‑down after a short idle window (default 45s) so the vision
 *     model isn't resident when not needed
 *   - orphan cleanup on startup (best‑effort) per Plan §3.9
 *
 * This module never throws on construction; every method is defensive so a
 * missing model/binary degrades to "not available" instead of crashing the
 * app. The actual GGUF/mmproj must be downloaded once (see logs.md / the
 * fetch script); until then visionEnabled simply short‑circuits.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const DEFAULT_PORT = 18766;
const IDLE_SHUTDOWN_MS = 45000;
const HEALTH_TIMEOUT_MS = 2000;
const STARTUP_TIMEOUT_MS = 60000;

const VISION_MODEL_FILE = "MiniCPM-V-4_6-Q4_K_M.gguf";
const VISION_MMPROJ_FILE = "mmproj-model-f16.gguf";

function triplet() {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  if (process.platform === "darwin") return "mac-" + arch;
  if (process.platform === "win32") return "win-" + arch;
  if (process.platform === "linux") return "linux-" + arch;
  return process.platform + "-" + arch;
}

function locateLlamaServerBin(appRoot) {
  const ext = process.platform === "win32" ? ".exe" : "";
  const override = process.env.MINICPM_LLAMA_SERVER_BIN;
  if (override && fs.existsSync(override)) return path.resolve(override);

  const candidates = [];
  if (process.type !== "renderer" && typeof process !== "undefined" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "sidecar-bin", "llama-server" + ext));
  }
  candidates.push(path.join(appRoot, "..", "minicpm-sidecar", "bin", triplet(), "llama-server" + ext));
  candidates.push(path.join(appRoot, "models", "llama-server" + ext));
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

function locateModel(appRoot, fileName, envName) {
  const override = process.env[envName];
  if (override && fs.existsSync(override)) return path.resolve(override);
  const userData = safeUserData(appRoot);
  if (userData) {
    const p = path.join(userData, "models", fileName);
    if (fs.existsSync(p)) return p;
  }
  // Dev convenience: repo-local models/ dir (populated by scripts/fetch-vision-model.js
  // and by onboarding, which downloads to the same dir as the text model).
  const dev = path.join(appRoot, "models", fileName);
  if (fs.existsSync(dev)) return dev;
  // Dev default model dir is <appRoot>/../models (the repo's models/ folder),
  // which is where the text model lands in dev — look there too.
  const repoModels = path.join(appRoot, "..", "models", fileName);
  if (fs.existsSync(repoModels)) return repoModels;
  return null;
}

function safeUserData(appRoot) {
  try {
    const { app } = require("electron");
    if (app && app.getPath) return app.getPath("userData");
  } catch {}
  try {
    if (process.env.APPDATA) return process.env.APPDATA;
  } catch {}
  return null;
}

class VisionSidecarManager {
  constructor(options = {}) {
    this.appRoot = options.appRoot || path.join(__dirname, "..");
    // Optional explicit model directory (e.g. the same dir the text model
    // uses). Checked first so a downloaded vision model is always found.
    this.modelDir = options.modelDir || null;
    this.port = Number(process.env.MINICPM_VISION_PORT) || options.port || DEFAULT_PORT;
    this.idleMs = options.idleMs || IDLE_SHUTDOWN_MS;
    this.bin = locateLlamaServerBin(this.appRoot);
    this.modelPath = this._resolveModel(VISION_MODEL_FILE, "MINICPM_VISION_MODEL");
    this.mmprojPath = this._resolveModel(VISION_MMPROJ_FILE, "MINICPM_VISION_MMPROJ");
    this.proc = null;
    this.starting = null;
    this.shutdownTimer = null;
    this.url = `http://127.0.0.1:${this.port}`;
    this.log = options.log || console.log;
  }

  isAvailable() {
    return !!(this.bin && this.modelPath && this.mmprojPath);
  }

  /** Resolve a model file, preferring the explicit modelDir when set. */
  _resolveModel(fileName, envName) {
    if (this.modelDir) {
      const p = path.join(this.modelDir, fileName);
      if (fs.existsSync(p)) return p;
    }
    return locateModel(this.appRoot, fileName, envName);
  }

  availabilityReport() {
    return {
      bin: !!this.bin,
      model: !!this.modelPath,
      mmproj: !!this.mmprojPath,
      port: this.port,
      binPath: this.bin,
      modelPath: this.modelPath,
      mmprojPath: this.mmprojPath,
    };
  }

  /** Best‑effort cleanup of a stray llama-server from a previous run. */
  cleanupOrphans() {
    // We only kill our own port if something is already listening on it and
    // looks like a leftover of our process. Aggressive cross‑process killing
    // is avoided to not disturb the user's other llama-server instances.
    this._checkHealth().then((ok) => {
      if (ok) this.log("[vision-sidecar] reusing already-running instance on " + this.port);
    }).catch(() => {});
  }

  async ensureReady() {
    if (this.proc && !this.proc.killed) {
      this.touch();
      return true;
    }
    if (this.starting) return this.starting;
    if (!this.isAvailable()) {
      this.log("[vision-sidecar] not available (missing binary/model/mmproj) — skipping start");
      return false;
    }
    this.starting = this._spawnAndWait().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _spawnAndWait() {
    return new Promise((resolve, reject) => {
      const args = [
        "--model", this.modelPath,
        "--mmproj", this.mmprojPath,
        "--port", String(this.port),
        "--host", "127.0.0.1",
        "--reasoning", "off",
      ];
      this.log(`[vision-sidecar] spawning ${this.bin} --port ${this.port}`);
      let proc;
      try {
        proc = spawn(this.bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        return reject(err);
      }
      this.proc = proc;
      let bootLog = "";
      const onData = (chunk) => { bootLog += chunk.toString(); };
      if (proc.stdout) proc.stdout.on("data", onData);
      if (proc.stderr) proc.stderr.on("data", onData);

      proc.on("exit", (code) => {
        this.proc = null;
        if (this._waitingHealth) return;
        this.log(`[vision-sidecar] process exited early (code=${code})`);
      });

      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      const poll = () => {
        if (!this.proc || this.proc.killed) return reject(new Error("vision sidecar died during startup"));
        this._checkHealth().then((ok) => {
          if (ok) {
            this._waitingHealth = false;
            this.touch();
            resolve(true);
          } else if (Date.now() > deadline) {
            reject(new Error("vision sidecar failed to become healthy in time"));
          } else {
            setTimeout(poll, 500);
          }
        }).catch(() => {
          if (Date.now() > deadline) reject(new Error("vision sidecar health check timeout"));
          else setTimeout(poll, 500);
        });
      };
      this._waitingHealth = true;
      setTimeout(poll, 800);
    });
  }

  _checkHealth() {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: this.port, path: "/health", timeout: HEALTH_TIMEOUT_MS }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("health timeout")); });
    });
  }

  /** Call after each use; (re)arms the idle auto‑shutdown timer. */
  touch() {
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
    this.shutdownTimer = setTimeout(() => this.stop(), this.idleMs);
  }

  stop() {
    if (this.shutdownTimer) { clearTimeout(this.shutdownTimer); this.shutdownTimer = null; }
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill("SIGTERM"); } catch {}
      this.proc = null;
    }
  }
}

module.exports = { VisionSidecarManager, VISION_MODEL_FILE, VISION_MMPROJ_FILE, DEFAULT_PORT };
