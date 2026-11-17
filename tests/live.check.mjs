// 실제 서버 점검. GitHub의 점검 서버에서 진짜 Supabase와 배포된 사이트에 접속해 상태를 확인한다.
// 사용자 데이터를 건드리지 않는다: 읽기, 그리고 일부러 실패하게 만든 요청(형식이 틀린 값)만 보낸다.
// 예외는 점검용 탐험가 'ci-live-check'의 튜토리얼 표시 한 건으로, 몇 번을 실행해도 한 줄만 남는다.
// 실행: node tests/live.check.mjs
import { readFileSync } from 'node:fs';

const cfgText = readFileSync(new URL('../config.js', import.meta.url), 'utf8');
const URL0 = (cfgText.match(/SUPABASE_URL:\s*'([^']*)'/) || [])[1], KEY = (cfgText.match(/SUPABASE_ANON_KEY:\s*'([^']*)'/) || [])[1];
const SITE = process.env.SITE_URL || 'https://leeseunggyu3.github.io/toilet-adventurer/';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const out = []; let hardFail = false;
const line = (mark, name, detail = '') => { out.push(`${mark} ${name}${detail ? ' — ' + detail : ''}`); console.log(out.at(-1)); };
const call = async (path, opt = {}) => { try { const r = await fetch(URL0 + path, Object.assign({ headers: H }, opt)); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, j, t }; } catch (e) { return { status: 0, j: null, t: String(e) }; } };
const rpc = (name, body) => call('/rest/v1/rpc/' + name, { method: 'POST', body: JSON.stringify(body) });

if (!URL0 || !KEY) { console.log('⚠️ config.js에 Supabase 설정이 없어 점검을 건너뜁니다'); process.exit(0); }

// 1. 읽기
for (const tb of ['messages', 'reports', 'visits', 'toilets']) {
  const r = await call(`/rest/v1/${tb}?select=*&limit=1`);
  if (r.status === 200) line('✅', `${tb} 읽기`); else { line('❌', `${tb} 읽기`, `[${r.status}] ${r.t.slice(0, 120)}`); hardFail = true; }
}
{ const r = await call('/rest/v1/profiles?select=user_id,data&limit=1'); line(r.status === 200 ? '✅' : '⚠️', '프로필 테이블(v4)', r.status === 200 ? '' : `[${r.status}] 아직 없음`); }
{ const r = await call('/rest/v1/profiles?select=key_hash&limit=1'); line(r.status === 200 ? '❌' : '✅', '프로필 열쇠 해시는 외부에서 읽을 수 없음', r.status === 200 ? '읽힘! 권한 확인 필요' : ''); if (r.status === 200) hardFail = true; }
{ const r = await call('/rest/v1/accounts?select=auth_uid&limit=1'); line(r.status === 200 && Array.isArray(r.j) && r.j.length === 0 || r.status === 401 || r.status === 403 ? '✅' : '⚠️', '계정 저장소(v5)는 본인 외 읽기 불가', `[${r.status}] ${Array.isArray(r.j) ? r.j.length + '행 보임' : r.t.slice(0, 80)}`); }
{ const r = await call('/rest/v1/feedback?select=id&limit=1'); line(r.status !== 200 || (Array.isArray(r.j) && r.j.length === 0) ? '✅' : '❌', '의견함(v3)은 외부에서 읽을 수 없음', `[${r.status}]`); }

// 2. 서버 지갑 (v6)
const CI = 'ci-live-check', CIS = 'ci-live-check-secret-0000000000';
let v6 = false;
{ const r = await rpc('wallet_state', { p_user: CI });
  if (r.status === 200 && r.j && typeof r.j.coins === 'number') { v6 = true; line('✅', '서버 지갑(v6) 설치됨', `점검용 탐험가 코인 ${r.j.coins}, 칭호 [${r.j.titles.join(',')}]`); }
  else if (r.status === 404) line('⏳', '서버 지갑(v6) 아직 실행 전', 'schema_v6_wallet.sql을 실행하면 켜짐. 그 전까지 앱은 예전 방식으로 동작');
  else line('❌', '서버 지갑(v6) 오류', `[${r.status}] ${r.t.slice(0, 160)}`); }
