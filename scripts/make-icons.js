/*
 * Generates all app/PWA icons from build/source-icon.png.
 *   -> build/icon.png        (1024, square)  used by electron-builder
 *   -> build/icon.ico        (multi-size)    Windows app icon
 *   -> assets/icons/icon-192.png / icon-512.png / maskable-512.png / apple-touch-icon.png
 *
 * Run with:  npm run icons
 */

const path = require("path");
const fs = require("fs");
const { Jimp } = require("jimp");
const pngToIcoModule = require("png-to-ico");
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "build", "source-icon.png");
const OUT_ICONS = path.join(ROOT, "assets", "icons");
const BG = 0x000000ff; // match the icon's black background seamlessly

async function squareCanvas(img) {
  const size = Math.max(img.bitmap.width, img.bitmap.height);
  const canvas = new Jimp({ width: size, height: size, color: BG });
  const x = Math.round((size - img.bitmap.width) / 2);
  const y = Math.round((size - img.bitmap.height) / 2);
  canvas.composite(img, x, y);
  return canvas;
}

async function resizedPng(square, size) {
  return square.clone().resize({ w: size, h: size }).getBuffer("image/png");
}

(async () => {
  fs.mkdirSync(OUT_ICONS, { recursive: true });

  const img = await Jimp.read(SRC);
  console.log(`source: ${img.bitmap.width} x ${img.bitmap.height}`);
  const square = await squareCanvas(img);

  // Electron / builder base icon
  fs.writeFileSync(path.join(ROOT, "build", "icon.png"), await resizedPng(square, 1024));

  // PWA icons
  fs.writeFileSync(path.join(OUT_ICONS, "icon-192.png"), await resizedPng(square, 192));
  fs.writeFileSync(path.join(OUT_ICONS, "icon-512.png"), await resizedPng(square, 512));
  fs.writeFileSync(path.join(OUT_ICONS, "maskable-512.png"), await resizedPng(square, 512));
  fs.writeFileSync(path.join(OUT_ICONS, "apple-touch-icon.png"), await resizedPng(square, 180));

  // Windows .ico (bundle a few sizes)
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffers = await Promise.all(icoSizes.map((s) => resizedPng(square, s)));
  const ico = await pngToIco(icoBuffers);
  fs.writeFileSync(path.join(ROOT, "build", "icon.ico"), ico);

  console.log("Icons generated: build/icon.png, build/icon.ico, assets/icons/*");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
