/*
 * Discord Rich Presence manager.
 * Fails silently if there's no Client ID configured or Discord isn't running,
 * so the app works fine with or without Discord.
 */

const { Client } = require("@xhayper/discord-rpc");
const { DISCORD_CLIENT_ID, LARGE_IMAGE_KEY } = require("./discord-config");

let client = null;
let ready = false;
let connecting = false;
let pending = null; // last activity requested before we were ready

function enabled() {
  return typeof DISCORD_CLIENT_ID === "string" && DISCORD_CLIENT_ID.trim() !== "";
}

async function connect() {
  if (!enabled() || client || connecting) return;
  connecting = true;
  try {
    client = new Client({ clientId: DISCORD_CLIENT_ID.trim() });
    client.on("ready", () => {
      ready = true;
      if (pending) {
        apply(pending);
        pending = null;
      }
    });
    await client.login();
  } catch (e) {
    // Discord not installed / not running — ignore.
    client = null;
    ready = false;
  } finally {
    connecting = false;
  }
}

function apply(info) {
  if (!client || !ready) return;
  try {
    const activity = {
      details: info.title ? String(info.title).slice(0, 128) : "Browsing",
      state:
        info.media === "tv" && info.season && info.episode
          ? `Season ${info.season} · Episode ${info.episode}`
          : info.media === "movie"
          ? "Watching a movie"
          : undefined,
      largeImageKey: info.poster || LARGE_IMAGE_KEY || undefined,
      largeImageText: info.title || "Club Sandwich Streaming",
      smallImageKey: info.poster ? LARGE_IMAGE_KEY || undefined : undefined,
      smallImageText: "Club Sandwich Streaming",
      startTimestamp: info.startTimestamp || Date.now(),
      instance: false,
    };
    client.user?.setActivity(activity);
  } catch (e) {
    /* ignore transient errors */
  }
}

// ---- Public API ----
async function setPresence(info) {
  if (!enabled()) return;
  if (!client) await connect();
  if (ready) apply(info || {});
  else pending = info || {};
}

function clearPresence() {
  if (client && ready) {
    try {
      client.user?.clearActivity();
    } catch (e) {
      /* ignore */
    }
  }
  pending = null;
}

module.exports = { setPresence, clearPresence, enabled };
