/*
 * Service worker: caches the app shell so Club Sandwich Streaming loads fast
 * and works offline (the UI — streams still need a connection).
 *
 * IMPORTANT: this uses a NETWORK-FIRST strategy for our own files. A previous
 * cache-first version served a stale index.html/app.js forever, which meant new
 * features (like accounts / sign-in) never appeared on the web + installed PWA
 * until the cache name changed. Network-first fetches the latest version when
 * online and only falls back to the cache when offline, so updates show up
 * immediately and we never get "stuck" on an old build again.
 */

const CACHE = "cs-stream-v10";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/css/style.css",
  "./assets/js/config.js",
  "./assets/js/shield.js",
  "./assets/js/tmdb.js",
  "./assets/js/player.js",
  "./assets/js/ui.js",
  "./assets/js/app.js",
  "./assets/js/auth.js",
  "./assets/js/tv.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // Only manage our own app shell. TMDB / VidLink / Firebase always hit the
  // network directly (skip the SW entirely).
  if (url.origin !== location.origin) return;

  // Network-first: try the network, cache a fresh copy, and fall back to the
  // cached copy only when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});
