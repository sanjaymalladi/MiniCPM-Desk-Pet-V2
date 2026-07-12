"use strict";

// ── Agent Reach bridge (plan §1.3, §6.1) ──
//
// Agent Reach is an open-source, key-free research surface (web / GitHub /
// Reddit / RSS). We drive it out-of-process via child_process (user-approved
// fallback). YouTube transcripts specifically use the `youtube-transcript-api`
// Python package, also spawned as a child process.
//
// All transport is injectable (spawnImpl) so the units can run without the real
// CLI installed.

const { spawn } = require("child_process");

function defaultSpawn() {
  return spawn;
}

// Normalize a YouTube id or URL into a bare 11-char id.
function parseVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(s)) return s;
  return null;
}

class AgentReachClient {
  constructor(options = {}) {
    this.spawnImpl = typeof options.spawnImpl === "function" ? options.spawnImpl : defaultSpawn();
    // CLI used for web/github/reddit/rss. Configurable in case the install path differs.
    this.reachCommand = options.reachCommand || "agent-reach";
    this.pythonCmd = options.pythonCmd || "python3";
    this.logger = options.logger || (() => {});
  }

  // Run a child process, resolve with its trimmed stdout. Rejects on non-zero exit.
  _run(command, args, { input } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnImpl(command, args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        return reject(err);
      }
      let out = "";
      let errOut = "";
      if (child.stdout) child.stdout.on("data", (d) => { out += d.toString(); });
      if (child.stderr) child.stderr.on("data", (d) => { errOut += d.toString(); });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`${command} exited ${code}: ${errOut.trim()}`));
      });
      if (input && child.stdin) {
        child.stdin.write(input);
        child.stdin.end();
      }
    });
  }

  // Generic Agent Reach query. `kind` ∈ {search, github, reddit, rss}.
  async query(kind, q) {
    const out = await this._run(this.reachCommand, [kind, String(q)]);
    return out;
  }

  async webSearch(q) { return this.query("search", q); }
  async github(q) { return this.query("github", q); }
  async reddit(q) { return this.query("reddit", q); }
  async rss(q) { return this.query("rss", q); }

  // Fetch a YouTube transcript as plain text via youtube-transcript-api.
  // Fails silently upstream if no transcript is available (plan §6.4).
  async youtubeTranscript(videoIdOrUrl) {
    const id = parseVideoId(videoIdOrUrl);
    if (!id) throw new Error("invalid YouTube id/url");
    const py = [
      "import sys,json",
      "from youtube_transcript_api import YouTubeTranscriptApi",
      `data=YouTubeTranscriptApi.get_transcript("${id}")`,
      "text=' '.join(seg['text'] for seg in data)",
      "print(text)",
    ].join(";");
    return this._run(this.pythonCmd, ["-c", py]);
  }
}

module.exports = { AgentReachClient, parseVideoId };
