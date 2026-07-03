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
const ANDROID_RES = path.join(ROOT, "android", "app", "src", "main", "res");
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

// Adaptive-icon foreground: logo centered on a TRANSPARENT canvas, scaled down
// so it sits inside the "safe zone" Android crops to (~66% of the icon).
async function foregroundPng(square, size, fraction = 0.62) {
  const canvas = new Jimp({ width: size, height: size, color: 0x00000000 });
  const inner = Math.round(size * fraction);
  const logo = square.clone().resize({ w: inner, h: inner });
  const off = Math.round((size - inner) / 2);
  canvas.composite(logo, off, off);
  return canvas.getBuffer("image/png");
}

// Fire TV / Android TV home-screen banner (recommended 320x180), logo on black.
async function bannerPng(square, w = 320, h = 180) {
  const canvas = new Jimp({ width: w, height: h, color: BG });
  const inner = Math.round(h * 0.78);
  const logo = square.clone().resize({ w: inner, h: inner });
  const x = Math.round((w - inner) / 2);
  const y = Math.round((h - inner) / 2);
  canvas.composite(logo, x, y);
  return canvas.getBuffer("image/png");
}

// Write Android launcher icons (legacy + adaptive foreground) and the TV banner
// straight into the committed android/ project so CI just builds them.
async function writeAndroidAssets(square) {
  if (!fs.existsSync(ANDROID_RES)) {
    console.log("android/ not present — skipping Android icon generation");
    return;
  }
  // dp bases: legacy launcher = 48dp, adaptive foreground = 108dp.
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, scale] of Object.entries(densities)) {
    const mip = path.join(ANDROID_RES, `mipmap-${d}`);
    if (!fs.existsSync(mip)) continue;
    const legacy = Math.round(48 * scale);
    const fg = Math.round(108 * scale);
    fs.writeFileSync(path.join(mip, "ic_launcher.png"), await resizedPng(square, legacy));
    fs.writeFileSync(path.join(mip, "ic_launcher_round.png"), await resizedPng(square, legacy));
    fs.writeFileSync(path.join(mip, "ic_launcher_foreground.png"), await foregroundPng(square, fg));
  }
  const drawable = path.join(ANDROID_RES, "drawable");
  fs.mkdirSync(drawable, { recursive: true });
  fs.writeFileSync(path.join(drawable, "banner.png"), await bannerPng(square));
  console.log("Android icons + TV banner written to android/app/src/main/res");
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

  // Android (Fire TV) launcher icons + banner
  await writeAndroidAssets(square);

  console.log("Icons generated: build/icon.png, build/icon.ico, assets/icons/*");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
