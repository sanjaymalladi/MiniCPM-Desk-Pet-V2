"use strict";

// ── Settings tab: Memory (Supermemory) ──
// plan §1–§6 controls. Mirrors settings-tab-attention.js. English labels are
// applied directly via setRowText so the tab works before full i18n coverage.

(function initSettingsTabMemory(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  function t(key) {
    return helpers.t(key);
  }

  function _t(key, def) {
    const v = helpers.t(key);
    return (v && v !== key) ? v : def;
  }

  function setRowText(row, title, desc) {
    if (!row) return;
    const el = row.querySelector(".settings-row-title, .row-label");
    if (el) el.textContent = title;
    const d = row.querySelector(".settings-row-desc, .row-desc");
    if (d) d.textContent = desc;
  }

  function buildTopicsRow({ key }) {
    const row = document.createElement("div");
    row.className = "row session-cleanup-row";
    row.innerHTML =
      '<div class="row-text">' +
        '<span class="row-label"></span>' +
        '<span class="row-desc"></span>' +
      '</div>' +
      '<div class="row-control session-cleanup-control" style="flex:1;max-width:320px;">' +
        '<textarea class="memory-topics-input" rows="4" ' +
        'style="width:100%;resize:vertical;font:inherit;"></textarea>' +
      '</div>';
    row.querySelector(".row-label").textContent = _t("rowMemoryTopics", "Research topics");
    row.querySelector(".row-desc").textContent = _t("rowMemoryTopicsDesc",
      "One topic per line. Idle time is spent fetching + distilling these into world-knowledge (plan §1.3).");
    const input = row.querySelector(".memory-topics-input");
    const current = () =>
      Array.isArray(state.snapshot && state.snapshot[key]) ? state.snapshot[key] : [];
    input.value = current().join("\n");
    let timer = null;
    input.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const lines = input.value.split("\n").map((s) => s.trim()).filter(Boolean);
        try { window.settingsAPI.update(key, lines); } catch (e) {}
      }, 500);
    });
    return row;
  }

  function buildButtonRow({ label, onClick }) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = '<div class="row-text"></div><div class="row-control"></div>';
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn accent";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    row.querySelector(".row-control").appendChild(btn);
    return row;
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = _t("sidebarMemory", "Memory (Supermemory)");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = _t("memSubtitle",
      "A unified, local-first memory store backed by a self-hosted Supermemory sidecar. Powers RAG in chat, a knowledge dashboard, proactive check-ins, and a goal countdown.");
    parent.appendChild(subtitle);

    const general = helpers.buildSection(_t("memSectionGeneral", "General"), [
      helpers.buildSwitchRow({ key: "memoryEnabled", labelKey: "memEnabled", descKey: "memEnabledDesc" }),
      helpers.buildSwitchRow({ key: "memoryAutoLaunch", labelKey: "memAutoLaunch", descKey: "memAutoLaunchDesc" }),
      buildButtonRow({
        label: _t("memOpenUi", "Open Supermemory UI"),
        onClick: () => { try { window.settingsAPI.openMemoryDashboard(); } catch (e) {} },
      }),
    ]);
    const gRows = general.querySelectorAll(".settings-row, .row");
    setRowText(gRows[0], _t("memEnabled", "Enable Memory"), _t("memEnabledDesc", "Launch the Supermemory sidecar and let the pet read/write memory."));
    setRowText(gRows[1], _t("memAutoLaunch", "Auto-launch sidecar"), _t("memAutoLaunchDesc", "Start Supermemory on launch. Turn off to attach to an already-running server."));
    parent.appendChild(general);

    const world = helpers.buildSection(_t("memSectionWorld", "World Knowledge (idle research)"), [
      helpers.buildSwitchRow({ key: "memoryWorldEnabled", labelKey: "memWorld", descKey: "memWorldDesc" }),
      buildTopicsRow({ key: "memoryWorldTopics" }),
      buildTextRow({
        key: "memoryWorldRssUrl",
        label: _t("memRssUrl", "AI news RSS feed"),
        desc: _t("memRssUrlDesc", "Idle time also pulls this feed and distills items into world-knowledge (plan §1.3)."),
        placeholder: "https://rss-feed-aggrigator.onrender.com/rss",
      }),
    ]);
    const wRows = world.querySelectorAll(".settings-row, .row");
    setRowText(wRows[0], _t("memWorld", "World research"), _t("memWorldDesc", "During idle time, research and distill topics into memory (plan §1.3)."));
    parent.appendChild(world);

    const proactive = helpers.buildSection(_t("memSectionProactive", "Proactive & Quiet Hours"), [
      helpers.buildSwitchRow({ key: "memoryProactiveEnabled", labelKey: "memProactive", descKey: "memProactiveDesc" }),
      helpers.buildSwitchRow({ key: "memoryMuted", labelKey: "memMuted", descKey: "memMutedDesc" }),
      helpers.buildNumberInputRow({
        key: "memoryQuietStart", labelKey: "memQuietStart", descKey: "memQuietStartDesc",
        toDisplay: (v) => v, fromDisplay: (v) => v, min: 0, max: 23,
      }),
      helpers.buildNumberInputRow({
        key: "memoryQuietEnd", labelKey: "memQuietEnd", descKey: "memQuietEndDesc",
        toDisplay: (v) => v, fromDisplay: (v) => v, min: 0, max: 23,
      }),
    ]);
    const pRows = proactive.querySelectorAll(".settings-row, .row");
    setRowText(pRows[0], _t("memProactive", "Proactive check-ins"), _t("memProactiveDesc", "Send OS-notification check-ins drawn from your recent context (plan §4)."));
    setRowText(pRows[1], _t("memMuted", "Mute proactive"), _t("memMutedDesc", "Suppress all proactive messages."));
    setRowText(pRows[2], _t("memQuietStart", "Quiet hours start"), _t("memQuietStartDesc", "No proactive messages after this hour."));
    setRowText(pRows[3], _t("memQuietEnd", "Quiet hours end"), _t("memQuietEndDesc", "Proactive messages resume after this hour."));
    parent.appendChild(proactive);

    const goal = helpers.buildSection(_t("memSectionGoal", "Goal Countdown"), [
      helpers.buildSwitchRow({ key: "memoryGoalEnabled", labelKey: "memGoal", descKey: "memGoalDesc" }),
    ]);
    const goRows = goal.querySelectorAll(".settings-row, .row");
    setRowText(goRows[0], _t("memGoal", "Goal countdown"), _t("memGoalDesc", "Mirror your nudge-contract goal into memory and surface a factual countdown on distraction (plan §5)."));
    parent.appendChild(goal);

    const video = helpers.buildSection(_t("memSectionVideo", "Video Transcript Summary"), [
      helpers.buildSwitchRow({ key: "memoryVideoEnabled", labelKey: "memVideo", descKey: "memVideoDesc" }),
    ]);
    const vRows = video.querySelectorAll(".settings-row, .row");
    setRowText(vRows[0], _t("memVideo", "Summarize videos"), _t("memVideoDesc", "Fetch a transcript when a video plays and store a summary if it looks work-related (plan §6)."));
    parent.appendChild(video);

    const advanced = helpers.buildSection(_t("memSectionAdvanced", "Advanced"), [
      helpers.buildNumberInputRow({
        key: "memoryPort", labelKey: "memPort", descKey: "memPortDesc",
        toDisplay: (v) => v, fromDisplay: (v) => v, min: 1, max: 65535,
      }),
      buildTextRow({ key: "memoryDataDir", label: _t("memDataDir", "Data directory"), desc: _t("memDataDirDesc", "Override Supermemory's storage location (empty = default).") }),
      buildTextRow({ key: "memoryLlmBaseUrl", label: _t("memLlmUrl", "LLM base URL"), desc: _t("memLlmUrlDesc", "OpenAI-compatible endpoint Supermemory uses for extraction.") }),
    ]);
    const aRows = advanced.querySelectorAll(".settings-row, .row");
    setRowText(aRows[0], _t("memPort", "Sidecar port"), _t("memPortDesc", "Port of an already-running Supermemory server (when auto-launch is off)."));
    parent.appendChild(advanced);
  }

  // Local text-input row (mirrors attention tab's buildTextRow).
  function buildTextRow({ key, label, desc, placeholder }) {
    const row = document.createElement("div");
    row.className = "row session-cleanup-row";
    row.innerHTML =
      '<div class="row-text">' +
        '<span class="row-label"></span>' +
        '<span class="row-desc"></span>' +
      '</div>' +
      '<div class="row-control session-cleanup-control">' +
        '<input type="text" class="bubble-policy-seconds session-cleanup-input" />' +
      '</div>';
    row.querySelector(".row-label").textContent = label;
    if (desc) row.querySelector(".row-desc").textContent = desc;
    else row.querySelector(".row-desc").remove();
    const input = row.querySelector(".session-cleanup-input");
    if (placeholder) input.placeholder = placeholder;
    const current = () =>
      state.snapshot && typeof state.snapshot[key] === "string" ? state.snapshot[key] : "";
    input.value = current();
    let timer = null;
    input.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try { window.settingsAPI.update(key, input.value); } catch (e) {}
      }, 500);
    });
    return row;
  }

  function patchInPlace() {
    return false;
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;

    core.tabs.memory = {
      render,
      patchInPlace,
    };
  }

  root.ClawdSettingsTabMemory = { init };
})(globalThis);
