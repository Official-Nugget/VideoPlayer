/*
 * Playback source layer.
 *
 * Supports multiple streaming sources (a "Source" dropdown in the player):
 *   - VidLink  -> https://vidlink.pro/movie/{id}  |  /tv/{id}/{s}/{e}
 *                 (brand colors, resume via ?startAt=, default or JW engine)
 *   - Backups  -> template-based TMDB-id embeds defined in CONFIG.SOURCES
 *
 * Also stores playback settings, computes resume position, and listens for the
 * postMessage events VidLink emits to power the "Continue Watching" row.
 */

const Player = (() => {
  // ---------------- Settings ----------------
  function getSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG.LS_SETTINGS) || "{}");
      return { ...CONFIG.SETTINGS_DEFAULTS, ...saved };
    } catch {
      return { ...CONFIG.SETTINGS_DEFAULTS };
    }
  }
  function setSettings(patch) {
    const merged = { ...getSettings(), ...patch };
    localStorage.setItem(CONFIG.LS_SETTINGS, JSON.stringify(merged));
    return merged;
  }

  // ---------------- Source selection ----------------
  function sources() {
    return CONFIG.SOURCES;
  }
  function getSource(id) {
    return CONFIG.SOURCES.find((s) => s.id === id) || CONFIG.SOURCES[0];
  }
  function getSourceId() {
    if (getSettings().rememberSource) {
      const saved = localStorage.getItem(CONFIG.LS_SOURCE);
      if (saved && CONFIG.SOURCES.some((s) => s.id === saved)) return saved;
    }
    return CONFIG.SOURCES[0].id;
  }
  function setSourceId(id) {
    localStorage.setItem(CONFIG.LS_SOURCE, id);
  }

  // ---------------- VidLink URL params ----------------
  function vidlinkParams(engine) {
    const p = CONFIG.PLAYER;
    const s = getSettings();
    return new URLSearchParams({
      primaryColor: p.primaryColor,
      secondaryColor: p.secondaryColor,
      iconColor: p.iconColor,
      icons: p.icons,
      title: String(p.title),
      poster: String(p.poster),
      autoplay: String(s.autoplay),
      nextbutton: String(p.nextbutton),
      player: engine || "default",
    });
  }

  // ---------------- Resume position ----------------
  // Reads VidLink's saved progress for this exact title/episode (in seconds).
  function resumeSeconds(ctx) {
    if (!ctx) return 0;
    const data = getProgress();
    const item = data[ctx.id] || data[String(ctx.id)];
    if (!item) return 0;
    if (ctx.media === "tv") {
      const key = `s${ctx.season}e${ctx.episode}`;
      const watched = item.show_progress?.[key]?.progress?.watched;
      return watched ? Math.floor(watched) : 0;
    }
    return item.progress?.watched ? Math.floor(item.progress.watched) : 0;
  }

  // ---------------- Build a playable URL ----------------
  // ctx = { media: "movie"|"tv", id, season?, episode? }
  function buildUrl(ctx, sourceId) {
    const src = getSource(sourceId || getSourceId());
    const settings = getSettings();

    if (src.vidlink) {
      const params = vidlinkParams(src.engine);
      if (settings.resume) {
        const sec = resumeSeconds(ctx);
        if (sec > 5) params.set("startAt", String(sec));
      }
      const qs = params.toString();
      return ctx.media === "movie"
        ? `${CONFIG.VIDLINK_BASE}/movie/${ctx.id}?${qs}`
        : `${CONFIG.VIDLINK_BASE}/tv/${ctx.id}/${ctx.season}/${ctx.episode}?${qs}`;
    }

    // Template-based backup source.
    const tpl = ctx.media === "movie" ? src.movie : src.tv;
    if (!tpl) return "about:blank";
    return tpl
      .replaceAll("{id}", ctx.id)
      .replaceAll("{season}", ctx.season)
      .replaceAll("{episode}", ctx.episode);
  }

  // ---------------- Continue-watching progress ----------------
  function initProgressListener() {
    window.addEventListener("message", (event) => {
      if (event.origin !== CONFIG.VIDLINK_ORIGIN) return;
      const data = event.data;
      if (!data) return;

      if (data.type === "MEDIA_DATA") {
        try {
          localStorage.setItem(CONFIG.LS_PROGRESS, JSON.stringify(data.data));
          document.dispatchEvent(new CustomEvent("progress:updated"));
        } catch (e) {
          /* storage may be full / disabled */
        }
      } else if (data.type === "PLAYER_EVENT") {
        // { event: "play"|"pause"|"seeked"|"ended"|"timeupdate", ... }
        document.dispatchEvent(
          new CustomEvent("player:event", { detail: data.data || {} })
        );
      }
    });
  }

  function getProgress() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG.LS_PROGRESS) || "{}");
    } catch {
      return {};
    }
  }

  // Pick the freshest per-episode progress for a TV item (fallback when there
  // is no usable top-level progress).
  function latestEpisodeProgress(item) {
    const sp = item.show_progress;
    if (!sp || typeof sp !== "object") return null;
    let best = null;
    for (const key of Object.keys(sp)) {
      const ep = sp[key];
      const p = ep?.progress;
      if (!p || !p.duration) continue;
      const stamp = ep.last_updated || p.last_updated || 0;
      if (!best || stamp >= best.stamp) {
        best = {
          stamp,
          season: ep.season,
          episode: ep.episode,
          progress: p,
        };
      }
    }
    return best;
  }

  function continueWatching() {
    const data = getProgress();
    return Object.values(data)
      .map((item) => {
        if (!item) return null;
        const isTv = (item.type || item.media_type) === "tv";

        // Prefer a valid top-level progress; else derive from show_progress.
        let progress = item.progress;
        let season = item.last_season_watched;
        let episode = item.last_episode_watched;

        if (isTv && (!progress || !progress.duration)) {
          const ep = latestEpisodeProgress(item);
          if (ep) {
            progress = ep.progress;
            season = season || ep.season;
            episode = episode || ep.episode;
          }
        }

        if (!progress || !progress.duration) return null;

        return {
          ...item,
          last_season_watched: season,
          last_episode_watched: episode,
          percent: Math.min(
            100,
            Math.round((progress.watched / progress.duration) * 100)
          ),
          _sort: item.last_updated || progress.last_updated || 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b._sort || 0) - (a._sort || 0));
  }

  return {
    getSettings,
    setSettings,
    sources,
    getSource,
    getSourceId,
    setSourceId,
    resumeSeconds,
    buildUrl,
    initProgressListener,
    getProgress,
    continueWatching,
  };
})();
