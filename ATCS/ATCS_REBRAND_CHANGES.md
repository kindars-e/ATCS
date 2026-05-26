# ATCS Rebrand & Dark Brick-Red Theme

This round is a pure **branding + visual** redesign. No communication logic was
touched — messaging, emergency broadcasts, pairing, scanning, location, LoRa,
Wi-Fi, and QR all work exactly as before. Written for someone still learning, so
it explains how the theming is structured and why certain things were left alone.

---

## 1. What changed at a glance

- The app now identifies as **ATCS — Alternative Text-based Communication System**.
- The blue accent identity is replaced by a **dark brick-red** palette over a warm
  charcoal foundation.
- The logo is **kept** (as requested).
- All of this is centralized so colors live in one file, not scattered everywhere.

---

## 2. How the theming is structured (the important part)

The app colors lived in **two** places, and we handled both centrally in
`app/globals.css`:

### a) A single source of truth for brand colors
At the top of `globals.css` there is now an ATCS palette defined as CSS
variables — a brick-red scale (`--brick-100` … `--brick-900`) plus a warm
charcoal foundation (`--atcs-bg`, `--atcs-surface`, …). Everything else
references these, so changing the brand color later means editing **one block**.

```css
--brick-600: oklch(0.47 0.155 28);  /* deep brick red — main action color */
--atcs-surface: oklch(0.22 0.012 30); /* card background */
```

> Why OKLCH? It's a color format where the first number is lightness. Picking
> shades along an even lightness ramp keeps the palette looking deliberate and
> keeps text contrast predictable (better accessibility in low light).

### b) Remapping the old blue utilities (no per-file edits)
The components were built with hardcoded Tailwind classes like `bg-blue-600`.
Instead of editing ~70 class usages across 7 files (error-prone), the bottom of
`globals.css` **remaps those exact class names** to the brick-red scale:

```css
.bg-blue-600 { background-color: var(--brick-600) !important; }
.text-blue-400 { color: var(--brick-400) !important; }
/* …backgrounds, hover, text, border, ring, gradient, shadow… */
```

So every existing `bg-blue-600` now renders brick-red, with zero component
edits. This is the maintainable approach: one file controls the whole accent.

The dark grays (`bg-gray-900/800/700`) used for backgrounds and cards are also
nudged to a **warm charcoal** so the brick-red reads as intentional rather than
clashing with a cold neutral gray.

### c) The shadcn tokens
The `ui/*` components use shadcn variables (`--primary`, `--card`, `--ring`,
etc.). Those were retuned to the brick-red identity too, in the `:root` and
`.dark` blocks.

---

## 3. Branding text replaced

| Location | Before | After |
|---|---|---|
| Splash title | "Fling" | "ATCS" + "Alternative Text-based Communication System" + "Communication when there is no network" |
| Splash badges | "End-to-End Encrypted / Works Offline" | "Emergency Ready / Works Without Internet" |
| Contacts header | "Fling" / "Not all who wander are lost" | "ATCS" / "Communication beyond network coverage" |
| Install prompt | "Install Fling" | "Install ATCS" |
| Wi-Fi modal | "Starting Fling…" | "Starting ATCS…" |
| Compass modal | "Fling needs access…" | "ATCS needs access…" |
| `app/layout.tsx` metadata | Fling title/description/keywords/author | ATCS equivalents + brick-red `themeColor` |
| `capacitor.config.ts` | `appName: 'Fling'` | `appName: 'ATCS'` |

---

## 4. What was deliberately NOT changed (and why)

You asked not to change any technicalities. These keep the literal word "fling"
but are **internal identifiers** — renaming them would break things, not rebrand
them:

- **Storage keys** (`fling-trails`, `fling-contacts`, `fling-messages`) — these
  are the keys the app saves data under in the browser. Renaming them would make
  the app unable to find existing saved contacts/messages/trails (data loss).
- **`fling://` QR pairing scheme** — both the QR generator and parser use this
  exact string as their contract. Changing it would break pairing with any
  device/QR using the current scheme. Left working as-is.
- **`Fling_Node1` SSID convention** — the Wi-Fi network name is set in the
  firmware; the app text references it so users connect to the right network.
  Changing the app text without reflashing every node would mislead users.
- **`appId: 'com.fling.app'`** — the app bundle identifier used for signing and
  app-store identity. Changing it is a release/technical concern, not branding,
  and would orphan installed-app upgrades.
- **`FlingApp` component / `fling-app.tsx` filename** — internal code names, not
  user-visible.

If you later want to migrate any of these (e.g. rename storage keys with a
one-time data migration, or move to an `atcs://` scheme on both sides), that can
be done deliberately as a separate technical task.

---

## 5. Files modified

| File | Change |
|---|---|
| `app/globals.css` | Centralized brick-red palette + charcoal foundation; blue→brick utility remap; warm-gray base. |
| `app/layout.tsx` | ATCS metadata, title, keywords, brick `themeColor`, flash-prevention bg. |
| `components/splash-screen.tsx` | ATCS name, subtitle, offline-comms tagline, reworded badges. |
| `components/contacts-view.tsx` | ATCS header + tagline; "Install ATCS"; brick FAB shadow. |
| `components/wifi-connection-modal.tsx` | "Starting ATCS…". |
| `components/compass-modal.tsx` | "ATCS needs access…". |
| `capacitor.config.ts` | `appName: 'ATCS'` (appId kept). |

The logo (`fling-logo.tsx` / `FlingLogo`) is unchanged, as requested.

---

## 6. Emergency colors stay distinct

The emergency sections use an orange→red treatment. Since the brand is now also
red, this was checked deliberately: the brand brick-red sits at a lower-chroma,
slightly different hue than the brighter orange-shifted emergency gradient, so
emergency still reads as a distinct "alert" and isn't confused with normal brand
buttons. Online/offline status colors (green/amber/red dots from v6) are also
preserved since they carry meaning.

---

## 7. How to run

```bash
cd Fling-Rola
npm install
npm run dev      # http://localhost:3000   (or: npm run build && npm run start)
```

`node_modules/` isn't bundled — run `npm install`. Verified with a full
production build.

---

## 8. How to tweak the theme later

- Change the **whole accent color**: edit the `--brick-*` values at the top of
  `globals.css`. Everything follows.
- Change **background darkness**: edit `--atcs-bg` / `--atcs-surface` and the
  `.bg-gray-900/800/700` overrides.
- Add a new branded button somewhere: just use `bg-blue-600` / `text-blue-400`
  like the rest of the app — it'll automatically render brick-red via the remap.
