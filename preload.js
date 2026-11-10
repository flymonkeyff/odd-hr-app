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
  onCheckNow: (fn) => ipcRenderer.on("oddhr:check-now", () => fn())
});
