"use strict";

const assert = require("node:assert");
const test = require("node:test");
const { WorldResearch, parseFeed } = require("../src/memory-world-research");

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>AI News</title>
    <item>
      <title>New local LLM beats GPT-4</title>
      <link>https://example.com/a</link>
      <description>Researchers released a 3B model that outperforms larger ones.</description>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Supermemory adds RSS ingest</title>
      <link>https://example.com/b</link>
      <description><![CDATA[A new <b>feature</b> lands.]]></description>
      <pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom headline</title>
    <link href="https://example.com/atom1" />
    <summary>An atom summary.</summary>
    <updated>2024-01-03T00:00:00Z</updated>
  </entry>
</feed>`;

test("parseFeed extracts RSS 2.0 items", () => {
  const items = parseFeed(RSS_SAMPLE);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].title, "New local LLM beats GPT-4");
  assert.strictEqual(items[0].link, "https://example.com/a");
  assert.match(items[0].description, /Researchers released/);
  assert.strictEqual(items[1].link, "https://example.com/b");
});

test("parseFeed handles CDATA and Atom link href", () => {
  const items = parseFeed(ATOM_SAMPLE);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, "Atom headline");
  assert.strictEqual(items[0].link, "https://example.com/atom1");
  assert.strictEqual(items[0].description, "An atom summary.");
  // CDATA stripped in RSS description
  const rss = parseFeed(RSS_SAMPLE);
  assert.strictEqual(rss[1].description, "A new feature lands.");
});

test("digestRss fetches, distills and stores items (capped)", async () => {
  const stored = [];
  const world = new WorldResearch({
    store: async (o) => { stored.push(o); return { ok: true }; },
    distill: async (raw) => raw.split("\n")[0],
    fetchImpl: async () => ({ text: async () => RSS_SAMPLE }),
    caps: { maxFetchesPerIdleSession: 3, maxFetchesPerDay: 12, maxRssItemsPerFetch: 2,
      worldStaleMs: 1, topicCooldownMs: 1, rssCooldownMs: 1 },
  });
  const res = await world.digestRss({ isIdle: true });
  assert.strictEqual(res.stored, 2);
  assert.strictEqual(res.topic, "AI news");
  assert.strictEqual(stored.length, 2);
  assert.strictEqual(stored[0].metadata.topic, "AI news");
  assert.strictEqual(stored[0].sourceUrl, "https://example.com/a");
  // whole digest counts as one idle unit
  assert.strictEqual(world._idleCount, 1);
});

test("digestRss retries a sleeping/503 feed until it gets data", async () => {
  let calls = 0;
  const world = new WorldResearch({
    store: async () => ({}),
    distill: async (raw) => raw.split("\n")[0],
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error("503 sleep");
      return { text: async () => RSS_SAMPLE };
    },
    caps: { maxFetchesPerIdleSession: 3, maxFetchesPerDay: 12, maxRssItemsPerFetch: 2,
      worldStaleMs: 1, topicCooldownMs: 1, rssCooldownMs: 1, rssMaxAttempts: 3, rssRetryMs: 1 },
  });
  const res = await world.digestRss({ isIdle: true });
  assert.strictEqual(calls, 3);
  assert.strictEqual(res.stored, 2);
});

test("digestRss de-dupes links already stored earlier the same day", async () => {
  const stored = [];
  const world = new WorldResearch({
    store: async (o) => { stored.push(o); return { ok: true }; },
    distill: async (raw) => raw.split("\n")[0],
    fetchImpl: async () => ({ text: async () => RSS_SAMPLE }),
    caps: { maxFetchesPerIdleSession: 3, maxFetchesPerDay: 12, maxRssItemsPerFetch: 2,
      worldStaleMs: 1, topicCooldownMs: 1, rssCooldownMs: 0 },
  });
  const r1 = await world.digestRss({ isIdle: true });
  assert.strictEqual(r1.stored, 2);
  // Same feed again same day: links already seen → no new items.
  const r2 = await world.digestRss({ isIdle: true });
  assert.strictEqual(r2.skipped, "no-new-items");
});

test("digestRss is a no-op when not idle", async () => {
  let fetched = false;
  const world = new WorldResearch({
    store: async () => ({}),
    distill: async (r) => r,
    fetchImpl: async () => { fetched = true; return { text: async () => RSS_SAMPLE }; },
  });
  const res = await world.digestRss({ isIdle: false });
  assert.strictEqual(res.skipped, "active");
  assert.strictEqual(fetched, false);
});

test("digestRss degrades gracefully on fetch failure", async () => {
  const world = new WorldResearch({
    store: async () => ({}),
    distill: async (r) => r,
    fetchImpl: async () => { throw new Error("network down"); },
  });
  const res = await world.digestRss({ isIdle: true });
  assert.strictEqual(res.skipped, "fetch-failed");
});
