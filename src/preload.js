"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gfxConv", {
  choosePlate: () => ipcRenderer.invoke("dialog:choosePlate"),
  choosePlateFolder: () => ipcRenderer.invoke("dialog:choosePlateFolder"),
  chooseTrack: () => ipcRenderer.invoke("dialog:chooseTrack"),
  chooseOutputDir: () => ipcRenderer.invoke("dialog:chooseOutputDir"),
  listColorSpaces: () => ipcRenderer.invoke("ocio:list"),
  analyzeConform: (payload) => ipcRenderer.invoke("conform:analyze", payload),
  createSourcePreview: (payload) => ipcRenderer.invoke("preview:createSource", payload),
  createConformPreview: (payload) => ipcRenderer.invoke("preview:createConform", payload),
  runConform: (payload) => ipcRenderer.invoke("conform:run", payload),
  cancelConform: () => ipcRenderer.invoke("conform:cancel"),
  openPath: (targetPath) => ipcRenderer.invoke("shell:openPath", targetPath),
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  collectLogs: (payload) => ipcRenderer.invoke("logs:collect", payload),
  log: (level, event, details) => ipcRenderer.send("logs:renderer", { level, event, details }),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  checkUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadAndInstallUpdate: () => ipcRenderer.invoke("updates:downloadAndInstall"),
  onConformProgress: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on("conform:progress", listener);
    return () => ipcRenderer.removeListener("conform:progress", listener);
  },
  onUpdateDownloadProgress: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on("updates:downloadProgress", listener);
    return () => ipcRenderer.removeListener("updates:downloadProgress", listener);
  }
});