if (v6) {
  const r = await rpc('claim_tut', { p_user: CI, p_secret: CIS });
  line(r.status === 200 && r.j.titles.includes('tut') ? '✅' : '❌', '지갑: 열쇠 확인 후 쓰기 동작(튜토리얼 표시)', r.status === 200 ? '' : `[${r.status}] ${r.t.slice(0, 160)}`);
  const w = await rpc('claim_bonus', { p_user: CI, p_secret: 'wrong-secret-wrong-secret-0000' });
  line(w.status >= 400 ? '✅' : '❌', '지갑: 틀린 열쇠는 거절', `[${w.status}] ${(w.j && w.j.message) || ''}`);
  const b = await rpc('buy_item', { p_user: CI, p_secret: CIS, p_item: 'bg_gold' });
  line(b.status >= 400 && /부족/.test((b.j && b.j.message) || '') ? '✅' : '⚠️', '지갑: 코인이 모자라면 구매 거절', `[${b.status}] ${(b.j && b.j.message) || b.t.slice(0, 80)}`);
}

// 3. 본인 확인 쓰기 (v7) — 일부러 너무 짧은 열쇠를 보내 "함수가 있는지"만 확인한다 (저장되지 않음)
{ const r = await rpc('post_report', { p_user: CI, p_secret: 'short', p_toilet: 'ci', p_k: 'open', p_v: 1 });
  if (r.status === 404) line('⏳', '본인 확인 쓰기(v7) 아직 실행 전', 'schema_v7_signed.sql을 실행하면 켜짐');
  else if (r.status === 400) line('✅', '본인 확인 쓰기(v7) 설치됨');
  else line('❌', '본인 확인 쓰기(v7) 오류', `[${r.status}] ${r.t.slice(0, 160)}`); }
// 직접 쓰기가 닫혔는지 — 허용되지 않는 값(k)을 보내므로 열려 있어도 저장되지 않는다
{ const r = await call('/rest/v1/reports', { method: 'POST', headers: Object.assign({ Prefer: 'return=minimal' }, H), body: JSON.stringify({ toilet_id: 'ci', k: '__probe__', v: 1, user_id: CI }) });
  const code = (r.j && r.j.code) || '';
  if (r.status === 401 || r.status === 403 || code === '42501') line('✅', '테이블 직접 쓰기 닫힘');
  else if (code === '23514') line('⏳', '테이블 직접 쓰기 아직 열려 있음', 'v7 실행 전 상태 (정상)');
  else line('⚠️', '테이블 직접 쓰기 상태 불명', `[${r.status}] ${r.t.slice(0, 120)}`); }

