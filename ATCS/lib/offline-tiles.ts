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
// deployment — see scripts/generate-tile-package.mjs), zipped and uploaded
// as a GitHub Release asset on this repo — never a live OpenStreetMap tile
// server, so this can't reproduce the tile-usage-policy incident hit
// before. Release assets are served through GitHub's object-storage CDN
// (a different pipeline than raw.githubusercontent.com), which is why a
// single zip archive is used here rather than fetching thousands of
// individual tile files directly out of the repo.
// ─────────────────────────────────────────────────────────────────────────────

import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Capacitor } from "@capacitor/core";
import { unzip } from "fflate";

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

// Regenerate the source package with scripts/generate-tile-package.mjs, zip
// the output folder, and attach it to a GitHub Release on this repo — see
// tile-packages/README.md for the exact steps. Update this to match.
const PACKAGE_URL = "https://github.com/kindars-e/ATCS/releases/download/tiles-dodoma-v1/dodoma-v1.zip";

// A partial extraction only counts as "done" if at least this fraction of
// the archive's files actually got written to disk — otherwise a future
// launch with better connectivity/storage retries instead of silently
// accepting a mostly-empty package forever.
const MIN_SUCCESS_RATIO_TO_COMPLETE = 0.9;

function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, unzipped) => {
      if (err) reject(err);
      else resolve(unzipped);
    });
  });
}

function arrayBufferToBase64(buffer: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000; // avoid stack overflow on String.fromCharCode spread
  for (let i = 0; i < buffer.length; i += chunkSize) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunkSize));
  }
  return btoa(binary);
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

/** Downloads the packaged zip, extracts every file to local app storage,
    and marks the package usable once enough of it has been written. Safe to
    call repeatedly — re-checks disk state internally, so a caller doesn't
    need to track whether a previous attempt partially completed. */
export async function downloadTilePackage(
  onProgress?: (progress: DownloadProgress) => void,
): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;

  let zipBytes: Uint8Array;
  try {
    const res = await fetch(PACKAGE_URL);
    if (!res.ok) return false;
    zipBytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return false;
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = await unzipAsync(zipBytes);
  } catch {
    return false;
  }

  // Zip archives made on Windows can store `\`-separated paths — normalise
  // to `/` so they work as Filesystem paths. Skip directory placeholder
  // entries (empty content, path ends with a separator).
  const files = Object.entries(entries)
    .map(([rawPath, data]) => ({ path: rawPath.replace(/\\/g, "/"), data }))
    .filter(({ path }) => !path.endsWith("/"));

  const total = files.length;
  let written = 0;
  let succeeded = 0;

  for (const { path, data } of files) {
    try {
      await Filesystem.writeFile({
        path: `${TILES_DIR}/${path}`,
        data: path.endsWith(".json") ? new TextDecoder().decode(data) : arrayBufferToBase64(data),
        directory: Directory.Data,
        encoding: path.endsWith(".json") ? Encoding.UTF8 : undefined,
        recursive: true,
      });
      succeeded++;
    } catch {
      // Disk-write hiccup on an individual file — skip, not fatal.
    }
    written++;
    onProgress?.({ fetched: written, total });
  }

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
