"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");
const invoke = (channel) => async (...args) => {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response.ok) throw new Error(response.error || "Ошибка приложения.");
  return response.value;
};
const subscribe = (channel) => (callback) => {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("simpleConv", {
  getInitialState: invoke("simple:initial"),
  chooseFiles: invoke("simple:files"),
  chooseFolder: invoke("simple:folder"),
  chooseOutput: invoke("simple:output"),
  chooseManifest: invoke("simple:manifest"),
  pathsForFiles: (files) => Array.from(files, (file) => webUtils.getPathForFile(file)).filter(Boolean),
  analyze: invoke("simple:analyze"),
  preview: invoke("simple:preview"),
  run: invoke("simple:run"),
  cancel: invoke("simple:cancel"),
  saveSettings: invoke("simple:settings"),
  openPath: invoke("simple:open"),
  collectLogs: invoke("simple:logs"),
  checkUpdates: invoke("simple:updates"),
  installUpdate: invoke("simple:install"),
  onProgress: subscribe("simple:progress"),
  onUpdateProgress: subscribe("simple:update-progress")
});
