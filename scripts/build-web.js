/*
 * Stages the web app into ./www so Capacitor can package it into the Android
 * (Fire TV) APK. We copy only the files the site needs — NOT node_modules,
 * electron/, build/, etc. Capacitor's webDir points at ./www.
 *
 * Run with:  npm run build:web   (also runs automatically before cap sync)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "www");

// Files/dirs (relative to repo root) that make up the shippable website.
const INCLUDE = [
  "index.html",
  "manifest.webmanifest",
  "assets",
];

function rmrf(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) {
    console.warn(`[build:web] skip (missing): ${item}`);
    continue;
  }
  copyRecursive(src, path.join(OUT, item));
}

console.log(`[build:web] staged ${INCLUDE.length} entries into www/`);
