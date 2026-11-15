// 최소 서비스워커: 앱 셸 캐시 (오프라인에서도 UI는 뜨게)
const C = 'ghc-shell-v2';
const SHELL = ['./', './index.html', './style.css', './app.js', './store.js', './manifest.webmanifest', './icon.svg', './vendor/leaflet.js', './vendor/leaflet.css'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return; // 지도 타일/Overpass는 네트워크 그대로
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
