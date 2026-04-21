const CACHE_NAME = "ghostchat-v2";
const DYNAMIC_CACHE = "ghostchat-dynamic-v2";
const CACHE_VERSION = "2.0.0";

// URLs que deben estar siempre en cache (critical assets)
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/js/app.js",
  "/js/crypto.js", 
  "/js/websocket.js",
  "/css/styles.css",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// URLs que nunca deben ser cacheadas
const NETWORK_ONLY = [
  "/ws",
  "/metrics",
  "/health"
];

// URLs que pueden ser cacheadas dinámicamente
const DYNAMIC_CACHE_PATTERNS = [
  /^https:\/\/cdnjs\.cloudflare\.com\/.*/,
  /^https:\/\/cloud\.umami\.is\/.*/
];

self.addEventListener("install", (event) => {
  console.log("[SW] Installing service worker...");
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log("[SW] Pre-caching static assets");
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => caches.open(DYNAMIC_CACHE))
      .then(() => {
        console.log("[SW] Cache ready");
      })
  );
});

self.addEventListener("activate", (event) => {
  console.log("[SW] Activating service worker...");
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // Borrar caches antiguas
          if (cacheName !== CACHE_NAME && cacheName !== DYNAMIC_CACHE) {
            console.log(`[SW] Deleting old cache: ${cacheName}`);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log("[SW] Service worker activated");
      return self.clients.claim();
    })
  );
});

// Network-first strategy for important data
async function networkFirst(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    console.log(`[SW] Network failed, trying cache for ${request.url}`);
    const cached = await caches.match(request);
    if (cached) return cached;
    
    // Si no hay cache, retornar página offline
    if (request.destination === "document") {
      return caches.match("/");
    }
    
    throw error;
  }
}

// Cache-first strategy for static assets
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    console.log(`[SW] Cache hit for ${request.url}`);
    return cached;
  }
  
  console.log(`[SW] Cache miss for ${request.url}, fetching from network`);
  return networkFirst(request);
}

// Cache only strategy
async function cacheOnly(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  throw new Error("No cache available");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // 1. Skip non-GET requests
  if (request.method !== "GET") {
    return;
  }
  
  // 2. Skip WebSocket connections
  if (NETWORK_ONLY.some(pattern => request.url.includes(pattern))) {
    return;
  }
  
  // 3. Apply strategies based on request type
  event.respondWith(
    (async () => {
      try {
        // HTML pages - Network first (siempre actualizar)
        if (request.destination === "document" || url.pathname === "/") {
          return await networkFirst(request);
        }
        
        // Static assets - Cache first
        if (STATIC_ASSETS.includes(url.pathname)) {
          return await cacheFirst(request);
        }
        
        // CDNs - Cache first, guardar en dynamic cache
        if (DYNAMIC_CACHE_PATTERNS.some(pattern => pattern.test(request.url))) {
          return await cacheFirst(request);
        }
        
        // Default: Network first for everything else
        return await networkFirst(request);
        
      } catch (error) {
        console.error(`[SW] Fetch failed for ${request.url}:`, error);
        
        // Para páginas, mostrar versión cacheada
        if (request.destination === "document") {
          const cached = await caches.match("/");
          if (cached) return cached;
        }
        
        // Para otros recursos, intentar cache
        const cached = await caches.match(request);
        if (cached) return cached;
        
        // Último recurso: error
        return new Response("Offline", {
          status: 503,
          statusText: "Service Unavailable",
          headers: new Headers({
            "Content-Type": "text/html"
          })
        });
      }
    })()
  );
});

// Background sync for failed requests
self.addEventListener("sync", (event) => {
  console.log(`[SW] Background sync: ${event.tag}`);
  
  if (event.tag === "message-sync") {
    event.waitUntil(syncMessages());
  }
});

async function syncMessages() {
  // Aquí iría la lógica para reintentar mensajes fallidos
  console.log("[SW] Syncing pending messages...");
  // Por ahora, solo un placeholder
}

// Push notifications handler
self.addEventListener("push", (event) => {
  console.log("[SW] Push received");
  
  const options = {
    body: event.data ? event.data.text() : "New message received",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    vibrate: [200, 100, 200],
    data: {
      dateOfArrival: Date.now()
    },
    actions: [
      {
        action: "open",
        title: "Open app"
      },
      {
        action: "close",
        title: "Dismiss"
      }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification("GhostChat", options)
  );
});

self.addEventListener("notificationclick", (event) => {
  console.log("[SW] Notification clicked");
  
  event.notification.close();
  
  if (event.action === "open") {
    event.waitUntil(
      clients.openWindow("/")
    );
  }
});

// Periodic background sync (si está disponible)
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "cleanup") {
    event.waitUntil(periodicCleanup());
  }
});

async function periodicCleanup() {
  console.log("[SW] Periodic cleanup running");
  
  try {
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    const now = Date.now();
    
    // Limpiar cache antigua (más de 7 días)
    const weekInMs = 7 * 24 * 60 * 60 * 1000;
    
    for (const request of requests) {
      const response = await cache.match(request);
      const dateHeader = response.headers.get("date");
      
      if (dateHeader) {
        const responseDate = new Date(dateHeader).getTime();
        if (now - responseDate > weekInMs) {
          console.log(`[SW] Deleting old cache entry: ${request.url}`);
          await cache.delete(request);
        }
      }
    }
    
    console.log("[SW] Cleanup completed");
  } catch (error) {
    console.error("[SW] Cleanup failed:", error);
  }
}

console.log("[SW] Service worker script loaded");