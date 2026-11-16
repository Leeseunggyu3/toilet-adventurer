// 배포 전 자동 점검. 가짜 GPS·가짜 지도 데이터·가짜 서버로 핵심 흐름을 실제 브라우저에서 눌러본다.
// 실행: node tests/smoke.mjs  (사이트가 http://localhost:8765 에서 서빙 중이어야 함)
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8765';
const osm = { elements: [
  { type: 'node', id: 1, lat: 37.5668, lon: 126.9782, tags: { amenity: 'toilets', name: '공원 화장실' } },
  { type: 'node', id: 2, lat: 37.5672, lon: 126.9786, tags: { amenity: 'toilets', name: '신고된 화장실' } },
  { type: 'node', id: 3, lat: 37.5700, lon: 126.9820, tags: { amenity: 'toilets', name: '먼 화장실' } },
] };
const db = { messages: [], visits: [], reports: [], toilets: [], feedback: [] };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 800 }, geolocation: { latitude: 37.5665, longitude: 126.978 }, permissions: ['geolocation'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.route('**/overpass-api.de/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(osm) }));
await page.route('**/tile.openstreetmap.org/**', r => r.abort());
// 서버를 같은 주소의 가짜로 바꿔치기
await page.route('**/config.js*', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: `window.GHC_CONFIG={SUPABASE_URL:'${BASE}/sb',SUPABASE_ANON_KEY:'test'};` }));
await page.route('**/sb/rest/v1/**', r => {
  const q = r.request(), u = new URL(q.url()), table = u.pathname.split('/rest/v1/')[1];
  if (q.method() === 'POST') {
    if (table.startsWith('rpc/')) return r.fulfill({ status: 204, body: '' });
    const row = Object.assign({ id: 'id' + Math.random().toString(36).slice(2), at: new Date().toISOString(), helpful: 0 }, JSON.parse(q.postData() || '{}'));
    (db[table] || (db[table] = [])).push(row);
    return r.fulfill({ status: 201, body: '' });
  }
  let rows = db[table] || [];
  const ch = u.searchParams.get('channel'); if (ch) rows = rows.filter(x => 'eq.' + x.channel === ch);
  const tid = u.searchParams.get('toilet_id'); if (tid) rows = rows.filter(x => 'eq.' + x.toilet_id === tid);
  const k = u.searchParams.get('k'); if (k === 'eq.flagged') rows = rows.filter(x => x.k === 'flagged'); else if (k === 'neq.flagged') rows = rows.filter(x => x.k !== 'flagged');
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
});
// 다른 탐험가 2명이 2번 변기를 "없음" 신고한 상태로 시작
db.reports.push({ toilet_id: 'osm2', k: 'flagged', v: 1, user_id: 'a', at: new Date().toISOString() }, { toilet_id: 'osm2', k: 'flagged', v: 1, user_id: 'b', at: new Date().toISOString() });

try {
  await page.goto(BASE + '/index.html'); await page.waitForTimeout(2500);
  check('페이지가 오류 없이 열림', errors.length === 0, errors[0]);
  check('첫 방문에 튜토리얼이 자동으로 뜸', await page.isVisible('#help'));
  for (let i = 0; i < 6; i++) await page.click('#tutNext');
  check('튜토리얼을 끝까지 넘기면 닫힘', !(await page.isVisible('#help')));
  check('지도에 변기 핀 3개 표시', (await page.locator('.tmark').count()) === 3);
  check('버튼 이름이 "구조 신청"', (await page.innerText('#sosBtn')).includes('구조 신청'));

  await page.waitForTimeout(2500); // 서버 동기화 대기
  await page.click('#sosBtn'); await page.waitForTimeout(400);
  const first = await page.innerText('#sosName');
  check('구조 신청: 가장 가까운 변기를 안내', first === '공원 화장실', first);
  const seen = new Set([first]); for (let i = 0; i < 3; i++) { await page.click('#sosNext'); seen.add(await page.innerText('#sosName')); }
  check('구조 신청: 2명 이상 신고된 변기는 후보에서 제외', !seen.has('신고된 화장실'), [...seen].join(', '));
  check('구조 신청: 길찾기 링크 3종 생성', (await page.getAttribute('#sosKakao', 'href') || '').includes('map.kakao.com') && (await page.getAttribute('#sosGoogle', 'href') || '').includes('google.com/maps'));
  await page.click('#sosClose');

  await page.evaluate(() => document.querySelectorAll('.tmark')[0].click()); await page.waitForTimeout(500);
  check('핀을 누르면 변기 시트가 열림', await page.isVisible('#sheet'));
  const coins0 = +(await page.innerText('#coins')).replace(/,/g, '');
  await page.click('.reports button[data-k=paper][data-v="1"]'); await page.waitForTimeout(500);
  check('상태 보고가 서버로 전송됨', db.reports.some(x => x.k === 'paper' && x.v === 1));
  check('상태 보고하면 코인이 오름', +(await page.innerText('#coins')).replace(/,/g, '') > coins0);
  check('보고한 상태가 시트에 표시됨', (await page.innerText('#shStatus')).includes('휴지 있음'));

  await page.click('#verifyBtn'); await page.waitForTimeout(800);
  check('도착 인증이 서버에 방문으로 기록됨', db.visits.length === 1);
  check('변기 레벨 카드에 방문 1회 반영', (await page.innerText('#tlVisits')).includes('1'));

  await page.click('.tab[data-tab=talk]'); await page.fill('#toiletMsg', '자동 점검 메시지'); await page.press('#toiletMsg', 'Enter'); await page.waitForTimeout(600);
  check('변기 이야기: 메시지 전송 후 말풍선 표시', (await page.locator('#toiletChat .msg').count()) === 1 && db.messages.length === 1);
  await page.click('#shClose');

  await page.click('#areaBtn'); await page.waitForTimeout(300); await page.click('#area .chips button >> nth=0'); await page.waitForTimeout(600);
  check('동네 광장: 질문 칩 전송', (await page.locator('#areaChat .msg.question').count()) === 1);
  await page.click('#areaClose');

  await page.click('#addBtn'); await page.fill('#addName', '점검용 등록'); await page.click('#addOk'); await page.waitForTimeout(500);
  check('화장실 등록이 서버로 전송됨', db.toilets.length === 1 && db.toilets[0].name === '점검용 등록');

  await page.click('#profBtn'); await page.waitForTimeout(600);
  check('탐험가 수첩: 도감에 방문한 변기 표시', (await page.innerText('#dex')).includes('공원 화장실'));
  await page.click('#profClose');

  await page.click('#helpBtn'); await page.click('.htab[data-htab=guide]');
  check('도움말: 사용법 탭 표시', await page.isVisible('#htab-guide'));
  await page.click('.htab[data-htab=fb]'); await page.fill('#fbText', '자동 점검 의견'); await page.click('#fbSend'); await page.waitForTimeout(500);
  check('의견 보내기가 서버로 전송됨', db.feedback.length === 1 && db.feedback[0].text === '자동 점검 의견');

  check('전체 흐름 중 자바스크립트 오류 없음', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  check('점검 스크립트가 끝까지 실행됨', false, String(e).slice(0, 300));
}
await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
