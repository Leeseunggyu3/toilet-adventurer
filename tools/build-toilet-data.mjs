// 화장실 데이터 미리 받기. GitHub Actions에서 일주일에 한 번 실행된다 (.github/workflows/toilet-data.yml).
// OpenStreetMap(Overpass)에서 한국·일본 지역의 화장실을 2도×2도 상자 단위로 천천히 받아서,
// 0.5도×0.5도 칸(타일)별 JSON 파일로 나눠 저장한다. 앱은 이 파일을 먼저 쓰고, 없을 때만 Overpass에 직접 묻는다.
//
// 실행: node tools/build-toilet-data.mjs <출력 폴더>
// 환경 변수: OVERPASS_URLS (쉼표로 구분, 앞에서부터 시도), REGION (s,w,n,e), STEP (상자 크기, 도), MIN_TOTAL, PAUSE_MS
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || 'out';
const ENDPOINTS = (process.env.OVERPASS_URLS || 'https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter').split(',').map(s => s.trim()).filter(Boolean);
const [S, W, N, E] = (process.env.REGION || '24,122,46,154').split(',').map(Number);  // 한국과 일본을 덮는 범위
const STEP = Number(process.env.STEP || 2);
const MIN_TOTAL = Number(process.env.MIN_TOTAL || 5000);  // 이보다 적으면 뭔가 잘못된 것으로 보고 발행하지 않는다
const PAUSE = Number(process.env.PAUSE_MS || 3000);       // 공용 서버에 부담을 주지 않도록 요청 사이에 쉰다
const UA = 'ToiletAdventure-data-refresh/1 (+https://github.com/Leeseunggyu3/toilet-adventurer)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r6 = x => Math.round(x * 1e6) / 1e6;

async function fetchBox(s, w, n, e) {
  const q = `[out:json][timeout:180];(node["amenity"="toilets"](${s},${w},${n},${e});way["amenity"="toilets"](${s},${w},${n},${e}););out center tags;`;
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(240000) });
        if (r.ok) { const j = await r.json(); if (j.remark && /runtime error|timed out|out of memory/i.test(j.remark)) throw new Error(j.remark.slice(0, 120)); return j.elements || []; }
        last = `${url} → ${r.status}`;
      } catch (err) { last = `${url} → ${String(err.message || err).slice(0, 120)}`; }
      await sleep(PAUSE);
    }
    await sleep([15000, 45000, 90000, 0][attempt]);
  }
  throw new Error(last);
}

// 한 줄 = [id, 위도, 경도, 이름, 표시, 개방시간]
// 표시(비트): 1 유료, 2 휠체어, 4 남녀공용, 8 기저귀교환대
function toRow(el) {
  const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  const t = el.tags || {};
  const flags = (t.fee === 'yes' ? 1 : 0) | (t.wheelchair === 'yes' ? 2 : 0) | (t.unisex === 'yes' ? 4 : 0) | (t.changing_table === 'yes' ? 8 : 0);
  const id = (el.type === 'way' ? 'osmw' : 'osm') + el.id;
  return [id, r6(lat), r6(lng), (t.name || t['name:ko'] || t['name:en'] || '').slice(0, 80), flags, (t.opening_hours || '').slice(0, 60)];
}

const all = new Map(), missing = [];
const boxes = [];
for (let s = S; s < N; s += STEP) for (let w = W; w < E; w += STEP) boxes.push([s, w, Math.min(s + STEP, N), Math.min(w + STEP, E)]);
console.log(`상자 ${boxes.length}개, 서버 ${ENDPOINTS.join(' / ')}`);
let i = 0;
for (const [s, w, n, e] of boxes) {
  i++;
  try {
    const els = await fetchBox(s, w, n, e);
    let added = 0; for (const el of els) { const row = toRow(el); if (row && !all.has(row[0])) { all.set(row[0], row); added++; } }
    if (added) console.log(`[${i}/${boxes.length}] ${s},${w} ~ ${n},${e}: ${added}곳`);
  } catch (err) {
    missing.push([s, w, n, e]);
    console.log(`[${i}/${boxes.length}] ${s},${w} ~ ${n},${e}: 실패 (${err.message}) — 이 지역은 앱이 직접 Overpass에 묻게 된다`);
  }
  await sleep(PAUSE);
}

const tiles = {};
for (const row of all.values()) {
  const key = `${Math.floor(row[1] * 2)}_${Math.floor(row[2] * 2)}`;
  (tiles[key] || (tiles[key] = [])).push(row);
}
console.log(`합계 ${all.size}곳, 타일 ${Object.keys(tiles).length}개, 실패 상자 ${missing.length}개`);
if (all.size < MIN_TOTAL) { console.error(`화장실이 ${all.size}곳뿐이라 이상하다고 보고 발행하지 않습니다 (기준 ${MIN_TOTAL})`); process.exit(1); }
if (missing.length > boxes.length / 3) { console.error('실패한 상자가 너무 많아 발행하지 않습니다'); process.exit(1); }

mkdirSync(join(OUT, 't'), { recursive: true });
const counts = {};
for (const [key, rows] of Object.entries(tiles)) {
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  writeFileSync(join(OUT, 't', key + '.json'), JSON.stringify({ v: 1, t: rows }));
  counts[key] = rows.length;
}
const index = { v: 1, at: new Date().toISOString(), source: 'OpenStreetMap (Overpass API)', license: 'ODbL 1.0', region: { s: S, w: W, n: N, e: E }, tile: 0.5, total: all.size, missing, tiles: counts };
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));
writeFileSync(join(OUT, 'LICENSE.txt'), 'This folder contains information from OpenStreetMap (https://www.openstreetmap.org), which is made available here under the Open Database License (ODbL) 1.0: https://opendatacommons.org/licenses/odbl/1-0/\n© OpenStreetMap contributors.\n');
console.log('완료:', OUT);
