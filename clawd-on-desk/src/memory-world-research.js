"use strict";

// ── World-knowledge research loop (plan §1.3) ──
//
// Idle-gated: only runs when the same idle/AFK detector the attention pipeline
// already uses says the user is away (no second detector). Bounded by per-session
// and per-day fetch caps so a long idle stretch can't become unbounded scraping.
// Distills via the injected `distill` fn (MiniCPM5-1B in production) and stores
// with source + date. De-dups by updating in place rather than duplicating.

const {
  RESEARCH_DEFAULTS,
  DEFAULT_WORLD_TOPICS,
  DEFAULT_WORLD_RSS_URL,
  DEFAULT_WORLD_RSS_TOPIC,
  CONTAINER_TAGS,
} = require("./memory-constants");

// Tiny RSS 2.0 / Atom parser — no dependency. Returns [{ title, link,
// description, pubDate }]. Tolerant of CDATA and `<link href>` (Atom) forms.
function parseFeed(xml) {
  if (!xml || typeof xml !== "string") return [];
  const items = [];
  const blockRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[0];
    const pick = (tag) => {
      const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
      const mm = block.match(re);
      if (!mm) return "";
      return stripCdata(mm[1]).trim();
    };
    const linkMatch = block.match(/<link\b[^>]*href="([^"]+)"[^>]*\/?>/i)
      || block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
    const link = linkMatch ? (linkMatch[1] || "").trim() : "";
    const title = pick("title");
    const description = pick("description") || pick("summary") || pick("content");
    const pubDate = pick("pubDate") || pick("updated") || pick("published") || "";
    if (title || link) {
      items.push({ title, link, description: stripTags(description), pubDate });
    }
  }
  return items;
}

function stripCdata(s) {
  if (!s) return s;
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : s;
}

