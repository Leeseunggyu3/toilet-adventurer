// 서버 SQL 점검. 진짜 Postgres(PGlite)에 스키마 v1~v6을 순서대로 올리고 보상 규칙을 확인한다.
// 실행: node tests/sql.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${name}${detail !== '' ? ' — ' + detail : ''}`); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const state = async u => (await q('select wallet_state($1) s', [u]))[0].s;
const fails = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };

// Supabase가 기본으로 갖고 있는 것들의 대역
await db.exec(`
  create role anon; create role authenticated;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
`);
for (const f of ['schema.sql', 'schema_v2.sql', 'schema_v3_feedback.sql', 'schema_v4_profiles.sql', 'schema_v5_accounts.sql', 'schema_v6_wallet.sql', 'schema_v7_signed.sql', 'schema_v8_evidence.sql', 'schema_v9_ads.sql']) {
  const sql = readFileSync(new URL('../supabase/' + f, import.meta.url), 'utf8').replace(/create extension if not exists pgcrypto;/g, '');
  try { await db.exec(sql); check(`${f} 실행`, true); } catch (e) { check(`${f} 실행`, false, e.message); }
}
// 같은 파일을 한 번 더 실행해도 안전한지 (사용자가 두 번 눌러도 괜찮아야 한다)
try { await db.exec(readFileSync(new URL('../supabase/schema_v6_wallet.sql', import.meta.url), 'utf8')); check('v6을 두 번 실행해도 안전', true); } catch (e) { check('v6을 두 번 실행해도 안전', false, e.message); }
await db.exec('alter table messages disable trigger all; alter table reports disable trigger all; alter table visits disable trigger all; alter table toilets disable trigger all;'); // 도배 방지 트리거는 아래에서 따로 확인

const U = 'user_a', S = 'secret-secret-secret-1234', T0 = "timestamptz '2026-11-10 03:00:00+00'";
const rep = (u, toilet, k, mins, v = 1) => db.query(`insert into reports (toilet_id,k,v,user_id,at) values ($1,$2,$3,$4, ${T0} + make_interval(mins => $5))`, [toilet, k, v, u, mins]);
const visit = (u, toilet, mins, tz = 540) => db.query(`insert into visits (toilet_id,user_id,tz,at) values ($1,$2,$3, ${T0} + make_interval(mins => $4))`, [toilet, u, tz, mins]);

let s = await state(U);
check('아무 기록이 없으면 0코인, 칭호 없음', s.coins === 0 && s.xp === 0 && s.titles.length === 0, JSON.stringify(s));

// --- 상태 보고 ---
await rep(U, 't1', 'paper', 0); s = await state(U);
check('보고 1건 = 5코인, 칭호 r1', s.coins === 5 && s.titles.includes('r1'), s.coins);
await rep(U, 't1', 'paper', 5); await rep(U, 't1', 'paper', 10); s = await state(U);
check('같은 변기·같은 항목을 30분 안에 다시 보고해도 보상 없음', s.coins === 5, s.coins);
await rep(U, 't1', 'paper', 45); s = await state(U);
check('30분이 지나면 다시 보상', s.coins === 10, s.coins);
await rep(U, 't1', 'open', 46); s = await state(U);
check('세 번째 보상 보고에서 일일 퀘스트 +60', s.coins === 15 + 60, s.coins);
await rep(U, 't1', 'flagged', 47); s = await state(U);
check('"없음" 신고는 코인을 주지 않음', s.coins === 75, s.coins);
for (let i = 0; i < 40; i++) await rep(U, 'bulk' + i, 'open', 60 + i);
s = await state(U);
check('하루 보상 보고는 30건까지 (3건 이미 있음 → 27건만 추가)', s.coins === 75 + 27 * 5, s.coins);
check('보고 10회 칭호 r10', s.titles.includes('r10') && !s.titles.includes('r50'));

