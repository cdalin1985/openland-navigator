/**
 * OpenLand service worker: keeps the app usable with no cell signal.
 *
 * - Page navigations: network first, falling back to the cached page.
 * - Built assets (/assets/*), icons and the manifest: cache first.
 * - USGS map tiles: served from the tile cache filled by "Save this map view
 *   for offline" (app/lib/offline.ts), otherwise fetched normally.
 * - API routes and all other sites (BLM, Montana, USFS, Google): untouched;
 *   the app falls back to saved offline areas itself.
 * Cache names must match app/lib/offline.ts.
 */
const SHELL_CACHE = "openland-shell-v1";
const TILE_CACHE = "openland-tiles-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.hostname === "basemap.nationalmap.gov" && url.pathname.includes("/tile/")) {
    event.respondWith(
      caches.open(TILE_CACHE).then(cache => cache.match(request.url)).then(hit => hit || fetch(request)),
    );
    return;
  }

  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then(cache => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.open(SHELL_CACHE).then(cache => cache.match("/")).then(hit => hit || Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/") || /\.(svg|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async cache => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
  }
});
