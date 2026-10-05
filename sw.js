/* Service worker: la app funciona sin conexión con los últimos datos descargados. */
const VERSION = 'cartera-v1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Datos: red primero, caché como respaldo.
  if (url.pathname.includes('/data/')) {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(stripQuery(e.request), copy)); return r; }).catch(() => caches.match(stripQuery(e.request))));
    return;
  }
  // Shell: red primero también (para recibir actualizaciones), caché si falla.
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then((m) => m || caches.match('./index.html'))));
});
function stripQuery(req) { const u = new URL(req.url); u.search = ''; return new Request(u.toString()); }