// --- 도착 인증 ---
const V = 'user_v';
await visit(V, 'a', 0); s = await state(V);
check('인증 1건 = 30 + 첫 탐험가 40, 칭호 v1·f1', s.coins === 70 && s.titles.includes('v1') && s.titles.includes('f1'), s.coins);
await visit(V, 'a', 30); s = await state(V);
check('같은 변기를 같은 날 다시 인증해도 추가 보상 없음', s.coins === 70, s.coins);
await visit(V, 'a', 60 * 24 + 5); s = await state(V);
check('다음 날 같은 변기는 30코인 (첫 탐험가는 한 번만)', s.coins === 100, s.coins);
await visit('user_w', 'a', 60 * 24 + 10); s = await state('user_w');
check('남이 먼저 인증한 변기는 첫 탐험가 보상 없음', s.coins === 30 && !s.titles.includes('f1'), s.coins);
await visit(V, 'b', 10); await visit(V, 'c', 20); s = await state(V);
check('2시간 안에 3곳 → 칭호 s3·d3', s.titles.includes('s3') && s.titles.includes('d3') && !s.titles.includes('s5'), s.titles.join(','));
await visit(V, 'd', 200); await visit(V, 'e', 300); s = await state(V);
check('24시간 안에 5곳 → 칭호 s5', s.titles.includes('s5'), s.titles.join(','));
const N = 'user_n';
await visit(N, 'n1', 60 * 14, 540); s = await state(N);  // 03:00 UTC + 14h = 17:00 UTC = 한국·일본 02:00
check('현지 시각 새벽 2시 인증 → 칭호 n1', s.titles.includes('n1'), s.titles.join(','));
await visit('user_n2', 'n2', 60 * 14, 0); s = await state('user_n2');  // 같은 순간이지만 시간대가 UTC면 17시
check('같은 순간이라도 현지 시각이 낮이면 n1 없음', !s.titles.includes('n1'));
const BV = 'user_bulk';
for (let i = 0; i < 20; i++) await visit(BV, 'fake' + i, i);
s = await state(BV);
check('하루 인증 보상은 15곳, 첫 탐험가는 5곳까지', s.coins === 15 * 30 + 5 * 40, s.coins);
check('변기 10곳 발견 칭호 d10', s.titles.includes('d10') && !s.titles.includes('d30'));

// --- 이야기 · 도움됐어요 · 등록 ---
const M = 'user_m';
for (let i = 0; i < 12; i++) await db.query(`insert into messages (channel,user_id,nick,text,kind,at) values ('c',$1,'n','hi',$2, ${T0} + make_interval(mins => $3))`, [M, i === 0 ? 'answer' : 'chat', i]);
s = await state(M);
check('이야기 보상은 하루 10건까지 (답변 5 + 일반 9건×2)', s.coins === 5 + 9 * 2, s.coins);
check('이야기 10번 칭호 t10', s.titles.includes('t10'));
const ans = (await q(`select id from messages where user_id=$1 and kind='answer'`, [M]))[0].id;
const chat = (await q(`select id from messages where user_id=$1 and kind='chat' limit 1`, [M]))[0].id;
await db.query('select mark_helpful($1)', [ans]); await db.query('select mark_helpful($1)', [ans]); await db.query('select mark_helpful($1)', [chat]);
s = await state(M);
check('도움됐어요: 답변에만, 여러 번 눌러도 +15 한 번', s.coins === 23 + 15 && (await q('select helpful from messages where id=$1', [ans]))[0].helpful === 1 && (await q('select helpful from messages where id=$1', [chat]))[0].helpful === 0, s.coins);
const G = 'user_g';
for (let i = 0; i < 5; i++) await db.query(`insert into toilets (id,lat,lng,name,user_id,at) values ($1,37,127,'x',$2, ${T0} + make_interval(mins => $3))`, ['g' + i, G, i]);
s = await state(G);
check('등록 보상은 하루 3곳까지 50코인, 칭호 g1', s.coins === 150 && s.titles.includes('g1'), s.coins);

