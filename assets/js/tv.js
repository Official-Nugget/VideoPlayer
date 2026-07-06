/*
 * TV / D-pad remote navigation for Fire TV & Android TV.
 *
 * The site is built for a mouse; a TV remote only sends arrow keys + OK(Enter)
 * + Back. This module adds spatial navigation: it makes cards and controls
 * focusable, moves focus in the pressed direction to the nearest element, and
 * activates the focused element on OK. It also scopes focus to whatever overlay
 * is open (modal / player / trailer) so you can't "escape" behind it.
 *
 * Enabled automatically on TV devices (and inside the Android app); on a normal
 * desktop/browser it stays dormant so the mouse experience is unchanged. Set
 * localStorage csTvMode = "1" to force it on for testing in a browser.
 */

(function () {
  function tvEnabled() {
    try {
      if (localStorage.getItem("csTvMode") === "1") return true;
    } catch (e) {
      /* ignore */
    }
    const ua = navigator.userAgent || "";
    if (
      /AFT|Android TV|GoogleTV|SMART-TV|SmartTV|BRAVIA|Web0S|Tizen|Silk|CrKey|NetCast|HbbTV|AppleTV/i.test(
        ua
      )
    )
      return true;
    // Any Capacitor native container is our packaged (TV/mobile) app — the web
    // build served over the internet has no window.Capacitor.
    if (window.Capacitor) return true;
    return false;
  }

  if (!tvEnabled()) return;

  document.documentElement.classList.add("tv-mode");

  const FOCUSABLE = [
    "a[data-nav]",
    "#searchInput",
    "#playerFrame",
    ".card",
    ".episode",
    ".btn",
    ".row__action",
    "select",
    ".filter__reset",
    ".player__back",
    ".player__navbtn",
    ".player__iconbtn",
    ".modal__close",
    ".trailer__close",
    ".trailer__yt",
    ".switch input",
    ".account__btn",
    ".account__signout",
    ".account__switch",
    ".account__username-row input",
    ".account__username-row button",
    ".account__swatches .swatch",
    ".signin-cta__btn",
    ".profile-tile",
    ".profiles__manage",
    ".profiles__close",
    ".pedit__field input",
    ".pedit__swatches .swatch",
    ".pedit__save",
    ".pedit__delete",
    ".auth__field input",
    ".auth__switch a",
    ".auth__reset a",
    "button",
  ].join(",");

  const $ = (s) => document.querySelector(s);

  // The layer the user is currently in — focus stays trapped inside it.
  function activeScope() {
    const pedit = $("#profileEdit");
    const picker = $("#profilesOverlay");
    const authModal = $("#authModal");
    const trailer = $("#trailer");
    const player = $("#player");
    const modal = $("#modal");
    if (pedit && !pedit.hidden) return pedit;
    if (picker && !picker.hidden) return picker;
    if (authModal && !authModal.hidden) return authModal;
    if (trailer && !trailer.hidden) return trailer;
    if (player && !player.hidden) return player;
    if (modal && !modal.hidden) return modal;
    return document.body;
  }

  function isVisible(el) {
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") return false;
    if (el.closest("[hidden]")) return false;
    return true;
  }

  function inHeaderZone(el) {
    return !!(el && el.closest && el.closest("#header"));
  }

  function inContentZone(el) {
    return !!(el && el.closest && el.closest("#viewport"));
  }

  function isChromeNav(el) {
    return inHeaderZone(el) || !!(el && el.closest && el.closest(".mobnav"));
  }

  function nearestCardByX(track, refCard) {
    if (!track) return null;
    const cards = cardsInRow(track);
    if (!cards.length) return null;
    const x = centerOf(refCard).x;
    let best = cards[0];
    let bestDist = Infinity;
    for (const c of cards) {
      const d = Math.abs(centerOf(c).x - x);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  function rowCardSibling(cur, dir) {
    const row = cur.closest(".row");
    if (!row) return null;
    const rowsEl = $("#rows");
    if (!rowsEl) return null;
    const rows = Array.from(rowsEl.children).filter(
      (r) => r.classList.contains("row") && isVisible(r)
    );
    const idx = rows.indexOf(row);
    if (idx < 0) return null;

    if (dir === "up") {
      if (idx === 0) {
        const hero = $("#hero");
        if (hero && !hero.hidden) return $("#heroPlay") || $("#heroInfo");
        return null;
      }
      return nearestCardByX(rows[idx - 1].querySelector(".row__track"), cur);
    }
    if (dir === "down" && idx < rows.length - 1) {
      return nearestCardByX(rows[idx + 1].querySelector(".row__track"), cur);
    }
    return null;
  }

  function gridCardSibling(cur, dir) {
    const grid = cur.closest(".grid");
    if (!grid) return null;
    const cards = Array.from(grid.querySelectorAll(".card")).filter(isVisible);
    const curC = centerOf(cur);
    let best = null;
    let bestScore = Infinity;
    for (const c of cards) {
      if (c === cur) continue;
      const p = centerOf(c);
      const dy = p.y - curC.y;
      if (dir === "up" && dy >= -2) continue;
      if (dir === "down" && dy <= 2) continue;
      const score = Math.abs(dy) + Math.abs(p.x - curC.x) * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  function heroSibling(cur, dir) {
    const play = $("#heroPlay");
    const info = $("#heroInfo");
    if (cur === play && dir === "right" && info && isVisible(info)) return info;
    if (cur === info && dir === "left" && play && isVisible(play)) return play;
    return null;
  }

  function headerDownTarget() {
    const hero = $("#hero");
    if (hero && !hero.hidden) {
      const play = $("#heroPlay");
      if (play && isVisible(play)) return play;
    }
    const gridView = $("#gridView");
    if (gridView && !gridView.hidden) {
      const card = gridView.querySelector(".grid .card");
      if (card && isVisible(card)) return card;
      const filter = $("#fType");
      if (filter && isVisible(filter)) return filter;
    }
    const card = $("#rows .card");
    if (card && isVisible(card)) return card;
    return null;
  }

  function navCandidates(scope, cur, dir) {
    let list = Array.from(scope.querySelectorAll(FOCUSABLE)).filter(isVisible);
    for (const el of list) {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    }

    if (scope !== document.body) return list;

    if (inHeaderZone(cur)) {
      return list.filter((el) => isChromeNav(el) && !el.classList.contains("logo"));
    }

    if (inContentZone(cur)) {
      list = list.filter((el) => !isChromeNav(el));
      if (cur.classList.contains("card") && (dir === "up" || dir === "down")) {
        list = list.filter((el) => !el.classList.contains("row__action"));
      }
      return list;
    }

    return list.filter((el) => !isChromeNav(el));
  }

  function firstContentFocus(scope) {
    const hero = $("#hero");
    if (scope === document.body && hero && !hero.hidden) {
      const play = $("#heroPlay");
      if (play && isVisible(play)) return play;
    }
    const gridView = $("#gridView");
    if (scope === document.body && gridView && !gridView.hidden) {
      const card = gridView.querySelector(".grid .card");
      if (card && isVisible(card)) return card;
    }
    const card = scope.querySelector(".card");
    if (card && isVisible(card)) return card;
    const items = navCandidates(scope, null, "down");
    return items[0] || null;
  }

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
  }

  function rowTrackOf(el) {
    return el && el.closest ? el.closest(".row__track") : null;
  }

  function cardsInRow(track) {
    return Array.from(track.querySelectorAll(".card")).filter(isVisible);
  }

  // Left/right within a row should step poster-to-poster, not jump via spatial math.
  function siblingCard(cur, dir) {
    const track = rowTrackOf(cur);
    if (!track || !cur.classList.contains("card")) return null;
    const cards = cardsInRow(track);
    const i = cards.indexOf(cur);
    if (i < 0) return null;
    if (dir === "right" && i < cards.length - 1) return cards[i + 1];
    if (dir === "left" && i > 0) return cards[i - 1];
    return null;
  }

  // Fire TV WebViews mishandle scrollIntoView on overflow-x rows — scroll the track
  // ourselves so posters slide while focus stays on screen.
  function scrollCardInRow(card) {
    const track = rowTrackOf(card);
    if (!track) return false;

    const pad = 20;
    const trackRect = track.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    let next = track.scrollLeft;

    if (cardRect.right > trackRect.right - pad) {
      next += cardRect.right - trackRect.right + pad;
    } else if (cardRect.left < trackRect.left + pad) {
      next -= trackRect.left + pad - cardRect.left;
    } else {
      return true;
    }

    const max = Math.max(0, track.scrollWidth - track.clientWidth);
    track.scrollLeft = Math.max(0, Math.min(max, next));
    return true;
  }

  function scrollVerticallyTo(el) {
    const marginTop = 88;
    const marginBottom = 40;
    const rect = el.getBoundingClientRect();
    const viewport =
      document.querySelector(".is-electron .viewport") || $("#viewport");

    if (viewport && viewport.scrollHeight > viewport.clientHeight + 2) {
      const vRect = viewport.getBoundingClientRect();
      const relTop = rect.top - vRect.top;
      const relBottom = rect.bottom - vRect.top;
      if (relTop < marginTop) {
        viewport.scrollTop += relTop - marginTop;
      } else if (relBottom > viewport.clientHeight - marginBottom) {
        viewport.scrollTop += relBottom - (viewport.clientHeight - marginBottom);
      }
      return;
    }

    if (rect.top < marginTop) {
      window.scrollBy(0, rect.top - marginTop);
    } else if (rect.bottom > window.innerHeight - marginBottom) {
      window.scrollBy(0, rect.bottom - window.innerHeight + marginBottom);
    }
  }

  // Show the player toolbar only when a toolbar control is focused; otherwise
  // (i.e. when the video itself is focused) keep it hidden for full-screen.
  function updatePlayerChrome(target) {
    const player = $("#player");
    if (!player || player.hidden) return;
    const onBar = !!(target && target.closest && target.closest(".player__bar"));
    player.classList.toggle("chrome-hidden", !onBar);
  }

  function focusEl(el) {
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      el.focus();
    }
    if (el.classList.contains("card") && rowTrackOf(el)) {
      scrollCardInRow(el);
      scrollVerticallyTo(el);
    } else {
      scrollVerticallyTo(el);
    }
    updatePlayerChrome(el);
  }

  function move(dir) {
    const scope = activeScope();
    const cur = document.activeElement;
    const items = navCandidates(scope, cur, dir);
    if (!items.length) return;

    if (!cur || cur === document.body || !items.includes(cur)) {
      focusEl(firstContentFocus(scope));
      return;
    }

    // Header chrome: down always returns to the main content, never traps in the logo.
    if (inHeaderZone(cur) && dir === "down") {
      const target = headerDownTarget();
      if (target) {
        focusEl(target);
        return;
      }
    }

    // Content: up from hero opens account (not the logo); up from rows steps row-to-row.
    if (inContentZone(cur)) {
      if (dir === "up" && (cur === $("#heroPlay") || cur === $("#heroInfo"))) {
        const account = $("#accountBtn");
        if (account && isVisible(account)) {
          focusEl(account);
          return;
        }
        return;
      }
      if (dir === "left" || dir === "right") {
        const heroNext = heroSibling(cur, dir);
        if (heroNext) {
          focusEl(heroNext);
          return;
        }
        if (cur.classList.contains("card")) {
          const next = siblingCard(cur, dir);
          if (next) {
            focusEl(next);
            return;
          }
        }
      }
      if (dir === "up" || dir === "down") {
        if (cur.classList.contains("card")) {
          const rowNext = rowCardSibling(cur, dir);
          if (rowNext) {
            focusEl(rowNext);
            return;
          }
          const gridNext = gridCardSibling(cur, dir);
          if (gridNext) {
            focusEl(gridNext);
            return;
          }
        }
        const grid = $("#gridView");
        if (grid && !grid.hidden && cur.closest("#filters") && dir === "down") {
          const card = grid.querySelector(".grid .card");
          if (card && isVisible(card)) {
            focusEl(card);
            return;
          }
        }
      }
    }

    const c = centerOf(cur);
    let best = null;
    let bestScore = Infinity;
    const rowBias =
      cur.classList.contains("card") && (dir === "left" || dir === "right") ? 4 : 2.2;

    for (const el of items) {
      if (el === cur) continue;
      if (el.classList.contains("logo")) continue;
      const p = centerOf(el);
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      let primary, cross, inDir;
      switch (dir) {
        case "left":
          inDir = dx < -2;
          primary = -dx;
          cross = Math.abs(dy);
          break;
        case "right":
          inDir = dx > 2;
          primary = dx;
          cross = Math.abs(dy);
          break;
        case "up":
          inDir = dy < -2;
          primary = -dy;
          cross = Math.abs(dx);
          break;
        case "down":
          inDir = dy > 2;
          primary = dy;
          cross = Math.abs(dx);
          break;
      }
      if (!inDir) continue;
      const score = primary + cross * rowBias;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }

    if (best) focusEl(best);
  }

  function activate(el) {
    if (!el) return;
    const tag = el.tagName;
    if (tag === "A" && el.getAttribute("href")) {
      el.click();
      return;
    }
    el.click();
  }

  const ARROWS = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    Left: "left",
    Right: "right",
    Up: "up",
    Down: "down",
  };
  // Fallback by numeric key code. Includes BOTH standard DOM arrow codes
  // (37-40) AND raw Android D-pad codes (19-22) that some Fire TV / Android TV
  // WebViews deliver instead of translating them.
  const ARROW_CODES = {
    37: "left",
    38: "up",
    39: "right",
    40: "down",
    21: "left", // KEYCODE_DPAD_LEFT
    22: "right", // KEYCODE_DPAD_RIGHT
    19: "up", // KEYCODE_DPAD_UP
    20: "down", // KEYCODE_DPAD_DOWN
  };
  const ENTER_CODES = { 13: 1, 23: 1, 66: 1 }; // Enter, DPAD_CENTER, KEYCODE_ENTER

  function directionOf(e) {
    return ARROWS[e.key] || ARROW_CODES[e.keyCode] || null;
  }
  function isEnter(e) {
    return e.key === "Enter" || e.key === "OK" || ENTER_CODES[e.keyCode];
  }

  document.addEventListener(
    "keydown",
    (e) => {
      const dir = directionOf(e);
      const active = document.activeElement;
      const tag = active ? active.tagName : "";
      const isText =
        (tag === "INPUT" && active.type !== "checkbox") || tag === "TEXTAREA";
      const isSelect = tag === "SELECT";

      if (dir) {
        // Text field: let Left/Right move the cursor; Up/Down leave the field.
        if (isText) {
          if (dir === "up" || dir === "down") {
            e.preventDefault();
            move(dir);
          }
          return;
        }
        // Native <select>: Up/Down change the option; Left/Right leave it.
        if (isSelect) {
          if (dir === "left" || dir === "right") {
            e.preventDefault();
            move(dir);
          }
          return;
        }
        e.preventDefault();
        move(dir);
        return;
      }

      if (isEnter(e)) {
        if (isText || isSelect) return; // native submit / option handling
        if (active && active !== document.body) {
          e.preventDefault();
          activate(active);
        }
      }
    },
    true
  );

  // ---- Initial + overlay focus management ----
  function firstIn(scope) {
    return firstContentFocus(scope);
  }

  // Focus the video iframe so the remote's keys are delivered to the streaming
  // player itself (its own play/pause/seek/mute shortcuts). We can't script a
  // cross-origin player, but we CAN route the remote into it.
  let playerHintShown = false;
  function enterPlayerFrame() {
    const frame = $("#playerFrame");
    if (!frame) return;
    const player = $("#player");
    if (player) player.classList.add("chrome-hidden"); // fullscreen video
    const grab = () => {
      try {
        frame.focus({ preventScroll: true });
      } catch (e) {
        try {
          frame.focus();
        } catch (e2) {
          /* ignore */
        }
      }
      window.scrollTo(0, 0);
      if (player) player.classList.add("chrome-hidden");
    };
    setTimeout(grab, 300);
    frame.addEventListener("load", grab, { once: true });
    if (!playerHintShown && window.UI && UI.notice) {
      playerHintShown = true;
      UI.notice(
        "Use the remote to control the video. Press Back for options (source, episodes), Back again to exit.",
        false
      );
    }
  }

  function focusScopeStart() {
    const scope = activeScope();
    // Prefer the hero Play button on the home screen.
    if (scope === document.body) {
      const heroPlay = $("#heroPlay");
      if (heroPlay && isVisible(heroPlay)) {
        focusEl(heroPlay);
        return;
      }
    } else if (scope === $("#player")) {
      // Hand control straight to the video player.
      enterPlayerFrame();
      return;
    } else if (scope === $("#authModal")) {
      const email = $("#authEmail");
      if (email && isVisible(email)) {
        focusEl(email);
        return;
      }
    } else if (scope === $("#profileEdit")) {
      const name = $("#profileEditName");
      if (name && isVisible(name)) {
        focusEl(name);
        return;
      }
    } else if (scope === $("#profilesOverlay")) {
      const first = scope.querySelector(".profile-tile");
      if (first && isVisible(first)) {
        focusEl(first);
        return;
      }
    } else {
      const back = scope.querySelector(".modal__close, .trailer__close");
      if (back && isVisible(back)) {
        focusEl(back);
        return;
      }
    }
    const el = firstIn(scope);
    if (el) focusEl(el);
  }

  // When an overlay opens/closes (its [hidden] toggles), move focus into the
  // now-active scope.
  const overlayObserver = new MutationObserver(() => {
    const active = document.activeElement;
    const scope = activeScope();
    if (!active || active === document.body || !scope.contains(active)) {
      focusScopeStart();
    }
  });
  ["#modal", "#player", "#trailer", "#authModal", "#profilesOverlay", "#profileEdit"].forEach((sel) => {
    const el = $(sel);
    if (el)
      overlayObserver.observe(el, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
  });

  // When rows/grid fill with cards and nothing is focused yet, grab the first.
  const contentObserver = new MutationObserver(() => {
    const active = document.activeElement;
    if (!active || active === document.body) {
      if (activeScope() === document.body) focusScopeStart();
    }
  });
  ["#rows", "#grid"].forEach((sel) => {
    const el = $(sel);
    if (el) contentObserver.observe(el, { childList: true, subtree: true });
  });

  window.addEventListener("load", () => {
    const logo = document.querySelector(".logo");
    if (logo) logo.setAttribute("tabindex", "-1");
    setTimeout(focusScopeStart, 400);
  });

  // ---- Remote BACK button ----
  // Close the topmost overlay if one is open; otherwise exit the app. Without
  // this, the hardware/remote Back would immediately quit even mid-video.
  function closeTopOverlay() {
    const pedit = $("#profileEdit");
    const picker = $("#profilesOverlay");
    const authModal = $("#authModal");
    const trailer = $("#trailer");
    const player = $("#player");
    const modal = $("#modal");
    if (pedit && !pedit.hidden) {
      const b = pedit.querySelector("[data-pedit-close]");
      if (b) b.click();
      return true;
    }
    if (picker && !picker.hidden) {
      // Only closeable once a profile is active (else you must pick one).
      const b = $("#profilesClose");
      if (b && !b.hidden) b.click();
      return true;
    }
    if (authModal && !authModal.hidden) {
      const b = authModal.querySelector("[data-auth-close]");
      if (b) b.click();
      return true;
    }
    if (trailer && !trailer.hidden) {
      const b = trailer.querySelector("[data-trailer-close]");
      if (b) b.click();
      return true;
    }
    if (player && !player.hidden) {
      const frame = $("#playerFrame");
      // If the remote is currently "inside" the video, first Back returns to
      // the toolbar (source/episodes/exit); it does NOT quit the video.
      if (frame && document.activeElement === frame) {
        const back = $("#playerBack");
        if (back) focusEl(back);
        return true;
      }
      // Already on the toolbar — Back closes the player.
      const b = $("#playerBack");
      if (b) b.click();
      return true;
    }
    if (modal && !modal.hidden) {
      const b = modal.querySelector("[data-close]");
      if (b) b.click();
      return true;
    }
    return false;
  }

  const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (App && typeof App.addListener === "function") {
    App.addListener("backButton", () => {
      if (closeTopOverlay()) return;
      // At the root with nothing open — leave the app.
      if (typeof App.exitApp === "function") App.exitApp();
    });
  }

  // Some TV remotes/keyboards send Escape or Backspace for "back" instead of
  // firing the Capacitor backButton event; handle those too (only closes
  // overlays — never exits — to stay safe).
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Backspace" || e.key === "BrowserBack" || e.key === "GoBack") {
        const active = document.activeElement;
        const inText =
          active &&
          ((active.tagName === "INPUT" && active.type !== "checkbox") ||
            active.tagName === "TEXTAREA");
        if (inText) return; // let Backspace edit text
        if (closeTopOverlay()) e.preventDefault();
      }
    },
    true
  );
})();
