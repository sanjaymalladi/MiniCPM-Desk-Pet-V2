"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { buildPrefsSnapshot } = require("../src/memory-dashboard");

describe("memory-dashboard helpers", () => {
  it("builds a pref snapshot from a getPref(key) function", () => {
    const values = {
      memoryEnabled: true,
      memoryAutoLaunch: false,
      memoryMuted: true,
    };
    const snap = buildPrefsSnapshot((key) => values[key]);

    assert.strictEqual(snap.memoryEnabled, true);
    assert.strictEqual(snap.memoryAutoLaunch, false);
    assert.strictEqual(snap.memoryMuted, true);
  });

  it("builds a pref snapshot from a prefs object", () => {
    const snap = buildPrefsSnapshot({ memoryEnabled: false, memoryWorldEnabled: true });

    assert.strictEqual(snap.memoryEnabled, false);
    assert.strictEqual(snap.memoryWorldEnabled, true);
  });
});
