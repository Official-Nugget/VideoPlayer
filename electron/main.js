/*
 * Electron main process for Club Sandwich Streaming.
 * Loads the existing static site (index.html) into a frameless desktop window
 * with a custom, branded title bar (see electron/preload.js + the .titlebar UI).
 */

const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const path = require("path");
const rpc = require("./rpc");
const adblock = require("./adblock");
const updater = require("./updater");

const APP_TITLE = "Club Sandwich Streaming";
// Use a packaged asset (build/ is only used at build time, not bundled).
const ICON = path.join(__dirname, "..", "assets", "icons", "icon-512.png");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#14110b",
    title: APP_TITLE,
    icon: ICON,
    frame: false, // we draw our own title bar
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, "..", "index.html"));

  mainWindow.on("page-title-updated", (e) => {
    e.preventDefault();
    mainWindow.setTitle(APP_TITLE);
  });

  // Tell the renderer when the maximize state changes so the button can update.
  const sendMaxState = () =>
    mainWindow.webContents.send(
      "window:maximized",
      mainWindow.isMaximized()
    );
  mainWindow.on("maximize", sendMaxState);
  mainWindow.on("unmaximize", sendMaxState);

  // Block ad hosts, popups, and redirect hijacks (see electron/adblock.js).
  adblock.install(app, mainWindow);

  // Auto-update (dormant unless a GitHub repo is configured).
  updater.init(app, mainWindow);
}

// ---- Window control IPC (from the custom title bar) ----
ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("window:close", () => mainWindow?.close());
ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() ?? false);

// ---- Discord Rich Presence IPC (from the renderer on play/close) ----
ipcMain.on("discord:set", (_e, info) => rpc.setPresence(info));
ipcMain.on("discord:clear", () => rpc.clearPresence());

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
