// 최소 서비스워커: 앱 셸 캐시 (오프라인에서도 UI는 뜨게)
const C = 'ghc-shell-v5';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './vendor/leaflet.js', './vendor/leaflet.css', './titles.js', './dict.js', './i18n.js', './privacy.html', './privacy-en.html'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return; // 지도 타일/Overpass는 네트워크 그대로
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(C).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request))); // 네트워크 우선, 오프라인이면 캐시
});
