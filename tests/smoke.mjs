// 배포 전 자동 점검. 가짜 GPS·가짜 지도 데이터·가짜 서버로 핵심 흐름을 실제 브라우저에서 눌러본다.
// 실행: node tests/smoke.mjs  (사이트가 http://localhost:8765 에서 서빙 중이어야 함)
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8765';
const osm = { elements: [
  { type: 'node', id: 1, lat: 37.5668, lon: 126.9782, tags: { amenity: 'toilets', name: '공원 화장실' } },
  { type: 'node', id: 2, lat: 37.5672, lon: 126.9786, tags: { amenity: 'toilets', name: '신고된 화장실' } },
  { type: 'node', id: 3, lat: 37.5700, lon: 126.9820, tags: { amenity: 'toilets', name: '먼 화장실' } },
] };
const db = { messages: [], visits: [], reports: [], toilets: [], feedback: [], wallet: null, walletCalls: [], signed: false, signedCalls: [], directWrites: 0, rejectVisit: false, v8: false, flagsV8: [], photos: [], photoReports: [], overpassCalls: 0 };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
// 시간대에 따라 결과가 달라지는 칭호(심야 인증)가 있으므로, 지금 낮(9~17시)인 시간대를 골라 브라우저를 그 시간대로 띄운다
const DAY_TZ = ['Asia/Seoul', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland', 'Europe/Moscow', 'America/Sao_Paulo']
  .find(tz => { const h = +new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()); return h >= 9 && h <= 17; }) || 'Asia/Seoul';
