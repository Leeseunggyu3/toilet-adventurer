// 플레이 스토어용 스크린샷. 실제 지도 + 미리 받은 화장실 데이터 + 가짜 서버(예시 채팅·프로필)로 폰 화면을 찍는다.
// 실행: node tests/store_shots.mjs <출력폴더>   (사이트가 http://localhost:8765 에서, data/ 포함해서 서빙 중이어야 함)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:8765';
const OUT = process.argv[2] || 'store-shots';
mkdirSync(OUT, { recursive: true });
const ago = m => new Date(Date.now() - m * 60000).toISOString();

const LANGS = {
  ko: { locale: 'ko-KR', tz: 'Asia/Seoul', pos: { latitude: 37.5784, longitude: 126.9894 }, nick: '🐼 용감한 탐험가', places: ['창경궁 화장실', '대학로 공원 화장실', '공중화장실', '원서동 화장실'], chat: [
    ['u1', '🦊 빠른 여우', '창경궁 정문 쪽 화장실 휴지 있나요?', 'question', 25],
    ['u2', '🐢 느긋한 거북', '방금 다녀왔는데 휴지 넉넉하고 깨끗해요!', 'answer', 21, 3],
    ['u3', '🐧 펭귄 탐험가', '궁 안 화장실은 줄이 좀 길어요. 조금 더 걸으면 비어 있어요', 'chat', 12],
    ['u4', '🦉 밤샘 부엉이', '고궁 산책하다가 덕분에 살았습니다 🙏', 'chat', 4],
  ] },
  en: { locale: 'en-US', tz: 'Asia/Tokyo', pos: { latitude: 35.7141, longitude: 139.7741 }, nick: '🐼 Brave Explorer', places: ['Ueno Park Toilet', 'Museum Side Toilet', 'Public Toilet', 'Pond Toilet'], chat: [
    ['u1', '🦊 Swift Fox', 'Is there toilet paper in the one near the museum?', 'question', 25],
    ['u2', '🐢 Easygoing Turtle', 'Just checked: plenty of paper and very clean!', 'answer', 21, 3],
    ['u3', '🐧 Penguin Scout', 'Long line at the park entrance one. The one by the pond is empty', 'chat', 12],
    ['u4', '🦉 Night Owl', 'Saved my day during the cherry blossom walk 🙏', 'chat', 4],
  ] },
  ja: { locale: 'ja-JP', tz: 'Asia/Tokyo', pos: { latitude: 35.7141, longitude: 139.7741 }, nick: '🐼 勇敢な探検家', places: ['上野公園トイレ', '博物館横トイレ', '公衆トイレ', '池のほとりトイレ'], chat: [
    ['u1', '🦊 すばやいキツネ', '博物館の近くのトイレ、紙ありますか？', 'question', 25],
    ['u2', '🐢 のんびりカメ', 'さっき行きました。紙もたっぷりでキレイでした！', 'answer', 21, 3],
    ['u3', '🐧 ペンギン隊員', '公園入口のトイレは行列です。池のそばは空いてますよ', 'chat', 12],
    ['u4', '🦉 夜ふかしフクロウ', 'お花見の途中で助かりました 🙏', 'chat', 4],
  ] },
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
for (const [lang, L] of Object.entries(LANGS)) {
  const ctx = await browser.newContext({ locale: L.locale, timezoneId: L.tz, viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, serviceWorkers: 'block', geolocation: L.pos, permissions: ['geolocation'] });
  await ctx.addInitScript(([lang, nick]) => {
    if (sessionStorage.getItem('shots-init')) return; sessionStorage.setItem('shots-init', '1');
    localStorage.clear();
    localStorage.setItem('ghc-lang', lang); localStorage.setItem('ghc-tut-done', '1');
    localStorage.setItem('ghc-uid', 'me'); localStorage.setItem('ghc-nick', nick.split(' ').slice(1).join(' ') || nick); localStorage.setItem('ghc-avatar', '🐼');
    const got = Object.fromEntries(['tut', 'v1', 'd3', 'd10', 'r1', 'r10', 't10', 'f1', 's3', 'g1'].map(k => [k, Date.now()]));
    const v = Array.from({ length: 23 }, (_, i) => ['seen' + (i % 12), Date.now() - (i + 1) * 864e5]);
    localStorage.setItem('ghc-ach', JSON.stringify({ v, rep: 14, talk: 12, reg: 1, first: 2, tut: true, got, title: 'd10', relics: ['s3'], stickers: [{ s: '🌸', x: 78, y: 18, z: 1.3 }, { s: '⭐', x: 88, y: 62, z: 1 }, { s: '🧻', x: 62, y: 70, z: 1.1 }],
      shop: { owned: { bg_sunset: 1, fr_gold: 1 }, bg: 'bg_sunset', frame: 'fr_gold', color: 'co0', bonusDay: '' } }));
  }, [lang, L.nick]);
  const page = await ctx.newPage();
  await page.route('**/config.js*', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: `window.GHC_CONFIG={SUPABASE_URL:'${BASE}/sb',SUPABASE_ANON_KEY:'shots',GOOGLE_LOGIN:false};` }));
  const wallet = { coins: 1240, xp: 2650, earned: 1990, spent: 750, titles: ['tut', 'v1', 'd3', 'd10', 'r1', 'r10', 't10', 'f1', 's3', 'g1'], owned: ['bg_sunset', 'fr_gold'], bonus_today: false, missions_today: 1, ads_today: 0, stats: { reports: 14, visits: 23, distinct: 12, talks: 12, regs: 1, firsts: 2 } };
  await page.route('**/sb/**', async r => {
    const u = new URL(r.request().url()), path = u.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (path === 'rpc/wallet_state') return json(wallet);
    if (path === 'rpc/toilet_stats') return json({ visits: 37, explorers: 21, first_nick: L.chat[1][1], mine: 3 });
    if (path === 'rpc/toilet_flags') return json([]);
    if (path === 'messages') {
      const ch = (u.searchParams.get('channel') || '').replace('eq.', '');
      // 서버는 최신 글부터 보낸다
      return json(L.chat.map(([uid, nick, text, kind, m, helpful], i) => ({ id: 'm' + i, at: ago(m), helpful: helpful || 0, channel: ch, user_id: uid, nick, text, kind, parent: kind === 'answer' ? 'm0' : null })).reverse());
    }
    if (path === 'reports') {
      const ids = (u.searchParams.get('toilet_id') || '').replace(/^in\.\(|\)$/g, '').split(',').map(x => x.replace(/"/g, '')).filter(Boolean);
      return json(ids.slice(0, 8).flatMap((id, i) => [{ toilet_id: id, k: 'paper', v: 1, at: ago(8 + i * 5) }, { toilet_id: id, k: 'clean', v: i % 3 ? 1 : 0, at: ago(15 + i * 4) }, { toilet_id: id, k: 'open', v: 1, at: ago(30 + i) }]));
    }
    if (path === 'visits') return json(Array.from({ length: 23 }, (_, i) => ({ toilet_id: 'seen' + (i % 12), toilet_name: L.places[i % L.places.length], at: ago(60 * 24 * (i + 1)) })));
    if (path === 'profiles') return json([]);
    return json([]);
  });
  const shot = async name => { await page.waitForTimeout(900); await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.style.display = 'none'; }); await page.screenshot({ path: `${OUT}/${lang}-${name}.png` }); console.log('📸', lang, name); };
  const closeAll = () => page.evaluate(() => document.querySelectorAll('.sheet:not(.hidden), .modal:not(.hidden)').forEach(m => m.classList.add('hidden')));

  await page.goto(BASE + '/index.html');
  await page.waitForFunction(() => document.querySelectorAll('.leaflet-marker-icon').length >= 5, null, { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3500);  // 지도 그림이 다 받아질 때까지
  await closeAll();
  await shot('1-map');

  await page.click('#sosBtn'); await page.waitForTimeout(1500); await shot('2-detect');
  await closeAll();
  // 가장 가까운 변기를 열어 상태·레벨 카드
  const pt = await page.evaluate(() => {
    const c = { x: innerWidth / 2, y: innerHeight / 2 };
    const ms = [...document.querySelectorAll('.leaflet-marker-icon .tmark')].map(e => e.getBoundingClientRect()).filter(r => r.y > 80 && r.y < innerHeight - 160 && r.x > 10 && r.x < innerWidth - 70);
    ms.sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y));
    return ms[0] ? { x: ms[0].x + ms[0].width / 2, y: ms[0].y + ms[0].height / 2 } : null;
  });
  if (pt) await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(1500); await shot('3-toilet');
  await closeAll();
  await page.click('#areaBtn'); await page.waitForTimeout(1800); await shot('4-chat');
  await closeAll();
  await page.click('#profBtn'); await page.waitForTimeout(1500); await shot('5-profile');
  await page.evaluate(() => document.getElementById('shopBtn').click()); await page.waitForTimeout(1200); await shot('6-shop');
  await ctx.close();
}
await browser.close();