// --- 본인 확인 · 보너스 · 미션 · 구매 ---
check('열쇠가 너무 짧으면 거절', !!(await fails('select claim_bonus($1,$2)', [U, 'short'])));
s = (await q('select claim_bonus($1,$2) s', [U, S]))[0].s;
check('오늘의 보너스 +50 (변기력에는 포함 안 됨)', s.coins === 75 + 135 + 50 && s.xp === 210 && s.bonus_today === true, `${s.coins} / xp ${s.xp}`);
s = (await q('select claim_bonus($1,$2) s', [U, S]))[0].s;
check('같은 날 두 번 받아도 한 번만', s.coins === 260, s.coins);
check('다른 열쇠로는 남의 지갑을 못 건드림', (await fails('select claim_bonus($1,$2)', [U, 'another-secret-another-secret']) || '').includes('본인 확인'));
check('구매: 코인이 부족하면 거절', (await fails('select buy_item($1,$2,$3)', [U, S, 'bg_gold']) || '').includes('부족'));
check('구매: 없는 상품은 거절', (await fails('select buy_item($1,$2,$3)', [U, S, 'nope']) || '').includes('없는 상품'));
s = (await q('select buy_item($1,$2,$3) s', [U, S, 'bg_night']))[0].s;
check('구매: 밤하늘 150코인 차감, 보유 목록에 추가', s.coins === 110 && s.owned.includes('bg_night') && s.spent === 150, s.coins);
s = (await q('select buy_item($1,$2,$3) s', [U, S, 'bg_night']))[0].s;
check('구매: 이미 가진 상품은 다시 차감하지 않음', s.coins === 110, s.coins);
check('구매 후에도 변기력은 줄지 않음', s.xp === 210, s.xp);
check('미션: 인증 기록이 없는 변기는 거절', !!(await fails('select claim_mission($1,$2,$3)', [U, S, 'nowhere'])));
await db.query(`insert into visits (toilet_id,user_id,tz) values ('m1',$1,540),('m2',$1,540),('m3',$1,540),('m4',$1,540)`, [U]);
const before = (await state(U)).coins;
for (const t of ['m1', 'm1', 'm2', 'm3', 'm4']) s = (await q('select claim_mission($1,$2,$3) s', [U, S, t]))[0].s;
check('미션: 하루 3번까지 40코인, 같은 변기 중복 없음', s.coins === before + 120 && s.missions_today === 3, s.coins - before);
s = (await q('select claim_tut($1,$2) s', [U, S]))[0].s;
check('튜토리얼 칭호 tut', s.titles.includes('tut'));

// --- 유물 보너스: 서버가 확인한 칭호 + 장착한 것만 ---
const R = 'user_r', RS = 'relic-secret-relic-secret';
for (let i = 0; i < 30; i++) await db.query(`insert into visits (toilet_id,user_id,tz,at) values ($1,$2,540, ${T0} - make_interval(days => $3))`, ['r' + i, R, i]);
await db.query('select save_profile($1,$2,$3)', [R, RS, JSON.stringify({ nick: 'r', relics: ['d30', 'k3', 'r50'] })]);
s = (await q('select claim_bonus($1,$2) s', [R, RS]))[0].s;
const bonusAmt = (await q(`select amount from claims where user_id=$1 and kind='bonus'`, [R]))[0].amount;
check('유물: 조건을 채운 d30(+5)만 적용, 조건 미달인 r50은 무시 (k3는 변기력 1000 이상이라 +5)', s.titles.includes('d30') && bonusAmt === 60, bonusAmt);

// --- 권한 ---
const priv = async (role, obj, p) => (await q(`select has_table_privilege($1,$2,$3) x`, [role, obj, p]))[0].x;
check('익명 사용자는 claims·purchases 테이블을 직접 못 봄', !(await priv('anon', 'claims', 'select')) && !(await priv('anon', 'purchases', 'insert')));
check('익명 사용자가 지갑 함수는 실행 가능', (await q(`select has_function_privilege('anon','wallet_state(text)','execute') x`))[0].x && (await q(`select has_function_privilege('anon','buy_item(text,text,text)','execute') x`))[0].x);
check('본인 확인 함수는 직접 호출 불가', !(await q(`select has_function_privilege('anon','check_key(text,text)','execute') x`))[0].x);

// --- 도배 방지 트리거 (v2) ---
await db.exec('alter table messages enable trigger all;');
let blocked = null;
for (let i = 0; i < 9 && !blocked; i++) blocked = await fails(`insert into messages (channel,user_id,nick,text) values ('c','spammer','n','x')`);
check('도배 방지: 1분에 9번째 글은 거절', (blocked || '').includes('너무 빨라요'), blocked || '거절되지 않음');

