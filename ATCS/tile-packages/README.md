# Downloadable tile packages

This folder holds the *real* offline basemap packages ATCS downloads for
itself — see `lib/offline-tiles.ts` for the app-side download/storage logic,
and `../public/tiles/README.md` for the small, always-bundled floor this
supplements.

**This folder is intentionally NOT under `public/`.** It must never be
picked up by `next build`'s static export or bundled into the APK — the
whole point is that these tiles live on GitHub and are pulled down by the
app at runtime, not shipped inside the install.

## How it works, end to end

1. A developer runs `scripts/generate-tile-package.mjs` once, on a machine
   with internet, ahead of a deployment. It fetches every tile for a
   configured bounding box/zoom range from `tile.openstreetmap.org`,
   respectfully (descriptive User-Agent, rate-limited, resumable), into
   `tile-packages/<name>/`.
2. That folder is committed and pushed to this repo, same as any other file.
3. The app fetches tiles from it via GitHub's raw-content CDN
   (`https://raw.githubusercontent.com/<owner>/<repo>/main/tile-packages/<name>/...`)
   — a static file host we control, never a live OSM tile server, so this
   can't reproduce the tile-usage-policy incident hit before.
4. The first time the app has any internet connection, `lib/offline-tiles.ts`
   downloads every tile in the package to the device's own private storage
   (via `@capacitor/filesystem`) and marks it complete. From then on, the
   map reads tiles straight from local disk — no network call, ever again,
   regardless of whether the device ever has internet again.

## Regenerating or replacing a package

Edit the `BOUNDS`/`MIN_ZOOM`/`MAX_ZOOM`/`OUT_DIR` constants at the top of
`scripts/generate-tile-package.mjs`, then run:

```powershell
node scripts/generate-tile-package.mjs
```

It skips any tile already on disk, so an interrupted run can just be
re-run to pick up where it left off. Commit and push the resulting folder,
and update `REMOTE_BASE` in `lib/offline-tiles.ts` if the folder name
changed.

**This is a one-time, manual, INTERNET-REQUIRING step done by the dev team
ahead of a deployment — never done automatically, and never done by the
field user's device fetching straight from OpenStreetMap.** Widening
coverage or adding a new operating area is exactly this: regenerate, commit,
push — no app rebuild required, since the download happens at runtime.