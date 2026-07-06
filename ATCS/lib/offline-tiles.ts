// ─────────────────────────────────────────────────────────────────────────────
// lib/offline-tiles.ts
//
// [STEP 17] The one-time offline map download system.
//
// WHAT THIS DOES
// ──────────────
// The app ships with a tiny bundled tile sample (public/tiles/) baked into
// the APK — that's the permanent, zero-setup floor and never goes away.
// This module adds a second, much larger tile package that the app
// downloads for itself the first time it has any internet connection, then
// keeps permanently in app-private storage (via @capacitor/filesystem) so
// every navigation after that is served from disk, with zero network calls.
//
// WHERE THE TILES COME FROM
// ──────────────────────────
// A pre-rendered package (built by the team, offline, ahead of a
// deployment — see scripts/generate-tile-package.mjs) committed straight
// into this repo under tile-packages/<name>/, served to the app via GitHub's
// raw-content CDN. Not a live OpenStreetMap tile server — the app only ever
// talks to infrastructure the team controls, so this can never reproduce the
// tile-usage-policy incident hit before.
//
// WHY NOT A ZIP
// ─────────────
// Each tile is its own tiny file already (a few KB). Fetching them
// individually — instead of one big zip that then needs unzipping on-device
// — needs no extra dependency (no unzip library) and is naturally resumable:
// if the app is killed or loses connectivity mid-download, whatever's
// already on disk is skipped next time, and the rest just continues.
// ─────────────────────────────────────────────────────────────────────────────

import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Capacitor } from "@capacitor/core";

export interface OfflineTileManifest {
  minZoom: number;
  maxZoom: number;
  tileSize?: number;
  // [south, west, north, east]
  bounds: [number, number, number, number];
  attribution?: string;
  tileCount?: number;
}

export interface DownloadProgress {
  fetched: number;
  total: number;
}

const TILES_DIR = "offline-tiles";
const MANIFEST_PATH = `${TILES_DIR}/manifest.json`;
const COMPLETE_MARKER_PATH = `${TILES_DIR}/.complete`;

// Regenerate the source package with scripts/generate-tile-package.mjs, then
// commit tile-packages/<name>/ to this repo and update the path below.
const REMOTE_BASE = "https://raw.githubusercontent.com/kindars-e/ATCS/main/tile-packages/dodoma-v1";

// A partial download only counts as "done" if at least this fraction of
// tiles actually succeeded — otherwise a future launch with better
// connectivity retries the missing ones instead of silently accepting a
// mostly-empty package forever.
const MIN_SUCCESS_RATIO_TO_COMPLETE = 0.9;

const DOWNLOAD_CONCURRENCY = 6;

function lon2tileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function lat2tileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z,
  );
}

function enumerateTiles(manifest: OfflineTileManifest): Array<{ z: number; x: number; y: number }> {
  const [south, west, north, east] = manifest.bounds;
  const jobs: Array<{ z: number; x: number; y: number }> = [];
  for (let z = manifest.minZoom; z <= manifest.maxZoom; z++) {
    const xMin = lon2tileX(west, z);
    const xMax = lon2tileX(east, z);
    const yMin = lat2tileY(north, z);
    const yMax = lat2tileY(south, z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        jobs.push({ z, x, y });
      }
    }
  }
  return jobs;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // avoid stack overflow on String.fromCharCode spread
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function next(): Promise<void> {
    const i = cursor++;
    if (i >= items.length) return;
    await worker(items[i]);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path, directory: Directory.Data });
    return true;
  } catch {
    return false;
  }
}

/** Only trusts a previous download if it was actually marked complete. */
export async function getDownloadedManifest(): Promise<OfflineTileManifest | null> {
  if (!Capacitor.isNativePlatform()) return null;
  if (!(await pathExists(COMPLETE_MARKER_PATH))) return null;
  try {
    const res = await Filesystem.readFile({
      path: MANIFEST_PATH,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return JSON.parse(res.data as string) as OfflineTileManifest;
  } catch {
    return null;
  }
}

/** A Leaflet-ready `{z}/{x}/{y}` URL template pointing at the downloaded
    package on local disk, or null if nothing has been downloaded (yet). */
export async function getDownloadedTileUrlTemplate(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  if (!(await pathExists(COMPLETE_MARKER_PATH))) return null;
  const { uri } = await Filesystem.getUri({ path: TILES_DIR, directory: Directory.Data });
  const converted = Capacitor.convertFileSrc(uri);
  return `${converted}/{z}/{x}/{y}.png`;
}

/** Fetches the remote manifest to plan a download without committing to it —
    lets the caller show "~42 MB, continue?" before starting, if desired. */
export async function fetchRemoteManifest(): Promise<OfflineTileManifest | null> {
  try {
    const res = await fetch(`${REMOTE_BASE}/manifest.json`);
    if (!res.ok) return null;
    return (await res.json()) as OfflineTileManifest;
  } catch {
    return null;
  }
}

/** Downloads every tile in the remote package to local app storage, skipping
    any already present (resumable across interrupted attempts). Returns true
    only if enough tiles succeeded to mark the package usable. */
export async function downloadTilePackage(
  onProgress?: (progress: DownloadProgress) => void,
): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;

  const manifest = await fetchRemoteManifest();
  if (!manifest) return false;

  const jobs = enumerateTiles(manifest);
  const total = jobs.length;
  let fetched = 0;
  let succeeded = 0;

  await runWithConcurrency(jobs, DOWNLOAD_CONCURRENCY, async ({ z, x, y }) => {
    const relPath = `${TILES_DIR}/${z}/${x}/${y}.png`;
    if (await pathExists(relPath)) {
      succeeded++;
    } else {
      try {
        const res = await fetch(`${REMOTE_BASE}/${z}/${x}/${y}.png`);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          await Filesystem.writeFile({
            path: relPath,
            data: arrayBufferToBase64(buf),
            directory: Directory.Data,
            recursive: true,
          });
          succeeded++;
        }
      } catch {
        // Network hiccup or missing edge tile — skip, not fatal.
      }
    }
    fetched++;
    onProgress?.({ fetched, total });
  });

  await Filesystem.writeFile({
    path: MANIFEST_PATH,
    data: JSON.stringify(manifest),
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
  });

  const complete = total > 0 && succeeded / total >= MIN_SUCCESS_RATIO_TO_COMPLETE;
  if (complete) {
    await Filesystem.writeFile({
      path: COMPLETE_MARKER_PATH,
      data: "1",
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true,
    });
  }
  return complete;
}