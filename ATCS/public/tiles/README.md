# Offline map tiles — the permanent floor

**A small real tile package is bundled here: central Dodoma, Tanzania**
(the project's active field-test area), bounds
`[-6.21, 35.69, -6.12, 35.80]`, zoom 12–15, 142 tiles, ~1.2 MB total. It was
fetched one time from `tile.openstreetmap.org` with a descriptive User-Agent
and a rate limit well under OSM's usage-policy ceiling — deliberately small
in scope (a demo/prototype area, not a wide production release).

**[STEP 17] This folder is deliberately kept tiny on purpose.** It's the
permanent, zero-setup floor: guaranteed present from the very first launch,
with no download step and no dependency on ever having internet. The *real*
basemap for actual field use is a much larger package the app downloads for
itself once — see `../../tile-packages/README.md` and
`../../lib/offline-tiles.ts` — this folder is only what's left if that
download has never happened (e.g. the very first launch, before the device
has ever had internet).

If this folder is ever emptied, the in-app map
(`components/map-navigation-modal.tsx`) gracefully falls back to a plain
dark canvas with markers/bearing/distance only — fully functional, just
without street/terrain imagery underneath. Nothing else in the app depends
on this folder existing.

**Regenerating or replacing this package is a one-time, manual,
INTERNET-REQUIRING step done by the dev team ahead of a deployment — never
done automatically, and never done by the field user.** The app cannot
generate real map imagery on its own; it needs to know a specific operating
area, which is a deployment decision.

## What to put here

1. **`manifest.json`** — describes the coverage:
   ```json
   {
     "minZoom": 12,
     "maxZoom": 17,
     "tileSize": 256,
     "bounds": [south, west, north, east],
     "attribution": "© OpenStreetMap contributors"
   }
   ```
2. **`{z}/{x}/{y}.png`** — the actual tile images, in a standard XYZ/Slippy
   Map folder structure (e.g. `14/2621/6333.png`), for every zoom level
   between `minZoom` and `maxZoom` and covering `bounds`.

## How to generate a tile set (while online, ahead of time)

Any tool that exports the standard XYZ tile folder structure works. Two
practical options:

- **QGIS** (free): load an OpenStreetMap or other basemap layer, use the
  "Generate XYZ tiles" processing tool for your area's bounding box and a
  sensible zoom range (e.g. 12–17 for a single park/reserve), export to this
  folder.
- **A tile-downloader script** (many exist, e.g. built on `gdal2tiles.py` or
  similar) pointed at an OSM extract for your bounding box.

Keep the covered area and max zoom deliberately small — this folder ships
inside the app bundle, so its size directly adds to the installed app size.
A single reserve/park at zoom 12–17 is typically tens of MB; an entire
country at zoom 20 would not be practical.

## Why this folder alone isn't the real solution

The entire point of the map is to keep working with zero internet access in
the field — the Ranger mesh node's own Wi-Fi hotspot has no internet by
design. A tile source that requires a live network call in the field would
simply fail every time it's actually needed. But this folder ships inside
the APK, so its size directly adds to the installed app size — it can only
ever cover a small demo-scale area.

**[STEP 17] The real basemap is downloaded once, ahead of time, instead.**
The first time the app has any internet connection at all (ideally before
it's ever taken into the field), it downloads a much larger tile package
from this project's own GitHub repo — never a live OpenStreetMap server —
and keeps it permanently in app-private storage. From then on the map is
served entirely from that local copy, with zero network calls, for the
whole real operating area rather than this folder's small demo box. See
`../../tile-packages/README.md` for how that package is generated and
hosted, and `../../lib/offline-tiles.ts` for the download/storage logic.