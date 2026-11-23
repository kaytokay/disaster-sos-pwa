// Bump this whenever the app shell changes so installed PWAs replace old assets.
const CACHE = "sos-shell-v6";
const SHELL = ["/", "/index.html", "/index-online.html", "/styles.css", "/styles-v2.css", "/app.js", "/app-v2.js", "/manifest.json", "/icon.svg", "/shelters.json", "/shelters-v2.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname === "/dashboard.html") return; // Keep authenticated responder pages out of the offline cache.
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(req).catch(() => new Response("Service unavailable", { status: 503 })));
    return;
  }
  // Network-first keeps the installed app current while preserving offline use.
  // Ignore query strings for the fallback so versioned requests can use the shell cache.
  e.respondWith(fetch(req).then(res => {
    if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
// Background Sync: ask an open page to flush the IndexedDB queue
self.addEventListener("sync", e => {
  if (e.tag === "sync-sos") {
    e.waitUntil(self.clients.matchAll({ includeUncontrolled: true }).then(cs => cs.forEach(c => c.postMessage("SYNC_NOW"))));
  }
});
