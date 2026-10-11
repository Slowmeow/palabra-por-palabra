// Offline support. The site's own files and the Firebase SDK are cached here; the user's chapters and
// words come from Firestore's own offline cache. Firebase data, the Claude API and Google sign-in
// always go to the network and are never touched by this worker.
const VERSION = "__BUILD__"; // replaced with the commit id when the site is published
const CACHE = `ppp-${VERSION}`;
const SDK = ["app", "auth", "firestore"].map((m) => `https://www.gstatic.com/firebasejs/12.19.0/firebase-${m}.js`);
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "config.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "js/app.js",
  "js/claude.js",
  "js/db.js",
  "js/i18n.js",
  "js/icons.js",
  "js/importer.js",
  "js/langs.js",
  "js/srs.js",
  "js/text.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([...SHELL, ...SDK]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ppp-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const remember = (request, response) => {
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
};

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const own = url.origin === self.location.origin;
  const fixed = SDK.includes(url.href) || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (own) {
    // Network first, so a new version of the site arrives at once; the cache is only the offline fallback.
    event.respondWith(
      fetch(request)
        .then((response) => remember(request, response))
        .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html")))
    );
  } else if (fixed) {
    // A pinned SDK version and fonts never change: cache first.
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((response) => remember(request, response))));
  }
});
