// ILRCensus service worker: keeps the app itself available offline.
// Data (units, outbox) is handled by app.js in localStorage; API calls are never cached here.
const CACHE = 'ilrcensus-v1';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network first, so updates arrive when online; fall back to the cached copy offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request.mode === 'navigate' ? '/' : e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request.mode === 'navigate' ? '/' : e.request).then((r) => r || caches.match('/')))
  );
});
