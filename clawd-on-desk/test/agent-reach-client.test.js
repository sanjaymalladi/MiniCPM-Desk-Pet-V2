"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");

const { AgentReachClient, parseVideoId } = require("../src/agent-reach-client");

function fakeSpawn(stdout, { code = 0, errOut = "" } = {}) {
  return (command, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    setTimeout(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (errOut) child.stderr.emit("data", Buffer.from(errOut));
      child.emit("close", code);
    }, 5);
    return child;
  };
}

describe("parseVideoId", () => {
  it("extracts an id from urls and bare ids", () => {
    assert.strictEqual(parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
    assert.strictEqual(parseVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
    assert.strictEqual(parseVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });
  it("returns null for junk", () => {
    assert.strictEqual(parseVideoId("not a video"), null);
  });
});

describe("AgentReachClient", () => {
  it("runs webSearch and returns stdout", async () => {
    const c = new AgentReachClient({ spawnImpl: fakeSpawn("result text") });
    const out = await c.webSearch("llm fine-tuning");
    assert.strictEqual(out, "result text");
  });

  it("fetches a transcript via youtube_transcript_api", async () => {
    const c = new AgentReachClient({ spawnImpl: fakeSpawn("hello world transcript") });
    const out = await c.youtubeTranscript("https://youtu.be/dQw4w9WgXcQ");
    assert.strictEqual(out, "hello world transcript");
  });

  it("rejects on non-zero exit", async () => {
    const c = new AgentReachClient({ spawnImpl: fakeSpawn("", { code: 1, errOut: "boom" }) });
    await assert.rejects(() => c.webSearch("x"), /exited 1/);
  });
});
