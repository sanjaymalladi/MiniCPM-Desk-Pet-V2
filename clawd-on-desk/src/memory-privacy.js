"use strict";

// ── Memory privacy guard (plan §1.5) ──
//
// Anything matching the exclude-list (banking, incognito, password managers,
// calls, …) must never be persisted. Two layers:
//   1. isPrivateText() — fast gate used by memory-service to refuse a write.
//   2. wrapPrivate()/unwrapPrivate() — Supermemory's <private>…</private>
//      convention, for the cases where we want to note "something happened"
//      without storing the sensitive content itself.

const { DEFAULT_EXCLUDE_LIST } = require("./memory-constants");

// Normalize for matching: lowercase, collapse whitespace, strip surrounding
// punctuation so "Password Manager!" still matches "password".
function _norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isPrivateText(text, excludeList) {
  const list = Array.isArray(excludeList) ? excludeList : DEFAULT_EXCLUDE_LIST;
  const n = _norm(text);
  if (!n) return false;
  return list.some((term) => n.includes(_norm(term)));
}

const PRIVATE_OPEN = "<private>";
const PRIVATE_CLOSE = "</private>";

function wrapPrivate(text) {
  const s = String(text == null ? "" : text);
  if (containsPrivateTag(s)) return s;
  return `${PRIVATE_OPEN}${s}${PRIVATE_CLOSE}`;
}

function unwrapPrivate(text) {
  const s = String(text == null ? "" : text);
  const m = s.match(/^\s*<private>([\s\S]*?)<\/private>\s*$/i);
  return m ? m[1] : s;
}

function containsPrivateTag(text) {
  return /<private>[\s\S]*?<\/private>/i.test(String(text || ""));
}

// Decide whether a piece of content may be stored. Returns:
//   { store: boolean, private: boolean, reason?: string }
// `redact` (default false): when true and private, wrap+store a redacted marker
// instead of refusing. When false (default), private content is never written.
function evaluate(text, { excludeList, redact = false } = {}) {
  const priv = isPrivateText(text, excludeList);
  if (!priv) return { store: true, private: false };
  if (redact) {
    return { store: true, private: true, content: wrapPrivate("[redacted: excluded by privacy policy]") };
  }
  return { store: false, private: true, reason: "excluded-by-privacy-policy" };
}

module.exports = {
  isPrivateText,
  wrapPrivate,
  unwrapPrivate,
  containsPrivateTag,
  evaluate,
  PRIVATE_OPEN,
  PRIVATE_CLOSE,
};
