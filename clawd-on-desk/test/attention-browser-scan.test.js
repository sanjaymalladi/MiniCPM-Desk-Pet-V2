"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  KNOWN_BROWSERS,
  BrowserScan,
  _isVideoLike,
  _isNotesLike,
} = require("../src/attention-browser-scan");

describe("attention-browser-scan detection", () => {
  const scan = new BrowserScan();

  it("filters detected app ids down to a known-browser subset with canonical ids", () => {
    const discovered = [
      "Google Chrome", "firefox", "code", "spotify", "msedge", "notepad",
    ];
    const found = scan.detectInstalled(discovered);
    const ids = found.map((b) => b.id).sort();
    assert.deepStrictEqual(ids, ["chrome", "edge", "firefox"]);
  });

  it("tolerates alternate executable names and unknown noise", () => {
    const found = scan.detectInstalled([
      "google-chrome-stable", "Mozilla Firefox", "brave.exe", "arc browser",
      "some-random-app", "Slack",
    ]);
    const ids = found.map((b) => b.id).sort();
    assert.deepStrictEqual(ids, ["arc", "brave", "chrome", "firefox"]);
  });

  it("returns an empty list when nothing matches", () => {
    assert.deepStrictEqual(scan.detectInstalled(["vim", "terminal", "slack"]), []);
    assert.deepStrictEqual(scan.detectInstalled([]), []);
    assert.deepStrictEqual(scan.detectInstalled(null), []);
  });

  it("is driven by the injected catalogue, not a real OS probe", () => {
    const custom = new BrowserScan([{ id: "frobnaut", names: ["frobnaut", "frob"] }]);
    const found = custom.detectInstalled(["Frob"]);
    assert.deepStrictEqual(found, [{ id: "frobnaut", names: ["frobnaut", "frob"] }]);
  });
});

describe("attention-browser-scan install plan", () => {
  const scan = new BrowserScan();

  it("flags every installed browser as needing install when none are done", () => {
    const installed = scan.detectInstalled(["chrome", "firefox", "brave"]);
    const plan = scan.buildInstallPlan(installed);
    assert.deepStrictEqual(plan, [
      { browser: "chrome", needsInstall: true },
      { browser: "firefox", needsInstall: true },
      { browser: "brave", needsInstall: true },
    ]);
  });

  it("only flags browsers missing the extension; accepts ids or entries", () => {
    const installed = [
      { id: "chrome" }, "firefox", { id: "edge", names: ["msedge"] },
    ];
    const plan = scan.buildInstallPlan(installed, ["chrome", "edge"]);
    assert.deepStrictEqual(plan, [
      { browser: "chrome", needsInstall: false },
      { browser: "firefox", needsInstall: true },
      { browser: "edge", needsInstall: false },
    ]);
  });

  it("returns an empty plan when no browsers are installed", () => {
    assert.deepStrictEqual(scan.buildInstallPlan([]), []);
  });
});

describe("attention-browser-scan same-task windows", () => {
  const scan = new BrowserScan();

  it("returns a reason for a video + notes pair across browsers", () => {
    const reason = scan.areSameTaskWindows(
      { app: "chrome", title: "Lofi beats — YouTube [Playback: 0:12 / 2:00]" },
      { app: "firefox", title: "Meeting notes — Notion" },
    );
    assert.ok(typeof reason === "string" && reason.length > 0);
  });

  it("returns a reason for the reversed video/notes ordering", () => {
    const reason = scan.areSameTaskWindows(
      { app: "obsidian", title: "Project brain dump" },
      { app: "edge", url: "https://netflix.com/watch/123" },
    );
    assert.ok(typeof reason === "string" && reason.length > 0);
  });

  it("returns null for two unrelated distraction apps", () => {
    const reason = scan.areSameTaskWindows(
      { app: "chrome", title: "Reddit — Dive into anything" },
      { app: "steam", title: "Counter-Strike 2" },
    );
    assert.strictEqual(reason, null);
  });

  it("returns null when both windows are video (not a notes pairing)", () => {
    const reason = scan.areSameTaskWindows(
      { app: "video-streaming", title: "Movie A" },
      { app: "youtube", title: "Movie B" },
    );
    assert.strictEqual(reason, null);
  });

  it("categorization helpers agree with the same-task decision", () => {
    const video = { app: "chrome", title: "Big Buck Bunny — YouTube" };
    const notes = { app: "notion", title: "Lecture notes" };
    assert.strictEqual(_isVideoLike(video), true);
    assert.strictEqual(_isNotesLike(notes), true);
    assert.ok(scan.areSameTaskWindows(video, notes));
  });
});

describe("attention-browser-scan catalogue", () => {
  it("exports a sensible set of browser identifiers", () => {
    const ids = KNOWN_BROWSERS.map((b) => b.id).sort();
    for (const expected of ["chrome", "edge", "firefox", "brave", "opera", "arc", "vivaldi", "safari"]) {
      assert.ok(ids.includes(expected), `expected KNOWN_BROWSERS to include ${expected}`);
    }
  });
});
