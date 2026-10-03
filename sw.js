/**
 * ClearPCB Service Worker — minimal, required for PWA install + file_handlers.
 *
 * Deliberately has no fetch handler: Chrome then bypasses the worker for every
 * request, so pages and modules load natively (no per-request worker hop, and
 * cancelled or failed navigations behave normally instead of surfacing as
 * "FetchEvent ... resulted in a network error response"). Chrome no longer
 * requires a fetch handler for installability.
 */

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Older versions created caches; nothing is cached now, so purge them all
    // so a stale module can never be served after files change on disk.
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});