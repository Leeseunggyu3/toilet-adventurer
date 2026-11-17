// 안드로이드 앱 안에서만 달라지는 동작 점검. 진짜 앱 대신 가짜 Capacitor를 심어서 확인한다.
// 실행: node tests/native.test.mjs  (사이트가 http://localhost:8765 에서 서빙 중이어야 함)
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8765';
const WEB = 'https://web.example.test/ta/';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'ko-KR', viewport: { width: 390, height: 800 }, geolocation: { latitude: 37.5665, longitude: 126.978 }, permissions: ['geolocation'] });
await ctx.addInitScript(() => {
  const calls = JSON.parse(localStorage.getItem('cap-calls') || '[]');
  const log = c => { calls.push(c); localStorage.setItem('cap-calls', JSON.stringify(calls)); };
  window.__cap = { listeners: {} };
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      App: {
        addListener(ev, fn) { (window.__cap.listeners[ev] || (window.__cap.listeners[ev] = [])).push(fn); return Promise.resolve({ remove() {} }); },
        getLaunchUrl: () => Promise.resolve(null),
        exitApp() { log('exit'); },
      },
      Browser: { open(o) { log('open:' + o.url); return Promise.resolve(); }, close() { log('close'); return Promise.resolve(); } },
    },
  };
});
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e)));
const dataHits = [];
await page.route('**/tile.openstreetmap.org/**', r => r.abort());
await page.route('**/overpass-api.de/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"elements":[]}' }));
await page.route('**/config.js*', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: `window.GHC_CONFIG={SUPABASE_URL:'${BASE}/sb',SUPABASE_ANON_KEY:'test',GOOGLE_LOGIN:true,WEB_URL:'${WEB}'};` }));
await page.route('**/sb/auth/v1/user', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"email":"app@test"}' }));
await page.route('**/sb/**', r => r.fulfill({ status: r.request().method() === 'GET' ? 200 : 404, contentType: 'application/json', body: '[]' }));
await page.route(WEB + 'data/**', r => {
  dataHits.push(r.request().url());
  if (r.request().url().includes('index.json')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ v: 1, at: '2026-11-17T00:00:00Z', region: { s: 37, w: 126, n: 38, e: 127.5 }, tile: 0.5, total: 1, missing: [], tiles: { '75_253': 1 } }) });
  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ v: 1, t: [['osm7001', 37.5667, 126.9779, '앱 데이터 화장실', 0, '']] }) });
});

try {
  await page.goto(BASE + '/index.html'); await page.waitForTimeout(2500);
  check('앱: 화장실 데이터를 웹 주소에서 받아옴', dataHits.some(u => u.startsWith(WEB + 'data/index.json')) && dataHits.some(u => u.includes('/data/t/75_253.json')), dataHits.join(' ').slice(0, 160));
  check('앱: 받아온 화장실이 지도에 표시', (await page.locator('.leaflet-marker-icon').count()) >= 1);
  check('앱: 서비스워커를 쓰지 않음', (await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(r => r.length))) === 0);

  // 구글 로그인: 바깥 브라우저로 열고, 앱 주소로 돌아오게
  await page.evaluate(() => window.Auth.signIn()); await page.waitForTimeout(300);
  const calls = await page.evaluate(() => JSON.parse(localStorage.getItem('cap-calls') || '[]'));
  const open = calls.find(c => c.startsWith('open:')) || '';
  check('앱: 구글 로그인은 바깥 브라우저로 열림', open.includes('/auth/v1/authorize?provider=google'), open.slice(0, 120));
  check('앱: 로그인 뒤 돌아올 주소가 앱 주소', open.includes('redirect_to=' + encodeURIComponent('com.toiletadventure.app://auth')));
  check('앱: 웹처럼 페이지를 이동하지 않음', page.url().startsWith(BASE));

  // 브라우저에서 돌아옴 → 토큰 저장, 브라우저 닫기, 다시 시작 후 로그인 상태
  await Promise.all([
    page.waitForEvent('load'),
    page.evaluate(() => window.__cap.listeners.appUrlOpen.forEach(f => f({ url: 'com.toiletadventure.app://auth#access_token=AAA&refresh_token=BBB&expires_in=3600&token_type=bearer' }))),
  ]);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({ signed: window.Auth.signedIn, auth: JSON.parse(localStorage.getItem('ghc-auth') || 'null'), calls: JSON.parse(localStorage.getItem('cap-calls') || '[]') }));
  check('앱: 돌아온 주소의 토큰을 저장하고 로그인 상태가 됨', after.signed && after.auth && after.auth.access_token === 'AAA' && after.auth.refresh_token === 'BBB');
  check('앱: 로그인 뒤 바깥 브라우저를 닫음', after.calls.includes('close'));
  await page.evaluate(() => window.__cap.listeners.appUrlOpen.forEach(f => f({ url: 'https://evil.example/#access_token=ZZZ' }))); await page.waitForTimeout(300);
  check('앱: 다른 주소로 들어온 토큰은 무시', (await page.evaluate(() => JSON.parse(localStorage.getItem('ghc-auth')).access_token)) === 'AAA');

  // 뒤로 가기: 열린 창 닫기 → 없으면 앱 나가기
  await page.waitForTimeout(1500);
  const cover = await page.evaluate(() => { const b = document.getElementById('helpBtn').getBoundingClientRect(); const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return el && (el.id || el.className); });
  if (cover !== 'helpBtn') console.log('  (도움말 버튼 위에 있던 것:', cover, ')');
  await page.evaluate(() => document.querySelectorAll('.modal:not(.hidden), .banner:not(.hidden)').forEach(m => m.classList.add('hidden')));
  await page.evaluate(() => document.getElementById('helpBtn').click()); await page.waitForTimeout(300);
  const back = () => page.evaluate(() => window.__cap.listeners.backButton.forEach(f => f()));
  await back(); await page.waitForTimeout(200);
  check('앱: 뒤로 가기는 열린 창을 닫음', await page.isHidden('#help'));
  await back(); await page.waitForTimeout(200);
  check('앱: 열린 창이 없으면 뒤로 가기로 앱을 나감', (await page.evaluate(() => JSON.parse(localStorage.getItem('cap-calls') || '[]'))).includes('exit'));
  check('앱 흐름 중 자바스크립트 오류 없음', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  check('앱 점검 스크립트가 끝까지 실행됨', false, String(e).slice(0, 300));
}
await browser.close();
const bad = results.filter(r => !r.ok).length;
console.log(`\n${results.length - bad}/${results.length} 통과`);
process.exit(bad ? 1 : 0);
