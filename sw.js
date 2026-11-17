// 최소 서비스워커: 앱 셸 캐시 (오프라인에서도 UI는 뜨게)
// 같은 파일은 ?v=(배포 버전), ?d=(데이터 날짜)를 떼고 한 칸에 덮어쓴다. 배포할 때마다 옛 파일이 휴대폰에 쌓이지 않게
const C = 'ghc-shell-v6';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './vendor/leaflet.js', './vendor/leaflet.css', './titles.js', './dict.js', './i18n.js', './privacy.html', './privacy-en.html'];
const key = req => { const u = new URL(req.url); u.search = ''; return u.href; };
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return; // 지도 타일/서버는 네트워크 그대로
  e.respondWith(fetch(e.request).then(r => {   // 네트워크 우선, 오프라인이면 캐시
    if (r.ok && r.type === 'basic') { const c = r.clone(); caches.open(C).then(x => x.put(key(e.request), c)); }
    return r;
  }).catch(() => caches.match(key(e.request)).then(r => r || caches.match(e.request))));
});