// ================= v7: 본인 확인이 붙은 쓰기 =================
try { await db.exec(readFileSync(new URL('../supabase/schema_v7_signed.sql', import.meta.url), 'utf8')); check('v7을 두 번 실행해도 안전', true); } catch (e) { check('v7을 두 번 실행해도 안전', false, e.message); }
await db.exec('alter table messages disable trigger all;');
const P = 'user_p', PS = 'p-secret-p-secret-p-secret';
check('익명 사용자는 테이블에 직접 쓸 수 없음', !(await priv('anon', 'messages', 'insert')) && !(await priv('anon', 'reports', 'insert')) && !(await priv('anon', 'visits', 'insert')) && !(await priv('anon', 'toilets', 'insert')));
check('익명 사용자가 읽기는 그대로 가능', (await priv('anon', 'messages', 'select')) && (await priv('anon', 'reports', 'select')));
check('익명 사용자가 쓰기 함수는 실행 가능', (await q(`select has_function_privilege('anon','post_report(text,text,text,text,int,text)','execute') x`))[0].x);
await db.query('select post_message($1,$2,$3,$4)', [P, PS, 'area:1', '안녕하세요']);
check('글쓰기: 열쇠로 본인 확인 후 저장', (await q(`select count(*)::int n from messages where user_id=$1`, [P]))[0].n === 1);
check('글쓰기: 남의 열쇠로는 그 사람 이름으로 못 씀', (await fails('select post_message($1,$2,$3,$4)', [P, 'wrong-secret-wrong-secret', 'area:1', '사칭']) || '').includes('본인 확인'));
check('글쓰기: 300자를 넘으면 거절', !!(await fails('select post_message($1,$2,$3,$4)', [P, PS, 'area:1', 'x'.repeat(301)])));
await db.query('select post_report($1,$2,$3,$4,$5)', [P, PS, 'osm1', 'paper', 1]);
check('보고: 저장되고 지갑에 반영', (await state(P)).stats.reports === 1);
check('보고: 없는 항목은 거절', !!(await fails('select post_report($1,$2,$3,$4,$5)', [P, PS, 'osm1', 'hack', 1])));
await db.query('select post_toilet($1,$2,$3,$4,$5,$6)', [P, PS, 'uabc123', 35.0, 135.0, '내가 등록한 곳']);
check('등록: 저장됨', (await q(`select count(*)::int n from toilets where id='uabc123'`))[0].n === 1);
check('등록: 좌표가 범위를 벗어나면 거절', !!(await fails('select post_toilet($1,$2,$3,$4,$5,$6)', [P, PS, 'uabc999', 123.0, 135.0, 'x'])));
// 도착 인증과 이동 속도
await db.query('select post_visit($1,$2,$3,$4,$5,$6,$7,$8)', [P, PS, 'osm_seoul', '서울', 'n', 540, 37.5665, 126.9780]);
check('인증: 저장되고 좌표 기록', (await q(`select lat from visits where user_id=$1 and toilet_id='osm_seoul'`, [P]))[0].lat === 37.5665);
await db.query('select post_visit($1,$2,$3,$4,$5,$6,$7,$8)', [P, PS, 'osm_near', '근처', 'n', 540, 37.5700, 126.9800]);
check('인증: 걸어갈 수 있는 거리는 바로 인증 가능', (await q(`select count(*)::int n from visits where user_id=$1`, [P]))[0].n === 2);
const tp = await fails('select post_visit($1,$2,$3,$4,$5,$6,$7,$8)', [P, PS, 'osm_busan', '부산', 'n', 540, 35.1796, 129.0756]);
check('인증: 서울에서 방금 인증하고 곧바로 부산(325km)은 거절', (tp || '').includes('너무 빨리'), tp || '거절되지 않음');
await db.query(`update visits set at = at - interval '3 hours' where user_id=$1`, [P]);
check('인증: 3시간 뒤라면 부산 인증 가능', (await fails('select post_visit($1,$2,$3,$4,$5,$6,$7,$8)', [P, PS, 'osm_busan', '부산', 'n', 540, 35.1796, 129.0756])) === null);
await db.query(`update visits set at = at - interval '3 hours' where user_id=$1`, [P]);
await db.query('select post_visit($1,$2,$3,$4,$5,$6,$7,$8)', [P, PS, 'uabc123', '등록한 곳', 'n', 540, 37.0, 127.0]);
check('인증: 사용자가 등록한 화장실은 서버에 있는 좌표를 사용(기기가 보낸 좌표 무시)', (await q(`select lat from visits where user_id=$1 and toilet_id='uabc123'`, [P]))[0].lat === 35);
check('거리 계산: 서울~부산 약 325km', Math.abs((await q('select dist_m(37.5665,126.9780,35.1796,129.0756) d'))[0].d - 325000) < 5000);
// 새 탐험가는 몇 명이든 만들 수 있다
let made = 0; for (let i = 0; i < 120; i++) { if ((await fails('select post_report($1,$2,$3,$4,$5)', ['many_' + i, 'many-secret-many-secret-' + i, 'osm1', 'open', 1])) === null) made++; }
check('새 탐험가 수는 제한하지 않음 (120명 모두 가능)', made === 120, made);
check('예전 네트워크 집계표는 남아 있지 않음', (await q(`select to_regclass('public.key_births') r`))[0].r === null);

