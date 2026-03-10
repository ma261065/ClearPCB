/**
 * ClearPCB Service Worker — minimal, required for PWA install.
 * Does not cache aggressively; just enables install + file_handlers.
 */

const CACHE_NAME = 'clearpcb-v1';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Network-first: always try network, fall back to cache
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
