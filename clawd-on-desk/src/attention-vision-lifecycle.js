"use strict";

/**
 * @file attention-vision-lifecycle.js
 *
 * PURE lifecycle state machine for the MiniCPM‑V 4.6 *vision* sidecar
 * (Plan §2.1 / §3.9). This module contains NO electron, NO network, and NO
 * real process spawning — it is the decision logic only, so it can be
 * unit‑tested in isolation. The actual llama‑server spawn/kill lives in
 * attention‑vision‑client.js (which wires it to this state machine) and the
 * Python sidecar (minicpm-sidecar/gateway).
 *
 * Lifecycle rules (mirroring the existing Python sidecar cleanup path,
 * minicpm-sidecar/gateway/lifecycle.py `cleanup_stale_llama_server` and
 * gateway/llama_client.py `VisionLlamaServer`):
 *   - cold start on the first genuinely‑still‑ambiguous event
 *   - independent from the MiniCPM5‑1B text sidecar (different port/pid file)
 *   - idle shutdown after 30–60s of inactivity (default 45s — see IDLE_*)
 *   - orphan check on next launch: detect & report leftover pids so the
 *     caller can reap them (defensive: alive AND process name matches)
 *
 * Timing is fully injectable via the `now` option so tests are deterministic.
 */

const IDLE_MIN_MS = 30000;
const IDLE_MAX_MS = 60000;
const DEFAULT_IDLE_MS = 45000;

const DEFAULT_ORPHAN_NAME = "llama-server-vision";

class VisionSidecarLifecycle {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] - injectable clock (ms). Defaults to Date.now().
   * @param {number} [options.idleMs] - idle shutdown threshold; clamped to [30000, 60000].
   * @param {Function} [options.onStart] - called on a successful cold start.
   * @param {Function} [options.onShutdown] - called when the sidecar shuts down.
   */
  constructor(options = {}) {
    this._now = typeof options.now === "function" ? options.now : () => Date.now();
    this._idleMs = VisionSidecarLifecycle._clampIdle(
      options.idleMs != null ? options.idleMs : DEFAULT_IDLE_MS
    );
    this._onStart = typeof options.onStart === "function" ? options.onStart : null;
    this._onShutdown = typeof options.onShutdown === "function" ? options.onShutdown : null;

    this._running = false;
    this._lastUsedAt = 0;
  }

  static _clampIdle(ms) {
    if (!Number.isFinite(ms)) return DEFAULT_IDLE_MS;
    if (ms < IDLE_MIN_MS) return IDLE_MIN_MS;
    if (ms > IDLE_MAX_MS) return IDLE_MAX_MS;
    return ms;
  }

  /**
   * Start the sidecar on the first ambiguous event. Idempotent: repeated
   * calls while already running do NOT double‑start (returns false).
   * @returns {boolean} true if this call performed the (cold) start.
   */
  coldStart() {
    if (this._running) return false;
    this._running = true;
    this._lastUsedAt = this._now();
    if (this._onStart) this._onStart();
    return true;
  }

  /**
   * Explicitly stop the sidecar (e.g. on app quit), bypassing the idle timer.
   * @returns {boolean} true if a running sidecar was stopped.
   */
  shutdownNow() {
    if (!this._running) return false;
    this._running = false;
    this._lastUsedAt = 0;
    if (this._onShutdown) this._onShutdown();
    return true;
  }

  /**
   * If the sidecar has been idle for >= idleMs, shut it down. Typically
   * polled by a timer in attention-vision-client.js.
   * @param {number} [idleMs] - override the idle threshold (clamped to range).
   * @returns {boolean} true if an idle sidecar was shut down on this call.
   */
  shutdownAfterIdle(idleMs) {
    const ms = VisionSidecarLifecycle._clampIdle(idleMs != null ? idleMs : this._idleMs);
    if (!this._running) return false;
    if (this._now() - this._lastUsedAt >= ms) {
      this._running = false;
      this._lastUsedAt = 0;
      if (this._onShutdown) this._onShutdown();
      return true;
    }
    return false;
  }

  /**
   * Record that the sidecar was just used, resetting the idle timer.
   */
  markUsed() {
    if (this._running) this._lastUsedAt = this._now();
  }

  /**
   * @returns {boolean} whether the sidecar is currently considered running.
   */
  isRunning() {
    return this._running;
  }

  /**
   * @returns {number} timestamp (ms) of the last use, or 0 if not running.
   */
  get lastUsedAt() {
    return this._lastUsedAt;
  }

  /**
   * On next launch, detect leftover vision sidecar processes from a previous
   * crash and return the pids that should be killed.
   *
   * This reuses the defensive checks of
   * minicpm-sidecar/gateway/lifecycle.py `cleanup_stale_llama_server`:
   *   (1) the pid must be alive, AND
   *   (2) its process name must contain the expected name (guards against pid
   *       recycling pointing at an unrelated process).
   *
   * @param {Array<{pid:number, alive?:boolean, name?:string}>|number[]} pids
   *        List of candidate pids. When an element is an object, `alive`
   *        (default true) and `name` (default "") describe it; when a number,
   *        it is treated as alive with an unknown name.
   * @param {object} [options]
   * @param {string} [options.expectedName] - process name needle (default "llama-server-vision").
   * @param {(p:any)=>boolean} [options.isAlive] - injectable liveness probe for testing.
   * @returns {number[]} pids that are alive AND match the expected name.
   */
  checkOrphans(pids, options = {}) {
    const expectedName = (options.expectedName || DEFAULT_ORPHAN_NAME).toLowerCase();
    const isAlive = typeof options.isAlive === "function"
      ? options.isAlive
      : (p) => (typeof p === "object" && p !== null ? (p.alive !== false) : true);

    const pidOf = (p) => (typeof p === "object" && p !== null ? p.pid : p);
    const nameOf = (p) =>
      (typeof p === "object" && p !== null && p.name ? String(p.name) : "").toLowerCase();

    const toKill = [];
    for (const p of pids || []) {
      if (!isAlive(p)) continue; // dead → not a killable orphan
      if (nameOf(p).includes(expectedName)) {
        toKill.push(pidOf(p));
      }
    }
    return toKill;
  }
}

module.exports = {
  VisionSidecarLifecycle,
  IDLE_MIN_MS,
  IDLE_MAX_MS,
  DEFAULT_IDLE_MS,
};
