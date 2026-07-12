"use strict";

const portInput = document.getElementById("port-input");
const saveBtn = document.getElementById("save-btn");
const dot = document.getElementById("dot");
const statusText = document.getElementById("status-text");

async function checkConnection(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`, { method: "GET" });
    return res.ok;
  } catch { return false; }
}

async function updateStatus() {
  const result = await chrome.storage.local.get(["clawd_hook_port"]);
  const port = result.clawd_hook_port || 23333;
  portInput.value = port;
  const ok = await checkConnection(port);
  dot.className = "dot " + (ok ? "connected" : "disconnected");
  statusText.textContent = ok ? `Connected on port ${port}` : `Not connected (port ${port})`;
}

saveBtn.addEventListener("click", async () => {
  const port = parseInt(portInput.value, 10);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) return;
  await chrome.storage.local.set({ clawd_hook_port: port });
  await updateStatus();
});

updateStatus();