// ================= v8: 없음 신고와 사진 증거 =================
try { await db.exec(readFileSync(new URL('../supabase/schema_v8_evidence.sql', import.meta.url), 'utf8')); check('v8을 두 번 실행해도 안전', true); } catch (e) { check('v8을 두 번 실행해도 안전', false, e.message); }
const flagsOf = async id => (await q('select * from toilet_flags() where toilet_id = $1', [id]))[0] || { flags: 0, hidden: false };
const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(500);
// 탐험가 셋: 둘은 도착 인증 경험 있음(믿을 만함), 하나는 갓 만든 계정
const TA = 'trust_a', TB = 'trust_b', NW = 'newbie', KA = 'ta-secret-ta-secret-ta', KB = 'tb-secret-tb-secret-tb', KN = 'nw-secret-nw-secret-nw';
await db.query('select post_visit($1,$2,$3,$4,$5,$6,$7,$8)', [TA, KA, 'home_a', 'a', 'a', 540, 36.0, 128.0]);
await db.query('select post_visit($1,$2,$3,$4,$5,$6,$7,$8)', [TB, KB, 'home_b', 'b', 'b', 540, 36.0, 128.0]);
await db.query(`update visits set at = now() - interval '1 day' where user_id in ($1,$2)`, [TA, TB]);
await db.query('select post_report($1,$2,$3,$4,$5)', [NW, KN, 'X', 'flagged', 1]);
await db.query('select post_report($1,$2,$3,$4,$5)', ['newbie2', 'nw2-secret-nw2-secret', 'X', 'flagged', 1]);
check('신고: 도착 인증을 안 해본 계정 둘의 신고로는 숨겨지지 않음', (await flagsOf('X')).hidden === false && (await flagsOf('X')).flags === 0, JSON.stringify(await flagsOf('X')));
await db.query('select post_report($1,$2,$3,$4,$5)', [TA, KA, 'X', 'flagged', 1]);
check('신고: 믿을 만한 탐험가 1명이면 표시만(숨기지 않음)', (await flagsOf('X')).flags === 1 && (await flagsOf('X')).hidden === false);
await db.query('select post_report($1,$2,$3,$4,$5)', [TA, KA, 'X', 'flagged', 1]);
check('신고: 같은 사람이 여러 번 신고해도 1건', (await flagsOf('X')).flags === 1);
await db.query('select post_report($1,$2,$3,$4,$5)', [TB, KB, 'X', 'flagged', 1]);
check('신고: 믿을 만한 탐험가 2명이면 숨김', (await flagsOf('X')).hidden === true);
// 반박: "있어요" 사진
check('사진: 도착 인증을 안 해본 계정은 올릴 수 없음', ((await fails('select post_photo($1,$2,$3,$4,$5)', [NW, KN, 'X', 'exists', IMG])) || '').includes('도착 인증'));
check('사진: 형식이 아니면 거절', !!(await fails('select post_photo($1,$2,$3,$4,$5)', [TA, KA, 'X', 'exists', 'data:image/png;base64,AAA'])));
check('사진: 너무 크면 거절', !!(await fails('select post_photo($1,$2,$3,$4,$5)', [TA, KA, 'X', 'exists', 'data:image/jpeg;base64,' + 'A'.repeat(200001)])));
const P3 = 'trust_c', K3 = 'tc-secret-tc-secret-tc';
await db.query('select post_visit($1,$2,$3,$4,$5,$6,$7,$8)', [P3, K3, 'home_c', 'c', 'c', 540, 36.0, 128.0]);
await db.query(`update visits set at = now() - interval '1 day' where user_id = $1`, [P3]);
const pid = (await q('select post_photo($1,$2,$3,$4,$5,$6) id', [P3, K3, 'X', 'exists', IMG, '📷 c']))[0].id;
check('반박: "있어요" 사진이 올라오면 그 전 신고는 무효', (await flagsOf('X')).flags === 0 && (await flagsOf('X')).hidden === false, JSON.stringify(await flagsOf('X')));
check('사진: 누구나 볼 수 있음', (await q('select count(*)::int n from photos where toilet_id = $1 and not hidden', ['X']))[0].n === 1);
// 부적절 사진 신고
check('사진 신고: 내 사진은 신고 불가', ((await fails('select report_photo($1,$2,$3)', [P3, K3, pid])) || '').includes('내 사진'));
check('사진 신고: 도착 인증 안 해본 계정은 신고 불가', !!(await fails('select report_photo($1,$2,$3)', [NW, KN, pid])));
await db.query('select report_photo($1,$2,$3)', [TA, KA, pid]); await db.query('select report_photo($1,$2,$3)', [TA, KA, pid]);
check('사진 신고: 한 명이 여러 번 눌러도 숨겨지지 않음', (await q('select hidden from photos where id=$1', [pid]))[0].hidden === false);
await db.query('select report_photo($1,$2,$3)', [TB, KB, pid]);
check('사진 신고: 2명이 신고하면 숨김', (await q('select hidden from photos where id=$1', [pid]))[0].hidden === true);
check('사진 신고: 숨겨진 사진이 반박 증거에서 빠지면서 신고가 다시 유효', (await flagsOf('X')).hidden === true);
// 반박: 도착 인증
await db.query(`update visits set at = now() - interval '3 hours' where user_id = $1`, [P3]);
await db.query('select post_visit($1,$2,$3,$4,$5,$6,$7,$8)', [P3, K3, 'X', 'X', 'c', 540, 36.0, 128.0]);
check('반박: 신고 뒤에 누가 도착 인증을 하면 신고 무효', (await flagsOf('X')).flags === 0);
// "없어졌어요" 사진은 신고로 셈
await db.query('select post_photo($1,$2,$3,$4,$5)', [TA, KA, 'Y', 'gone', IMG]);
await db.query('select post_report($1,$2,$3,$4,$5)', [TB, KB, 'Y', 'flagged', 1]);
check('"없어졌어요" 사진 + 신고 1건 = 2명 → 숨김', (await flagsOf('Y')).hidden === true);
// 하루 5장
const P4 = 'trust_d', K4 = 'td-secret-td-secret-td';
await db.query('select post_visit($1,$2,$3,$4,$5,$6,$7,$8)', [P4, K4, 'home_d', 'd', 'd', 540, 36.0, 128.0]);
let up = 0; for (let i = 0; i < 6; i++) if ((await fails('select post_photo($1,$2,$3,$4,$5)', [P4, K4, 'Z' + i, 'exists', IMG])) === null) up++;
check('사진: 하루 5장까지', up === 5, up);
// 지도에 보이는 변기만 집계
check('신고 집계: 고른 변기만 돌려줌', JSON.stringify((await q(`select toilet_id from toilet_flags(array['Y']::text[])`)).map(r => r.toilet_id)) === '["Y"]');
check('신고 집계: 고른 변기에 신고가 없으면 빈 결과', (await q(`select * from toilet_flags(array['nothing']::text[])`)).length === 0);
// 미리보기와 변기당 사진 수 제한
const TH = 'data:image/jpeg;base64,' + 'B'.repeat(300);
const P5 = 'trust_e', K5 = 'te-secret-te-secret-te', P6 = 'trust_f', K6 = 'tf-secret-tf-secret-tf';
for (const [p, k] of [[P5, K5], [P6, K6]]) { await db.query('select post_visit($1,$2,$3,$4,$5,$6,$7,$8)', [p, k, 'home_' + p, 'h', 'h', 540, 36.0, 128.0]); }
await db.query('select post_photo($1,$2,$3,$4,$5,$6,$7)', [P5, K5, 'W', 'exists', IMG, 'e', TH]);
check('사진: 미리보기가 함께 저장', (await q(`select thumb from photos where toilet_id='W'`))[0].thumb === TH);
await db.query('select post_photo($1,$2,$3,$4,$5,$6,$7)', [P5, K5, 'W', 'exists', IMG, 'e', 'javascript:alert(1)']);
check('사진: 형식이 틀린 미리보기는 버림', (await q(`select thumb from photos where toilet_id='W' order by id desc limit 1`))[0].thumb === null);
for (let i = 0; i < 3; i++) await db.query('select post_photo($1,$2,$3,$4,$5)', [P5, K5, 'W', 'exists', IMG]);
for (let i = 0; i < 5; i++) await db.query('select post_photo($1,$2,$3,$4,$5)', [P6, K6, 'W', 'exists', IMG]);
check('사진: 변기 하나에 최근 8장만 남음', (await q(`select count(*)::int n from photos where toilet_id='W'`))[0].n === 8);
const st = (await q(`select toilet_stats('X', $1) s`, [P3]))[0].s;
const vX = (await q(`select count(*)::int n, count(distinct user_id)::int e from visits where toilet_id='X'`))[0];
check('변기 기록: 서버가 방문 수·탐험가 수·내 방문을 셈', st.visits === vX.n && st.explorers === vX.e && st.mine >= 1 && st.first_nick === 'c', JSON.stringify(st));
check('변기 기록: 기록이 없는 변기는 0', (await q(`select toilet_stats('nowhere') s`))[0].s.visits === 0);
check('익명 사용자는 숨김 여부 칸을 직접 볼 수 없음', !(await q(`select has_column_privilege('anon','photos','hidden','select') x`))[0].x);
check('익명 사용자는 사진 테이블에 직접 쓸 수 없음', !(await priv('anon', 'photos', 'insert')));

