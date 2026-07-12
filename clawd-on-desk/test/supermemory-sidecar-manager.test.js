"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");

const {
  SupermemorySidecarManager,
  parseBootOutput,
  buildSidecarEnv,
} = require("../src/supermemory-sidecar-manager");

describe("parseBootOutput", () => {
  const BANNER = [
    "  url       http://localhost:6767",
    "  database  ./.supermemory",
    "  api key   sm_abc123def456ghi789",
  ].join("\n");

  it("extracts url, api key, and database from the boot banner", () => {
    const creds = parseBootOutput(BANNER);
    assert.strictEqual(creds.url, "http://localhost:6767");
    assert.strictEqual(creds.apiKey, "sm_abc123def456ghi789");
    assert.strictEqual(creds.database, "./.supermemory");
  });

  it("returns nulls for missing fields", () => {
    const creds = parseBootOutput("nothing useful here");
    assert.strictEqual(creds.url, null);
    assert.strictEqual(creds.apiKey, null);
    assert.strictEqual(creds.database, null);
  });

  it("parses incrementally across multiple chunks", () => {
    assert.strictEqual(parseBootOutput("  url       http://localhost:6767").url, "http://localhost:6767");
    assert.strictEqual(parseBootOutput("  api key   sm_zzz").apiKey, "sm_zzz");
  });
});

describe("buildSidecarEnv", () => {
  it("injects the LLM endpoint + api key and optional data dir", () => {
    const env = buildSidecarEnv({
      llmBaseUrl: "http://127.0.0.1:18766/v1",
      llmApiKey: "local",
      dataDir: "/tmp/sm",
      baseEnv: { PATH: "/usr/bin" },
    });
    assert.strictEqual(env.OPENAI_BASE_URL, "http://127.0.0.1:18766/v1");
    assert.strictEqual(env.OPENAI_API_KEY, "local");
    assert.strictEqual(env.SUPERMEMORY_DATA_DIR, "/tmp/sm");
    assert.strictEqual(env.PATH, "/usr/bin");
  });
});

// Fake child process: emits a banner on stdout shortly after spawn, and supports
// kill() -> exit. Lets us exercise start()/stop() without spawning anything.
function fakeChild(bannerChunks) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = (sig) => {
    child.killed = true;
    child.exitCode = 0;
    setTimeout(() => child.emit("exit", 0, sig), 0);
    return true;
  };
  if (bannerChunks) {
    setTimeout(() => {
      for (const c of bannerChunks) child.stdout.emit("data", Buffer.from(c));
    }, 10);
  }
  return child;
}

function makeSpawn(bannerChunks) {
  return (command, args, opts) => fakeChild(bannerChunks);
}

describe("SupermemorySidecarManager lifecycle", () => {
  it("starts and discovers credentials from the banner", async () => {
    const mgr = new SupermemorySidecarManager({
      spawnImpl: makeSpawn(["  url       http://localhost:6767\n", "  api key   sm_testkey\n"]),
      bootTimeoutMs: 2000,
    });
    const creds = await mgr.start();
    assert.strictEqual(creds.url, "http://localhost:6767");
    assert.strictEqual(creds.apiKey, "sm_testkey");
    assert.strictEqual(mgr.isRunning(), true);
    assert.strictEqual(mgr.getBaseUrl(), "http://localhost:6767");
    await mgr.stop();
    assert.strictEqual(mgr.isRunning(), false);
  });

  it("rejects if the process exits before booting", async () => {
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.exitCode = null;
      child.kill = () => {};
      setTimeout(() => child.emit("exit", 1, null), 5);
      return child;
    };
    const mgr = new SupermemorySidecarManager({ spawnImpl, bootTimeoutMs: 2000 });
    await assert.rejects(() => mgr.start(), /exited before boot/);
  });

  it("resolves via boot timeout fallback if only the url appears", async () => {
    const mgr = new SupermemorySidecarManager({
      spawnImpl: makeSpawn(["  url       http://localhost:6767\n"]),
      bootTimeoutMs: 400,
    });
    const creds = await mgr.start();
    assert.strictEqual(creds.url, "http://localhost:6767");
    await mgr.stop();
  });
});
