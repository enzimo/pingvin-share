// Requests use the network, including authenticated API and share responses.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Remove caches left by older next-pwa versions when this worker replaces them.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("workbox-"))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});
