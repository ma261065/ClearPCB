/**
 * ClearPCB Service Worker — minimal, required for PWA install.
 * Does not cache aggressively; just enables install + file_handlers.
 */

const CACHE_NAME = 'clearpcb-v1';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Purge any caches left behind by older service-worker versions so a
    // stale module is never served after files change on disk.
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            ))
            .then(() => clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    // Network-first: always try network, fall back to cache. If both miss,
    // return a proper Response (never undefined) so respondWith won't throw.
    event.respondWith(
        fetch(event.request)
            .catch(async () => {
                const cached = await caches.match(event.request);
                return cached || Response.error();
            })
    );
});
