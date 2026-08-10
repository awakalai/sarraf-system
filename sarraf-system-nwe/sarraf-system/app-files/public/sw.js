// Identity-only cache revision. Financial/application data is not cached or cleared here.
importScripts("/share-handoff-store.js");
const IDENTITY_CACHE = "zeman-identity-v1";
const IDENTITY_ASSETS = ["/brand/zeman-symbol.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(IDENTITY_CACHE).then((cache) => cache.addAll(IDENTITY_ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(Promise.all([
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("zeman-identity-") && key !== IDENTITY_CACHE).map((key) => caches.delete(key)))),
  ZemanShareStore.cleanup(),
]).then(() => self.clients.claim())));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "GET" && event.request.mode === "navigate") event.waitUntil(ZemanShareStore.cleanup());
  if (event.request.method === "POST" && url.origin === self.location.origin && url.pathname === "/receipt-share") {
    event.respondWith((async () => {
      let result = { id: null, rejected: [{ code: "malformed", name: "" }] };
      try {
        const contentType = event.request.headers.get("content-type") || "";
        if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new Error("invalid multipart content type");
        const form = await event.request.formData();
        result = await ZemanShareStore.stage(form.getAll("receipts"));
      } catch (_) { /* Return a safe intake state rather than a raw error. */ }
      const destination = new URL("/", self.location.origin);
      destination.searchParams.set("receiptShare", result.id || "invalid");
      if (result.rejected && result.rejected.length) destination.searchParams.set("shareRejected", String(result.rejected.length));
      return Response.redirect(destination.href, 303);
    })());
    return;
  }
  if (event.request.method === "GET" && IDENTITY_ASSETS.some((path) => url.pathname === path)) event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
