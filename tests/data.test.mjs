// 데이터 미리 받기 스크립트 점검. 가짜 Overpass 서버를 띄워서 타일 나누기, 실패 처리, 발행 기준을 확인한다.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d !== '' ? ' — ' + d : ''}`); };
let calls = 0;
const srv = createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    calls++;
    const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
    const m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/); const [s, w] = [Number(m[1]), Number(m[2])];
    if (s === 26 && w === 126) { res.writeHead(504); return res.end('gateway timeout'); }  // 이 상자는 항상 실패
    const els = [];
    if (s === 34 && w === 138) for (let i = 0; i < 30; i++) els.push({ type: 'node', id: 1000 + i, lat: 35.6 + i * 0.001, lon: 139.7, tags: { amenity: 'toilets', name: '도쿄' + i, wheelchair: 'yes' } });
    if (s === 36 && w === 126) { els.push({ type: 'way', id: 77, center: { lat: 37.5665, lon: 126.978 }, tags: { amenity: 'toilets', 'name:ko': '시청 화장실', fee: 'yes', changing_table: 'yes', opening_hours: '24/7' } }); els.push({ type: 'node', id: 1000, lat: 35.6, lon: 139.7, tags: {} }); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ elements: els }));
  });
}).listen(0);
const port = srv.address().port;
// 실패 상자는 재시도 대기가 길어서, 시험에서는 재시도 대기를 줄인 사본으로 돌린다
const src = readFileSync(new URL('../tools/build-toilet-data.mjs', import.meta.url), 'utf8').replace('[15000, 45000, 90000, 0]', '[0, 0, 0, 0]');
const fast = new URL('./.build-fast.mjs', import.meta.url).pathname;
(await import('node:fs')).writeFileSync(fast, src);
// 가짜 서버가 같은 프로세스에 있으므로, 스크립트는 반드시 비동기로 실행해야 서로 막히지 않는다
const runFast = (out, extra = {}) => new Promise(res => execFile('node', [fast, out], { env: Object.assign({}, process.env, { OVERPASS_URLS: `http://127.0.0.1:${port}/api/interpreter`, REGION: '24,122,40,140', STEP: '2', MIN_TOTAL: '10', PAUSE_MS: '0' }, extra), timeout: 120000 }, err => res(err ? (err.code || 1) : 0)));

const out = '/tmp/ta-data-test'; rmSync(out, { recursive: true, force: true });
check('정상 실행', (await runFast(out)) === 0);
const ix = JSON.parse(readFileSync(out + '/index.json', 'utf8'));
check('합계: 중복(같은 id)을 빼고 31곳', ix.total === 31, ix.total);
check('도쿄 30곳은 0.5도 타일 71_279에', ix.tiles['71_279'] === 30, JSON.stringify(ix.tiles));
const seoul = JSON.parse(readFileSync(out + '/t/75_253.json', 'utf8')).t;
check('서울 시청: way는 osmw, 이름은 name:ko, 표시(유료+기저귀=9), 개방시간', seoul.length === 1 && seoul[0][0] === 'osmw77' && seoul[0][3] === '시청 화장실' && seoul[0][4] === 9 && seoul[0][5] === '24/7', JSON.stringify(seoul[0]));
check('실패한 상자는 missing에 기록 (앱이 그 지역만 직접 묻게)', JSON.stringify(ix.missing) === JSON.stringify([[26, 126, 28, 128]]), JSON.stringify(ix.missing));
check('출처와 라이선스 표기 파일', existsSync(out + '/LICENSE.txt') && ix.license === 'ODbL 1.0');
check('타일 파일 수 = 화장실이 있는 칸 수', readdirSync(out + '/t').length === Object.keys(ix.tiles).length);
check('너무 적게 받으면 발행하지 않음(실패로 끝남)', (await runFast('/tmp/ta-data-test2', { MIN_TOTAL: '1000' })) !== 0 && !existsSync('/tmp/ta-data-test2/index.json'));
check('실패 상자가 3분의 1을 넘으면 발행하지 않음', (await runFast('/tmp/ta-data-test3', { REGION: '26,126,28,130', STEP: '2', MIN_TOTAL: '0' })) !== 0);
srv.close(); rmSync(fast, { force: true });
const bad = results.filter(x => !x).length; console.log(`\n${results.length - bad}/${results.length} 통과`); process.exit(bad ? 1 : 0);
