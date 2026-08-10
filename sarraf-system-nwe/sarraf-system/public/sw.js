// Identity-only cache revision. Financial/application data is not cached or cleared here.
const IDENTITY_CACHE = "zeman-identity-v1";
const IDENTITY_ASSETS = ["/brand/zeman-symbol.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(IDENTITY_CACHE).then((cache) => cache.addAll(IDENTITY_ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("zeman-identity-") && key !== IDENTITY_CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (event) => { if (event.request.method === "GET" && IDENTITY_ASSETS.some((path) => new URL(event.request.url).pathname === path)) event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request))); });
