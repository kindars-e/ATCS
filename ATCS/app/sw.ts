/// <reference lib="webworker" />
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import {
  Serwist,
  StaleWhileRevalidate,
  NetworkOnly,
  CacheableResponsePlugin,
  ExpirationPlugin,
} from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: WorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // keep all the defaults
    ...defaultCache,

    // 1) Cache images, fonts, JS/CSS, etc. with Stale-While-Revalidate
    // [STEP 13] Scoped to same-origin only. The old regex
    // (`/^https?.*\.(png|...)$/`) matched ANY absolute URL ending in one of
    // those extensions regardless of host — meaning if the app ever made a
    // request to an external domain for a matching file (e.g. a CDN-hosted
    // asset, or map tiles from a real tile server), the service worker would
    // cache it too. This app is offline-first and should never depend on
    // caching external resources; restricting the matcher to this app's own
    // origin is a defense-in-depth guard against that ever happening again,
    // by accident or via a future regression.
    {
      matcher: ({ url }) => url.origin === self.location.origin && /\.(png|jpg|jpeg|webp|svg|gif|tiff|js|woff2?|json|css)$/.test(url.pathname),
      handler: new StaleWhileRevalidate({
        cacheName: "static-assets",
        plugins: [
          new CacheableResponsePlugin({ statuses: [0, 200] }),
          new ExpirationPlugin({
            maxEntries: 100,
            maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
          }),
        ],
      }),
    },

    // 2) Always hit the network for your local LoRa-bridge API
    {
      matcher: /^https?:\/\/localhost:8765\/.*$/,
      handler: new NetworkOnly(),
    },
  ],
});

serwist.addEventListeners();

