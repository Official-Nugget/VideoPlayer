/*
 * Main application controller.
 * Wires routing, data loading, detail modal, TV episode picker and playback.
 */

(() => {
  const $ = (s) => document.querySelector(s);
  const rowsEl = $("#rows");
  const gridView = $("#gridView");
  const heroEl = $("#hero");

  // ---------- Setup / API key check ----------
  function keyConfigured() {
    const hasV3 =
      CONFIG.TMDB_API_KEY &&
      CONFIG.TMDB_API_KEY !== "YOUR_TMDB_API_KEY_HERE" &&
      CONFIG.TMDB_API_KEY.trim().length > 0;
    const hasV4 =
      CONFIG.TMDB_ACCESS_TOKEN && CONFIG.TMDB_ACCESS_TOKEN.trim().length > 0;
    return hasV3 || hasV4;
  }

  // ---------- My List (localStorage) ----------
  const MyList = {
    all() {
      try {
        return JSON.parse(localStorage.getItem(CONFIG.LS_MYLIST) || "[]");
      } catch {
        return [];
      }
    },
    has(id, media) {
      return this.all().some((i) => i.id === id && i.media === media);
    },
    toggle(n) {
      let list = this.all();
      if (this.has(n.id, n.media)) {
        list = list.filter((i) => !(i.id === n.id && i.media === n.media));
      } else {
        list.unshift({
          id: n.id,
          media: n.media,
          title: n.title,
          poster_path: n.poster,
          backdrop_path: n.backdrop,
          vote_average: n.rating ? parseFloat(n.rating) : 0,
          release_date: n.media === "movie" ? `${n.year}` : "",
          first_air_date: n.media === "tv" ? `${n.year}` : "",
          overview: n.overview,
        });
      }
      localStorage.setItem(CONFIG.LS_MYLIST, JSON.stringify(list));
      return this.has(n.id, n.media);
    },
  };

  // ---------- Recently viewed (localStorage) ----------
  const Recent = {
    all() {
      try {
        return JSON.parse(localStorage.getItem(CONFIG.LS_RECENT) || "[]");
      } catch {
        return [];
      }
    },
    add(n) {
      if (!n || !n.id || !n.media) return;
      const item = {
        id: n.id,
        media: n.media,
        title: n.title || "",
        poster_path: n.poster ?? n.poster_path ?? null,
        backdrop_path: n.backdrop ?? n.backdrop_path ?? null,
      };
      let list = this.all().filter(
        (i) => !(i.id === item.id && i.media === item.media)
      );
      list.unshift(item);
      localStorage.setItem(CONFIG.LS_RECENT, JSON.stringify(list.slice(0, 20)));
    },
  };

  // ---------- Playback ----------
  const Playback = {
    ctx: null,
    seasons: [], // [{ season_number, episode_count }] for the current show
    open(ctx, seasons) {
      // ctx = { media, id, season?, episode?, title, poster?, backdrop? }
      this.ctx = ctx;
      if (seasons) this.seasons = normalizeSeasons(seasons);
      Recent.add(ctx);
      populateSourceSelect();
      UI.openPlayer(this.displayTitle());
      updatePresence(ctx);
      this.reload();
      if (ctx.media === "tv") this.ensureSeasons();
      this.updateNav();
    },
    displayTitle() {
      const c = this.ctx;
      if (!c) return "";
      return c.media === "tv"
        ? `${c.title} — S${c.season}:E${c.episode}`
        : c.title;
    },
    reload() {
      if (!this.ctx) return;
      $("#playerTitle").textContent = this.displayTitle();
      UI.setPlayerFrame(Player.buildUrl(this.ctx));
    },
    async ensureSeasons() {
      if (this.seasons.length) return this.updateNav();
      try {
        const d = await TMDB.details("tv", this.ctx.id);
        this.seasons = normalizeSeasons(d.seasons);
      } catch {
        /* leave nav hidden */
      }
      this.updateNav();
    },
    episodeCount(seasonNum) {
      const s = this.seasons.find((x) => x.season_number === Number(seasonNum));
      return s ? s.episode_count : 0;
    },
    nextTarget() {
      const c = this.ctx;
      if (!c || c.media !== "tv") return null;
      const s = Number(c.season);
      const e = Number(c.episode);
      if (e < this.episodeCount(s)) return { season: s, episode: e + 1 };
      const next = this.seasons.find((x) => x.season_number > s);
      return next ? { season: next.season_number, episode: 1 } : null;
    },
    prevTarget() {
      const c = this.ctx;
      if (!c || c.media !== "tv") return null;
      const s = Number(c.season);
      const e = Number(c.episode);
      if (e > 1) return { season: s, episode: e - 1 };
      const prev = [...this.seasons]
        .reverse()
        .find((x) => x.season_number < s);
      return prev
        ? { season: prev.season_number, episode: prev.episode_count }
        : null;
    },
    go(target) {
      if (!target || !this.ctx) return;
      this.ctx = { ...this.ctx, season: target.season, episode: target.episode };
      Recent.add(this.ctx);
      updatePresence(this.ctx);
      this.reload();
      this.updateNav();
    },
    updateNav() {
      const isTv = this.ctx?.media === "tv";
      const prevBtn = $("#playerPrev");
      const nextBtn = $("#playerNext");
      prevBtn.hidden = !(isTv && this.prevTarget());
      nextBtn.hidden = !(isTv && this.nextTarget());
    },
  };

  function normalizeSeasons(seasons) {
    return (seasons || [])
      .filter((s) => s.season_number > 0 && s.episode_count > 0)
      .map((s) => ({
        season_number: s.season_number,
        episode_count: s.episode_count,
      }))
      .sort((a, b) => a.season_number - b.season_number);
  }

  function playMovie(n) {
    Playback.open({
      media: "movie",
      id: n.id,
      title: n.title,
      poster: n.poster,
      backdrop: n.backdrop,
    });
  }
  function playEpisode(n, season, episode, seasons) {
    Playback.open(
      {
        media: "tv",
        id: n.id,
        season,
        episode,
        title: n.title,
        poster: n.poster,
        backdrop: n.backdrop,
      },
      seasons
    );
  }
  async function playSmart(n) {
    // Movies play instantly; TV opens the detail so the user can pick an episode.
    if (n.media === "movie") return playMovie(n);
    await openDetail(n);
  }

  function updatePresence(ctx) {
    if (!window.desktop?.setPresence) return;
    const poster = ctx.poster
      ? TMDB.img(ctx.poster, "w342")
      : ctx.backdrop
      ? TMDB.img(ctx.backdrop, "w780")
      : null;
    window.desktop.setPresence({
      media: ctx.media,
      title: ctx.title,
      season: ctx.season,
      episode: ctx.episode,
      poster,
      startTimestamp: Date.now(),
    });
  }

  function populateSourceSelect() {
    const sel = $("#sourceSelect");
    sel.innerHTML = Player.sources()
      .map(
        (s) => `<option value="${s.id}">${UI.escapeHtml(s.name)}</option>`
      )
      .join("");
    sel.value = Player.getSourceId();
  }

  // ---------- Detail modal ----------
  async function openDetail(n) {
    UI.openModal('<div class="spinner"></div>');
    let d;
    try {
      d = await TMDB.details(n.media, n.id);
    } catch (e) {
      UI.openModal(`<div class="empty">Couldn't load details.<br>${UI.escapeHtml(
        e.message
      )}</div>`);
      return;
    }

    const title = d.title || d.name;
    const year = (d.release_date || d.first_air_date || "").slice(0, 4);
    const runtime =
      d.runtime ||
      (Array.isArray(d.episode_run_time) && d.episode_run_time[0]) ||
      null;
    const genres = (d.genres || []).map((g) => g.name).join(", ");
    const cast = (d.credits?.cast || [])
      .slice(0, 4)
      .map((c) => c.name)
      .join(", ");
    const backdrop =
      TMDB.img(d.backdrop_path, "w1280") ||
      TMDB.img(d.poster_path, "w780") ||
      "";
    const inList = MyList.has(d.id, n.media);

    const trailer = (d.videos?.results || []).find(
      (v) =>
        v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser")
    );
    const prog = Player.getProgress()[d.id];
    const resumeInfo =
      n.media === "tv" &&
      prog?.last_season_watched &&
      prog?.last_episode_watched
        ? { s: prog.last_season_watched, e: prog.last_episode_watched }
        : null;

    const html = `
      <div class="modal__hero" style="background-image:url('${backdrop}')">
        <div class="modal__hero-fade"></div>
        <div class="modal__hero-title">${UI.escapeHtml(title)}</div>
      </div>
      <div class="modal__content">
        <div class="modal__actions">
          ${
            n.media === "movie"
              ? `<button class="btn btn--play" id="mPlay">
                   <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Play
                 </button>`
              : ""
          }
          ${
            resumeInfo
              ? `<button class="btn btn--play" id="mResume">
                   <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                   Resume S${resumeInfo.s}:E${resumeInfo.e}
                 </button>`
              : ""
          }
          ${
            trailer
              ? `<button class="btn btn--ghost" id="mTrailer">
                   <svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M8 5v14l11-7z"/></svg>
                   Trailer
                 </button>`
              : ""
          }
          <button class="btn btn--info" id="mList">
            ${inList ? "✓ In My List" : "+ My List"}
          </button>
          <button class="btn btn--ghost" id="mShare">Copy Link</button>
        </div>
        <div class="modal__meta">
          <span class="tag-green">${
            d.vote_average ? Math.round(d.vote_average * 10) + "% Match" : ""
          }</span>
          <span>${year || ""}</span>
          ${runtime ? `<span>${runtime} min</span>` : ""}
          ${
            n.media === "tv" && d.number_of_seasons
              ? `<span>${d.number_of_seasons} Season${
                  d.number_of_seasons > 1 ? "s" : ""
                }</span>`
              : ""
          }
          <span class="badge">${n.media === "tv" ? "TV" : "Movie"}</span>
        </div>
        <p class="modal__overview">${UI.escapeHtml(
          d.overview || "No description available."
        )}</p>
        <div class="modal__facts">
          ${genres ? `<div><b>Genres:</b> ${UI.escapeHtml(genres)}</div>` : ""}
          ${cast ? `<div><b>Cast:</b> ${UI.escapeHtml(cast)}</div>` : ""}
        </div>
        ${n.media === "tv" ? `<div class="episodes" id="episodes"></div>` : ""}
      </div>
    `;
    UI.openModal(html);

    const nData = {
      ...n,
      title,
      poster: n.poster ?? d.poster_path,
      backdrop: n.backdrop ?? d.backdrop_path,
    };
    Recent.add(nData);

    const playBtn = $("#mPlay");
    if (playBtn) playBtn.onclick = () => playMovie(nData);

    const resumeBtn = $("#mResume");
    if (resumeBtn)
      resumeBtn.onclick = () =>
        playEpisode(nData, resumeInfo.s, resumeInfo.e);

    const trailerBtn = $("#mTrailer");
    if (trailerBtn) trailerBtn.onclick = () => UI.openTrailer(trailer.key);

    const shareBtn = $("#mShare");
    if (shareBtn) shareBtn.onclick = () => shareLink(nData);

    const listBtn = $("#mList");
    listBtn.onclick = () => {
      const now = MyList.toggle(nData);
      listBtn.textContent = now ? "✓ In My List" : "+ My List";
    };

    if (n.media === "tv") {
      renderEpisodePicker(nData, d);
    }
  }

  function shareLink(n) {
    const url = `${location.origin}${location.pathname}#info/${n.media}/${n.id}`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => UI.notice("Link copied to clipboard."),
        () => UI.notice(url)
      );
    } else {
      UI.notice(url);
    }
  }

  async function renderEpisodePicker(n, details) {
    const wrap = $("#episodes");
    const seasons = (details.seasons || []).filter(
      (s) => s.season_number > 0 && s.episode_count > 0
    );
    const seasonList = seasons.length
      ? seasons
      : [{ season_number: 1, name: "Season 1" }];

    wrap.innerHTML = `
      <div class="episodes__head">
        <h3>Episodes</h3>
        <select class="select" id="seasonSelect">
          ${seasonList
            .map(
              (s) =>
                `<option value="${s.season_number}">${UI.escapeHtml(
                  s.name || "Season " + s.season_number
                )}</option>`
            )
            .join("")}
        </select>
      </div>
      <div id="episodeList"><div class="spinner"></div></div>
    `;

    const select = $("#seasonSelect");
    const loadSeason = async (num) => {
      const listEl = $("#episodeList");
      listEl.innerHTML = '<div class="spinner"></div>';
      let season;
      try {
        season = await TMDB.seasonDetails(n.id, num);
      } catch {
        listEl.innerHTML = '<div class="empty">Couldn\'t load episodes.</div>';
        return;
      }
      const eps = season.episodes || [];
      if (!eps.length) {
        listEl.innerHTML = '<div class="empty">No episodes found.</div>';
        return;
      }
      listEl.innerHTML = "";
      eps.forEach((ep) => {
        const row = document.createElement("div");
        row.className = "episode";
        const thumb = TMDB.img(ep.still_path, "w300");
        row.innerHTML = `
          <div class="episode__num">${ep.episode_number}</div>
          ${
            thumb
              ? `<img class="episode__thumb" loading="lazy" src="${thumb}" alt="">`
              : `<div class="episode__thumb"></div>`
          }
          <div class="episode__info">
            <h4>${UI.escapeHtml(ep.name || "Episode " + ep.episode_number)}</h4>
            <p>${UI.escapeHtml(ep.overview || "")}</p>
          </div>
        `;
        row.onclick = () =>
          playEpisode(n, num, ep.episode_number, details.seasons);
        listEl.appendChild(row);
      });
    };
    select.onchange = () => loadSeason(select.value);
    loadSeason(select.value);
  }

  // ---------- Row rendering ----------
  function cardOpts(percent) {
    return {
      percent,
      onClick: (n) => openDetail(n),
    };
  }

  async function addRow(title, loader, { play = false } = {}) {
    const { section, track } = UI.rowShell(title);
    rowsEl.appendChild(section);
    try {
      const items = await loader();
      track.innerHTML = "";
      let count = 0;
      items.forEach((item) => {
        const el = UI.card(item, cardOpts());
        if (el) {
          track.appendChild(el);
          count++;
        }
      });
      if (!count) section.remove();
    } catch (e) {
      section.remove();
      console.error(`Row "${title}" failed:`, e);
    }
  }

  function continueWatchingItems() {
    return Player.continueWatching();
  }

  function clearContinueWatching() {
    if (!confirm("Clear your Continue Watching history?")) return;
    localStorage.removeItem(CONFIG.LS_PROGRESS);
    loadHome();
    UI.notice("Continue Watching cleared.");
  }
  function clearRecent() {
    if (!confirm("Clear your Recently Viewed history?")) return;
    localStorage.removeItem(CONFIG.LS_RECENT);
    loadHome();
    UI.notice("Recently Viewed cleared.");
  }

  function renderContinueWatching() {
    const items = continueWatchingItems();
    if (!items.length) return;
    const { section, track } = UI.rowShell("Continue Watching", {
      action: { label: "✕ Clear", onClick: clearContinueWatching },
    });
    rowsEl.prepend(section);
    track.innerHTML = "";
    items.forEach((item) => {
      const el = UI.card(item, {
        percent: item.percent,
        onClick: (n) => {
          if (n.media === "tv") {
            const s = item.last_season_watched || 1;
            const e = item.last_episode_watched || 1;
            playEpisode(n, s, e);
          } else {
            playMovie(n);
          }
        },
      });
      if (el) track.appendChild(el);
    });
  }

  function renderRecent() {
    const items = Recent.all();
    if (!items.length) return;
    const { section, track } = UI.rowShell("Recently Viewed", {
      action: { label: "✕ Clear", onClick: clearRecent },
    });
    rowsEl.appendChild(section);
    track.innerHTML = "";
    let count = 0;
    items.forEach((item) => {
      const el = UI.card(item, { onClick: (n) => openDetail(n) });
      if (el) {
        track.appendChild(el);
        count++;
      }
    });
    if (!count) section.remove();
  }

  // "Because you watched X" rows built from your most recent titles.
  async function renderRecommendations() {
    const recent = Recent.all().slice(0, 3);
    const seen = new Set();
    for (const item of recent) {
      try {
        const res = await TMDB.recommendations(item.media, item.id);
        const results = (res.results || []).filter((r) => {
          const key = `${r.media_type || item.media}:${r.id}`;
          if (seen.has(key) || r.id === item.id) return false;
          seen.add(key);
          return r.poster_path;
        });
        if (results.length < 4) continue;
        results.forEach((r) => (r.media_type = r.media_type || item.media));
        const { section, track } = UI.rowShell(`Because you watched ${item.title}`);
        rowsEl.appendChild(section);
        track.innerHTML = "";
        results.slice(0, 20).forEach((r) => {
          const el = UI.card(r, { onClick: (n) => openDetail(n) });
          if (el) track.appendChild(el);
        });
      } catch (e) {
        /* skip this recommendation row */
      }
    }
  }

  // ---------- Views / routing ----------
  const GENRES_MOVIE = [
    { id: 28, name: "Action" },
    { id: 35, name: "Comedy" },
    { id: 27, name: "Horror" },
    { id: 10749, name: "Romance" },
    { id: 878, name: "Sci-Fi" },
    { id: 16, name: "Animation" },
  ];
  const GENRES_TV = [
    { id: 10759, name: "Action & Adventure" },
    { id: 35, name: "Comedy" },
    { id: 18, name: "Drama" },
    { id: 9648, name: "Mystery" },
    { id: 10765, name: "Sci-Fi & Fantasy" },
    { id: 16, name: "Animation" },
  ];

  function showRows() {
    gridView.hidden = true;
    rowsEl.hidden = false;
  }
  function showGrid(title, { filters = false } = {}) {
    heroEl.hidden = true;
    rowsEl.hidden = true;
    gridView.hidden = false;
    $("#filters").hidden = !filters;
    $("#gridTitle").textContent = title;
    $("#grid").innerHTML = '<div class="spinner"></div>';
  }

  // ---------- Filters / Browse ----------
  const Filters = {
    ready: false,
    movieGenres: {}, // name -> id
    tvGenres: {},
    query: "",
    async init() {
      if (this.ready) return;
      try {
        const [mg, tg] = await Promise.all([
          TMDB.genres("movie"),
          TMDB.genres("tv"),
        ]);
        (mg.genres || []).forEach((g) => (this.movieGenres[g.name] = g.id));
        (tg.genres || []).forEach((g) => (this.tvGenres[g.name] = g.id));
      } catch {
        /* genres optional */
      }
      // Year dropdown
      const yearSel = $("#fYear");
      const now = new Date().getFullYear();
      for (let y = now; y >= 1950; y--) {
        const o = document.createElement("option");
        o.value = String(y);
        o.textContent = String(y);
        yearSel.appendChild(o);
      }
      this.populateGenres();
      this.ready = true;
    },
    populateGenres() {
      const type = $("#fType").value;
      const names =
        type === "tv"
          ? Object.keys(this.tvGenres)
          : type === "movie"
          ? Object.keys(this.movieGenres)
          : Array.from(
              new Set([
                ...Object.keys(this.movieGenres),
                ...Object.keys(this.tvGenres),
              ])
            );
      const sel = $("#fGenre");
      const current = sel.value;
      sel.innerHTML =
        `<option value="">Any</option>` +
        names
          .sort()
          .map((n) => `<option value="${UI.escapeHtml(n)}">${UI.escapeHtml(n)}</option>`)
          .join("");
      if (names.includes(current)) sel.value = current;
    },
    state() {
      return {
        type: $("#fType").value,
        genreName: $("#fGenre").value,
        year: $("#fYear").value,
        minRating: $("#fRating").value,
        sort: $("#fSort").value,
      };
    },
    reset() {
      $("#fType").value = "all";
      $("#fGenre").value = "";
      $("#fYear").value = "";
      $("#fRating").value = "";
      $("#fSort").value = "popularity.desc";
      this.populateGenres();
      this.apply();
    },
    async apply() {
      const s = this.state();
      const grid = $("#grid");
      const title = this.query
        ? `Results for “${this.query}”`
        : "Browse";
      showGrid(title, { filters: true });

      try {
        let results = [];
        if (this.query && this.query.trim().length >= 2) {
          results = await this.filteredSearch(s);
        } else {
          results = await this.discover(s);
        }
        renderGridResults(results);
      } catch (e) {
        grid.innerHTML = `<div class="empty">Couldn't load results.<br>${UI.escapeHtml(
          e.message
        )}</div>`;
      }
    },
    async filteredSearch(s) {
      const res = await TMDB.search(this.query.trim());
      let items = (res.results || []).filter(
        (r) => r.media_type === "movie" || r.media_type === "tv"
      );
      if (s.type !== "all") items = items.filter((r) => r.media_type === s.type);
      if (s.year) {
        items = items.filter((r) =>
          (r.release_date || r.first_air_date || "").startsWith(s.year)
        );
      }
      if (s.minRating) {
        items = items.filter((r) => (r.vote_average || 0) >= Number(s.minRating));
      }
      if (s.genreName) {
        items = items.filter((r) => {
          const map = r.media_type === "tv" ? this.tvGenres : this.movieGenres;
          const gid = map[s.genreName];
          return gid && (r.genre_ids || []).includes(gid);
        });
      }
      return this.sortItems(items, s.sort);
    },
    async discover(s) {
      const medias = s.type === "all" ? ["movie", "tv"] : [s.type];
      const pages = await Promise.all(
        medias.map((m) =>
          TMDB.discover(m, {
            genre:
              (m === "tv" ? this.tvGenres : this.movieGenres)[s.genreName] ||
              undefined,
            year: s.year || undefined,
            minRating: s.minRating || undefined,
            sortBy: s.sort,
          }).then((r) => {
            (r.results || []).forEach((x) => (x.media_type = m));
            return r.results || [];
          })
        )
      );
      const merged = pages.flat();
      return this.sortItems(merged, s.sort);
    },
    sortItems(items, sort) {
      const arr = [...items];
      if (sort === "vote_average.desc") {
        arr.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
      } else if (sort === "primary_release_date.desc") {
        const d = (x) => x.release_date || x.first_air_date || "";
        arr.sort((a, b) => d(b).localeCompare(d(a)));
      } else {
        arr.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      }
      return arr;
    },
  };

  function renderGridResults(results) {
    const grid = $("#grid");
    grid.innerHTML = "";
    if (!results.length) {
      grid.innerHTML = '<div class="empty">No results match your filters.</div>';
      return;
    }
    results.forEach((item) => {
      const el = UI.card(item, { onClick: (n) => openDetail(n) });
      if (el) grid.appendChild(el);
    });
  }

  async function loadHome() {
    rowsEl.innerHTML = "";
    showRows();
    // Hero from trending
    try {
      const trend = await TMDB.trending("all", "week");
      const heroPick = (trend.results || []).find(
        (i) => i.backdrop_path && (i.media_type === "movie" || i.media_type === "tv")
      );
      if (heroPick) {
        UI.renderHero(heroPick, {
          onPlay: (n) => playSmart(n),
          onInfo: (n) => openDetail(n),
        });
      }
    } catch (e) {
      console.error(e);
    }

    renderContinueWatching();
    renderRecent();
    renderRecommendations();
    addRow("Trending Now", async () => (await TMDB.trending("all", "day")).results);
    addRow("Popular Movies", async () => (await TMDB.popular("movie")).results);
    addRow("Popular TV Shows", async () => (await TMDB.popular("tv")).results);
    addRow("Now Playing in Theaters", async () => (await TMDB.nowPlayingMovies()).results);
    addRow("Top Rated Movies", async () => (await TMDB.topRated("movie")).results);
    addRow("Top Rated TV", async () => (await TMDB.topRated("tv")).results);
    GENRES_MOVIE.forEach((g) =>
      addRow(`${g.name} Movies`, async () => (await TMDB.byGenre("movie", g.id)).results)
    );
  }

  async function loadCatalog(media) {
    rowsEl.innerHTML = "";
    showRows();
    const label = media === "movie" ? "Movies" : "TV Shows";
    try {
      const trend = await TMDB.trending(media, "week");
      const pick = (trend.results || []).find((i) => i.backdrop_path);
      if (pick) {
        pick.media_type = media;
        UI.renderHero(pick, {
          onPlay: (n) => playSmart(n),
          onInfo: (n) => openDetail(n),
        });
      }
    } catch (e) {
      console.error(e);
    }

    const mapMedia = (r) => ((r || []).forEach((x) => (x.media_type = media)), r);
    addRow(`Trending ${label}`, async () => mapMedia((await TMDB.trending(media, "week")).results));
    addRow(`Popular ${label}`, async () => mapMedia((await TMDB.popular(media)).results));
    addRow(`Top Rated ${label}`, async () => mapMedia((await TMDB.topRated(media)).results));
    const genres = media === "movie" ? GENRES_MOVIE : GENRES_TV;
    genres.forEach((g) =>
      addRow(g.name, async () => mapMedia((await TMDB.byGenre(media, g.id)).results))
    );
  }

  function loadMyList() {
    showGrid("My List", { filters: false });
    const items = MyList.all();
    const grid = $("#grid");
    grid.innerHTML = "";
    if (!items.length) {
      grid.innerHTML =
        '<div class="empty">Your list is empty. Tap “+ My List” on any title to save it here.</div>';
      return;
    }
    items.forEach((item) => {
      const el = UI.card(item, { onClick: (n) => openDetail(n) });
      if (el) grid.appendChild(el);
    });
  }

  // ---------- Search ----------
  let searchTimer;
  async function runSearch(query) {
    if (!query || query.trim().length < 2) {
      setActiveNav("home");
      return loadHome();
    }
    await Filters.init();
    Filters.query = query;
    Filters.apply();
  }

  // ---------- Nav ----------
  function setActiveNav(view) {
    document.querySelectorAll(".nav a, .logo").forEach((a) => {
      a.classList.toggle("active", a.dataset.nav === view);
    });
  }

  function getScroller() {
    return window.desktop?.isElectron ? $("#viewport") : window;
  }
  function scrollToTop() {
    const s = getScroller();
    if (s === window) window.scrollTo({ top: 0 });
    else s.scrollTop = 0;
  }

  function route(view) {
    setActiveNav(view);
    $("#searchInput").value = "";
    scrollToTop();
    if (view === "home") return loadHome();
    if (view === "movie") return loadCatalog("movie");
    if (view === "tv") return loadCatalog("tv");
    if (view === "browse") return loadBrowse();
    if (view === "mylist") return loadMyList();
  }

  async function loadBrowse() {
    await Filters.init();
    Filters.query = "";
    Filters.apply();
  }

  // ---------- Events ----------
  function bindEvents() {
    document.querySelectorAll("[data-nav]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        route(a.dataset.nav);
      });
    });

    $("#searchForm").addEventListener("submit", (e) => e.preventDefault());
    $("#searchInput").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      const q = e.target.value;
      searchTimer = setTimeout(() => runSearch(q), 350);
    });

    // Filter bar
    $("#fType").addEventListener("change", () => {
      Filters.populateGenres();
      Filters.apply();
    });
    ["fGenre", "fYear", "fRating", "fSort"].forEach((id) =>
      $("#" + id).addEventListener("change", () => Filters.apply())
    );
    $("#fReset").addEventListener("click", () => Filters.reset());

    // Modal / player / trailer close
    document.querySelectorAll("[data-close]").forEach((el) =>
      el.addEventListener("click", UI.closeModal)
    );
    document.querySelectorAll("[data-trailer-close]").forEach((el) =>
      el.addEventListener("click", UI.closeTrailer)
    );
    $("#playerBack").addEventListener("click", UI.closePlayer);

    // Player: source picker
    $("#sourceSelect").addEventListener("change", (e) => {
      Player.setSourceId(e.target.value);
      Playback.reload();
    });

    // Player: prev / next episode
    $("#playerPrev").addEventListener("click", () =>
      Playback.go(Playback.prevTarget())
    );
    $("#playerNext").addEventListener("click", () =>
      Playback.go(Playback.nextTarget())
    );

    // Auto-advance to next episode when one ends
    document.addEventListener("player:event", (e) => {
      if (e.detail?.event !== "ended") return;
      if (!Player.getSettings().autoNext) return;
      const next = Playback.nextTarget();
      if (next) Playback.go(next);
    });

    // Player: settings popover
    const settingsBtn = $("#playerSettings");
    const settingsPop = $("#settingsPop");
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      settingsPop.hidden = !settingsPop.hidden;
    });
    document.addEventListener("click", (e) => {
      if (
        !settingsPop.hidden &&
        !settingsPop.contains(e.target) &&
        !settingsBtn.contains(e.target)
      ) {
        settingsPop.hidden = true;
      }
    });
    const syncSettingsUI = () => {
      const s = Player.getSettings();
      $("#setAutoplay").checked = !!s.autoplay;
      $("#setResume").checked = !!s.resume;
      $("#setRemember").checked = !!s.rememberSource;
      $("#setAutoNext").checked = !!s.autoNext;
    };
    syncSettingsUI();
    $("#setAutoplay").addEventListener("change", (e) => {
      Player.setSettings({ autoplay: e.target.checked });
      Playback.reload();
    });
    $("#setResume").addEventListener("change", (e) => {
      Player.setSettings({ resume: e.target.checked });
      Playback.reload();
    });
    $("#setRemember").addEventListener("change", (e) => {
      Player.setSettings({ rememberSource: e.target.checked });
    });
    $("#setAutoNext").addEventListener("change", (e) => {
      Player.setSettings({ autoNext: e.target.checked });
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!$("#trailer").hidden) UI.closeTrailer();
        else if (!$("#player").hidden) UI.closePlayer();
        else if (!$("#modal").hidden) UI.closeModal();
        return;
      }
      if (e.key === "/" && !isTyping(e.target)) {
        e.preventDefault();
        $("#searchInput").focus();
      }
    });

    // Header background on scroll (desktop scrolls inside #viewport)
    const header = $("#header");
    const scroller = getScroller();
    const onScroll = () => {
      const y = scroller === window ? window.scrollY : scroller.scrollTop;
      header.classList.toggle("scrolled", y > 20);
    };
    scroller.addEventListener("scroll", onScroll);

    // Deep links (#info/movie/123, #play/tv/123/1/2)
    window.addEventListener("hashchange", () => openFromHash());
  }

  function isTyping(el) {
    if (!el) return false;
    const tag = el.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      el.isContentEditable
    );
  }

  async function openFromHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return false;
    const [action, media, id, season, episode] = h.split("/");
    if (
      !["info", "play"].includes(action) ||
      !["movie", "tv"].includes(media) ||
      !id
    ) {
      return false;
    }
    if (action === "info") {
      openDetail({ id: Number(id), media, title: "" });
      return true;
    }
    // play: fetch title so the player bar reads nicely
    try {
      const d = await TMDB.details(media, id);
      const n = {
        id: Number(id),
        media,
        title: d.title || d.name || "",
        poster: d.poster_path,
        backdrop: d.backdrop_path,
      };
      if (media === "movie") playMovie(n);
      else playEpisode(n, Number(season) || 1, Number(episode) || 1);
    } catch {
      openDetail({ id: Number(id), media, title: "" });
    }
    return true;
  }

  // ---------- Desktop (Electron) title bar ----------
  function initDesktopTitlebar() {
    if (!window.desktop?.isElectron) return;
    document.documentElement.classList.add("is-electron");
    $("#titlebar").hidden = false;
    $("#winMin").addEventListener("click", () => window.desktop.minimize());
    $("#winMax").addEventListener("click", () =>
      window.desktop.toggleMaximize()
    );
    $("#winClose").addEventListener("click", () => window.desktop.close());
  }

  // ---------- Auto-update toasts ----------
  function initUpdateNotifications() {
    if (!window.desktop?.onUpdateAvailable) return;
    window.desktop.onUpdateAvailable((info) =>
      UI.notice(
        `A new version${
          info?.version ? " (v" + info.version + ")" : ""
        } is downloading…`
      )
    );
    window.desktop.onUpdateDownloaded(() =>
      UI.notice(
        "Update ready — it installs automatically when you close the app.",
        true
      )
    );
  }

  // ---------- Init ----------
  function init() {
    initDesktopTitlebar();
    initUpdateNotifications();
    Player.initProgressListener();
    bindEvents();

    if (!keyConfigured()) {
      UI.notice(
        `<b>Setup needed:</b> add your free TMDB API key in
         <code>assets/js/config.js</code>.
         Get one at <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org</a>.`,
        true
      );
      return;
    }
    loadHome();
    openFromHash();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
