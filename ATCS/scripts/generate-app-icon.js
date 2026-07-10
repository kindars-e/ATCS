// Save as scripts/generate-app-icon.js
// Run: node scripts/generate-app-icon.js
//
// Regenerates the Android launcher icon (and the PWA/apple-touch icons under
// public/) from the actual in-app FlingLogo SVG paths (components/fling-logo.tsx)
// on the app's brick-red brand background, replacing the stock Android Studio
// placeholder icon (teal graph-paper background + unrelated blue "X" mark) that
// had never been customized since project creation.

const sharp = require("sharp");
const fs = require("fs").promises;
const path = require("path");

// ── The exact path data from components/fling-logo.tsx (viewBox 0 0 77.64 59.08) ──
const LOGO_PATHS = [
  "M74.93,35.9h-8.44c-.65,0-1.18-.53-1.18-1.18v-8.06c0-2.06-.84-3.92-2.19-5.27s-3.24-2.2-5.3-2.2-3.94.85-5.3,2.2c-1.36,1.35-2.21,3.21-2.21,5.27v25.11c0,.61-.25,1.17-.65,1.59-.42.4-.98.65-1.59.65s-1.18-.25-1.59-.65c-.4-.42-.67-.98-.67-1.59v-30.25c0-2.07-.84-3.94-2.19-5.29-1.37-1.35-3.24-2.21-5.3-2.21s-3.94.85-5.3,2.21c-1.37,1.35-2.21,3.22-2.21,5.29v25.83c0,.61-.25,1.17-.67,1.59-.4.4-.97.65-1.57.65s-1.18-.25-1.59-.65c-.42-.42-.67-.98-.67-1.59v-13.77c0-2.04-.84-3.91-2.21-5.27-1.36-1.35-3.23-2.18-5.3-2.18s-3.93.83-5.3,2.18c-1.36,1.36-2.19,3.23-2.19,5.27v1.14c0,.65-.53,1.18-1.18,1.18H2.77c-1.29,0-2.48.86-2.72,2.13-.32,1.67,1,3.12,2.66,3.12h8.57c2.91,0,5.28-2.36,5.28-5.28v-2.28c0-.59.25-1.13.67-1.52.4-.41.97-.65,1.57-.65s1.18.24,1.59.65c.42.39.67.93.67,1.52v13.5c0,2.05.84,3.94,2.19,5.29,1.37,1.35,3.24,2.19,5.31,2.19s3.93-.84,5.3-2.19c1.36-1.35,2.19-3.24,2.19-5.29v-25.69c0-.62.25-1.18.67-1.59.4-.4.97-.67,1.59-.67s1.17.26,1.57.67c.42.4.67.96.67,1.59v30.2c0,2.05.84,3.94,2.21,5.29,1.36,1.35,3.23,2.19,5.3,2.19s3.94-.84,5.3-2.19c1.36-1.35,2.19-3.24,2.19-5.29v-24.9c0-.6.26-1.15.67-1.54.4-.39.97-.65,1.59-.65s1.17.26,1.59.65c.4.39.65.93.65,1.54v9.17c0,2.91,2.36,5.28,5.28,5.28h.14s9.4,0,9.4,0c1.29,0,2.48-.86,2.72-2.13.32-1.67-1-3.12-2.66-3.12Z",
  "M57.61,5.25c-2.9,0-5.26,2.35-5.26,5.25s2.36,5.24,5.26,5.24,5.25-2.34,5.25-5.24-2.35-5.25-5.25-5.25Z",
  "M37.96,0c-2.9,0-5.26,2.35-5.26,5.25s2.36,5.24,5.26,5.24,5.25-2.34,5.25-5.24-2.35-5.25-5.25-5.25Z",
  "M18.97,12.18c-2.9,0-5.26,2.35-5.26,5.25s2.36,5.24,5.26,5.24,5.25-2.34,5.25-5.24-2.35-5.25-5.25-5.25Z",
];
const LOGO_W = 77.64;
const LOGO_H = 59.08;

