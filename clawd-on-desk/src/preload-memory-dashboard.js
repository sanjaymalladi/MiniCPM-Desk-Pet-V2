"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("memoryAPI", {
  getState: () => ipcRenderer.invoke("memory-dashboard:get-state"),
  getGraph: () => ipcRenderer.invoke("memory-dashboard:get-graph"),
  search: (query, category) => ipcRenderer.invoke("memory-dashboard:search", { query, category }),
  add: (content, category) => ipcRenderer.invoke("memory-dashboard:add", { content, category }),
  remove: (id) => ipcRenderer.invoke("memory-dashboard:delete", { id }),
  setPref: (key, value) => ipcRenderer.invoke("memory-dashboard:set-pref", { key, value }),
});