console.log('시험용 시간대:', DAY_TZ);
const ctx = await browser.newContext({ timezoneId: DAY_TZ, locale: 'ko-KR', serviceWorkers: 'block', viewport: { width: 390, height: 800 }, geolocation: { latitude: 37.5665, longitude: 126.978 }, permissions: ['geolocation'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.route('**/overpass-api.de/**', r => (db.overpassCalls++, r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(osm) })));
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
    // 본인 확인 쓰기(v7) 대역: db.signed가 꺼져 있으면 "v7을 아직 실행하지 않은 서버"처럼 404
    if (['rpc/post_message', 'rpc/post_report', 'rpc/post_visit', 'rpc/post_toilet'].includes(table)) {
      if (!db.signed) return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function' }) });
      const b = JSON.parse(q.postData() || '{}'); db.signedCalls.push({ table, b });
      if (!(b.p_secret && b.p_secret.length >= 16)) return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'bad request' }) });
      if (table === 'rpc/post_visit' && b.p_toilet === 'osm3' && db.rejectVisit) return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: '직전 인증 지점에서 너무 빨리 이동했어요. 잠시 후 다시 인증해 주세요.' }) });
      const now = new Date().toISOString(), id = 'id' + Math.random().toString(36).slice(2);
      if (table === 'rpc/post_message') db.messages.push({ id, at: now, helpful: 0, channel: b.p_channel, toilet_id: b.p_toilet, user_id: b.p_user, nick: b.p_nick, text: b.p_text, kind: b.p_kind, parent: b.p_parent });
      if (table === 'rpc/post_report') { db.reports.push({ id, at: now, toilet_id: b.p_toilet, k: b.p_k, v: b.p_v, user_id: b.p_user }); if (db.wallet) { db.wallet.earned += 5; db.wallet.coins += 5; db.wallet.xp += 5; } }
      if (table === 'rpc/post_visit') db.visits.push({ id, at: now, toilet_id: b.p_toilet, toilet_name: b.p_name, user_id: b.p_user, nick: b.p_nick, lat: b.p_lat, lng: b.p_lng });
      if (table === 'rpc/post_toilet') db.toilets.push({ id: b.p_id, at: now, lat: b.p_lat, lng: b.p_lng, name: b.p_name, user_id: b.p_user, nick: b.p_nick });
      return r.fulfill({ status: 204, body: '' });
    }
    if (db.signed && ['messages', 'reports', 'visits', 'toilets'].includes(table)) { db.directWrites++; return r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'permission denied' }) }); }
    // 없음 신고 집계·사진(v8) 대역
    if (table === 'rpc/toilet_flags') { if (!db.v8) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"PGRST202"}' }); const ids = (JSON.parse(q.postData() || '{}').p_ids) || null; db.flagIds = ids; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(db.flagsV8.filter(f => !ids || ids.includes(f.toilet_id))) }); }
    if (table === 'rpc/delete_my_data') {
      const b = JSON.parse(q.postData()); db.deleted = (db.deleted || []).concat(b.p_user);
      for (const k of ['messages', 'visits', 'reports', 'toilets', 'photos']) db[k] = db[k].filter(x => x.user_id !== b.p_user);
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"messages":0}' });
    }
    if (table === 'rpc/toilet_stats') {
      if (!db.v8) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"PGRST202"}' });
      const b = JSON.parse(q.postData()), v = db.visits.filter(x => x.toilet_id === b.p_toilet); db.statsRpc = (db.statsRpc || 0) + 1;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ visits: v.length, explorers: new Set(v.map(x => x.user_id)).size, first_nick: v[0] ? v[0].nick : null, mine: v.filter(x => x.user_id === b.p_user).length }) });
    }
    if (table === 'rpc/post_photo') { const b = JSON.parse(q.postData()); if (!b.p_data.startsWith('data:image/jpeg;base64,') || b.p_data.length > 200000) return r.fulfill({ status: 400, contentType: 'application/json', body: '{"message":"사진 형식"}' }); db.photos.push({ id: db.photos.length + 1, toilet_id: b.p_toilet, kind: b.p_kind, data: b.p_data, thumb: b.p_thumb, user_id: b.p_user, nick: b.p_nick, at: new Date().toISOString() }); if (b.p_kind === 'exists') db.flagsV8 = db.flagsV8.filter(f => f.toilet_id !== b.p_toilet); return r.fulfill({ status: 200, contentType: 'application/json', body: String(db.photos.length) }); }
    if (table === 'rpc/report_photo') { db.photoReports.push(JSON.parse(q.postData()).p_photo); return r.fulfill({ status: 200, contentType: 'application/json', body: 'false' }); }
    // 서버 지갑 대역: db.wallet이 없으면 "v6 스키마를 아직 실행하지 않은 서버"처럼 404를 돌려준다
    if (['rpc/wallet_state', 'rpc/claim_bonus', 'rpc/claim_mission', 'rpc/claim_tut', 'rpc/buy_item'].includes(table)) {
      const w = db.wallet, b = JSON.parse(q.postData() || '{}'), json = (code, o) => r.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(o) });
      if (!w) return json(404, { code: 'PGRST202', message: 'Could not find the function' });
      db.walletCalls.push(table);
      if (table !== 'rpc/wallet_state' && !(b.p_secret && b.p_secret.length >= 16)) return json(400, { message: 'bad request' });
      if (table === 'rpc/claim_bonus' && !w.bonus_today) { w.bonus_today = true; w.earned += 50; w.coins += 50; }
      if (table === 'rpc/claim_tut' && !w.titles.includes('tut')) w.titles.push('tut');
      if (table === 'rpc/claim_mission') { w.earned += 40; w.coins += 40; w.xp += 40; w.missions_today++; }
      if (table === 'rpc/buy_item') { const price = { bg_night: 150, bg_gold: 1500, pk_sea: 250 }[b.p_item]; if (price === undefined) return json(400, { message: '없는 상품이에요' }); if (!w.owned.includes(b.p_item)) { if (w.coins < price) return json(400, { message: '코인이 부족해요' }); w.coins -= price; w.spent += price; w.owned.push(b.p_item); } }
      return json(200, w);
    }
    if (table.startsWith('rpc/')) return r.fulfill({ status: 204, body: '' });
    if (db.wallet && table === 'reports') { db.wallet.earned += 5; db.wallet.coins += 5; db.wallet.xp += 5; }  // 서버가 보고 보상을 계산한 것처럼
    const row = Object.assign({ id: 'id' + Math.random().toString(36).slice(2), at: new Date().toISOString(), helpful: 0 }, JSON.parse(q.postData() || '{}'));
    (db[table] || (db[table] = [])).push(row);
    return r.fulfill({ status: 201, body: '' });
  }
  if (table === 'photos') {
    if (!db.v8) return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    const pid = u.searchParams.get('id'), sel = (u.searchParams.get('select') || '').split(',');
    const pick = p => Object.fromEntries(sel.map(k => [k, p[k]]));
    if (pid) { db.fullFetches = (db.fullFetches || 0) + 1; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(db.photos.filter(p => 'eq.' + p.id === pid).map(pick)) }); }
    const id = (u.searchParams.get('toilet_id') || '').replace('eq.', '');
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(db.photos.filter(p => p.toilet_id === id).reverse().map(pick)) });
  }
  if (table === 'accounts') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(db.account ? [db.account] : []) });
  if (table === 'profiles') { const id = (u.searchParams.get('user_id') || '').replace('eq.', ''); const p = (db.profiles || {})[id]; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(p ? [{ user_id: id, data: p.data }] : []) }); }
  let rows = db[table] || [];
  const ch = u.searchParams.get('channel'); if (ch) rows = rows.filter(x => 'eq.' + x.channel === ch);
  const tid = u.searchParams.get('toilet_id');
  if (tid && tid.startsWith('in.')) { const ids = tid.slice(4, -1).split(',').map(x => x.replace(/^"|"$/g, '')); db.inQueries = (db.inQueries || 0) + 1; rows = rows.filter(x => ids.includes(x.toilet_id)); }
  else if (tid) rows = rows.filter(x => 'eq.' + x.toilet_id === tid);
  const atq = (u.searchParams.getAll('at') || []).find(x => x.startsWith('gte.') && table === 'messages');
  if (atq) { db.sinceQueries = (db.sinceQueries || 0) + 1; const t0 = new Date(atq.slice(4)).getTime(); rows = rows.filter(x => new Date(x.at).getTime() >= t0); }
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
  const c1 = +(await page.innerText('#coins')).replace(/,/g, '');
  await page.click('.reports button[data-k=paper][data-v="0"]'); await page.waitForTimeout(400);
  check('같은 항목을 바로 다시 보고하면 코인이 늘지 않음', +(await page.innerText('#coins')).replace(/,/g, '') === c1);
  await page.click('.reports button[data-k=paper][data-v="1"]'); await page.waitForTimeout(300);
  check('보고한 상태가 시트에 표시됨', (await page.innerText('#shStatus')).includes('휴지 있음'));

  await page.click('#verifyBtn'); await page.waitForTimeout(800);
  check('도착 인증이 서버에 방문으로 기록됨', db.visits.length === 1);
  check('변기 레벨 카드에 방문 1회 반영', (await page.innerText('#tlVisits')).includes('1'));

  await page.click('.tab[data-tab=talk]'); await page.fill('#toiletMsg', '자동 점검 메시지'); await page.press('#toiletMsg', 'Enter'); await page.waitForTimeout(600);
  check('변기 이야기: 메시지 전송 후 말풍선 표시', (await page.locator('#toiletChat .msg').count()) === 1 && db.messages.length === 1);
  await page.click('#shClose');

  await page.click('#areaBtn'); await page.waitForTimeout(300); await page.click('#area .chips button >> nth=0'); await page.waitForTimeout(600);
  check('동네 광장: 질문 칩 전송', (await page.locator('#areaChat .msg.question').count()) === 1);
  { const ch = db.messages[db.messages.length - 1].channel, sq = db.sinceQueries || 0;
    db.messages.push({ id: 'live1', at: new Date(Date.now() + 1000).toISOString(), helpful: 0, channel: ch, user_id: 'other9', nick: '🦆 지나가던 탐험가', text: '새로 올라온 글', kind: 'chat' });
    await page.waitForTimeout(6800);
    check('동네 광장: 열어두면 새 글만 받아서 이어 붙임', (db.sinceQueries || 0) > sq && (await page.innerText('#areaChat')).includes('새로 올라온 글'));
    db.messages = db.messages.filter(m => m.id !== 'live1'); }
  await page.click('#areaClose');

  await page.click('#addBtn'); await page.fill('#addName', '점검용 등록'); await page.click('#addOk'); await page.waitForTimeout(500);
  check('화장실 등록이 서버로 전송됨', db.toilets.length === 1 && db.toilets[0].name === '점검용 등록');

  await page.click('#profBtn'); await page.waitForTimeout(600);
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
  db.profiles.other1 = { data: { nick: '다른탐험가', avatar: '🦊', title: 'd10', titles: ['tut', 'd10'], rank: '소용돌이', power: 1200, relics: ['d10'], stickers: [{ s: '🗝️', x: 80, y: 20 }], found: 12 } };
  db.messages.push({ id: 'mx', channel: db.messages.at(-1).channel, user_id: 'other1', nick: '🦊 다른탐험가', text: '안녕하세요', kind: 'chat', helpful: 0, at: new Date().toISOString() });
  await page.click('#areaBtn'); await page.waitForTimeout(600);
  await page.click('#areaChat .nicklink[data-uid="other1"]'); await page.waitForTimeout(600);
  const peek = await page.innerText('#peekBoard');
  check('프로필 조회: 닉네임을 누르면 상대의 칭호와 경지가 보임', peek.includes('열 개의 문을 연 자') && peek.includes('다른탐험가') && peek.includes('소용돌이'), peek.replace(/\n/g, ' '));
  check('프로필 조회: 상대가 장착한 유물 표시', (await page.innerText('#peekRelics')).includes('열쇠 꾸러미'));
  check('프로필 조회: 상대의 스티커와 획득 칭호 목록 표시', (await page.locator('#peekBoard .stk').count()) === 1 && (await page.locator('#peekTitles .ttl').count()) === 2);
  await page.click('#peekClose');

  // ---- 도움됐어요: 답변자가 실제로 보상을 받는다 ----
  { const myUid = await page.evaluate(() => localStorage.getItem('ghc-uid')); const ch = db.messages.at(-1).channel;
    db.messages.push({ id: 'q9', channel: ch, user_id: 'other2', nick: '🐸 질문자', text: '휴지 있나요?', kind: 'question', helpful: 0, at: new Date().toISOString() });
    db.messages.push({ id: 'a9', channel: ch, user_id: myUid, nick: 'me', text: '있어요', kind: 'answer', parent: 'q9', helpful: 1, at: new Date().toISOString() });
    const cb = +(await page.innerText('#coins')).replace(/,/g, '');
    await page.click('#areaBtn'); await page.waitForTimeout(700);
    check('도움됐어요를 받은 내 답변에 +15 보상', +(await page.innerText('#coins')).replace(/,/g, '') === cb + 15, (await page.innerText('#coins')));
    await page.click('#areaClose'); await page.click('#areaBtn'); await page.waitForTimeout(700);
    check('같은 답변으로 두 번 받지 않음', +(await page.innerText('#coins')).replace(/,/g, '') === cb + 15);
    await page.click('#areaClose'); }

  // ---- 유물: 어려운 칭호에만, 여러 개 장착, 작은 효과 ----
  await page.click('#profBtn'); await page.waitForTimeout(300);
  check('유물: 쉬운 칭호만으로는 유물이 없음(전부 잠김)', (await page.locator('#relics .ttl.got').count()) === 0 && (await page.locator('#relics .ttl.locked').count()) === 7);
  await page.evaluate(() => { const a = JSON.parse(localStorage.getItem('ghc-ach')); for (let i = 0; i < 30; i++) a.v.push(['fake' + i, Date.now() - i * 9e6]); a.rep = 50; localStorage.setItem('ghc-ach', JSON.stringify(a)); });
  await page.reload(); await page.waitForTimeout(1500); await page.click('#profBtn'); await page.waitForTimeout(500);
  const ownR = await page.locator('#relics .ttl.got').count();
  check('유물: 변기 10곳·30곳, 보고 50회 칭호를 얻으면 유물 해금', ownR >= 3, ownR + '개');
  await page.click('#titleCats button[data-c="report"]'); await page.waitForTimeout(200);
  check('칭호: 분류 버튼으로 걸러 보기(보고 3개)', (await page.locator('#titles .ttl').count()) === 3 && (await page.innerText('#titleCats')).includes('보고 3/3'), await page.innerText('#titleCats'));
  await page.click('#titleCats button[data-c="all"]');
  await page.click('#relics .ttl[data-r="d10"]'); await page.click('#relics .ttl[data-r="d30"]'); await page.waitForTimeout(200);
  check('유물: 여러 개를 함께 장착', (await page.locator('#relics .ttl.on').count()) === 2 && (await page.innerText('#relicCount')).includes('장착 2'));
  await page.click('#profClose'); await page.evaluate(() => document.querySelectorAll('.tmark')[2].click()); await page.waitForTimeout(500);
  const vlabel = await page.innerText('#verifyBtn');
  check('유물: 열쇠 꾸러미 효과가 인증 거리에 반영(55m)', vlabel.includes('55m') && vlabel.includes('+30'), vlabel);
  await page.click('#shClose');

  // ---- 코인 상점 · 오늘의 보너스 ----
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ghc-v0')); s.coins = 500; localStorage.setItem('ghc-v0', JSON.stringify(s)); });
  await page.reload(); await page.waitForTimeout(1500);
  await page.click('#coinBtn'); await page.waitForTimeout(300);
  check('상점: 화면 위 코인을 누르면 열림', await page.isVisible('#shop') && (await page.innerText('#shopCoins')).includes('500'));
  check('상점: 웹에서는 광고 보너스 버튼이 안 보임 (앱 전용)', await page.isHidden('#adBtn'));
  await page.click('#bonusBtn'); await page.waitForTimeout(300);
  check('상점: 오늘의 보너스는 하루 한 번(+50, 장착한 유물 주인의 인장 +5)', (await page.innerText('#shopCoins')).includes('555') && await page.isDisabled('#bonusBtn'));
  await page.click('#shopList [data-buy="bg_night"]'); await page.waitForTimeout(300);
  check('상점: 배경을 사면 코인이 줄고 바로 적용', (await page.innerText('#shopCoins')).includes('405') && (await page.innerText('#shopList')).includes('적용 중'));
  await page.click('#shopList [data-buy="bg_gold"]'); await page.waitForTimeout(300);
  check('상점: 코인이 부족하면 살 수 없음', (await page.innerText('#shopCoins')).includes('405'));
  await page.click('#shopTabs button[data-k="pack"]'); await page.click('#shopList [data-buy="pk_sea"]'); await page.waitForTimeout(300);
  await page.click('#shopClose'); await page.click('#profBtn'); await page.waitForTimeout(400);
  check('상점: 산 배경이 프로필 카드에 적용', (await page.evaluate(() => document.getElementById('myBoard').style.background)).includes('gradient'));
  await page.click('#decoBtn'); await page.waitForTimeout(200);
  check('상점: 산 스티커 묶음이 꾸미기 목록에 나옴', (await page.innerText('#tray')).includes('🐳'));
  await page.click('#decoCancel'); await page.click('#profClose');

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

  // ---- 서버 지갑: 코인·변기력·칭호·구매를 서버가 정한다 ----
  db.wallet = { coins: 400, xp: 1200, earned: 1450, spent: 1050, titles: ['tut', 'v1', 'r1', 'k3'], owned: ['bg_night'], bonus_today: false, missions_today: 0, stats: {} };
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ghc-v0')); s.coins = 999999; s.xp = 999999; localStorage.setItem('ghc-v0', JSON.stringify(s)); });  // 기기 값을 조작해도
  await page.goto(BASE + '/index.html?wallet=1'); await page.waitForTimeout(2500);
  check('서버 지갑: 기기 저장값을 고쳐도 서버 값(400코인)으로 표시', (await page.innerText('#coins')) === '400', await page.innerText('#coins'));
  check('서버 지갑: 변기력 1,200 → 경지 소용돌이', (await page.innerText('#rankLabel')) === '소용돌이' && (await page.innerText('#level')) === '1,200');
  await page.click('#coinBtn'); await page.waitForTimeout(300);
  await page.click('#shopList [data-buy="bg_gold"]'); await page.waitForTimeout(500);
  check('서버 지갑: 코인이 모자라면 구매 불가', (await page.innerText('#shopCoins')).includes('400') && !db.wallet.owned.includes('bg_gold'));
  await page.click('#bonusBtn'); await page.waitForTimeout(700);
  check('서버 지갑: 오늘의 보너스는 서버에 청구(+50)', db.walletCalls.includes('rpc/claim_bonus') && (await page.innerText('#shopCoins')).includes('450') && await page.isDisabled('#bonusBtn'));
  await page.click('#shopTabs button[data-k="pack"]'); await page.click('#shopList [data-buy="pk_sea"]'); await page.waitForTimeout(700);
  check('서버 지갑: 구매는 서버에서 차감(450 → 200)', db.wallet.owned.includes('pk_sea') && (await page.innerText('#shopCoins')).includes('200') && (await page.innerText('#coins')) === '200');
  await page.click('#shopTabs button[data-k="bg"]'); await page.waitForTimeout(200);
  check('서버 지갑: 서버가 가진 것으로 인정한 배경만 보유', (await page.locator('#shopList [data-use], #shopList i').count()) === 2, await page.innerText('#shopList'));
  await page.click('#shopClose'); await page.click('#profBtn'); await page.waitForTimeout(400);
  const srvTitles = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('ghc-ach')).got));
  check('서버 지갑: 서버가 인정한 칭호(k3)가 지급됨', srvTitles.includes('k3'), srvTitles.join(','));
  await page.click('#profClose');
  await page.evaluate(() => document.querySelectorAll('.tmark')[2].click()); await page.waitForTimeout(500);
  await page.click('.reports button[data-k=clean][data-v="1"]'); await page.waitForTimeout(1800);
  check('서버 지갑: 보고 보상은 서버가 계산한 만큼(+5) 반영', (await page.innerText('#coins')) === '205', await page.innerText('#coins'));
  await page.click('#shClose');

  // ---- 본인 확인이 붙은 쓰기(v7): 직접 쓰기가 막힌 서버에서도 전부 동작해야 한다 ----
  db.signed = true; db.rejectVisit = true;
  await page.goto(BASE + '/index.html?signed=1'); await page.waitForTimeout(2500);
  const nMsg = db.messages.length, nRep = db.reports.length;
  await page.click('#areaBtn'); await page.waitForTimeout(300); await page.fill('#areaMsg', '서명된 글'); await page.press('#areaMsg', 'Enter'); await page.waitForTimeout(800);
  check('본인 확인 쓰기: 채팅이 열쇠와 함께 전송되고 화면에 표시', db.messages.length === nMsg + 1 && db.signedCalls.some(c => c.table === 'rpc/post_message' && c.b.p_secret.length >= 16) && (await page.innerText('#areaChat')).includes('서명된 글'));
  await page.click('#areaClose');
  await page.evaluate(() => document.querySelectorAll('.tmark')[2].click()); await page.waitForTimeout(500);
  await page.click('.reports button[data-k=queue][data-v="0"]'); await page.waitForTimeout(600);
  check('본인 확인 쓰기: 상태 보고', db.reports.length === nRep + 1 && db.signedCalls.some(c => c.table === 'rpc/post_report'));
  await page.click('#shClose');
  // 서버가 "이동이 너무 빠르다"며 인증을 거절하는 경우: 기기에서도 인증이 취소되어 다시 시도할 수 있어야 한다
  await ctx.setGeolocation({ latitude: 37.5700, longitude: 126.9820 }); await page.click('#locBtn'); await page.waitForTimeout(1500);
  const nMark = await page.locator('.tmark').count();
  for (let k = 0; k < nMark; k++) { await page.evaluate(n => document.querySelectorAll('.tmark')[n].click(), k); await page.waitForTimeout(250); if ((await page.innerText('#shName')) === '먼 화장실') break; }
  const nVis = db.visits.length;
  await page.click('#verifyBtn'); await page.waitForTimeout(1200);
  check('인증 거절: 서버가 거절하면 안내가 뜨고 기록되지 않음', db.visits.length === nVis && (await page.innerText('#toast')).includes('너무 빨리'), await page.innerText('#toast'));
  check('인증 거절: 기기에서도 취소되어 다시 인증할 수 있음', !(await page.isDisabled('#verifyBtn')) && (await page.innerText('#verifyBtn')).includes('도착 인증'));
  db.rejectVisit = false;
  await page.click('#verifyBtn'); await page.waitForTimeout(1200);
  const lastV = db.visits.at(-1);
  check('본인 확인 쓰기: 도착 인증이 변기 좌표와 함께 전송', db.visits.length === nVis + 1 && Math.abs(lastV.lat - 37.57) < 0.001 && Math.abs(lastV.lng - 126.982) < 0.001, JSON.stringify(lastV));
  check('본인 확인 쓰기: 테이블에 직접 쓰는 요청은 한 번도 보내지 않음', db.directWrites === 0, db.directWrites);
  await page.click('#shClose');

  // ---- 없음 신고 반박과 사진 증거(v8) ----
  db.v8 = true; db.flagsV8 = [{ toilet_id: 'osm1', flags: 2, hidden: true }];
  await ctx.setGeolocation({ latitude: 37.5665, longitude: 126.978 });
  await page.goto(BASE + '/index.html?v8=1'); await page.waitForTimeout(4500);
  await page.click('#sosBtn'); await page.waitForTimeout(400);
  const seen8 = new Set([await page.innerText('#sosName')]); for (let i = 0; i < 3; i++) { await page.click('#sosNext'); seen8.add(await page.innerText('#sosName')); }
  check('신고(v8): 서버가 숨김으로 판정한 변기는 변기탐지에서 빠짐', !seen8.has('공원 화장실'), [...seen8].join(','));
  await page.click('#sosClose');
  const openByName = async name => { const n = await page.locator('.tmark').count(); for (let k = 0; k < n; k++) { await page.evaluate(i => document.querySelectorAll('.tmark')[i].click(), k); await page.waitForTimeout(200); if ((await page.innerText('#shName')) === name) return true; } return false; };
  await openByName('공원 화장실');
  check('신고(v8): 변기 창에 신고 안내와 반박 방법이 보임', (await page.innerText('#flagNote')).includes('탐험가 2명') && (await page.innerText('#flagNote')).includes('있어요 사진'));
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#photoYes')]);
  await fc.setFiles({ name: 'proof.png', mimeType: 'image/png', buffer: PNG }); await page.waitForTimeout(1500);
  check('사진: JPEG로 줄여서 올라감(위치 정보 제거)', db.photos.length === 1 && db.photos[0].data.startsWith('data:image/jpeg;base64,') && db.photos[0].kind === 'exists', db.photos[0] ? db.photos[0].data.slice(0, 30) : '없음');
  await page.waitForTimeout(1500);
  check('사진: 변기 창에 사진이 표시', (await page.locator('#photos .ph').count()) === 1);
  check('사진: 작은 미리보기도 함께 올라감', !!db.photos[0].thumb && db.photos[0].thumb.startsWith('data:image/jpeg;base64,') && db.photos[0].thumb.length <= 16000 && db.photos[0].data.length <= 110000);
  check('사진: 목록은 미리보기만 받음(원본은 안 받음)', (db.fullFetches || 0) === 0 && (await page.getAttribute('#photos .ph img', 'src')) === db.photos[0].thumb);
  check('변기 레벨(v8): 방문 기록 대신 서버가 센 숫자를 받음', (db.statsRpc || 0) >= 1 && /\d/.test(await page.innerText('#tlVisits')));
  check('신고 집계: 전 세계가 아니라 주변 변기만 물어봄', Array.isArray(db.flagIds) && db.flagIds.length > 0 && db.flagIds.length <= 200 && db.flagIds.includes('osm1'));
  check('반박: 있어요 사진 뒤 신고 안내가 사라짐', !(await page.isVisible('#flagNote')));
  await page.click('#shClose'); await page.click('#sosBtn'); await page.waitForTimeout(400);
  const back8 = new Set([await page.innerText('#sosName')]); for (let i = 0; i < 4; i++) { await page.click('#sosNext'); back8.add(await page.innerText('#sosName')); }
  check('반박: 다시 변기탐지 후보로 돌아옴', back8.has('공원 화장실'), [...back8].join(','));
  await page.click('#sosClose');
  db.photos.push({ id: 99, toilet_id: 'osm1', kind: 'gone', data: db.photos[0].data, user_id: 'stranger', nick: '👻 누군가', at: new Date().toISOString() });
  await openByName('공원 화장실'); await page.waitForTimeout(800);
  await page.click('#photos .ph >> nth=0'); await page.waitForTimeout(200);
  check('사진 보기: 남의 사진에는 신고 버튼이 보임', await page.isVisible('#photoView') && await page.isVisible('#photoReport'));
  await page.waitForTimeout(400);
  check('사진 보기: 누르면 그때 원본을 받음', (db.fullFetches || 0) >= 1 && (await page.getAttribute('#photoBig', 'src')) === db.photos.find(p => p.id === 99).data);
  await page.click('#photoReport'); await page.waitForTimeout(600);
  check('사진 신고가 서버로 전송', db.photoReports.includes(99));
  await page.click('#photos .ph >> nth=1'); await page.waitForTimeout(200);
  check('사진 보기: 내 사진에는 신고 버튼이 없음', !(await page.isVisible('#photoReport')));
  await page.click('#photoClose'); await page.click('#shClose');
  await ctx.setGeolocation({ latitude: 37.60, longitude: 127.05 }); await page.click('#locBtn'); await page.waitForTimeout(1200);
  await openByName('공원 화장실'); await page.click('#photoYes'); await page.waitForTimeout(300);
  check('사진: 멀리(200m 밖)서는 올릴 수 없음', (await page.innerText('#toast')).includes('200m'));
  await page.click('#shClose');

  // ---- 미리 받아둔 화장실 데이터: 덮는 지역에서는 Overpass에 묻지 않는다 ----
  await page.route('**/data/index.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ v: 1, at: '2026-11-17T00:00:00Z', region: { s: 37, w: 126, n: 38, e: 127.5 }, tile: 0.5, total: 2, missing: [[37.5, 127, 38, 127.5]], tiles: { '75_253': 2 } }) }));
  await page.route('**/data/t/75_253.json*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ v: 1, t: [['osm5001', 37.5667, 126.9779, '미리받은 시청 화장실', 3, '24/7'], ['osmw5002', 37.5672, 126.9790, '', 0, '']] }) }));
  await ctx.setGeolocation({ latitude: 37.5665, longitude: 126.978 });
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('ghc-osm')) localStorage.removeItem(k); });
  db.overpassCalls = 0;
  await page.goto(BASE + '/index.html?pre=1'); await page.waitForTimeout(3000);
  check('미리 받은 데이터: 덮는 지역에서는 Overpass를 부르지 않음', db.overpassCalls === 0, db.overpassCalls + '번 호출');
  check('미리 받은 데이터: 그 지역 화장실이 지도에 표시', await openByName('미리받은 시청 화장실'));
  check('미리 받은 데이터: 휠체어·유료·개방시간 정보 유지', (await page.innerText('#shMeta')).includes('휠체어') && (await page.innerText('#shMeta')).includes('유료') && (await page.innerText('#shMeta')).includes('24/7'), await page.innerText('#shMeta'));
  check('미리 받은 데이터: 이름이 없으면 "공중화장실"', await (async () => { await page.click('#shClose'); return openByName('공중화장실'); })());
  await page.click('#shClose');
  await ctx.setGeolocation({ latitude: 37.6, longitude: 127.2 }); await page.click('#locBtn'); await page.waitForTimeout(2500);
  check('미리 받은 데이터: 데이터가 없는 칸에서는 Overpass로 직접', db.overpassCalls > 0, db.overpassCalls + '번 호출');
  await page.unroute('**/data/index.json'); await page.unroute('**/data/t/75_253.json*');

  // ---- 다국어: 일본어·영어로 모든 화면을 열어 보고, 번역되지 않은 한국어가 남았는지 찾는다 ----
  // (사용자가 쓴 글·닉네임·화장실 이름처럼 data-raw 표시가 있는 곳은 제외)
  // 사용자가 만든 글(닉네임, 화장실 이름)은 번역 대상이 아니므로 문장 속에 섞여 있어도 지우고 본다
  const userText = () => [...new Set([...osm.elements.map(e => e.tags.name), ...db.messages.map(m => m.nick), ...db.photos.map(p => p.nick), ...db.visits.map(v => v.nick), ...db.toilets.map(x => x.name), ...db.toilets.map(x => x.nick), ...Object.values(db.profiles || {}).map(p => p.data && p.data.nick)].filter(Boolean))].sort((a, b) => b.length - a.length);
  const leftovers = async () => { const ut = userText().concat(await page.evaluate(() => [window.Backend.me().nick, window.Backend.me().full])); return page.evaluate(ut => {
    const H = /[가-힣]/, out = new Set(), strip = s => ut.reduce((a, u) => a.split(u).join(''), s);
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (!H.test(n.data)) continue; const p = n.parentElement; if (!p || p.closest('script,style,#map,[data-raw]')) continue; if (H.test(strip(n.data))) out.add(n.data.trim()); }
    for (const el of document.querySelectorAll('[placeholder],[title],[alt]')) { if (el.closest('#map,[data-raw]')) continue; for (const a of ['placeholder', 'title', 'alt']) { const v = el.getAttribute(a); if (v && H.test(v)) out.add('@' + a + ': ' + v); } }
    if (H.test(document.title)) out.add('<title> ' + document.title);
    return [...out];
  }, ut); };
  await ctx.setGeolocation({ latitude: 37.5665, longitude: 126.978 });
  for (const L of ['ja', 'en']) {
    await page.evaluate(l => localStorage.setItem('ghc-lang', l), L);
    await page.goto(BASE + '/index.html?lang=' + L); await page.waitForTimeout(3500);
    const found = new Set(), step = async (name, fn) => { try { await fn(); await page.waitForTimeout(350); } catch (e) { found.add(`(${name} 단계 실패: ${String(e).slice(0, 80)})`); } (await leftovers()).forEach(x => found.add(x)); };
    await step('첫 화면', async () => {});
    await step('튜토리얼', async () => { await page.click('#helpBtn'); for (let i = 0; i < 5; i++) { await page.click('#tutNext'); (await leftovers()).forEach(x => found.add(x)); } });
    await step('사용법', async () => { await page.click('.htab[data-htab=guide]'); await page.evaluate(() => document.querySelectorAll('#htab-guide details').forEach(d => d.open = true)); });
    await step('의견', async () => { await page.click('.htab[data-htab=fb]'); await page.click('#helpClose'); });
    await step('변기 창', async () => { await openByName('공원 화장실'); await page.waitForTimeout(800); });
    await step('사진 보기', async () => { if (await page.locator('#photos .ph').count()) { await page.click('#photos .ph >> nth=0'); (await leftovers()).forEach(x => found.add(x)); await page.click('#photoClose'); } });
    await step('변기 이야기', async () => { await page.click('.tab[data-tab=talk]'); await page.waitForTimeout(500); await page.click('#shClose'); });
    await step('동네 광장', async () => { await page.click('#areaBtn'); await page.waitForTimeout(800); });
    await step('다른 탐험가', async () => { if (await page.locator('#areaChat .nicklink[data-uid="other1"]').count()) { await page.click('#areaChat .nicklink[data-uid="other1"]'); await page.waitForTimeout(600); (await leftovers()).forEach(x => found.add(x)); await page.click('#peekClose'); } else await page.click('#areaClose'); });
    await step('수첩', async () => { await page.click('#profBtn'); await page.waitForTimeout(600); for (const c of await page.locator('#titleCats button').all()) { await c.click(); (await leftovers()).forEach(x => found.add(x)); } });
    await step('꾸미기', async () => { await page.click('#decoBtn'); (await leftovers()).forEach(x => found.add(x)); await page.click('#decoCancel'); await page.click('#profClose'); });
    await step('상점', async () => { await page.click('#coinBtn'); for (const c of await page.locator('#shopTabs button').all()) { await c.click(); (await leftovers()).forEach(x => found.add(x)); } await page.click('#shopClose'); });
    await step('변기탐지', async () => { await page.click('#sosBtn'); await page.waitForTimeout(400); (await leftovers()).forEach(x => found.add(x)); await page.click('#sosClose'); });
    await step('등록', async () => { await page.click('#addBtn'); (await leftovers()).forEach(x => found.add(x)); await page.click('#addCancel'); });
    await step('미션', async () => { await page.click('#missionBtn'); await page.waitForTimeout(300); });
    check(`다국어(${L}): 화면에 번역되지 않은 한국어가 없음`, found.size === 0, [...found].slice(0, 12).join(' | '));
  }
  // 대표 문장이 실제로 바뀌는지, 사용자 글은 그대로인지
  check('다국어(en): 변기탐지 버튼이 영어', (await page.innerText('#sosBtn')).includes('Toilet Radar'), await page.innerText('#sosBtn'));
  check('다국어(en): 굵은 글씨가 섞인 문단도 번역', (await page.evaluate(() => document.querySelector('#htab-guide p[data-i18n-html]').innerHTML)).startsWith('<b>Loo Power</b>'));
  check('다국어(en): 틀이 있는 문장 번역 (주변 화장실 3곳 → Loaded 3 toilets nearby)', await page.evaluate(() => I18N.tr('주변 화장실 3곳 불러옴') === 'Loaded 3 toilets nearby' && I18N.tr('24m · 도보 1분 · 유료') === '24m · 1 min walk · Paid' && I18N.tr('인증 실패: 직전 인증 지점에서 너무 빨리 이동했어요. 잠시 후 다시 인증해 주세요.').startsWith('Check-in failed: You moved too fast')));
  check('다국어: 채팅 글과 닉네임은 번역하지 않음', await page.evaluate(() => { const m = [...document.querySelectorAll('#areaChat [data-raw]')]; return m.length > 0 && m.some(x => /[가-힣]/.test(x.textContent)); }));
  await page.click('#helpBtn'); await page.click('.langs button[data-lang="ko"]'); await page.waitForTimeout(3000);
  check('다국어: 도움말에서 한국어로 되돌리기', (await page.innerText('#sosBtn')).includes('변기탐지') && (await page.evaluate(() => localStorage.getItem('ghc-lang'))) === 'ko');

  check('광고: 설정이 꺼져 있으면 광고 자리가 생기지 않음', (await page.locator('.ad-slot').count()) === 0);
  const pv = await page.request.get(BASE + '/privacy.html');
  check('개인정보처리방침 페이지가 열림', pv.ok() && (await pv.text()).includes('개인정보처리방침'));
  check('전체 흐름 중 자바스크립트 오류 없음', errors.length === 0, errors.join(' | ').slice(0, 300));

  // 저장 공간: 예전 형식(ghc-v0 안에 보고가 쌓인 것)을 옮기고 오래된 것은 지운다
  const now = Date.now();
  await page.evaluate(n => {
    localStorage.setItem('ghc-v0', JSON.stringify({ coins: 12, xp: 34, reports: { oldT: { open: { v: 1, t: n - 5 * 864e5 } }, newT: { paper: { v: 0, t: n - 3600e3 } } }, toilets: {}, verified: { a: '2020-01-01' }, daily: { day: '', done: 0 } }));
    localStorage.removeItem('ghc-rep');
  }, now);
  await page.reload(); await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({ v0: JSON.parse(localStorage.getItem('ghc-v0')), rep: JSON.parse(localStorage.getItem('ghc-rep') || '{}') }));
  check('저장 공간: 보고는 별도 칸으로 옮겨지고 계정 백업 칸(ghc-v0)에서는 빠짐', !('reports' in st.v0) && !!st.rep.newT, JSON.stringify(st).slice(0, 200));
  check('저장 공간: 이틀 지난 보고와 지난 날짜의 인증 기록은 지움', !st.rep.oldT && !st.v0.verified.a);

  // 계정·데이터 삭제: 한 번 누르면 확인, 두 번째에 서버 삭제 → 기기 기록도 지우고 새 탐험가로
  const oldUid = await page.evaluate(() => localStorage.getItem('ghc-uid'));
  await page.evaluate(() => document.querySelectorAll('.sheet:not(.hidden), .modal:not(.hidden)').forEach(m => m.classList.add('hidden')));
  await page.click('#profBtn'); await page.waitForTimeout(400);
  await page.click('#delMe'); await page.waitForTimeout(200);
  check('삭제: 첫 번째 누름은 확인만 (아직 안 지움)', !(db.deleted || []).length && (await page.innerText('#delMe')).includes('한 번 더'));
  await Promise.all([page.waitForEvent('load', { timeout: 8000 }).catch(async e => { console.log('  (삭제 뒤 알림:', await page.innerText('#toast').catch(() => '?'), ')'); throw e; }), page.click('#delMe')]);
  await page.waitForTimeout(1200);
  const newUid = await page.evaluate(() => localStorage.getItem('ghc-uid'));
  check('삭제: 서버에서 내 데이터 삭제를 요청', (db.deleted || []).includes(oldUid));
  check('삭제: 기기 기록도 지우고 새 탐험가로 시작', !!newUid && newUid !== oldUid && !db.messages.some(m => m.user_id === oldUid));
} catch (e) {
  check('점검 스크립트가 끝까지 실행됨', false, String(e).slice(0, 300));
}
await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
