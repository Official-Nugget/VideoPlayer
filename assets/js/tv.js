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
    if (/AFT|Android TV|GoogleTV|SMART-TV|SmartTV|BRAVIA|Web0S|Tizen|Silk/i.test(ua))
      return true;
    if (
      window.Capacitor &&
      typeof window.Capacitor.getPlatform === "function" &&
      window.Capacitor.getPlatform() !== "web"
    )
      return true;
    return false;
  }

  if (!tvEnabled()) return;

  document.documentElement.classList.add("tv-mode");

  const FOCUSABLE = [
    "a[data-nav]",
    ".logo",
    "#searchInput",
    ".card",
    ".btn",
    ".row__arrow",
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
    "button",
  ].join(",");

  const $ = (s) => document.querySelector(s);

  // The layer the user is currently in — focus stays trapped inside it.
  function activeScope() {
    const trailer = $("#trailer");
    const player = $("#player");
    const modal = $("#modal");
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
    // Must be (mostly) within the viewport bounds vertically to be reachable.
    if (r.bottom < -5 || r.top > window.innerHeight + 5) {
      // still allow — we may scroll to it — but skip fully off-screen rows far away
    }
    return true;
  }

  function focusables(scope) {
    const list = Array.from(scope.querySelectorAll(FOCUSABLE)).filter(isVisible);
    // Ensure every candidate can hold focus and show a focus ring.
    for (const el of list) {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    }
    return list;
  }

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
  }

  function focusEl(el) {
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      el.focus();
    }
    // Center it in both axes (handles nested horizontal row scrollers).
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    } catch (e) {
      el.scrollIntoView();
    }
  }

  function move(dir) {
    const scope = activeScope();
    const items = focusables(scope);
    if (!items.length) return;

    const cur = document.activeElement;
    if (!cur || !items.includes(cur)) {
      focusEl(items[0]);
      return;
    }

    const c = centerOf(cur);
    let best = null;
    let bestScore = Infinity;

    for (const el of items) {
      if (el === cur) continue;
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
      // Weight the cross-axis so moving stays on the same row/column.
      const score = primary + cross * 2.2;
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
  };

  document.addEventListener(
    "keydown",
    (e) => {
      const dir = ARROWS[e.key];
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

      if (e.key === "Enter" || e.key === "OK") {
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
    const items = focusables(scope);
    return items[0] || null;
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
    } else {
      // In the player, land on Back so the remote's OK doesn't hit the iframe.
      const back = scope.querySelector(".player__back, .modal__close, .trailer__close");
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
  ["#modal", "#player", "#trailer"].forEach((sel) => {
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
    setTimeout(focusScopeStart, 400);
  });

  // ---- Remote BACK button ----
  // Close the topmost overlay if one is open; otherwise exit the app. Without
  // this, the hardware/remote Back would immediately quit even mid-video.
  function closeTopOverlay() {
    const trailer = $("#trailer");
    const player = $("#player");
    const modal = $("#modal");
    if (trailer && !trailer.hidden) {
      const b = trailer.querySelector("[data-trailer-close]");
      if (b) b.click();
      return true;
    }
    if (player && !player.hidden) {
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
