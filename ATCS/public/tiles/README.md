# Offline map tiles

**A real tile package is currently bundled here: central Dodoma, Tanzania**
(the project's active field-test area), bounds
`[-6.21, 35.69, -6.12, 35.80]`, zoom 12–15, 142 tiles, ~1.2 MB total. It was
fetched one time from `tile.openstreetmap.org` with a descriptive User-Agent
and a rate limit well under OSM's usage-policy ceiling — deliberately small
in scope (a demo/prototype area, not a wide production release). **If you
ship this app widely or cover a large area, replace this with tiles sourced
properly** (a Geofabrik extract + your own renderer, or a licensed
commercial tile provider) rather than relying on OSM's shared tile server —
see "How to generate a tile set" below.

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

## Why the app doesn't just download tiles itself

The entire point of this system is to keep working with zero internet
access in the field — the Ranger mesh node's own Wi-Fi hotspot has no
internet by design. Any tile source that requires a live network call would
simply fail every time it's actually needed.