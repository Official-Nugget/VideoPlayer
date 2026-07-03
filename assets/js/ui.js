/*
 * UI rendering helpers: cards, rows, hero, modal and player overlay.
 * Pure DOM building — data comes from app.js.
 */

const UI = (() => {
  const $ = (sel) => document.querySelector(sel);

  // Normalize a TMDB item (movie / tv / multi) into a common shape.
  // Note: VidLink progress items use `type` ("tv"|"movie"), while TMDB uses
  // `media_type`; both must win over guessing from title/name.
  function normalize(item) {
    if (!item) return null;
    const media =
      item.media_type ||
      item.media ||
      item.type ||
      (item.first_air_date || item.name ? "tv" : "movie");
    if (media !== "movie" && media !== "tv") return null; // skip persons
    const title = item.title || item.name || "Untitled";
    const date = item.release_date || item.first_air_date || "";
    return {
      id: item.id,
      media,
      title,
      year: date ? date.slice(0, 4) : "",
      rating: item.vote_average ? item.vote_average.toFixed(1) : null,
      poster: item.poster_path,
      backdrop: item.backdrop_path,
      overview: item.overview || "",
      raw: item,
    };
  }

  function card(item, opts = {}) {
    const n = normalize(item);
    if (!n) return null;
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.id = n.id;
    el.dataset.media = n.media;
    el.tabIndex = 0; // focusable for TV / D-pad remote navigation

    const posterUrl = TMDB.img(n.poster, CONFIG.POSTER_SIZE);
    const imgHtml = posterUrl
      ? `<img class="card__img" loading="lazy" src="${posterUrl}" alt="${escapeHtml(
          n.title
        )}" />`
      : `<div class="card__noimg">${escapeHtml(n.title)}</div>`;

    const progressBar =
      opts.percent != null
        ? `<div class="card__progress"><span style="width:${opts.percent}%"></span></div>`
        : "";

    el.innerHTML = `
      <span class="card__type">${n.media === "tv" ? "TV" : "Movie"}</span>
      ${imgHtml}
      <div class="card__overlay">
        <div class="card__title">${escapeHtml(n.title)}</div>
        <div class="card__sub">${n.year || ""}${
      n.rating ? " • ★ " + n.rating : ""
    }</div>
      </div>
      ${progressBar}
    `;
    el.addEventListener("click", () => opts.onClick && opts.onClick(n));
    return el;
  }

  function skeletonRow(count = 8) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const s = document.createElement("div");
      s.className = "skeleton-card";
      frag.appendChild(s);
    }
    return frag;
  }

  // Build an empty row container; returns { section, track } so app can fill it.
  // opts.action = { label, onClick } renders a small button beside the title.
  function rowShell(title, opts = {}) {
    const section = document.createElement("section");
    section.className = "row";
    section.innerHTML = `
      <div class="row__head">
        <h2 class="row__title">${escapeHtml(title)}</h2>
        ${
          opts.action
            ? `<button class="row__action">${escapeHtml(
                opts.action.label
              )}</button>`
            : ""
        }
      </div>
      <div class="row__track-wrap">
        <button class="row__arrow row__arrow--left" aria-label="Scroll left">‹</button>
        <div class="row__track"></div>
        <button class="row__arrow row__arrow--right" aria-label="Scroll right">›</button>
      </div>
    `;
    if (opts.action) {
      section
        .querySelector(".row__action")
        .addEventListener("click", opts.action.onClick);
    }
    const track = section.querySelector(".row__track");
    const left = section.querySelector(".row__arrow--left");
    const right = section.querySelector(".row__arrow--right");
    const scrollBy = () => Math.round(track.clientWidth * 0.85);
    left.addEventListener("click", () =>
      track.scrollBy({ left: -scrollBy(), behavior: "smooth" })
    );
    right.addEventListener("click", () =>
      track.scrollBy({ left: scrollBy(), behavior: "smooth" })
    );
    track.appendChild(skeletonRow());
    return { section, track };
  }

  function renderHero(item, { onPlay, onInfo }) {
    const n = normalize(item);
    if (!n) return;
    const hero = $("#hero");
    hero.hidden = false;
    $("#heroBackdrop").style.backgroundImage = `url(${
      TMDB.img(n.backdrop, CONFIG.BACKDROP_SIZE) ||
      TMDB.img(n.poster, "w780") ||
      ""
    })`;
    $("#heroTitle").textContent = n.title;
    $("#heroMeta").innerHTML = `
      <span class="badge badge--rating">★ ${n.rating || "—"}</span>
      <span>${n.year || ""}</span>
      <span class="badge">${n.media === "tv" ? "Series" : "Film"}</span>
    `;
    $("#heroOverview").textContent = n.overview;
    $("#heroPlay").onclick = () => onPlay(n);
    $("#heroInfo").onclick = () => onInfo(n);
  }

  // ---------- Modal ----------
  function openModal(html) {
    const modal = $("#modal");
    $("#modalBody").innerHTML = html;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeModal() {
    $("#modal").hidden = true;
    document.body.style.overflow = "";
  }

  // ---------- Player overlay ----------
  function openPlayer(title) {
    $("#playerTitle").textContent = title || "";
    $("#player").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function setPlayerFrame(url) {
    $("#playerFrame").src = url;
  }
  function closePlayer() {
    $("#playerFrame").src = "about:blank";
    $("#player").hidden = true;
    $("#settingsPop").hidden = true;
    document.body.style.overflow = "";
    if (window.desktop?.clearPresence) window.desktop.clearPresence();
  }

  // ---------- Trailer overlay ----------
  let currentTrailerKey = null;
  function openTrailer(youtubeKey) {
    currentTrailerKey = youtubeKey;
    // NOTE: intentionally NO `origin`/`enablejsapi` params. When present,
    // YouTube runs origin verification and throws "Error 153" if it can't
    // match the embedding origin (common in packaged/desktop contexts). A
    // plain embed just plays. The desktop app also forces a youtube.com
    // Referer header (see electron/adblock.js) as a second safeguard.
    const params = new URLSearchParams({
      autoplay: "1",
      rel: "0",
      modestbranding: "1",
      playsinline: "1",
    });
    $(
      "#trailerFrame"
    ).src = `https://www.youtube-nocookie.com/embed/${youtubeKey}?${params}`;
    const yt = $("#trailerYT");
    if (yt) yt.href = `https://www.youtube.com/watch?v=${youtubeKey}`;
    $("#trailer").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeTrailer() {
    $("#trailerFrame").src = "about:blank";
    $("#trailer").hidden = true;
    if ($("#modal").hidden && $("#player").hidden) {
      document.body.style.overflow = "";
    }
  }

  // ---------- Notice ----------
  let noticeTimer;
  function notice(html, persist = false) {
    const el = $("#notice");
    el.innerHTML = html;
    el.hidden = false;
    clearTimeout(noticeTimer);
    if (!persist) noticeTimer = setTimeout(() => (el.hidden = true), 4500);
  }

  function escapeHtml(str = "") {
    return str.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c])
    );
  }

  return {
    normalize,
    card,
    rowShell,
    skeletonRow,
    renderHero,
    openModal,
    closeModal,
    openPlayer,
    setPlayerFrame,
    closePlayer,
    openTrailer,
    closeTrailer,
    notice,
    escapeHtml,
  };
})();
