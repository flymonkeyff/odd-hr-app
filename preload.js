// 화면(렌더러)에 꼭 필요한 것만 연다. 파일 시스템이나 명령 실행은 직접 열지 않는다.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oddhr", {
  config: () => ipcRenderer.sendSync("oddhr:config"),
  saveConfig: (c) => ipcRenderer.sendSync("oddhr:save-config", c),
  agent: (args) => ipcRenderer.invoke("oddhr:agent", args),
  setLoginItem: (on) => ipcRenderer.invoke("oddhr:set-login", on),
  setTheme: (t) => ipcRenderer.send("oddhr:set-theme", t),
  notify: (title, body) => ipcRenderer.invoke("oddhr:notify", { title, body }),
  onCheckNow: (fn) => ipcRenderer.on("oddhr:check-now", () => fn()),
  oauth: (url, back) => ipcRenderer.invoke("oddhr:oauth", { url, back }),
  saveFile: (name, bytes) => ipcRenderer.invoke("oddhr:save-file", { name, bytes }),
  showItem: (p) => ipcRenderer.invoke("oddhr:show-item", p),
  openFolder: (dir) => ipcRenderer.invoke("oddhr:open-folder", dir),
  updateCheck: () => ipcRenderer.invoke("oddhr:update-check"),
  updateInstall: () => ipcRenderer.invoke("oddhr:update-install"),
  installProperly: () => ipcRenderer.invoke("oddhr:install-properly"),
  installState: () => ipcRenderer.sendSync("oddhr:install-state"),
  onUpdate: (fn) => ipcRenderer.on("oddhr:update", (e, m) => fn(m))
});
