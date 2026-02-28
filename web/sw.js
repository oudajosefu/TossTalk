const CACHE_NAME = 'tosstalk-v13';
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

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).catch(() => {
          if (event.request.mode === 'navigate') return caches.match('./index.html');
          return new Response('', { status: 404 });
        })
      );
    })
  );
});