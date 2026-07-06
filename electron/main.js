/*
 * Electron main process for Club Sandwich Streaming.
 * Loads the existing static site (index.html) into a frameless desktop window
 * with a custom, branded title bar (see electron/preload.js + the .titlebar UI).
 */

const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const path = require("path");
const rpc = require("./rpc");
const adblock = require("./adblock");
const updater = require("./updater");
const server = require("./server");

const APP_TITLE = "Club Sandwich Streaming";
// Use a packaged asset (build/ is only used at build time, not bundled).
const ICON = path.join(__dirname, "..", "assets", "icons", "icon-512.png");
const APP_ROOT = path.join(__dirname, "..");

let mainWindow = null;
let appOrigin = null; // http://127.0.0.1:<port>

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
      // Let embedded players (trailers, streams) start without a click gesture.
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  Menu.setApplicationMenu(null);

  // Served over http://127.0.0.1 (see electron/server.js) so YouTube trailers
  // embed correctly; falls back to file:// if the server didn't start.
  if (appOrigin) {
    mainWindow.loadURL(`${appOrigin}/index.html`);
  } else {
    mainWindow.loadFile(path.join(APP_ROOT, "index.html"));
  }

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

  // Allow HTML5 fullscreen from stream embeds (VidSrc, 2Embed, etc.).
  const wireEmbedFullscreen = (contents) => {
    contents.on("enter-html-full-screen", () => {
      const win = BrowserWindow.fromWebContents(contents);
      if (win && !win.isDestroyed()) win.setFullScreen(true);
    });
    contents.on("leave-html-full-screen", () => {
      const win = BrowserWindow.fromWebContents(contents);
      if (win && !win.isDestroyed() && win.isFullScreen()) win.setFullScreen(false);
    });
  };
  wireEmbedFullscreen(mainWindow.webContents);
  app.on("web-contents-created", (_e, contents) => {
    wireEmbedFullscreen(contents);
  });

  // Block ad hosts, popups, and redirect hijacks (see electron/adblock.js).
  adblock.install(app, mainWindow, appOrigin);

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

// ---- Auto-update: "Restart & update now" from the renderer ----
ipcMain.on("update:install", () => updater.installNow());

// ---- Open a URL in the real browser (used for "Cast / open in browser") ----
ipcMain.on("open-external", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

app.whenReady().then(async () => {
  try {
    const s = await server.start(APP_ROOT);
    appOrigin = s.origin;
  } catch (e) {
    appOrigin = null; // fall back to file://
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
