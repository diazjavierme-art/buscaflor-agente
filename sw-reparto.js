// Service worker de la app de reparto: la app se abre aunque haya poca cobertura.
// La página va siempre primero a la red (para tener la versión nueva); si no hay red, usa la copia guardada.
const CACHE = 'reparto-v1';
const BASE = ['reparto.html', 'reparto.webmanifest', 'icons/reparto-192.png', 'icons/reparto-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Firebase (datos en vivo) nunca desde la caché
  if (/firebaseio|firebasedatabase|googleapis\.com\/identitytoolkit|securetoken/.test(u.host + u.pathname)) return;
  const esPagina = e.request.mode === 'navigate' || /reparto\.html$/.test(u.pathname);
  const esLib = /gstatic\.com|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(u.host);
  if (esPagina) {
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put('reparto.html', c)); return r; })
      .catch(() => caches.match('reparto.html')));
  } else if (esLib || u.origin === location.origin) {
    e.respondWith(caches.match(e.request).then(m => m || fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); } return r; })));
  }
});