// ── OKLCH → sRGB hex, matching app/globals.css's --brick-600 (oklch(0.47 0.155 28)) ──
function oklchToHex(L, C, H) {
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const toSrgb = (c) => {
    c = Math.min(1, Math.max(0, c));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  };
  const toByte = (c) => Math.round(toSrgb(c) * 255);

  const r = toByte(rLin);
  const g = toByte(gLin);
  const bl = toByte(bLin);
  return "#" + [r, g, bl].map((n) => n.toString(16).padStart(2, "0")).join("");
}

const BRICK_600 = oklchToHex(0.47, 0.155, 28); // deep brick red — the app's "main action" accent
console.log(`Computed --brick-600 as ${BRICK_600}`);

// ── Position the logo inside a 108x108 canvas, scaled to fit within Android's
// adaptive-icon safe zone (a centered 66dp circle) with a little breathing room. ──
const CANVAS = 108;
const TARGET_W = 60; // < 66dp safe-zone diameter
const SCALE = TARGET_W / LOGO_W;
const SCALED_W = LOGO_W * SCALE;
const SCALED_H = LOGO_H * SCALE;
const OFFSET_X = (CANVAS - SCALED_W) / 2;
const OFFSET_Y = (CANVAS - SCALED_H) / 2;

function logoGroup(fill) {
  const paths = LOGO_PATHS.map((d) => `<path d="${d}" fill="${fill}"/>`).join("");
  return `<g transform="translate(${OFFSET_X},${OFFSET_Y}) scale(${SCALE})">${paths}</g>`;
}

function fullIconSvg({ round }) {
  const content = `<rect width="${CANVAS}" height="${CANVAS}" fill="${BRICK_600}"/>${logoGroup("#FFFFFF")}`;
  if (!round) {
    return `<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">${content}</svg>`;
  }
  const r = CANVAS / 2;
  return `<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
    <defs><clipPath id="round"><circle cx="${r}" cy="${r}" r="${r}"/></clipPath></defs>
    <g clip-path="url(#round)">${content}</g>
  </svg>`;
}

function foregroundSvg() {
  return `<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">${logoGroup(
    "#FFFFFF",
  )}</svg>`;
}

// Android density buckets: legacy launcher icon is 48dp, adaptive foreground/
// background layers are 108dp — both scaled by the same per-density multiplier.
const DENSITIES = {
  mdpi: 1,
  hdpi: 1.5,
  xhdpi: 2,
  xxhdpi: 3,
  xxxhdpi: 4,
};

async function renderSvgToPng(svg, size, outPath) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outPath);
  console.log(`  wrote ${outPath} (${size}x${size})`);
}

async function main() {
  const resDir = path.join(process.cwd(), "android", "app", "src", "main", "res");

  console.log("Generating Android launcher icons…");
  for (const [density, mult] of Object.entries(DENSITIES)) {
    const dir = path.join(resDir, `mipmap-${density}`);
    await fs.mkdir(dir, { recursive: true });

    const legacySize = Math.round(48 * mult);
    const adaptiveSize = Math.round(108 * mult);

    await renderSvgToPng(fullIconSvg({ round: false }), legacySize, path.join(dir, "ic_launcher.png"));
    await renderSvgToPng(fullIconSvg({ round: true }), legacySize, path.join(dir, "ic_launcher_round.png"));
    await renderSvgToPng(foregroundSvg(), adaptiveSize, path.join(dir, "ic_launcher_foreground.png"));
  }

  // Update the adaptive icon's background color to match.
  const colorXmlPath = path.join(resDir, "values", "ic_launcher_background.xml");
  const colorXml = `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BRICK_600}</color>\n</resources>\n`;
  await fs.writeFile(colorXmlPath, colorXml);
  console.log(`  updated ${colorXmlPath} -> ${BRICK_600}`);

  // ── PWA / browser-tab / apple-touch icons (public/icon-*.png) — same logo
  // and brand color, referenced directly by app/layout.tsx and manifest.webmanifest. ──
  console.log("Generating PWA icons…");
  const pwaSizes = [72, 96, 128, 144, 152, 192, 384, 512];
  const publicDir = path.join(process.cwd(), "public");
  for (const size of pwaSizes) {
    await renderSvgToPng(
      fullIconSvg({ round: false }),
      size,
      path.join(publicDir, `icon-${size}x${size}.png`),
    );
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
