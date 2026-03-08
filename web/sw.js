const CACHE_NAME = 'tosstalk-v18';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './core.js',
  './manifest.webmanifest',
  './favicon.svg',
  './debug/',
  './debug/index.html',
  './debug/styles.css',
  './debug/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

// Network-first strategy: always try the network so users get the latest
// code.  Fall back to the pre-cached copy only when offline or on error.
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Update the cache with the fresh response for offline use
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          return cached || (event.request.mode === 'navigate'
            ? caches.match('./index.html')
            : new Response('', { status: 404 }));
        });
      })
  );
});