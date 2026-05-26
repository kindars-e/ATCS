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
    {
      matcher: /^https?.*\.(png|jpg|jpeg|webp|svg|gif|tiff|js|woff2?|json|css)$/,
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

