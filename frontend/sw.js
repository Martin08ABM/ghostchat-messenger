const CACHE_NAME = "ghostchat-v1";
const ASSETS = [
  "/",
  "/js/app.js",
  "/js/crypto.js",
  "/js/websocket.js",
  "/css/styles.css"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.url.includes("/ws")) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
