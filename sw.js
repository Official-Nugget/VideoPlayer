/*
 * Service worker: caches the app shell so Club Sandwich Streaming loads fast
 * and works offline (the UI — streams still need a connection).
 */

const CACHE = "cs-stream-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/css/style.css",
  "./assets/js/config.js",
  "./assets/js/tmdb.js",
  "./assets/js/player.js",
  "./assets/js/ui.js",
  "./assets/js/app.js",
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
  // Only serve our own app shell from cache; TMDB / VidLink always hit network.
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
