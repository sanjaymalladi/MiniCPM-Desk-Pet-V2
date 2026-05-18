"use strict";

// ── MiniCPM settings tab ──
// Status panel + controls for the local MiniCPM sidecar. Reads/writes
// state via window.minicpmSettings (defined in preload-settings.js).
//
// Sections:
//   1. 当前状态        — model / adapter / persona / device
//   2. 模型更新        — check + apply
//   3. LoRA / 人格     — list + switch
//   4. 桌宠旁白         — narration on/off
//   5. 快捷键 (只读)    — reminder of hotkeys

(function initSettingsTabMinicpm(root) {
  let core = null;
  let helpers = null;
  let cachedAdapters = null;

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      if (k === "style") Object.assign(e.style, attrs[k]);
      else if (k === "className") e.className = attrs[k];
      else if (k.startsWith("on") && typeof attrs[k] === "function") e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    for (const child of children) {
      if (child == null) continue;
      e.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return e;
  }

  function row(label, control, hint) {
    const wrap = el("div", { className: "row" });
    const text = el("div", { className: "row-text" });
    text.appendChild(el("span", { className: "row-label" }, label));
    if (hint) text.appendChild(el("span", { className: "row-desc" }, hint));
    wrap.appendChild(text);
    const ctl = el("div", { className: "row-control" });
    if (control) ctl.appendChild(control);
    wrap.appendChild(ctl);
    return wrap;
  }

  function section(title, ...rows) {
    const grp = el("section", { className: "section" });
    grp.appendChild(el("h3", { className: "section-title" }, title));
    for (const r of rows) if (r) grp.appendChild(r);
    return grp;
  }

  function btn(label, onClick, opts = {}) {
    const b = el("button", { className: "btn" + (opts.primary ? " primary" : ""), onClick });
    b.textContent = label;
    if (opts.disabled) b.disabled = true;
    return b;
  }

  function statusLine(label, value, valueColor) {
    const r = el("div", { className: "row" });
    const t = el("div", { className: "row-text" });
    t.appendChild(el("span", { className: "row-label" }, label));
    r.appendChild(t);
    const v = el("div", { className: "row-control" });
    const span = el("span", {});
    span.textContent = value || "—";
    if (valueColor) span.style.color = valueColor;
    v.appendChild(span);
    r.appendChild(v);
    return r;
  }

  async function render(parent) {
    parent.innerHTML = "";
    const head = el("div", { className: "tab-header" });
    head.appendChild(el("h2", {}, "MiniCPM"));
    head.appendChild(el("p", { className: "tab-subtitle" }, "本地推理服务、LoRA 适配器、模型更新和桌宠旁白。"));
    parent.appendChild(head);

    // State containers — populated async.
    const statusBox = el("div", { className: "section" });
    statusBox.appendChild(el("h3", { className: "section-title" }, "当前状态"));
    statusBox.appendChild(el("div", { className: "row-desc" }, "加载中…"));
    parent.appendChild(statusBox);

    const updateBox = el("div", {});
    parent.appendChild(updateBox);

    const adapterBox = el("div", {});
    parent.appendChild(adapterBox);

    const paramsBox = el("div", {});
    parent.appendChild(paramsBox);

    const bubblePosBox = el("div", {});
    parent.appendChild(bubblePosBox);

    const narrationBox = el("div", {});
    parent.appendChild(narrationBox);

    const hotkeysBox = el("div", {});
    parent.appendChild(hotkeysBox);

    parent.appendChild(section("快捷键",
      statusLine("⌘⇧M", "开关聊天气泡"),
      statusLine("⌘⇧T", "切换思考显示"),
      statusLine("Esc", "关闭气泡 (在气泡内)"),
    ));

    if (!window.minicpmSettings) {
      statusBox.querySelector(".row-desc").textContent = "MiniCPM IPC 不可用 (preload 未加载)";
      return;
    }

    await refreshAll(statusBox, updateBox, adapterBox, paramsBox, bubblePosBox, narrationBox);
  }

  // Editing flag is module-scoped so navigating away cleans up safely.
  let editingBubble = false;
  async function renderBubblePosSection(box) {
    box.innerHTML = "";
    let payload = null;
    try { payload = await window.minicpmSettings.getBubblePos(); } catch {}
    const pos = (payload && payload.pos) || { side: "left", dx: 0, dy: 0 };
    const sec = el("section", { className: "section" });
    sec.appendChild(el("h3", { className: "section-title" }, "气泡位置"));

    // Side preference dropdown.
    const sideRow = el("div", { className: "row" });
    const st = el("div", { className: "row-text" });
    st.appendChild(el("span", { className: "row-label" }, "默认侧边"));
    st.appendChild(el("span", { className: "row-desc" },
      "气泡优先出现在桌宠的哪一侧；空间不够会自动翻到对面。"));
    sideRow.appendChild(st);
    const sideSel = el("select", { className: "select" });
    [["left", "左侧"], ["right", "右侧"], ["auto", "自动"]].forEach(([v, label]) => {
      const opt = el("option", { value: v }, label);
      if (pos.side === v) opt.selected = true;
      sideSel.appendChild(opt);
    });
    sideSel.addEventListener("change", async () => {
      const next = { ...pos, side: sideSel.value };
      await window.minicpmSettings.setBubblePos(next);
      Object.assign(pos, next);
    });
    const sideCtl = el("div", { className: "row-control" });
    sideCtl.appendChild(sideSel);
    sideRow.appendChild(sideCtl);
    sec.appendChild(sideRow);

    // Offset display + drag-to-position controls.
    const offsetRow = el("div", { className: "row" });
    const ot = el("div", { className: "row-text" });
    ot.appendChild(el("span", { className: "row-label" }, "微调偏移"));
    const desc = el("span", { className: "row-desc" });
    desc.textContent = `当前 dx=${pos.dx ?? 0}px · dy=${pos.dy ?? 0}px`;
    ot.appendChild(desc);
    offsetRow.appendChild(ot);
    const ctl = el("div", { className: "row-control", style: { gap: "8px" } });

    const editBtn = btn(editingBubble ? "✓ 保存位置" : "📍 拖动调整", null);
    const cancelBtn = btn("× 取消", null);
    cancelBtn.style.display = editingBubble ? "" : "none";

    editBtn.addEventListener("click", async () => {
      if (!editingBubble) {
        editingBubble = true;
        editBtn.textContent = "✓ 保存位置";
        editBtn.classList.add("primary");
        cancelBtn.style.display = "";
        await window.minicpmSettings.enterBubbleEdit();
      } else {
        const r = await window.minicpmSettings.exitBubbleEdit(true);
        editingBubble = false;
        if (r && r.pos) Object.assign(pos, r.pos);
        await renderBubblePosSection(box);
      }
    });
    cancelBtn.addEventListener("click", async () => {
      await window.minicpmSettings.exitBubbleEdit(false);
      editingBubble = false;
      await renderBubblePosSection(box);
    });
    const resetBtn = btn("重置默认", async () => {
      await window.minicpmSettings.resetBubblePos();
      await renderBubblePosSection(box);
    });

    ctl.appendChild(editBtn);
    ctl.appendChild(cancelBtn);
    ctl.appendChild(resetBtn);
    offsetRow.appendChild(ctl);
    sec.appendChild(offsetRow);

    if (editingBubble) {
      sec.appendChild(el("div", { className: "row-desc", style: { padding: "4px 12px", color: "var(--accent, #6b56ff)" } },
        "气泡已弹出 — 直接用鼠标拖到喜欢的位置，回到这里点「保存位置」。"));
    }

    box.appendChild(sec);
  }

  // Build a "label · slider · numeric input · hint" row that debounces
  // writes back to the main process. `key` is the chatParams field name,
  // `range` is { min, max, step, decimals }, `hint` describes the param.
  function paramRow(currentValue, key, label, hint, range, onCommit) {
    const r = el("div", { className: "row" });
    const tx = el("div", { className: "row-text" });
    tx.appendChild(el("span", { className: "row-label" }, label));
    tx.appendChild(el("span", { className: "row-desc" }, hint));
    r.appendChild(tx);

    const ctl = el("div", { className: "row-control", style: { gap: "8px", alignItems: "center" } });
    const slider = el("input", {
      type: "range",
      min: String(range.min),
      max: String(range.max),
      step: String(range.step),
    });
    slider.value = String(currentValue);
    slider.style.width = "150px";

    const num = el("input", { type: "number" });
    num.min = String(range.min);
    num.max = String(range.max);
    num.step = String(range.step);
    num.value = String(currentValue);
    num.style.width = "70px";
    num.style.padding = "4px 6px";
    num.style.border = "1px solid var(--input-border, rgba(0,0,0,0.08))";
    num.style.borderRadius = "6px";
    num.style.background = "var(--input-bg, #f4f4f5)";
    num.style.color = "var(--text-primary, #18181b)";
    num.style.fontSize = "12px";

    const sync = (v) => {
      const fixed = Number.isFinite(v) ? Number(v) : currentValue;
      slider.value = String(fixed);
      num.value = String(fixed);
    };
    let pending = null;
    const debounceCommit = (v) => {
      pending = v;
      if (debounceCommit._t) clearTimeout(debounceCommit._t);
      debounceCommit._t = setTimeout(() => { if (pending !== null) onCommit(key, pending); pending = null; }, 200);
    };
    slider.addEventListener("input", () => { sync(parseFloat(slider.value)); debounceCommit(parseFloat(slider.value)); });
    num.addEventListener("change", () => { sync(parseFloat(num.value)); onCommit(key, parseFloat(num.value)); });

    ctl.appendChild(slider);
    ctl.appendChild(num);
    r.appendChild(ctl);
    return r;
  }

  function checkboxRow(currentValue, label, hint, onChange) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !!currentValue;
    cb.addEventListener("change", () => onChange(cb.checked));
    const r = el("div", { className: "row" });
    const tx = el("div", { className: "row-text" });
    tx.appendChild(el("span", { className: "row-label" }, label));
    tx.appendChild(el("span", { className: "row-desc" }, hint));
    r.appendChild(tx);
    const ctl = el("div", { className: "row-control" });
    ctl.appendChild(cb);
    r.appendChild(ctl);
    return r;
  }

  async function renderParamsSection(paramsBox) {
    paramsBox.innerHTML = "";
    let payload = null;
    try { payload = await window.minicpmSettings.getChatParams(); } catch {}
    const params = (payload && payload.params) || {};
    const sec = el("section", { className: "section" });
    sec.appendChild(el("h3", { className: "section-title" }, "聊天生成参数"));

    const commit = async (key, value) => {
      const next = { ...params, [key]: value };
      const r = await window.minicpmSettings.setChatParams(next);
      if (r && r.params) Object.assign(params, r.params);
    };

    sec.appendChild(paramRow(
      params.temperature ?? 0.6, "temperature",
      "Temperature",
      "0 = 贪心解码（确定）；1 = 默认；越高越发散",
      { min: 0, max: 2, step: 0.05 }, commit,
    ));
    sec.appendChild(paramRow(
      params.top_p ?? 0.95, "top_p",
      "Top-p",
      "核采样阈值，常用 0.9–0.95",
      { min: 0.1, max: 1, step: 0.01 }, commit,
    ));
    sec.appendChild(paramRow(
      params.top_k ?? 0, "top_k",
      "Top-k",
      "0 = 不限制；典型范围 20–80",
      { min: 0, max: 200, step: 1 }, commit,
    ));
    sec.appendChild(paramRow(
      params.repetition_penalty ?? 1.05, "repetition_penalty",
      "Repetition penalty",
      "1.0 = 不惩罚；> 1 抑制复读",
      { min: 1, max: 2, step: 0.01 }, commit,
    ));
    sec.appendChild(paramRow(
      params.max_new_tokens ?? 768, "max_new_tokens",
      "Max new tokens",
      "单条回复最大 token 数",
      { min: 16, max: 4096, step: 16 }, commit,
    ));
    sec.appendChild(checkboxRow(
      !!params.thinking,
      "默认开启思考模式",
      "新会话默认显示 <think>。LoRA 模型未训练 think 时建议关闭。",
      (v) => commit("thinking", v),
    ));

    const resetRow = el("div", { className: "row" });
    const t = el("div", { className: "row-text" });
    t.appendChild(el("span", { className: "row-label" }, "重置"));
    t.appendChild(el("span", { className: "row-desc" }, "把所有参数还原到内置默认值。"));
    resetRow.appendChild(t);
    const c = el("div", { className: "row-control" });
    c.appendChild(btn("重置默认值", async () => {
      await window.minicpmSettings.resetChatParams();
      await renderParamsSection(paramsBox);
    }));
    resetRow.appendChild(c);
    sec.appendChild(resetRow);

    paramsBox.appendChild(sec);
  }

  async function refreshAll(statusBox, updateBox, adapterBox, paramsBox, bubblePosBox, narrationBox) {
    // ── status ──
    let st = null;
    try { st = await window.minicpmSettings.getStatus(); } catch {}
    statusBox.innerHTML = "";
    statusBox.appendChild(el("h3", { className: "section-title" }, "当前状态"));
    if (!st || !st.healthy) {
      statusBox.appendChild(el("div", { className: "row-desc" }, "Sidecar 未连接 — 启动桌宠后再试"));
      return;
    }
    const h = st.health || {};
    statusBox.appendChild(statusLine("模型", h.model_name || h.model_dir || "?"));
    statusBox.appendChild(statusLine("适配器", h.adapter ? h.adapter.split("/").pop() : "无 (base)"));
    statusBox.appendChild(statusLine("人格", h.persona || "default"));
    statusBox.appendChild(statusLine("设备", `${h.device || "?"} · ${h.dtype || "?"}`));
    statusBox.appendChild(statusLine("Sidecar URL", st.sidecarUrl || ""));
    statusBox.appendChild(statusLine("Bridge dir", st.bridgeDir || ""));

    // ── update ──
    updateBox.innerHTML = "";
    let upd = null;
    try { upd = await window.minicpmSettings.checkUpdate(); } catch {}
    const updRow = el("div", { className: "row" });
    const updText = el("div", { className: "row-text" });
    updText.appendChild(el("span", { className: "row-label" }, "模型版本"));
    if (upd) {
      const desc = upd.available
        ? `本地 ${upd.local_revision || "?"} · 远端 ${upd.remote_revision || "?"} · 有新版可用`
        : `${upd.local_revision || "?"}（已是最新）`;
      const descEl = el("span", { className: "row-desc" }, desc);
      if (upd.available) descEl.style.color = "var(--accent, #6b56ff)";
      updText.appendChild(descEl);
    } else {
      updText.appendChild(el("span", { className: "row-desc" }, "无法读取版本信息"));
    }
    updRow.appendChild(updText);
    const updCtl = el("div", { className: "row-control" });
    updCtl.appendChild(btn("重新检查", async () => {
      await refreshAll(statusBox, updateBox, adapterBox, paramsBox, bubblePosBox, narrationBox);
    }));
    if (upd && upd.available) {
      updCtl.appendChild(btn("立即更新", async (ev) => {
        ev.target.disabled = true;
        ev.target.textContent = "下载中…";
        await window.minicpmSettings.applyUpdate();
        ev.target.disabled = false;
        ev.target.textContent = "立即更新";
        await refreshAll(statusBox, updateBox, adapterBox, paramsBox, bubblePosBox, narrationBox);
      }, { primary: true }));
    }
    const updSec = el("section", { className: "section" });
    updSec.appendChild(el("h3", { className: "section-title" }, "模型更新"));
    updSec.appendChild(updRow);
    updateBox.appendChild(updSec);

    // ── adapters ──
    adapterBox.innerHTML = "";
    let adapters = null;
    try { adapters = await window.minicpmSettings.listAdapters(); } catch {}
    const adapterSec = el("section", { className: "section" });
    adapterSec.appendChild(el("h3", { className: "section-title" }, "LoRA / 人格"));
    if (!adapters || !adapters.items || adapters.items.length === 0) {
      adapterSec.appendChild(el("div", { className: "row-desc" },
        "在 adapters/ 目录里放 PEFT 格式的 LoRA 才能切换。"));
    } else {
      const select = el("select", { className: "select" });
      const noneOpt = el("option", { value: "" }, "无 LoRA (base 模型)");
      if (!adapters.current) noneOpt.selected = true;
      select.appendChild(noneOpt);
      for (const a of adapters.items) {
        const opt = el("option", { value: a.path }, a.name);
        if (a.path === adapters.current) opt.selected = true;
        select.appendChild(opt);
      }
      const applyBtn = btn("应用", async () => {
        applyBtn.disabled = true;
        applyBtn.textContent = "切换中…";
        const target = select.value || null;
        await window.minicpmSettings.loadAdapter(target);
        applyBtn.disabled = false;
        applyBtn.textContent = "应用";
        await refreshAll(statusBox, updateBox, adapterBox, paramsBox, bubblePosBox, narrationBox);
      }, { primary: true });
      const ctl = el("div", { className: "row-control", style: { gap: "8px" } });
      ctl.appendChild(select);
      ctl.appendChild(applyBtn);
      const r = el("div", { className: "row" });
      const t = el("div", { className: "row-text" });
      t.appendChild(el("span", { className: "row-label" }, "选择"));
      t.appendChild(el("span", { className: "row-desc" }, "切换会清空当前对话历史以避免人格污染。"));
      r.appendChild(t);
      r.appendChild(ctl);
      adapterSec.appendChild(r);
    }
    adapterBox.appendChild(adapterSec);

    // ── chat generation params ──
    await renderParamsSection(paramsBox);

    // ── bubble position ──
    await renderBubblePosSection(bubblePosBox);

    // ── narration ──
    narrationBox.innerHTML = "";
    const narrSec = el("section", { className: "section" });
    narrSec.appendChild(el("h3", { className: "section-title" }, "桌宠旁白"));
    const cb = el("input", { type: "checkbox" });
    cb.checked = !!st.narration;
    cb.addEventListener("change", async () => {
      await window.minicpmSettings.setNarration(cb.checked);
    });
    const nr = el("div", { className: "row" });
    const nt = el("div", { className: "row-text" });
    nt.appendChild(el("span", { className: "row-label" }, "启用主动旁白"));
    nt.appendChild(el("span", { className: "row-desc" },
      "Cursor / Claude / Codex 完成一轮、报错时桌宠会用一句话点评。"));
    nr.appendChild(nt);
    const nc = el("div", { className: "row-control" });
    nc.appendChild(cb);
    nr.appendChild(nc);
    narrSec.appendChild(nr);
    narrationBox.appendChild(narrSec);
  }

  function init(coreArg) {
    core = coreArg;
    helpers = core.helpers;
    core.tabs.minicpm = {
      render: (parent) => { void render(parent); },
    };
  }

  root.ClawdSettingsTabMinicpm = { init };
})(typeof globalThis !== "undefined" ? globalThis : window);
