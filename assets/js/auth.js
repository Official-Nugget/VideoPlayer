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

  // Preset avatar gradients (used with the user's initials when they have no
  // photo). Index is stored per account and synced.
  const AVATAR_COLORS = [
    "linear-gradient(135deg,#ff9f1c,#ffb347)",
    "linear-gradient(135deg,#ef4444,#f97316)",
    "linear-gradient(135deg,#22c55e,#84cc16)",
    "linear-gradient(135deg,#3b82f6,#06b6d4)",
    "linear-gradient(135deg,#a855f7,#ec4899)",
    "linear-gradient(135deg,#64748b,#cbd5e1)",
  ];
  const LS_AVATAR = "csAvatar";
  const LS_PROFILE = "csProfile"; // remembers the active profile id
  const MAX_PROFILES = 5;

  let auth = null;
  let db = null;
  let user = null;
  let unsubscribeDoc = null;
  let applyingRemote = false; // true while we write cloud data into localStorage
  let lastLocalPush = 0; // updatedAt of our own most recent push (loop guard)
  let pushTimer = null;
  let profiles = []; // [{ id, name, avatar }]
  let activeProfileId = null;
  let manageMode = false; // profile picker is in "manage" (edit) mode

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
      if (user && activeProfileId && !applyingRemote && SYNC_KEYS.includes(key))
        schedulePush();
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

  // ---------------- Firestore refs ----------------
  //   users/{uid}                      -> account doc: profile list + activeProfile
  //   users/{uid}/profiles/{profileId} -> per-profile data (list, progress, etc.)
  function accountRef() {
    return db.collection("users").doc(user.uid);
  }
  function profileRef(pid) {
    return accountRef().collection("profiles").doc(pid);
  }

  // ---------------- Push (local -> a profile's cloud doc) ----------------
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
    if (!user || !db || !activeProfileId) return;
    const payload = collectPayload();
    lastLocalPush = payload.updatedAt;
    try {
      await profileRef(activeProfileId).set(payload, { merge: true });
    } catch (e) {
      console.warn("[account] push failed:", e && e.message);
    }
  }

  // ---------------- Apply (a profile's cloud doc -> local) ----------------
  // replace=true  -> clean swap (used when switching profiles) so one profile's
  //                  list never bleeds into another.
  // replace=false -> union/merge (used on first login and for live updates) so
  //                  nothing on this device is lost.
  function applyProfileData(data, opts) {
    const replace = opts && opts.replace;
    data = data || {};
    if (replace) {
      writeJSON(KEYS.myList, data.myList || []);
      writeJSON(KEYS.recent, (data.recent || []).slice(0, 20));
      writeJSON(KEYS.progress, data.progress || {});
      writeJSON(KEYS.settings, data.settings || {});
      applyingRemote = true;
      try {
        if (data.source) localStorage.setItem(KEYS.source, data.source);
        else localStorage.removeItem(KEYS.source);
      } finally {
        applyingRemote = false;
      }
    } else {
      const localList = readJSON(KEYS.myList, []);
      const localRecent = readJSON(KEYS.recent, []);
      const localSettings = readJSON(KEYS.settings, {});
      const localProgress = readJSON(KEYS.progress, {});
      writeJSON(KEYS.myList, unionList(localList, data.myList));
      writeJSON(KEYS.recent, unionList(localRecent, data.recent).slice(0, 20));
      writeJSON(KEYS.progress, mergeProgress(localProgress, data.progress));
      writeJSON(KEYS.settings, { ...(data.settings || {}), ...localSettings });
      if (data.source && !localStorage.getItem(KEYS.source)) {
        applyingRemote = true;
        try {
          localStorage.setItem(KEYS.source, data.source);
        } finally {
          applyingRemote = false;
        }
      }
    }
    document.dispatchEvent(new CustomEvent("account:datachanged"));
  }

  // Live updates for the active profile from other devices.
  function listenForChanges() {
    if (!user || !db || !activeProfileId) return;
    if (unsubscribeDoc) unsubscribeDoc();
    unsubscribeDoc = profileRef(activeProfileId).onSnapshot(
      (snap) => {
        if (!snap.exists || snap.metadata.hasPendingWrites) return;
        const data = snap.data();
        if (!data) return;
        if (data.updatedAt && data.updatedAt <= lastLocalPush) return;
        applyProfileData(data, { replace: false });
      },
      (e) => console.warn("[account] listen failed:", e && e.message)
    );
  }

  // ============================================================
  //  PROFILES  (Netflix-style, under one account)
  // ============================================================
  function genId() {
    return "p_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
  }
  function setLS(key, value) {
    applyingRemote = true;
    try {
      localStorage.setItem(key, value);
    } finally {
      applyingRemote = false;
    }
  }

  // Load the account doc, build the profile list, migrating any pre-profiles
  // data into a default profile the first time.
  async function initProfiles() {
    if (!user || !db) return;
    activeProfileId = null;
    let acct = {};
    try {
      const snap = await accountRef().get();
      if (snap.exists) acct = snap.data() || {};
    } catch (e) {
      console.warn("[account] load account failed:", e && e.message);
    }

    profiles = Array.isArray(acct.profiles) ? acct.profiles : [];

    if (!profiles.length) {
      // First time on the profiles system — create a default profile and fold
      // in any existing data (older top-level account data + this device).
      const def = {
        id: genId(),
        name: user.displayName || "Profile 1",
        avatar: avatarIndex(),
      };
      profiles = [def];
      const legacy = {
        myList: unionList(readJSON(KEYS.myList, []), acct.myList),
        recent: unionList(readJSON(KEYS.recent, []), acct.recent).slice(0, 20),
        progress: mergeProgress(readJSON(KEYS.progress, {}), acct.progress),
        settings: { ...(acct.settings || {}), ...readJSON(KEYS.settings, {}) },
        source: localStorage.getItem(KEYS.source) || acct.source || null,
        updatedAt: Date.now(),
      };
      try {
        await profileRef(def.id).set(legacy, { merge: true });
        await accountRef().set(
          { profiles, activeProfile: def.id, updatedAt: Date.now() },
          { merge: true }
        );
      } catch (e) {
        console.warn("[account] profile bootstrap failed:", e && e.message);
      }
    }

    renderProfilesUI();

    // Choose which profile to open.
    const remembered = localStorage.getItem(LS_PROFILE);
    const validRemembered = profiles.find((p) => p.id === remembered);
    if (profiles.length === 1) {
      await selectProfile(profiles[0].id, { merge: true });
    } else if (validRemembered) {
      // Show the picker each launch (Netflix-style) but pre-load the remembered
      // one's data so the app isn't empty behind the picker.
      openPicker();
    } else {
      openPicker();
    }
  }

  // Switch to a profile: save the current one, then load the chosen profile's
  // data (replace, so lists don't mix), and start listening for its updates.
  async function selectProfile(pid, opts) {
    const merge = opts && opts.merge;
    const p = profiles.find((x) => x.id === pid);
    if (!p) return;

    // Persist whatever the previous profile had before swapping.
    if (activeProfileId && activeProfileId !== pid) await pushNow();
    if (unsubscribeDoc) {
      unsubscribeDoc();
      unsubscribeDoc = null;
    }

    activeProfileId = pid;
    setLS(LS_PROFILE, pid);
    setLS(LS_AVATAR, String(p.avatar || 0));
    accountRef().set({ activeProfile: pid }, { merge: true }).catch(() => {});

    let data = {};
    try {
      const snap = await profileRef(pid).get();
      if (snap.exists) data = snap.data() || {};
    } catch (e) {
      console.warn("[account] load profile failed:", e && e.message);
    }
    // On fresh login (merge) keep this device's data; on a manual switch replace.
    applyProfileData(data, { replace: !merge });
    if (merge) await pushNow(); // save the merged result to this profile

    closePicker();
    renderActiveProfile();
    listenForChanges();
  }

  async function createProfile(name, avatar) {
    if (profiles.length >= MAX_PROFILES) return;
    const p = { id: genId(), name: name, avatar: avatar || 0 };
    profiles.push(p);
    try {
      await accountRef().set(
        { profiles, updatedAt: Date.now() },
        { merge: true }
      );
      await profileRef(p.id).set(
        { myList: [], recent: [], progress: {}, updatedAt: Date.now() },
        { merge: true }
      );
    } catch (e) {
      console.warn("[account] create profile failed:", e && e.message);
    }
    renderProfilesUI();
    return p;
  }

  async function updateProfileMeta(pid, patch) {
    const p = profiles.find((x) => x.id === pid);
    if (!p) return;
    Object.assign(p, patch);
    try {
      await accountRef().set(
        { profiles, updatedAt: Date.now() },
        { merge: true }
      );
    } catch (e) {
      console.warn("[account] update profile failed:", e && e.message);
    }
    if (pid === activeProfileId) {
      if (typeof patch.avatar === "number") setLS(LS_AVATAR, String(patch.avatar));
      renderActiveProfile();
    }
    renderProfilesUI();
  }

  async function deleteProfile(pid) {
    if (profiles.length <= 1) return; // keep at least one
    profiles = profiles.filter((x) => x.id !== pid);
    try {
      await accountRef().set(
        { profiles, updatedAt: Date.now() },
        { merge: true }
      );
      await profileRef(pid).delete();
    } catch (e) {
      console.warn("[account] delete profile failed:", e && e.message);
    }
    if (pid === activeProfileId) {
      activeProfileId = null;
      localStorage.removeItem(LS_PROFILE);
    }
    renderProfilesUI();
  }

  function activeProfile() {
    return profiles.find((p) => p.id === activeProfileId) || null;
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
    els.unameInput = $("#accountUsernameInput");
    els.unameSave = $("#accountUsernameSave");
    els.unameMsg = $("#accountUsernameMsg");
    els.swatches = $("#accountSwatches");

    els.modal = $("#authModal");
    els.title = $("#authTitle");
    els.google = $("#authGoogle");
    els.or = els.modal.querySelector(".auth__or");
    els.form = $("#authForm");
    els.unameField = $("#authUsernameField");
    els.unameIn = $("#authUsername");
    els.emailIn = $("#authEmail");
    els.passIn = $("#authPassword");
    els.error = $("#authError");
    els.submit = $("#authSubmit");
    els.switchText = $("#authSwitchText");
    els.switchLink = $("#authSwitch");
    els.resetLink = $("#authReset");

    // Account menu — active profile + switch
    els.profileName = $("#accountProfileName");
    els.switchBtn = $("#accountSwitch");

    // Profile picker + editor overlays
    els.picker = $("#profilesOverlay");
    els.pickerGrid = $("#profilesGrid");
    els.pickerManage = $("#profilesManage");
    els.pickerClose = $("#profilesClose");
    els.pedit = $("#profileEdit");
    els.peditTitle = $("#profileEditTitle");
    els.peditName = $("#profileEditName");
    els.peditSwatches = $("#profileEditSwatches");
    els.peditSave = $("#profileEditSave");
    els.peditDelete = $("#profileEditDelete");
    els.peditError = $("#profileEditError");
  }

  // 3–20 chars: letters, numbers, underscore. Returns cleaned value or null.
  function validUsername(raw) {
    const u = (raw || "").trim();
    return /^[a-zA-Z0-9_]{3,20}$/.test(u) ? u : null;
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
    els.unameField.hidden = !signup;
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

  function initialsFor(text) {
    const s = (text || "?").trim();
    const parts = s.split(/[\s@._-]+/).filter(Boolean);
    return (
      ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() ||
      s[0].toUpperCase()
    );
  }

  function avatarIndex() {
    const n = parseInt(localStorage.getItem(LS_AVATAR) || "0", 10);
    return Number.isFinite(n) && n >= 0 && n < AVATAR_COLORS.length ? n : 0;
  }

  // Paint the header avatar from the active profile (falling back to the
  // account identity before a profile is chosen), and highlight the swatch.
  function applyAvatar() {
    const p = activeProfile ? activeProfile() : null;
    const label =
      (p && p.name) ||
      (user && (user.displayName || (user.email || "").split("@")[0])) ||
      "";
    const idx = p ? p.avatar || 0 : avatarIndex();
    if (!p && user && user.photoURL) {
      els.avatar.style.background = "";
      els.avatar.style.backgroundImage = `url("${user.photoURL}")`;
      els.avatar.textContent = "";
    } else {
      els.avatar.style.backgroundImage = "";
      els.avatar.style.background = AVATAR_COLORS[idx];
      els.avatar.textContent = label ? initialsFor(label) : "";
    }
    if (els.swatches) {
      els.swatches.querySelectorAll(".swatch").forEach((s, i) => {
        s.classList.toggle("swatch--active", i === idx);
      });
    }
  }

  function buildSwatches() {
    if (!els.swatches) return;
    els.swatches.innerHTML = "";
    AVATAR_COLORS.forEach((c, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.style.background = c;
      b.setAttribute("aria-label", `Avatar color ${i + 1}`);
      b.addEventListener("click", () => pickAvatar(i));
      els.swatches.appendChild(b);
    });
  }

  // Menu swatches recolor the ACTIVE profile's avatar.
  function pickAvatar(i) {
    setLS(LS_AVATAR, String(i));
    applyAvatar();
    if (user && activeProfileId) updateProfileMeta(activeProfileId, { avatar: i });
  }

  function renderSignedIn(u) {
    els.account.classList.add("account--in");
    els.label.textContent =
      u.displayName || (u.email || "").split("@")[0] || "Account";
    els.name.textContent = u.displayName || "Signed in";
    els.email.textContent = u.email || "";
    if (els.unameInput) els.unameInput.value = u.displayName || "";
    applyAvatar();
    unameMsg("");
  }

  // Reflect the chosen profile in the header + account menu once selected.
  function renderActiveProfile() {
    const p = activeProfile();
    if (!p) return;
    els.label.textContent = p.name;
    if (els.profileName) els.profileName.textContent = p.name;
    applyAvatar();
    if (els.switchBtn) els.switchBtn.hidden = false;
  }

  // ---------------- Profile picker ("Who's watching?") ----------------
  function openPicker(opts) {
    manageMode = false;
    renderProfilesUI();
    els.picker.hidden = false;
    els.pickerClose.hidden = !activeProfileId; // can't close before first pick
    document.documentElement.classList.add("modal-open");
  }
  function closePicker() {
    els.picker.hidden = true;
    els.pedit.hidden = true;
    document.documentElement.classList.remove("modal-open");
  }

  function renderProfilesUI() {
    if (!els.pickerGrid) return;
    els.pickerGrid.innerHTML = "";
    profiles.forEach((p) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "profile-tile";
      if (p.id === activeProfileId) tile.classList.add("profile-tile--active");

      const av = document.createElement("span");
      av.className = "profile-tile__avatar";
      av.style.background = AVATAR_COLORS[p.avatar || 0];
      av.textContent = initialsFor(p.name);
      if (manageMode) {
        const pencil = document.createElement("span");
        pencil.className = "profile-tile__edit";
        pencil.textContent = "✎";
        av.appendChild(pencil);
      }
      const nm = document.createElement("span");
      nm.className = "profile-tile__name";
      nm.textContent = p.name;

      tile.appendChild(av);
      tile.appendChild(nm);
      tile.addEventListener("click", () =>
        manageMode ? openEdit(p) : selectProfile(p.id)
      );
      els.pickerGrid.appendChild(tile);
    });

    if (profiles.length < MAX_PROFILES) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "profile-tile profile-tile--add";
      add.innerHTML =
        '<span class="profile-tile__avatar profile-tile__avatar--add">+</span>' +
        '<span class="profile-tile__name">Add profile</span>';
      add.addEventListener("click", () => openEdit(null));
      els.pickerGrid.appendChild(add);
    }

    els.pickerManage.textContent = manageMode ? "Done" : "Manage Profiles";
  }

  // ---------------- Profile editor (add / rename / delete) ----------------
  let editingId = null;
  let editAvatar = 0;

  function openEdit(p) {
    editingId = p ? p.id : null;
    editAvatar = p ? p.avatar || 0 : profiles.length % AVATAR_COLORS.length;
    els.peditTitle.textContent = p ? "Edit profile" : "Add profile";
    els.peditName.value = p ? p.name : "";
    els.peditDelete.hidden = !p || profiles.length <= 1;
    els.peditError.hidden = true;
    buildEditSwatches();
    els.pedit.hidden = false;
    setTimeout(() => els.peditName.focus(), 30);
  }
  function closeEdit() {
    els.pedit.hidden = true;
    editingId = null;
  }
  function buildEditSwatches() {
    els.peditSwatches.innerHTML = "";
    AVATAR_COLORS.forEach((c, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch" + (i === editAvatar ? " swatch--active" : "");
      b.style.background = c;
      b.addEventListener("click", () => {
        editAvatar = i;
        buildEditSwatches();
      });
      els.peditSwatches.appendChild(b);
    });
  }
  async function saveEdit() {
    const name = (els.peditName.value || "").trim().slice(0, 20);
    if (name.length < 1) {
      els.peditError.textContent = "Enter a profile name.";
      els.peditError.hidden = false;
      return;
    }
    els.peditSave.disabled = true;
    try {
      if (editingId) {
        await updateProfileMeta(editingId, { name, avatar: editAvatar });
      } else {
        await createProfile(name, editAvatar);
      }
      closeEdit();
      renderProfilesUI();
    } finally {
      els.peditSave.disabled = false;
    }
  }
  async function deleteEditing() {
    if (!editingId) return;
    if (!confirm("Delete this profile? Its list and history will be removed."))
      return;
    await deleteProfile(editingId);
    closeEdit();
    renderProfilesUI();
  }

  function unameMsg(text, ok) {
    if (!els.unameMsg) return;
    els.unameMsg.textContent = text || "";
    els.unameMsg.hidden = !text;
    els.unameMsg.classList.toggle("account__username-msg--ok", !!ok);
  }

  // Change (or set) the username from the account menu — works for accounts
  // created before usernames existed, too.
  async function changeUsername() {
    if (!user) return;
    const username = validUsername(els.unameInput.value);
    if (!username) {
      unameMsg("3–20 letters, numbers or underscore.");
      return;
    }
    if (username === user.displayName) {
      unameMsg("That's already your username.");
      return;
    }
    els.unameSave.disabled = true;
    try {
      await saveUsername(user, username);
      renderSignedIn(user);
      unameMsg("Saved!", true);
    } catch (e) {
      unameMsg("Couldn't save — try again.");
    } finally {
      els.unameSave.disabled = false;
    }
  }
  function renderSignedOut() {
    els.account.classList.remove("account--in");
    els.label.textContent = "Sign in";
    els.avatar.style.background = "";
    els.avatar.style.backgroundImage = "";
    els.avatar.textContent = "";
    if (els.switchBtn) els.switchBtn.hidden = true;
    closePicker();
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
    if (!ensureFirebase()) {
      showError("Can't reach the account service. Check your connection.");
      return;
    }
    const email = els.emailIn.value.trim();
    const password = els.passIn.value;
    if (!email || password.length < 6) {
      showError("Enter your email and a password (6+ characters).");
      return;
    }
    let username = null;
    if (mode === "signup") {
      username = validUsername(els.unameIn.value);
      if (!username) {
        showError("Pick a username: 3–20 letters, numbers or underscore.");
        return;
      }
    }
    setBusy(true);
    showError("");
    try {
      if (mode === "signup") {
        const cred = await auth.createUserWithEmailAndPassword(email, password);
        await saveUsername(cred.user, username);
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

  // Store the username on the Firebase profile (displayName) and in the user's
  // Firestore doc so it syncs and shows on every device.
  async function saveUsername(u, username) {
    if (!u || !username) return;
    try {
      await u.updateProfile({ displayName: username });
    } catch (e) {
      console.warn("[account] updateProfile failed:", e && e.message);
    }
    try {
      if (db) {
        await db
          .collection("users")
          .doc(u.uid)
          .set({ username, updatedAt: Date.now() }, { merge: true });
      }
    } catch (e) {
      console.warn("[account] username write failed:", e && e.message);
    }
  }

  async function googleSignIn() {
    if (!ensureFirebase()) {
      showError("Can't reach the account service. Check your connection.");
      return;
    }
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
    if (!ensureFirebase()) {
      showError("Can't reach the account service. Check your connection.");
      return;
    }
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
    buildSwatches();
    els.btn.addEventListener("click", () => {
      if (user) {
        els.menu.hidden ? openMenu() : closeMenu();
        return;
      }
      if (!ensureFirebase()) {
        UI.notice(
          "Accounts need an internet connection — check your connection and try again."
        );
        return;
      }
      openModal();
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
    els.unameSave.addEventListener("click", changeUsername);
    els.unameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        changeUsername();
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

    // --- Profiles ---
    if (els.switchBtn) {
      els.switchBtn.addEventListener("click", () => {
        closeMenu();
        openPicker();
      });
    }
    if (els.pickerManage) {
      els.pickerManage.addEventListener("click", () => {
        manageMode = !manageMode;
        renderProfilesUI();
      });
    }
    if (els.pickerClose) {
      els.pickerClose.addEventListener("click", () => {
        if (activeProfileId) closePicker();
      });
    }
    if (els.pedit) {
      els.pedit
        .querySelectorAll("[data-pedit-close]")
        .forEach((el) => el.addEventListener("click", closeEdit));
      els.peditSave.addEventListener("click", saveEdit);
      els.peditDelete.addEventListener("click", deleteEditing);
      els.peditName.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          saveEdit();
        }
      });
    }

    // Google OAuth can't run inside the desktop / Fire TV webviews.
    if (isEmbedded) {
      els.google.hidden = true;
      if (els.or) els.or.hidden = true;
    }
  }

  // ============================================================
  //  Boot
  // ============================================================
  let firebaseReady = false;
  let authStateBound = false;

  // Lazily initialize Firebase. Returns true once auth/db are usable. We do NOT
  // hide the account button if this fails — the button stays visible and we
  // retry here whenever the user actually tries to sign in, so a slow CDN or a
  // brief offline moment at launch no longer makes the button disappear.
  function ensureFirebase() {
    if (firebaseReady) return true;
    if (typeof firebase === "undefined" || !CONFIG.FIREBASE) return false;
    try {
      if (!firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(CONFIG.FIREBASE);
      }
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
      return false;
    }

    firebaseReady = true;
    hookLocalWrites();

    if (!authStateBound) {
      authStateBound = true;
      auth.onAuthStateChanged((u) => {
        user = u || null;
        if (unsubscribeDoc) {
          unsubscribeDoc();
          unsubscribeDoc = null;
        }
        if (user) {
          renderSignedIn(user);
          initProfiles();
        } else {
          profiles = [];
          activeProfileId = null;
          renderSignedOut();
        }
        document.dispatchEvent(new CustomEvent("account:authchanged"));
      });
    }
    return true;
  }

  function init() {
    cacheEls();
    if (!CONFIG.FIREBASE) {
      els.account.hidden = true;
      return;
    }
    // Button is always shown and clickable; Firebase is initialized now if it's
    // ready, otherwise on first sign-in attempt.
    bindUI();
    ensureFirebase();
  }

  // Open the sign-in modal from elsewhere in the app (e.g. the My List prompt).
  function promptSignIn() {
    if (!ensureFirebase()) {
      UI.notice(
        "Accounts need an internet connection — check your connection and try again."
      );
      return;
    }
    openModal();
  }

  return {
    init,
    isSignedIn: () => !!user,
    promptSignIn,
  };
})();

document.addEventListener("DOMContentLoaded", () => Account.init());