// 3-2. 없음 신고 집계와 사진 증거 (v8)
{ const r = await rpc('toilet_flags', {});
  if (r.status === 200 && Array.isArray(r.j)) line('✅', '없음 신고 집계·사진 증거(v8) 설치됨', `신고가 걸린 변기 ${r.j.length}곳, 숨김 ${r.j.filter(x => x.hidden).length}곳`);
  else if (r.status === 404) line('⏳', '없음 신고 집계·사진 증거(v8) 아직 실행 전', 'schema_v8_evidence.sql을 실행하면 켜짐');
  else line('❌', '없음 신고 집계(v8) 오류', `[${r.status}] ${r.t.slice(0, 160)}`); }
{ const r = await rpc('toilet_stats', { p_toilet: 'live-check-none' });
  if (r.status === 200 && r.j && r.j.visits === 0) line('✅', '변기 기록 서버 집계(v8) 동작', '방문 기록 대신 숫자만 보냄');
  else if (r.status === 404) line('⏳', '변기 기록 서버 집계(v8) 아직 실행 전', '최신 schema_v8_evidence.sql을 실행하면 켜짐 (그 전엔 예전 방식)');
  else line('❌', '변기 기록 서버 집계 오류', `[${r.status}] ${String(r.t).slice(0, 160)}`); }
{ const r = await rpc('wallet_state', { p_user: 'live-check-nobody' });
  const c = await rpc('claim_ad_bonus', { p_user: 'live-check-nobody', p_secret: 'x' });  // 열쇠가 짧아 거절되어야 정상 (함수가 있다는 뜻)
  if (r.status === 200 && r.j && typeof r.j.ads_today === 'number' && c.status !== 404) line('✅', '앱 광고 보너스(v9) 준비됨', '하루 3번, 끝까지 본 광고만');
  else if (c.status === 404 || (r.j && r.j.ads_today === undefined)) line('⏳', '앱 광고 보너스(v9) 아직 실행 전', 'schema_v9_ads.sql을 실행하면 앱 상점에 광고 버튼이 나옴');
  else line('❌', '앱 광고 보너스 확인 오류', `[${c.status}] ${String(c.t).slice(0, 160)}`); }
{ const c = await rpc('delete_my_data', { p_user: 'live-check-nobody', p_secret: 'x' });  // 열쇠가 짧아 거절되어야 정상 (함수가 있다는 뜻)
  if (c.status === 404) line('⏳', '계정·데이터 삭제(v10) 아직 실행 전', 'schema_v10_delete.sql을 실행해야 앱의 삭제 버튼이 동작함 (플레이 스토어 필수)');
  else if (c.status >= 400 && /bad request|본인 확인/.test(String(c.t))) line('✅', '계정·데이터 삭제(v10) 준비됨', '본인 열쇠가 있어야만 지움');
  else line('❌', '계정·데이터 삭제 확인 오류', `[${c.status}] ${String(c.t).slice(0, 160)}`); }

// 4. 구글 로그인 설정
{ const r = await call('/auth/v1/settings');
  if (r.status === 200 && r.j && r.j.external) line(r.j.external.google ? '✅' : '⚠️', '구글 로그인 ' + (r.j.external.google ? '켜짐' : '꺼짐'));
  else line('⚠️', '로그인 설정을 읽지 못함', `[${r.status}]`); }

// 5. 배포된 사이트
try {
  const r = await fetch(SITE + '?live=' + Date.now()); const t = await r.text();
  const ver = (t.match(/app\.js\?v=([0-9a-z]+)/) || [])[1];
  line(r.ok && t.includes('Toilet Adventure') ? '✅' : '❌', '배포된 사이트 열림', `버전 ${ver || '알 수 없음'}`);
  const d = await fetch(SITE + 'data/index.json?live=' + Date.now());
  if (d.ok) { const ix = await d.json(); const days = Math.round((Date.now() - new Date(ix.at)) / 864e5); line(days <= 10 ? '✅' : '⚠️', '미리 받은 화장실 데이터', `${ix.total.toLocaleString()}곳, 타일 ${Object.keys(ix.tiles).length}개, ${days}일 전 갱신, 받기 실패 지역 ${ix.missing.length}곳`); }
  else line('⏳', '미리 받은 화장실 데이터 없음', '데이터 받기 작업이 아직 안 돌았음. 앱은 Overpass에 직접 묻는다');
  const p = await fetch(SITE + 'privacy.html'); line(p.ok ? '✅' : '❌', '개인정보처리방침 페이지');
} catch (e) { line('❌', '배포된 사이트 접속 실패', String(e).slice(0, 120)); }

console.log(hardFail ? '\n결과: 핵심 기능에 문제가 있음' : '\n결과: 핵심 기능 정상 (⏳는 SQL 실행을 기다리는 항목)');
process.exit(hardFail ? 1 : 0);
