/*
 * ============================================================
 *  ACCOUNTS  (Firebase Auth + Cloud Firestore)
 * ============================================================
 *  Uses the shared Club Sandwich Firebase project, so accounts here are the
 *  same accounts as clubsandwich.dev.
 *
 *  Sign-in is OPTIONAL. Signing in syncs three things across every device the
 *  viewer logs into, stored in Firestore at users/{uid}:
 *      - My List            (LS_MYLIST)
 *      - Continue Watching  (LS_PROGRESS, from VidLink)
 *      - Recently Viewed    (LS_RECENT)
 *      - Playback settings  (LS_SETTINGS) + last source (LS_SOURCE)
 *
 *  Providers: email/password everywhere; Google on the website only (Google
 *  blocks its OAuth flow inside embedded webviews like the desktop / Fire TV
 *  apps, so we hide that button there).
 *
 *  Local <-> cloud strategy:
 *    - On sign-in we pull the cloud doc, MERGE it with whatever is on this
 *      device (union lists, keep the freshest progress), write the merged
 *      result locally, and push it back up.
 *    - After that a Firestore live listener keeps the device in sync, and any
 *      local change (finishing an episode, adding to My List, changing a
 *      setting) is pushed up automatically (debounced).
 * ============================================================
 */

const Account = (() => {
  const KEYS = {
    myList: CONFIG.LS_MYLIST,
    recent: CONFIG.LS_RECENT,
    settings: CONFIG.LS_SETTINGS,
    source: CONFIG.LS_SOURCE,
    progress: CONFIG.LS_PROGRESS,
  };
  const SYNC_KEYS = Object.values(KEYS);

  const isEmbedded = !!(
    (window.desktop && window.desktop.isElectron) ||
    window.Capacitor
  );

  const $ = (s) => document.querySelector(s);

  let auth = null;
  let db = null;
  let user = null;
  let unsubscribeDoc = null;
  let applyingRemote = false; // true while we write cloud data into localStorage
  let lastLocalPush = 0; // updatedAt of our own most recent push (loop guard)
  let pushTimer = null;

  // ---------------- localStorage helpers ----------------
  function readJSON(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  }
  function writeJSON(key, value) {
    applyingRemote = true;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } finally {
      applyingRemote = false;
    }
  }

  // Wrap setItem once so any writes made elsewhere in the app (My List toggle,
  // progress updates, settings changes) trigger a debounced cloud push.
  function hookLocalWrites() {
    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (key, value) {
      original(key, value);
      if (user && !applyingRemote && SYNC_KEYS.includes(key)) schedulePush();
    };
  }

  // ---------------- Merge helpers ----------------
  const mediaKey = (i) => `${i.media || i.media_type || ""}:${i.id}`;

  function unionList(local, remote) {
    const out = [];
    const seen = new Set();
    for (const item of [...(local || []), ...(remote || [])]) {
      if (!item || item.id == null) continue;
      const k = mediaKey(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
    return out;
  }

  // VidLink progress is a map keyed by TMDB id. Keep the freshest record per
  // title, and merge per-episode show_progress so episodes watched on two
  // devices both survive.
  function stamp(entry) {
    if (!entry) return 0;
    let s = entry.last_updated || 0;
    const sp = entry.show_progress;
    if (sp && typeof sp === "object") {
      for (const ep of Object.values(sp)) {
        s = Math.max(s, ep?.last_updated || ep?.progress?.last_updated || 0);
      }
    }
    return s;
  }
  function mergeProgress(local, remote) {
    const out = { ...(remote || {}) };
    for (const [id, lv] of Object.entries(local || {})) {
      const rv = out[id];
      if (!rv) {
        out[id] = lv;
        continue;
      }
      // Merge episode maps, newest episode entry wins.
      const merged = { ...rv, ...lv };
      const lsp = lv.show_progress || {};
      const rsp = rv.show_progress || {};
      if (Object.keys(lsp).length || Object.keys(rsp).length) {
        const sp = { ...rsp };
        for (const [k, ev] of Object.entries(lsp)) {
          const cur = sp[k];
          const curStamp = cur?.last_updated || cur?.progress?.last_updated || 0;
          const evStamp = ev?.last_updated || ev?.progress?.last_updated || 0;
          if (!cur || evStamp >= curStamp) sp[k] = ev;
        }
        merged.show_progress = sp;
      }
      // Top-level fields from whichever record is newer overall.
      out[id] = stamp(lv) >= stamp(rv) ? { ...merged } : { ...merged, ...rv };
    }
    return out;
  }

  // ---------------- Push (local -> cloud) ----------------
  function collectPayload() {
    return {
      myList: readJSON(KEYS.myList, []),
      recent: readJSON(KEYS.recent, []),
      settings: readJSON(KEYS.settings, {}),
      source: localStorage.getItem(KEYS.source) || null,
      progress: readJSON(KEYS.progress, {}),
      updatedAt: Date.now(),
    };
  }

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, 1500);
  }

  async function pushNow() {
    if (!user || !db) return;
    const payload = collectPayload();
    lastLocalPush = payload.updatedAt;
    try {
      await db.collection("users").doc(user.uid).set(payload, { merge: true });
    } catch (e) {
      console.warn("[account] push failed:", e && e.message);
    }
  }

  // ---------------- Apply (cloud -> local) ----------------
  function applyRemote(data) {
    if (!data) return;
    const localList = readJSON(KEYS.myList, []);
    const localRecent = readJSON(KEYS.recent, []);
    const localSettings = readJSON(KEYS.settings, {});
    const localProgress = readJSON(KEYS.progress, {});

    writeJSON(KEYS.myList, unionList(localList, data.myList));
    writeJSON(KEYS.recent, unionList(localRecent, data.recent).slice(0, 20));
    writeJSON(KEYS.progress, mergeProgress(localProgress, data.progress));
    // Local settings win, filling any gaps from the cloud.
    writeJSON(KEYS.settings, { ...(data.settings || {}), ...localSettings });
    if (data.source && !localStorage.getItem(KEYS.source)) {
      applyingRemote = true;
      try {
        localStorage.setItem(KEYS.source, data.source);
      } finally {
        applyingRemote = false;
      }
    }
    document.dispatchEvent(new CustomEvent("account:datachanged"));
  }

  // One-time reconcile on sign-in: merge whatever the account already has with
  // this device, save locally, then push the union back up.
  async function reconcileOnLogin() {
    if (!user || !db) return;
    try {
      const snap = await db.collection("users").doc(user.uid).get();
      if (snap.exists) applyRemote(snap.data());
      await pushNow(); // publish the merged result
    } catch (e) {
      console.warn("[account] reconcile failed:", e && e.message);
    }
    listenForChanges();
  }

  // Live updates from other devices.
  function listenForChanges() {
    if (!user || !db) return;
    if (unsubscribeDoc) unsubscribeDoc();
    unsubscribeDoc = db
      .collection("users")
      .doc(user.uid)
      .onSnapshot(
        (snap) => {
          if (!snap.exists || snap.metadata.hasPendingWrites) return;
          const data = snap.data();
          if (!data) return;
          // Ignore echoes of our own writes.
          if (data.updatedAt && data.updatedAt <= lastLocalPush) return;
          applyRemote(data);
        },
        (e) => console.warn("[account] listen failed:", e && e.message)
      );
  }

  // ============================================================
  //  UI
  // ============================================================
  const els = {};
  function cacheEls() {
    els.account = $("#account");
    els.btn = $("#accountBtn");
    els.avatar = $("#accountAvatar");
    els.label = $("#accountLabel");
    els.menu = $("#accountMenu");
    els.name = $("#accountName");
    els.email = $("#accountEmail");
    els.signout = $("#accountSignout");

    els.modal = $("#authModal");
    els.title = $("#authTitle");
    els.google = $("#authGoogle");
    els.or = els.modal.querySelector(".auth__or");
    els.form = $("#authForm");
    els.emailIn = $("#authEmail");
    els.passIn = $("#authPassword");
    els.error = $("#authError");
    els.submit = $("#authSubmit");
    els.switchText = $("#authSwitchText");
    els.switchLink = $("#authSwitch");
    els.resetLink = $("#authReset");
  }

  let mode = "signin"; // or "signup"

  function openModal() {
    setMode("signin");
    showError("");
    els.modal.hidden = false;
    document.documentElement.classList.add("modal-open");
    setTimeout(() => els.emailIn && els.emailIn.focus(), 30);
  }
  function closeModal() {
    els.modal.hidden = true;
    document.documentElement.classList.remove("modal-open");
  }
  function setMode(next) {
    mode = next;
    const signup = mode === "signup";
    els.title.textContent = signup ? "Create your account" : "Sign in";
    els.submit.textContent = signup ? "Create account" : "Sign in";
    els.switchText.textContent = signup
      ? "Already have an account?"
      : "New to Club Sandwich?";
    els.switchLink.textContent = signup ? "Sign in" : "Create an account";
    els.passIn.setAttribute(
      "autocomplete",
      signup ? "new-password" : "current-password"
    );
    els.resetLink.parentElement.hidden = signup;
    showError("");
  }
  function showError(msg) {
    els.error.textContent = msg || "";
    els.error.hidden = !msg;
  }
  function setBusy(busy) {
    els.submit.disabled = busy;
    els.google.disabled = busy;
    els.submit.classList.toggle("is-busy", busy);
  }

  function friendlyError(e) {
    const code = (e && e.code) || "";
    const map = {
      "auth/invalid-email": "That email address doesn't look right.",
      "auth/user-not-found": "No account with that email. Create one below?",
      "auth/wrong-password": "Wrong password. Try again or reset it.",
      "auth/invalid-credential": "Email or password is incorrect.",
      "auth/email-already-in-use": "An account already exists for that email.",
      "auth/weak-password": "Password must be at least 6 characters.",
      "auth/too-many-requests": "Too many attempts — please wait a moment.",
      "auth/network-request-failed": "Network error — check your connection.",
      "auth/popup-blocked": "Popup blocked — allow popups and try again.",
      "auth/popup-closed-by-user": "Sign-in was cancelled.",
      "auth/operation-not-allowed":
        "That sign-in method isn't enabled for this project.",
    };
    return map[code] || (e && e.message) || "Something went wrong.";
  }

  function initials(u) {
    const s = (u.displayName || u.email || "?").trim();
    const parts = s.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() ||
      s[0].toUpperCase();
  }

  function renderSignedIn(u) {
    els.account.classList.add("account--in");
    els.label.textContent = u.displayName || (u.email || "").split("@")[0] || "Account";
    if (u.photoURL) {
      els.avatar.style.backgroundImage = `url("${u.photoURL}")`;
      els.avatar.textContent = "";
    } else {
      els.avatar.style.backgroundImage = "";
      els.avatar.textContent = initials(u);
    }
    els.name.textContent = u.displayName || "Signed in";
    els.email.textContent = u.email || "";
  }
  function renderSignedOut() {
    els.account.classList.remove("account--in");
    els.label.textContent = "Sign in";
    els.avatar.style.backgroundImage = "";
    els.avatar.textContent = "";
    closeMenu();
  }

  function openMenu() {
    els.menu.hidden = false;
    els.btn.setAttribute("aria-expanded", "true");
  }
  function closeMenu() {
    els.menu.hidden = true;
    els.btn.setAttribute("aria-expanded", "false");
  }

  // ---------------- Auth actions ----------------
  async function submitForm(e) {
    e.preventDefault();
    const email = els.emailIn.value.trim();
    const password = els.passIn.value;
    if (!email || password.length < 6) {
      showError("Enter your email and a password (6+ characters).");
      return;
    }
    setBusy(true);
    showError("");
    try {
      if (mode === "signup") {
        await auth.createUserWithEmailAndPassword(email, password);
      } else {
        await auth.signInWithEmailAndPassword(email, password);
      }
      closeModal();
    } catch (err) {
      showError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function googleSignIn() {
    setBusy(true);
    showError("");
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      await auth.signInWithPopup(provider);
      closeModal();
    } catch (err) {
      showError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(e) {
    e.preventDefault();
    const email = els.emailIn.value.trim();
    if (!email) {
      showError("Enter your email above, then tap “Forgot password?”");
      return;
    }
    try {
      await auth.sendPasswordResetEmail(email);
      showError("");
      UI.notice("Password reset email sent — check your inbox.");
    } catch (err) {
      showError(friendlyError(err));
    }
  }

  function bindUI() {
    els.btn.addEventListener("click", () => {
      if (user) {
        els.menu.hidden ? openMenu() : closeMenu();
      } else {
        openModal();
      }
    });
    els.signout.addEventListener("click", async () => {
      closeMenu();
      try {
        await auth.signOut();
        UI.notice("Signed out. Your data stays on this device.");
      } catch (e) {
        /* ignore */
      }
    });
    document.addEventListener("click", (e) => {
      if (!els.menu.hidden && !els.account.contains(e.target)) closeMenu();
    });

    els.modal
      .querySelectorAll("[data-auth-close]")
      .forEach((el) => el.addEventListener("click", closeModal));
    els.form.addEventListener("submit", submitForm);
    els.google.addEventListener("click", googleSignIn);
    els.switchLink.addEventListener("click", (e) => {
      e.preventDefault();
      setMode(mode === "signup" ? "signin" : "signup");
    });
    els.resetLink.addEventListener("click", resetPassword);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.modal.hidden) closeModal();
    });

    // Google OAuth can't run inside the desktop / Fire TV webviews.
    if (isEmbedded) {
      els.google.hidden = true;
      if (els.or) els.or.hidden = true;
    }
  }

  // ============================================================
  //  Boot
  // ============================================================
  function init() {
    cacheEls();
    if (typeof firebase === "undefined" || !CONFIG.FIREBASE) {
      // Firebase failed to load (offline / blocked) — accounts unavailable,
      // the rest of the app still works with on-device data.
      els.account.hidden = true;
      return;
    }

    try {
      firebase.initializeApp(CONFIG.FIREBASE);
      auth = firebase.auth();
      db = firebase.firestore();
      // Fire TV / restrictive-network WebViews sometimes stall on Firestore's
      // streaming WebChannel; auto-detecting long-polling keeps sync reliable.
      try {
        db.settings({ experimentalAutoDetectLongPolling: true, merge: true });
      } catch (_) {
        /* settings already applied */
      }
    } catch (e) {
      console.warn("[account] Firebase init failed:", e && e.message);
      els.account.hidden = true;
      return;
    }

    hookLocalWrites();
    bindUI();

    auth.onAuthStateChanged((u) => {
      user = u || null;
      if (unsubscribeDoc) {
        unsubscribeDoc();
        unsubscribeDoc = null;
      }
      if (user) {
        renderSignedIn(user);
        reconcileOnLogin();
      } else {
        renderSignedOut();
      }
    });
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", () => Account.init());
