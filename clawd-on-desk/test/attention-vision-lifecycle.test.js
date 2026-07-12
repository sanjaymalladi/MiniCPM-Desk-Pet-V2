"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const {
  VisionSidecarLifecycle,
  IDLE_MIN_MS,
  IDLE_MAX_MS,
  DEFAULT_IDLE_MS,
} = require("../src/attention-vision-lifecycle");

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

test("cold start sets running and records lastUsedAt", () => {
  const clock = fakeClock();
  const lc = new VisionSidecarLifecycle({ now: clock.now });
  assert.strictEqual(lc.isRunning(), false);

  const started = lc.coldStart();
  assert.strictEqual(started, true);
  assert.strictEqual(lc.isRunning(), true);
  assert.strictEqual(lc.lastUsedAt, clock.now());

  const shutdown = lc.shutdownNow();
  assert.strictEqual(shutdown, true);
  assert.strictEqual(lc.isRunning(), false);
  assert.strictEqual(lc.lastUsedAt, 0);
});

test("repeated coldStart does not double-start", () => {
  let starts = 0;
  const lc = new VisionSidecarLifecycle({ now: () => 1, onStart: () => { starts++; } });

  assert.strictEqual(lc.coldStart(), true);
  assert.strictEqual(lc.coldStart(), false);
  assert.strictEqual(lc.coldStart(), false);
  assert.strictEqual(lc.isRunning(), true);
  assert.strictEqual(starts, 1);

  lc.shutdownNow();
  assert.strictEqual(lc.coldStart(), true);
  assert.strictEqual(starts, 2);
});

test("idle timeout triggers shutdown", () => {
  const clock = fakeClock();
  const lc = new VisionSidecarLifecycle({ now: clock.now, idleMs: 45000 });

  lc.coldStart();

  clock.advance(40000);
  assert.strictEqual(lc.shutdownAfterIdle(), false, "not idle yet");
  assert.strictEqual(lc.isRunning(), true);

  clock.advance(5001);
  assert.strictEqual(lc.shutdownAfterIdle(), true, "idle elapsed");
  assert.strictEqual(lc.isRunning(), false);
  assert.strictEqual(lc.lastUsedAt, 0);
});

test("markUsed resets the idle timer", () => {
  const clock = fakeClock();
  const lc = new VisionSidecarLifecycle({ now: clock.now, idleMs: 45000 });

  lc.coldStart();
  clock.advance(44000);
  lc.markUsed();
  clock.advance(44000);

  assert.strictEqual(lc.shutdownAfterIdle(), false, "idle reset by markUsed");
  assert.strictEqual(lc.isRunning(), true);

  clock.advance(1001);
  assert.strictEqual(lc.shutdownAfterIdle(), true);
});

test("idle threshold is clamped into the 30-60s range", () => {
  assert.strictEqual(
    new VisionSidecarLifecycle({ idleMs: 1000 })._idleMs,
    IDLE_MIN_MS
  );
  assert.strictEqual(
    new VisionSidecarLifecycle({ idleMs: 999999 })._idleMs,
    IDLE_MAX_MS
  );
  assert.strictEqual(
    new VisionSidecarLifecycle({ idleMs: 45000 })._idleMs,
    DEFAULT_IDLE_MS
  );
});

test("shutdownAfterIdle is a no-op when not running", () => {
  const lc = new VisionSidecarLifecycle({ now: () => 1 });
  assert.strictEqual(lc.shutdownAfterIdle(), false);
  assert.strictEqual(lc.shutdownNow(), false);
});

test("checkOrphans returns only alive pids matching the expected name", () => {
  const lc = new VisionSidecarLifecycle({ now: () => 1 });
  const candidates = [
    { pid: 11, alive: true, name: "llama-server-vision.exe" },
    { pid: 12, alive: false, name: "llama-server-vision.exe" },
    { pid: 13, alive: true, name: "clawd-on-desk" },
    { pid: 14, alive: true, name: "llama-server" },
    { pid: 15, alive: true, name: "someuserapp" },
  ];

  const toKill = lc.checkOrphans(candidates);
  assert.deepStrictEqual(toKill, [11]);
});

test("checkOrphans supports a custom expected name and an injected liveness probe", () => {
  const lc = new VisionSidecarLifecycle({ now: () => 1 });
  const dead = new Set([5]);
  const isAlive = (p) => !dead.has(p.pid);

  const candidates = [
    { pid: 5, name: "llama-server", alive: true },
    { pid: 6, name: "llama-server --model vision.gguf" },
    { pid: 7, name: "llama-server" },
  ];

  const toKill = lc.checkOrphans(candidates, {
    expectedName: "llama-server",
    isAlive,
  });
  assert.deepStrictEqual(toKill.sort((a, b) => a - b), [6, 7]);
});

test("onStart and onShutdown callbacks fire", () => {
  const events = [];
  const lc = new VisionSidecarLifecycle({
    now: () => 1,
    onStart: () => events.push("start"),
    onShutdown: () => events.push("shutdown"),
  });
  lc.coldStart();
  lc.shutdownNow();
  assert.deepStrictEqual(events, ["start", "shutdown"]);
});
