"use strict";

(function initSettingsTabAttention(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  function t(key) {
    return helpers.t(key);
  }

  // i18n with a sensible English default: routes through the same translation
  // table as the rest of the settings tabs, but falls back to `def` when no
  // translation exists yet (helpers.t returns the raw key when missing).
  function _t(key, def) {
    const v = helpers.t(key);
    return (v && v !== key) ? v : def;
  }

  function setRowText(row, title, desc) {
    if (!row) return;
    if (title) {
      const el = row.querySelector(".settings-row-title, .row-label");
      if (el) el.textContent = title;
    }
    if (desc) {
      const el = row.querySelector(".settings-row-desc, .row-desc");
      if (el) el.textContent = desc;
    }
  }

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

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("sidebarAttention") || "Attention Tracking";
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = _t("attSubtitle", "The pet watches your active window and uses MiniCPM to figure out if you're working or slacking off.");
    parent.appendChild(subtitle);

    const section = helpers.buildSection(_t("attSectionFocus", "Focus & Accountability"), [
      helpers.buildSwitchRow({
        key: "attentionEnabled",
        labelKey: "rowAttentionEnabled",
        descKey: "rowAttentionEnabledDesc",
      }),
      helpers.buildSwitchRow({
        key: "attentionVisionEnabled",
        labelKey: "rowAttentionVisionEnabled",
        descKey: "rowAttentionVisionEnabledDesc",
      }),
      helpers.buildSwitchRow({
        key: "attentionIdleEnabled",
        labelKey: "rowAttentionIdleEnabled",
        descKey: "rowAttentionIdleEnabledDesc",
      })
    ]);

    const rows = section.querySelectorAll(".settings-row");
    setRowText(rows[0], _t("rowAttentionEnabled", "Enable Attention Tracking"), _t("rowAttentionEnabledDesc", "The pet will monitor your focused window and track your current task."));
    setRowText(rows[1], _t("rowAttentionVisionEnabled", "Enable Vision Verification (MiniCPM-V)"), _t("rowAttentionVisionEnabledDesc", "Take a screenshot of the active window when the text title is ambiguous. Needs the MiniCPM-V model."));
    setRowText(rows[2], _t("rowAttentionIdleEnabled", "Pause when idle / AFK"), _t("rowAttentionIdleEnabledDesc", "Stop evaluating focus while you've been away from the keyboard for a couple minutes."));

    parent.appendChild(section);

    // ── v2 observer features ──
    const obs = helpers.buildSection(_t("attSectionObserver", "Observer Features (v2)"), [
      helpers.buildSwitchRow({
        key: "attentionCheckInEnabled",
        labelKey: "rowAttentionCheckIn",
        descKey: "rowAttentionCheckInDesc",
      }),
      helpers.buildSwitchRow({
        key: "attentionStuckEnabled",
        labelKey: "rowAttentionStuck",
        descKey: "rowAttentionStuckDesc",
      }),
      helpers.buildSwitchRow({
        key: "attentionRecapEnabled",
        labelKey: "rowAttentionRecap",
        descKey: "rowAttentionRecapDesc",
      }),
      helpers.buildSwitchRow({
        key: "attentionPatternsEnabled",
        labelKey: "rowAttentionPatterns",
        descKey: "rowAttentionPatternsDesc",
      }),
      helpers.buildNumberInputRow({
        key: "attentionWanderBudgetMinutes",
        labelKey: "rowAttentionWander",
        descKey: "rowAttentionWanderDesc",
        unitKey: "unitMin",
        toDisplay: (v) => v,
        fromDisplay: (v) => v,
        min: 0,
        max: 240,
        zeroLabelKey: "Off"
      })
    ]);

    const orows = obs.querySelectorAll(".settings-row");
    setRowText(orows[0], _t("rowAttentionCheckIn", "Task check-in"), _t("rowAttentionCheckInDesc", "When a new task is detected, confirm it's right instead of assuming."));
    setRowText(orows[1], _t("rowAttentionStuck", "Stuck detection"), _t("rowAttentionStuckDesc", "If you repeat a question across tools or thrash files, the pet offers help (not a scold)."));
    setRowText(orows[2], _t("rowAttentionRecap", "Session recap"), _t("rowAttentionRecapDesc", "Track where time went and tell you where you left off after a break."));
    setRowText(orows[3], _t("rowAttentionPatterns", "Pattern surfacing"), _t("rowAttentionPatternsDesc", "Occasionally note when you tend to drift (e.g. around 3pm)."));

    const wrow = obs.querySelector(".session-cleanup-row");
    if (wrow) {
      const lbl = wrow.querySelector(".row-label");
      if (lbl) lbl.textContent = _t("rowAttentionWander", "Wander budget (minutes)");
      const dsc = wrow.querySelector(".row-desc");
      if (dsc) dsc.textContent = _t("rowAttentionWanderDesc", "Per-session tangent allowance. 0 = off.");
      const unit = wrow.querySelector(".session-cleanup-unit");
      if (unit) unit.textContent = _t("unitMin", "min");
    }

    const contractRow = buildTextRow({
      key: "attentionNudgeContract",
      label: _t("rowAttentionNudgeContract", "Nudge contract"),
      desc: _t("rowAttentionNudgeContractDesc", "What to hold you to this session — resolves doubt vs distraction at the source."),
      placeholder: "e.g. just this report"
    });
    obs.appendChild(contractRow);

    parent.appendChild(obs);

    // ── v2 vision + privacy (plan §2 vision + §3.1 multi-browser) ──
    const privacy = helpers.buildSection(_t("attSectionPrivacy", "Vision & Privacy"), [
      helpers.buildSwitchRow({
        key: "attentionVisionConsent",
        labelKey: "rowAttentionVisionConsent",
        descKey: "rowAttentionVisionConsentDesc",
      }),
      helpers.buildSwitchRow({
        key: "attentionAccessibilityConsent",
        labelKey: "rowAttentionAccessibilityConsent",
        descKey: "rowAttentionAccessibilityConsentDesc",
      })
    ]);
    const prows = privacy.querySelectorAll(".settings-row");
    setRowText(prows[0], _t("rowAttentionVisionConsent", "Allow vision check (screenshots)"), _t("rowAttentionVisionConsentDesc", "When the focused window's title is ambiguous, let the pet take a quick screenshot to decide what you're doing. Needs the MiniCPM-V model."));
    setRowText(prows[1], _t("rowAttentionAccessibilityConsent", "Allow OS accessibility reading"), _t("rowAttentionAccessibilityConsentDesc", "Let Clawd read the focused app's accessibility info for a stronger signal. Off by default."));

    // Vision model download control
    const vrow = document.createElement("div");
    vrow.className = "settings-row";
    vrow.innerHTML =
      '<div class="row-text">' +
        '<span class="row-label">' + _t("attVisionModel", "Vision model") + '</span>' +
        '<span class="row-desc">' + _t("attVisionModelDesc", "Download the MiniCPM-V 4.6 model (~1 GB) used for the last-resort screenshot check.") + '</span>' +
      '</div>' +
      '<div class="row-control">' +
        '<button type="button" class="btn-attention-action" id="att-vision-dl">Download</button>' +
        '<span class="att-vision-status dim"></span>' +
      '</div>';
    privacy.appendChild(vrow);

    const vbtn = vrow.querySelector("#att-vision-dl");
    const vstatus = vrow.querySelector(".att-vision-status");
    vbtn.addEventListener("click", async () => {
      if (vbtn.disabled) return;
      vbtn.disabled = true;
      vbtn.textContent = "Downloading…";
      vstatus.textContent = "";
      try {
        const r = await window.minicpmSettings.startVisionModelDownload();
        if (r && r.ok) { vstatus.textContent = "Ready"; vbtn.textContent = "Downloaded"; }
        else { vstatus.textContent = (r && r.error) || "Failed"; vbtn.disabled = false; vbtn.textContent = "Retry"; }
      } catch (err) {
        vstatus.textContent = String((err && err.message) || err);
        vbtn.disabled = false; vbtn.textContent = "Retry";
      }
    });

    // Per-browser tab-tracking extension scan
    const browRow = document.createElement("div");
    browRow.className = "settings-row";
    browRow.innerHTML =
      '<div class="row-text">' +
        '<span class="row-label">' + _t("attBrowserTabTracking", "Browser tab-tracking") + '</span>' +
        '<span class="row-desc">' + _t("attBrowserTabTrackingDesc", "Install the tab-tracking helper in each browser you use so Clawd can tell coding from watching.") + '</span>' +
      '</div>' +
      '<div class="row-control">' +
        '<button type="button" class="btn-attention-action" id="att-scan-browsers">Scan browsers</button>' +
      '</div>';
    privacy.appendChild(browRow);

    const browList = document.createElement("ul");
    browList.className = "att-browser-list";
    browList.style.margin = "8px 0 0";
    privacy.appendChild(browList);

    browRow.querySelector("#att-scan-browsers").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      browList.innerHTML = '<li class="dim">Scanning…</li>';
      let plan = [];
      try {
        const r = await window.minicpmSettings.detectBrowsers();
        plan = (r && r.plan) || [];
      } catch (err) {
        browList.innerHTML = '';
      }
      browList.innerHTML = "";
      if (!plan.length) {
        browList.innerHTML = '<li class="dim">No browsers detected.</li>';
        btn.disabled = false;
        return;
      }
      const chromium = ["chrome", "edge", "brave", "opera", "arc", "vivaldi", "chromium"];
      const labels = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", brave: "Brave", opera: "Opera", arc: "Arc", vivaldi: "Vivaldi", chromium: "Chromium", safari: "Safari", tor: "Tor Browser" };
      for (const entry of plan) {
        const id = entry.browser;
        const lower = String(id).toLowerCase();
        const li = document.createElement("li");
        li.className = "att-browser-item";
        const name = labels[lower] || id;
        li.innerHTML = '<span class="att-browser-name">' + name + '</span>';
        if (chromium.includes(lower) || lower === "firefox") {
          const open = document.createElement("button");
          open.type = "button";
          open.className = "btn-attention-action";
          open.textContent = "Reveal folder";
          open.addEventListener("click", () => {
            window.minicpmSettings.openExtensionFolder(id).catch(() => {});
          });
          li.appendChild(open);
        } else {
          const note = document.createElement("span");
          note.className = "dim";
          note.textContent = "No helper yet";
          li.appendChild(note);
        }
        browList.appendChild(li);
      }
      btn.disabled = false;
    });

    parent.appendChild(privacy);
  }

  function patchInPlace() {
    return false;
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;

    core.tabs.attention = {
      render,
      patchInPlace,
    };
  }

  root.ClawdSettingsTabAttention = { init };
})(globalThis);
