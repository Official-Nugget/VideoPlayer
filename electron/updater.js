/*
 * Auto-update via electron-updater + GitHub Releases.
 * Completely dormant unless electron/update-config.js has OWNER + REPO set,
 * and only runs in the packaged app (never during `npm start`).
 */

const { OWNER, REPO } = require("./update-config");

function configured() {
  return (
    typeof OWNER === "string" &&
    OWNER.trim() &&
    typeof REPO === "string" &&
    REPO.trim()
  );
}

function init(app, mainWindow) {
  if (!configured()) return;
  if (!app.isPackaged) return; // don't check while developing

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return;
  }

  try {
    autoUpdater.setFeedURL({
      provider: "github",
      owner: OWNER.trim(),
      repo: REPO.trim(),
    });
  } catch {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const notify = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  };

  autoUpdater.on("update-available", (info) =>
    notify("update:available", { version: info?.version })
  );
  autoUpdater.on("update-downloaded", (info) =>
    notify("update:downloaded", { version: info?.version })
  );
  autoUpdater.on("error", () => {
    /* network / no release yet — ignore silently */
  });

  // Check shortly after launch, then every 6 hours.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
  setInterval(
    () => autoUpdater.checkForUpdates().catch(() => {}),
    6 * 60 * 60 * 1000
  );
}

module.exports = { init, configured };
