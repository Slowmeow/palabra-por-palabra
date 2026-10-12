// Palabra por palabra has moved into AntonCards (https://audiocards.vercel.app/).
// This worker replaces the old offline one: it deletes the cached copy of the app, removes itself
// and reloads open windows, which then get index.html from the network and are sent to the new address.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
      await self.registration.unregister();
      const windows = await self.clients.matchAll({ type: "window" });
      windows.forEach((client) => client.navigate(client.url).catch(() => {}));
    })()
  );
});