// v9: 앱 광고 보너스 (위에서 v6을 다시 실행해 지갑 계산이 옛것으로 돌아갔으므로 v9을 다시 적용)
await db.exec(readFileSync(new URL('../supabase/schema_v9_ads.sql', import.meta.url), 'utf8'));
{
  const A = 'ad_user', AK = 'ad-secret-ad-secret-ad';
  let w = (await q('select claim_bonus($1,$2) s', [A, AK]))[0].s;
  const base = w.coins;
  check('광고 보너스: 오늘의 보너스와 따로 셈', w.bonus_today === true && w.ads_today === 0);
  w = (await q('select claim_ad_bonus($1,$2) s', [A, AK]))[0].s;
  check('광고 보너스: 한 번에 +30', w.coins === base + 30 && w.ads_today === 1 && w.bonus_today === true);
  check('광고 보너스: 너무 빨리 다시 받으면 거절', ((await fails('select claim_ad_bonus($1,$2)', [A, AK])) || '').includes('잠시 후'));
  await db.query(`update claims set at = at - interval '1 minute' where user_id = $1`, [A]);
  await q('select claim_ad_bonus($1,$2)', [A, AK]);
  await db.query(`update claims set at = at - interval '1 minute' where user_id = $1`, [A]);
  w = (await q('select claim_ad_bonus($1,$2) s', [A, AK]))[0].s;
  await db.query(`update claims set at = at - interval '1 minute' where user_id = $1`, [A]);
  check('광고 보너스: 하루 3번까지', w.ads_today === 3 && w.coins === base + 90 && ((await fails('select claim_ad_bonus($1,$2)', [A, AK])) || '').includes('다 받았'));
  check('광고 보너스: 남의 열쇠로는 못 받음', ((await fails('select claim_ad_bonus($1,$2)', [A, 'another-secret-another-secret'])) || '').includes('본인 확인'));
  const B2 = 'ad_user2', BK = 'ad2-secret-ad2-secret-a';
  w = (await q('select claim_ad_bonus($1,$2) s', [B2, BK]))[0].s;
  check('광고 보너스: 광고를 먼저 봐도 오늘의 보너스는 그대로 받을 수 있음', w.bonus_today === false && w.ads_today === 1);
  check('광고 보너스: 변기력(XP)에는 안 들어감', w.xp === 0);
  try { await db.exec(readFileSync(new URL('../supabase/schema_v9_ads.sql', import.meta.url), 'utf8')); check('v9을 두 번 실행해도 안전', true); } catch (e) { check('v9을 두 번 실행해도 안전', false, e.message); }
}

const bad = results.filter(x => !x).length;
console.log(`\n${results.length - bad}/${results.length} 통과`);
process.exit(bad ? 1 : 0);
