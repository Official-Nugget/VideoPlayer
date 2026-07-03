/*
 * Preload: safely exposes a tiny window-control API to the renderer.
 * The web page detects `window.desktop?.isElectron` to show its custom title bar.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true,
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onMaximizeChange: (cb) =>
    ipcRenderer.on("window:maximized", (_e, isMax) => cb(isMax)),

  // Discord Rich Presence
  setPresence: (info) => ipcRenderer.send("discord:set", info),
  clearPresence: () => ipcRenderer.send("discord:clear"),

  // Auto-update notifications
  onUpdateAvailable: (cb) =>
    ipcRenderer.on("update:available", (_e, info) => cb(info)),
  onUpdateDownloaded: (cb) =>
    ipcRenderer.on("update:downloaded", (_e, info) => cb(info)),
});
