// App-shell cache: serve what we have, refresh it in the background. Hive calls are cross-origin
// and never touched.
const CACHE = "stickit-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      const net = fetch(request)
        .then((r) => {
          if (r.ok) cache.put(request, r.clone());
          return r;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
