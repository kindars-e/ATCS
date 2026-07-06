// ─────────────────────────────────────────────────────────────────────────────
// scripts/generate-tile-package.mjs
//
// One-time, manual, INTERNET-REQUIRING tool for the dev team to pre-render a
// real offline map-tile package ahead of a field deployment. NEVER run by the
// field app itself, and never run automatically — this is exactly the kind
// of bulk tile fetch OpenStreetMap's tile usage policy asks NOT to be done
// from end-user devices. Run this once, on a developer machine, then commit
// the output so the app can download it from our own repo instead.
//
// Usage:
//   node scripts/generate-tile-package.mjs
//
// Respects OSM's tile usage policy: descriptive User-Agent, one request at a
// time, rate-limited well under any reasonable ceiling, and resumable (skips
// tiles already present on disk) so an interrupted run can continue later
// without re-fetching everything.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";

// ── Configuration — the operating area for this package ────────────────────
// Widened from the original small demo box to comfortably include the
// coordinates seen during real field testing (-6.216, 35.814), with margin
// for walking around during a test.
const BOUNDS = { south: -6.30, west: 35.65, north: -6.05, east: 35.90 };
const MIN_ZOOM = 12;
const MAX_ZOOM = 16;
const OUT_DIR = path.resolve("tile-packages/dodoma-v1");
const TILE_SOURCE = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const USER_AGENT = "ATCS-Ranger-OfflineMapBuilder/1.0 (one-time field-deployment tile package; contact: project maintainer)";
const RATE_LIMIT_MS = 1100; // ~1 request/second, well under any reasonable ceiling

function lon2tileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function lat2tileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z,
  );
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const xMinAll = [], xMaxAll = [], yMinAll = [], yMaxAll = [];
  const jobs = [];
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const xMin = lon2tileX(BOUNDS.west, z);
    const xMax = lon2tileX(BOUNDS.east, z);
    // Latitude tile Y increases southward, so north (larger lat) -> smaller Y.
    const yMin = lat2tileY(BOUNDS.north, z);
    const yMax = lat2tileY(BOUNDS.south, z);
    xMinAll.push(xMin); xMaxAll.push(xMax); yMinAll.push(yMin); yMaxAll.push(yMax);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        jobs.push({ z, x, y });
      }
    }
  }

  console.log(`Planned ${jobs.length} tiles across zoom ${MIN_ZOOM}-${MAX_ZOOM}.`);
  console.log(`Estimated time at ${RATE_LIMIT_MS}ms/tile: ~${Math.round((jobs.length * RATE_LIMIT_MS) / 60000)} min.`);

  let fetched = 0, skipped = 0, failed = 0;

  for (const { z, x, y } of jobs) {
    const dir = path.join(OUT_DIR, String(z), String(x));
    const file = path.join(dir, `${y}.png`);

    if (await fileExists(file)) {
      skipped++;
      continue;
    }

    try {
      const res = await fetch(TILE_SOURCE(z, x, y), {
        headers: { "User-Agent": USER_AGENT },
      });
      if (!res.ok) {
        // Some edge tiles at low zoom over water/blank areas can 404 — skip, not fatal.
        failed++;
        console.warn(`  [${z}/${x}/${y}] HTTP ${res.status} — skipped`);
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        await mkdir(dir, { recursive: true });
        await writeFile(file, buf);
        fetched++;
        if (fetched % 50 === 0) {
          console.log(`  ...${fetched} fetched, ${skipped} already had, ${failed} failed (z${z} x${x} y${y})`);
        }
      }
    } catch (err) {
      failed++;
      console.warn(`  [${z}/${x}/${y}] ${err.message} — skipped`);
    }

    await sleep(RATE_LIMIT_MS);
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(
      {
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        tileSize: 256,
        bounds: [BOUNDS.south, BOUNDS.west, BOUNDS.north, BOUNDS.east],
        attribution: "© OpenStreetMap contributors",
        tileCount: fetched + skipped,
      },
      null,
      2,
    ),
  );

  console.log(`\nDone. Fetched ${fetched}, already present ${skipped}, failed ${failed}.`);
  console.log(`Package written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});