// Ambient module declaration for plain (non-CSS-Modules) stylesheet imports.
// Next.js's own types (node_modules/next/types/global.d.ts) only declare
// `*.module.css`/`.module.scss` (CSS Modules) — a side-effect-only import of
// a plain `.css` file from a relative path happens to resolve fine under
// this project's `moduleResolution: "bundler"` setting, but a bare
// module-specifier import (e.g. `leaflet/dist/leaflet.css`) does not, and
// TypeScript reports "Cannot find module" for it without this declaration.
declare module "*.css";