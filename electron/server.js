/*
 * Tiny built-in static file server.
 *
 * We serve the app over http://127.0.0.1:<port> instead of file:// so that
 * embedded YouTube trailers work (YouTube rejects the file:// origin with
 * "Error 153"), and so the service worker / PWA behavior is correct.
 *
 * Zero dependencies — uses Node's http + fs (reads through app.asar fine).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

// Stable ports to try, in order. Using a FIXED port keeps the app's origin
// (http://127.0.0.1:<port>) the same on every launch. That matters a lot:
// browser storage — localStorage (My List / Continue Watching) and IndexedDB
// (Firebase login state) — is keyed by origin. A random port each launch gave
// a brand-new origin every time, so the app "forgot" your data and signed you
// out on restart. These candidates are uncommon, app-specific ports.
const PREFERRED_PORTS = [39217, 39218, 39219, 41783, 45591];

function listen(server, ports, index) {
  return new Promise((resolve, reject) => {
    const tryPort = (i) => {
      const isLast = i >= ports.length;
      const port = isLast ? 0 : ports[i]; // 0 = OS-assigned fallback
      const onError = (err) => {
        if (err && err.code === "EADDRINUSE" && !isLast) {
          tryPort(i + 1);
        } else {
          reject(err);
        }
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        const actual = server.address().port;
        resolve({ server, port: actual, origin: `http://127.0.0.1:${actual}` });
      });
    };
    tryPort(index || 0);
  });
}

function start(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
        if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

        // Resolve within rootDir; block path traversal.
        const filePath = path.join(rootDir, path.normalize(urlPath));
        if (!filePath.startsWith(rootDir)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, {
            "Content-Type": MIME[ext] || "application/octet-stream",
            "Cache-Control": "no-cache",
          });
          res.end(data);
        });
      } catch (e) {
        res.writeHead(500);
        res.end("Server error");
      }
    });

    // Fixed port (localhost only) so the origin — and thus saved data + login —
    // is stable across launches; fall back to the next candidate if it's busy.
    listen(server, PREFERRED_PORTS, 0).then(resolve, reject);
  });
}

module.exports = { start };