function stripTags(s) {
  if (!s) return s;
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function isStale(fetchedAt, now, worldStaleMs) {
  return Number.isFinite(fetchedAt) && (now - fetchedAt) > worldStaleMs;
}

class WorldResearch {
  constructor(options = {}) {
    this.reach = options.reach;
    this.distill = typeof options.distill === "function"
      ? options.distill
      : async (raw) => (typeof raw === "string" ? raw.slice(0, 280) : "");
    this.store = typeof options.store === "function"
      ? options.store
      : async () => ({});
    this.recall = typeof options.recall === "function"
      ? options.recall
      : async () => [];
    this.topics = Array.isArray(options.topics) ? options.topics : [...DEFAULT_WORLD_TOPICS];
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.caps = Object.assign({}, RESEARCH_DEFAULTS, options.caps || {});
    this.logger = options.logger || (() => {});

    // AI-news RSS digest (plan §1.3): direct feed URL + a fetch primitive.
    // Defaults to the global fetch (Electron's Node 18+); injectable for tests.
    this.rssUrl = options.rssUrl || DEFAULT_WORLD_RSS_URL;
    this.rssTopic = options.rssTopic || DEFAULT_WORLD_RSS_TOPIC;
    this.fetchImpl = typeof options.fetchImpl === "function"
      ? options.fetchImpl
      : (typeof fetch !== "undefined" ? fetch.bind(typeof globalThis !== "undefined" ? globalThis : undefined) : null);

    this._idleCount = 0;
    this._dayCount = 0;
    this._dayKey = this._dayStamp();
    this._lastFetch = new Map(); // topic -> timestamp
    this._lastRss = 0; // last RSS digest timestamp
    this._seenRss = new Set(); // links stored this day (de-dup)
  }

  _dayStamp() {
    const d = new Date(this.now());
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  // Call when a fresh idle session begins (resets the per-session cap).
  resetIdleSession() {
    this._idleCount = 0;
  }

  // Update the topic list at runtime (Settings UI, plan §1.3.2).
  setTopics(topics) {
    if (Array.isArray(topics) && topics.length) {
      this.topics = topics.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
    }
  }

  setRssUrl(url) {
    if (typeof url === "string" && url.trim()) this.rssUrl = url.trim();
  }

  _rollDayIfNeeded() {
    const key = this._dayStamp();
    if (key !== this._dayKey) {
      this._dayKey = key;
      this._dayCount = 0;
      this._seenRss = new Set();
    }
  }

  _pickTopic(now) {
    // Choose the topic whose cooldown has elapsed; prefer least-recently fetched.
    let best = null;
    let bestAt = Infinity;
    for (const topic of this.topics) {
      const last = this._lastFetch.get(topic) || 0;
      // last === 0 means "never fetched" — always eligible (don't gate on cooldown).
      if (last && now - last < this.caps.topicCooldownMs) continue;
      if (last < bestAt) { bestAt = last; best = topic; }
    }
    return best;
  }

  // One research step. Returns a small report describing what happened.
  async tick({ isIdle = false, now = this.now() } = {}) {
    if (!isIdle) return { skipped: "active" };
    this._rollDayIfNeeded();
    if (this._idleCount >= this.caps.maxFetchesPerIdleSession) return { skipped: "idle-cap" };
    if (this._dayCount >= this.caps.maxFetchesPerDay) return { skipped: "day-cap" };

    const topic = this._pickTopic(now);
    if (!topic) return { skipped: "cooldown" };

    let raw;
    try {
      raw = await this.reach.webSearch(topic);
    } catch (err) {
      this.logger(`world research fetch failed for "${topic}": ${err && err.message}`);
      return { skipped: "fetch-failed", topic };
    }
    const summary = await this.distill(raw, topic);
    if (!summary) return { skipped: "empty-distill", topic };

    const res = await this.store({
      content: summary,
      sourceUrl: `research:${topic}`,
      fetchedAt: now,
      confidence: 1,
      metadata: { topic },
    });
    this._lastFetch.set(topic, now);
    this._idleCount += 1;
    this._dayCount += 1;
    return { stored: true, topic, summary, res };
  }

  // Flag stale world-knowledge entries on read (plan §1.3.5). Returns the same
  // list with a `stale` boolean added per entry.
  flagStale(entries, now = this.now()) {
    return (Array.isArray(entries) ? entries : []).map((e) => {
      const fetchedAt = e && e.metadata && Number.isFinite(e.metadata.fetchedAt) ? e.metadata.fetchedAt : null;
      return Object.assign({}, e, { stale: fetchedAt ? isStale(fetchedAt, now, this.caps.worldStaleMs) : false });
    });
  }

  // Pull the AI-news RSS feed, distill each item, and store it as world-knowledge.
  // Shares the same idle/day caps as `tick` so idle time stays bounded.
  async digestRss({ isIdle = false, now = this.now(), url = this.rssUrl } = {}) {
    if (!isIdle) return { skipped: "active" };
    if (!url) return { skipped: "no-url" };
    this._rollDayIfNeeded();
    if (this._idleCount >= this.caps.maxFetchesPerIdleSession) return { skipped: "idle-cap" };
    if (this._dayCount >= this.caps.maxFetchesPerDay) return { skipped: "day-cap" };
    if (this._lastRss && now - this._lastRss < this.caps.rssCooldownMs) return { skipped: "rss-cooldown" };
    if (!this.fetchImpl) return { skipped: "no-fetch" };

    const maxAttempts = this.caps.rssMaxAttempts || 1;
    const retryMs = this.caps.rssRetryMs || 0;
    let xml = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await this.fetchImpl(url);
        if (!res || typeof res.text !== "function") throw new Error("bad fetch response");
        xml = await res.text();
        if (xml && xml.trim()) break; // got data — stop retrying
        lastErr = new Error("empty response");
      } catch (err) {
        lastErr = err;
        this.logger(`world research RSS fetch attempt ${attempt}/${maxAttempts} failed: ${err && err.message}`);
      }
      if (attempt < maxAttempts && retryMs > 0) {
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }
    if (!xml || !xml.trim()) {
      return { skipped: "fetch-failed", url, error: lastErr && lastErr.message };
    }
    const items = parseFeed(xml);
    if (!items.length) return { skipped: "empty-feed", url };

    let stored = 0;
    const max = this.caps.maxRssItemsPerFetch || 0;
    for (const item of items) {
      if (stored >= max) break;
      // Skip links we already distilled earlier today (feed is stable within a day).
      if (item.link && this._seenRss.has(item.link)) continue;
      const raw = `${item.title}\n${item.description}`.trim();
      if (!raw) continue;
      const summary = await this.distill(raw, this.rssTopic);
      if (!summary) continue;
      try {
        await this.store({
          content: summary,
          sourceUrl: item.link || `research:${this.rssTopic}`,
          fetchedAt: now,
          confidence: 1,
          metadata: { topic: this.rssTopic, pubDate: item.pubDate || null },
        });
      } catch (err) {
        this.logger(`world research RSS store failed: ${err && err.message}`);
        continue;
      }
      if (item.link) this._seenRss.add(item.link);
      stored += 1;
    }
    if (stored === 0) return { skipped: "no-new-items", url, total: items.length };
    // The whole digest counts as a single idle/day unit (like one web-search tick).
    this._idleCount += 1;
    this._dayCount += 1;
    this._lastRss = now;
    return { stored, topic: this.rssTopic, url, total: items.length };
  }
}

module.exports = { WorldResearch, isStale, parseFeed };
