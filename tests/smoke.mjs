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
await page.route('**/config.js*', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: `window.GHC_CONFIG={SUPABASE_URL:'${BASE}/sb',SUPABASE_ANON_KEY:'test',GOOGLE_LOGIN:true};` }));
await page.route('**/sb/auth/v1/**', r => {
  const u = r.request().url();
  if (u.includes('/user')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'auth-1', email: 'tester@example.com' }) });
  r.fulfill({ status: 204, body: '' });
});
await page.route('**/sb/rest/v1/**', r => {
  const q = r.request(), u = new URL(q.url()), table = u.pathname.split('/rest/v1/')[1];
  if (q.method() === 'POST') {
    if (table.startsWith('accounts')) { const b = JSON.parse(q.postData()); db.account = { state: b.state, updated_at: b.updated_at }; return r.fulfill({ status: 201, body: '' }); }
    if (table === 'rpc/save_profile') { const b = JSON.parse(q.postData()); (db.profiles || (db.profiles = {}))[b.p_user] = { data: b.p_data, secret: b.p_secret }; return r.fulfill({ status: 204, body: '' }); }
    if (table.startsWith('rpc/')) return r.fulfill({ status: 204, body: '' });
    const row = Object.assign({ id: 'id' + Math.random().toString(36).slice(2), at: new Date().toISOString(), helpful: 0 }, JSON.parse(q.postData() || '{}'));
    (db[table] || (db[table] = [])).push(row);
    return r.fulfill({ status: 201, body: '' });
  }
  if (table === 'accounts') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(db.account ? [db.account] : []) });
  if (table === 'profiles') { const id = (u.searchParams.get('user_id') || '').replace('eq.', ''); const p = (db.profiles || {})[id]; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(p ? [{ user_id: id, data: p.data }] : []) }); }
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
  check('버튼 이름이 "변기탐지"', (await page.innerText('#sosBtn')).includes('변기탐지'));

  await page.waitForTimeout(2500); // 서버 동기화 대기
  await page.click('#sosBtn'); await page.waitForTimeout(400);
  const first = await page.innerText('#sosName');
  check('변기탐지: 가장 가까운 변기를 안내', first === '공원 화장실', first);
  const seen = new Set([first]); for (let i = 0; i < 3; i++) { await page.click('#sosNext'); seen.add(await page.innerText('#sosName')); }
  check('변기탐지: 2명 이상 신고된 변기는 후보에서 제외', !seen.has('신고된 화장실'), [...seen].join(', '));
  check('변기탐지: 길찾기 링크 3종 생성', (await page.getAttribute('#sosKakao', 'href') || '').includes('map.kakao.com') && (await page.getAttribute('#sosGoogle', 'href') || '').includes('google.com/maps'));
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
  check('수첩: 5번 이상 활동하면 계통이 발현됨', (await page.innerText('#meStyle')).includes('계통') && !(await page.innerText('#meStyle')).includes('미발현'), await page.innerText('#meStyle'));
  check('경지 이름 표시', ['잠든 물방울', '첫 물결', '고요한 수면', '소용돌이'].includes(await page.innerText('#rankLabel')), await page.innerText('#rankLabel'));
  check('탐험가 수첩: 도감에 방문한 변기 표시', (await page.innerText('#dex')).includes('공원 화장실'));
  await page.fill('#nickInput', '점검탐험가'); await page.click('#nickSave'); await page.click('#avatars button[data-a="🦖"]'); await page.waitForTimeout(200);
  check('수첩: 닉네임 변경과 아이콘 선택 반영', (await page.innerText('#meName')) === '점검탐험가' && (await page.innerText('#meAvatar')) === '🦖');
  await page.click('#profClose');
  await page.click('#areaBtn'); await page.fill('#areaMsg', '아이콘 확인'); await page.press('#areaMsg', 'Enter'); await page.waitForTimeout(600);
  check('채팅에 새 아이콘과 닉네임으로 표시', db.messages.at(-1).nick === '🦖 점검탐험가', db.messages.at(-1).nick);
  await page.click('#areaClose');

  await page.click('#helpBtn'); await page.click('.htab[data-htab=guide]');
  check('도움말: 사용법 탭 표시', await page.isVisible('#htab-guide'));
  await page.click('.htab[data-htab=fb]'); await page.fill('#fbText', '자동 점검 의견'); await page.click('#fbSend'); await page.waitForTimeout(500);
  check('의견 보내기가 서버로 전송됨', db.feedback.length === 1 && db.feedback[0].text === '자동 점검 의견');

  // ---- 칭호 · 스티커 · 프로필 조회 ----
  await page.click('#helpClose'); await page.click('#profBtn'); await page.waitForTimeout(500);
  const gotN = await page.locator('#titles .ttl.got').count();
  check('칭호: 튜토리얼·첫 인증·첫 보고·등록·1호 탐험 칭호 획득', gotN >= 5, gotN + '개');
  await page.click('#titles .ttl.got[data-t="f1"]'); await page.waitForTimeout(200);
  check('칭호: 누르면 대표 칭호로 장착되어 카드에 표시', (await page.innerText('#myBoard')).includes('개척자'));
  await page.click('#decoBtn'); await page.click('#tray button >> nth=0'); await page.waitForTimeout(200);
  const sb = await page.locator('#myBoard .stk').first().boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2); await page.mouse.down(); await page.mouse.move(sb.x + 110, sb.y - 30, { steps: 6 }); await page.mouse.up();
  await page.click('#decoBig'); await page.click('#decoBig');
  await page.click('#tray button >> nth=1'); await page.click('#decoDel'); // 두 번째 스티커는 붙였다가 삭제
  await page.click('#decoOk'); await page.waitForTimeout(2200);
  const mineP = Object.values(db.profiles || {})[0];
  check('스티커: 붙이고 끌어서 확인하면 그 자리에 저장', !!mineP && mineP.data.stickers.length === 1 && mineP.data.stickers[0].x > 55, mineP ? JSON.stringify(mineP.data.stickers) : '프로필 없음');
  check('스티커: 확대가 저장되고, 삭제한 스티커는 남지 않음', !!mineP && mineP.data.stickers.length === 1 && mineP.data.stickers[0].z > 1.3, mineP ? JSON.stringify(mineP.data.stickers) : '');
  check('프로필이 서버에 대표 칭호와 함께 저장', !!mineP && mineP.data.title === 'f1' && mineP.data.titles.length >= 5);
  await page.click('#profClose');
  db.profiles.other1 = { data: { nick: '다른탐험가', avatar: '🦊', title: 'd10', titles: ['tut', 'd10'], rank: '소용돌이', power: 1200, style: '👣 발자국', stickers: [{ s: '🗝️', x: 80, y: 20 }], found: 12 } };
  db.messages.push({ id: 'mx', channel: db.messages.at(-1).channel, user_id: 'other1', nick: '🦊 다른탐험가', text: '안녕하세요', kind: 'chat', helpful: 0, at: new Date().toISOString() });
  await page.click('#areaBtn'); await page.waitForTimeout(600);
  await page.click('#areaChat .nicklink[data-uid="other1"]'); await page.waitForTimeout(600);
  const peek = await page.innerText('#peekBoard');
  check('프로필 조회: 닉네임을 누르면 상대의 칭호와 경지가 보임', peek.includes('열 개의 문을 연 자') && peek.includes('다른탐험가') && peek.includes('소용돌이'), peek.replace(/\n/g, ' '));
  check('프로필 조회: 상대의 스티커와 획득 칭호 목록 표시', (await page.locator('#peekBoard .stk').count()) === 1 && (await page.locator('#peekTitles .ttl').count()) === 2);
  await page.click('#peekClose');

  // ---- 게스트 → 구글 로그인 → 다른 기록 불러오기 ----
  await page.click('#profBtn'); await page.waitForTimeout(300);
  check('계정: 처음엔 게스트로 표시되고 구글 로그인 버튼이 있음', (await page.innerText('#acct')).includes('게스트') && await page.isVisible('#acctIn'));
  const uidBefore = await page.evaluate(() => localStorage.getItem('ghc-uid'));
  await page.goto(BASE + '/index.html?login=1#access_token=TESTTOKEN&refresh_token=R1&expires_in=3600&token_type=bearer'); await page.waitForTimeout(2500);
  check('계정: 로그인하면 게스트 기록이 계정에 저장됨', !!db.account && db.account.state['ghc-uid'] === uidBefore && !!db.account.state['ghc-ach']);
  check('계정: 주소에서 토큰이 지워짐', !(await page.evaluate(() => location.hash)).includes('access_token'));
  await page.click('#profBtn'); await page.waitForTimeout(400);
  check('계정: 수첩에 로그인한 이메일 표시', (await page.innerText('#acct')).includes('tester@example.com'));
  // 다른 기기에서 만든 기록이 계정에 있는 상황
  db.account = { updated_at: new Date().toISOString(), state: { 'ghc-uid': 'xotherdevice1', 'ghc-secret': 's'.repeat(48), 'ghc-nick': '옛폰탐험가', 'ghc-avatar': '🐙', 'ghc-v0': JSON.stringify({ coins: 777, xp: 1500, reports: {}, toilets: {}, verified: {}, daily: { day: '', done: 0 } }), 'ghc-tut-done': '1' } };
  await page.goto(BASE + '/index.html?login=2#access_token=TESTTOKEN&refresh_token=R1&expires_in=3600&token_type=bearer'); await page.waitForTimeout(2500);
  check('계정: 기록이 다르면 어느 쪽을 쓸지 묻는 창이 뜸', await page.isVisible('#acctDlg') && (await page.innerText('#pickCloud')).includes('옛폰탐험가'));
  await page.click('#useCloud'); await page.waitForTimeout(2500);
  check('계정: 계정 기록을 불러오면 닉네임·코인·경지가 복원됨', (await page.evaluate(() => localStorage.getItem('ghc-uid'))) === 'xotherdevice1' && (await page.innerText('#coins')) === '777' && (await page.innerText('#rankLabel')) === '소용돌이', await page.innerText('#rankLabel'));

  check('전체 흐름 중 자바스크립트 오류 없음', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  check('점검 스크립트가 끝까지 실행됨', false, String(e).slice(0, 300));
}
await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
