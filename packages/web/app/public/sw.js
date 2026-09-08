/* global self, caches */
// Cache only this explicit public-file allowlist. Never store authenticated
// pages, chat data, API responses, uploads, or WebSocket credentials.
const BASE = new URL("./", self.location.href ?? `${self.location.origin}/sw.js`).pathname;
const CACHE_PREFIX = `codeshell-public-${encodeURIComponent(BASE)}-`;
const STATIC_CACHE = `${CACHE_PREFIX}v2`;
const PUBLIC_FILES = ["offline.html", "icon.svg", "manifest.webmanifest"].map(
  (file) => BASE + file,
);
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PUBLIC_FILES))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                (key.startsWith(CACHE_PREFIX) || (BASE === "/" && key === "codeshell-public-v1")) &&
                key !== STATIC_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;
  if (!url.pathname.startsWith(BASE)) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(`${BASE}offline.html`)));
  } else if (PUBLIC_FILES.includes(url.pathname) && !url.search) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});
