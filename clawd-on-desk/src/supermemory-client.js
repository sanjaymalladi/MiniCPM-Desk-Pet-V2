"use strict";

// ── Supermemory REST client (main process) ──
//
// Thin wrapper over the self-hosted Supermemory API. Every method takes a
// `category` (one of the two container tags) so the personal / world-knowledge
// split stays scoped end-to-end. `fetchImpl` is injectable for tests.
//
// Endpoints (verified against https://supermemory.ai/llms.txt):
//   POST /v3/add     { content, category, metadata }      -> { success, data }
//   POST /v3/search  { query, category, pageSize, page }  -> { success, results }
//   GET  /v4/profile                                     -> { success, data }
//   POST /v3/delete  { id }                               -> { success }

const {
  ENDPOINTS,
  SUPERMEMORY_DEFAULT_HOST,
  SUPERMEMORY_DEFAULT_PORT,
  SUPERMEMORY_HEALTH_PATH,
  CONTAINER_TAGS,
  normalizeContainerTag,
} = require("./memory-constants");

function defaultFetch() {
  // Electron's main process has a global fetch (Node 18+ / Electron 27+).
  if (typeof fetch === "function") return fetch;
  throw new Error("global fetch is unavailable in this runtime");
}

class SupermemoryClient {
  constructor(options = {}) {
    const baseUrl = options.baseUrl
      || `http://${SUPERMEMORY_DEFAULT_HOST}:${options.port || SUPERMEMORY_DEFAULT_PORT}`;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey || "";
    this.fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : defaultFetch();
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  }

  setCredentials({ baseUrl, apiKey } = {}) {
    if (baseUrl) this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (apiKey) this.apiKey = apiKey;
  }

  _headers() {
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    return headers;
  }

  async _request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: this._headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch (e) {
        json = { raw: text };
      }
      if (!res.ok) {
        const err = new Error(`Supermemory ${method} ${path} failed (${res.status})`);
        err.status = res.status;
        err.body = json;
        throw err;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  // Add a memory. `category` scopes it to one of the two container tags.
  async add({ content, category = CONTAINER_TAGS.PERSONAL, metadata = {}, private: isPrivate = false } = {}) {
    if (!content || typeof content !== "string") {
      throw new Error("add() requires a non-empty content string");
    }
    const payload = {
      content,
      category: normalizeContainerTag(category, CONTAINER_TAGS.PERSONAL),
      metadata: metadata && typeof metadata === "object" ? metadata : {},
    };
    if (isPrivate) payload.private = true;
    return this._request("POST", ENDPOINTS.ADD, payload);
  }

  // Hybrid search scoped by category. Returns the `results` array.
  async search({ query = "", category, pageSize = 10, page = 1 } = {}) {
    const body = { query: query || "", pageSize, page };
    if (category) body.category = normalizeContainerTag(category);
    const json = await this._request("POST", ENDPOINTS.SEARCH, body);
    return Array.isArray(json.results) ? json.results : [];
  }

  // List memories in a category (search with an empty query returns the set).
  async list({ category, pageSize = 50, page = 1 } = {}) {
    return this.search({ query: "", category, pageSize, page });
  }

  // User profile: stable facts + recent dynamic context (Tier 2/3 surfacing).
  async getProfile() {
    const json = await this._request("GET", ENDPOINTS.PROFILE);
    return json.data || json;
  }

  // Delete a memory by id.
  async deleteMemory(id) {
    if (!id) throw new Error("deleteMemory() requires an id");
    return this._request("POST", ENDPOINTS.DELETE, { id });
  }

  // Liveness probe — used by the sidecar manager's health loop.
  async health() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${SUPERMEMORY_HEALTH_PATH}`, {
        method: "GET",
        signal: controller.signal,
      });
      return res.ok;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { SupermemoryClient };
