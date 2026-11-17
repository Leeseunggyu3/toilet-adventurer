/* Toilet Adventure — app.js */
(() => {
  const $ = id => document.getElementById(id);
  const toast = (m, ms = 1800) => { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); };

  // ===== 지도 =====
  const DEFAULT = [37.5665, 126.9780]; // 서울시청 (위치 거부 시)
  const map = L.map('map', { zoomControl: false, attributionControl: false }).setView(DEFAULT, 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  let me = null, meMarker = null, meAcc = null, routeLine = null;

  // ===== 상태 =====
  const toilets = new Map();   // id -> {id, lat, lng, name, src, tags}
  const markers = new Map();
  let sel = null, sosList = [], sosIdx = 0, mission = null;
  const fetched = new Set();   // 이미 불러온 타일 키

  // ===== 유틸 =====
  const dist = (a, b, c, d) => { const R = 6371000, p = Math.PI / 180, dl = (c - a) * p, dn = (d - b) * p; const h = Math.sin(dl / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const fmtD = m => m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
  const walkMin = m => Math.max(1, Math.round(m / 75));
  const enc = encodeURIComponent;

  // ===== 레벨/랭크 =====
  // 경지: 변기력이 쌓이면 물의 흐름처럼 깊어진다
  const RANKS = [[0, '잠든 물방울'], [100, '첫 물결'], [400, '고요한 수면'], [1000, '소용돌이'], [2500, '깊은 흐름'], [6000, '맑은 근원'], [15000, '무한수류']];
  // 프로필에는 한국어 원문으로 저장한다 (보는 사람의 언어로 각자 번역됨)
  function rankName() { let i = 0; for (let j = 0; j < RANKS.length; j++) if (Store.xp >= RANKS[j][0]) i = j; return RANKS[i][1]; }
  function refreshHUD() {
    $('coins').textContent = Store.coins.toLocaleString();
    // 변기력(누적 경험치)과 등급. 게이지는 다음 등급까지 남은 정도
    let i = 0; for (let j = 0; j < RANKS.length; j++) if (Store.xp >= RANKS[j][0]) i = j;
    const cur = RANKS[i][0], nxt = RANKS[i + 1] ? RANKS[i + 1][0] : null;
    $('level').textContent = Store.xp.toLocaleString();
    $('xpfill').style.width = nxt ? `${((Store.xp - cur) / (nxt - cur)) * 100}%` : '100%';
    if (window._lastRank !== undefined && i > window._lastRank) setTimeout(() => toast(`🌊 경지 상승: ${RANKS[i][1]}`, 3500), 1900);
    window._lastRank = i;
    $('rankLabel').textContent = RANKS[i][1];
  }
  // ===== 지갑 =====
  // 서버 지갑(serverMode): 코인·변기력·칭호·구매를 서버가 기록에서 직접 계산한다. 기기는 결과를 보여주기만 한다.
  // 예전 방식(기기 계산)은 서버에 v6 스키마가 없거나 데모 모드일 때만 쓴다.
  let srv = null, serverMode = false, whyQ = [], walletT = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function applyWallet(st) {
    const prev = srv ? srv.earned : null;
    srv = st; serverMode = true;
    Store.setWallet(st.coins, st.xp); refreshHUD();
    if (typeof onWallet === 'function') onWallet();
    return prev === null ? 0 : st.earned - prev;
  }
  async function refreshWallet() { return applyWallet(await window.Backend.walletState()); }
  function reward(c, why) {
    if (!serverMode) { Store.earn(c); refreshHUD(); toast(`+${c}💰 ${why}`); return; }
    // 서버 지갑: 기록이 서버에 닿은 뒤 다시 계산해서, 실제로 늘어난 만큼만 알려준다
    whyQ.push(why); clearTimeout(walletT);
    walletT = setTimeout(async () => {
      let d = 0;
      try { d = await refreshWallet(); if (d <= 0) { await sleep(1500); d = await refreshWallet(); } } catch (e) { console.warn('wallet', e); }
      const w = whyQ.splice(0); if (!w.length) return;
      toast(d > 0 ? `+${d}💰 ${w[0]}` : w[0], 2200);
    }, 900);
  }

  // ===== 화장실 데이터 (OSM Overpass, 사용자 등록) =====
  function tileKey(lat, lng) { return `${Math.floor(lat * 50)}:${Math.floor(lng * 50)}`; } // ~2km 격자
  // 격자 한 칸(약 2km) 전체를 불러온다. 예전에는 '처음 본 지점 주변 1.3km'만 불러와서 같은 칸 안의 먼 곳이 비는 문제가 있었다
  // ===== 미리 받아둔 화장실 데이터 (data/ 폴더, 매주 갱신) =====
  // index.json: 덮는 지역, 실패한 지역(missing), 타일별 개수. 타일 = 0.5도 칸, 파일 data/t/{floor(위도*2)}_{floor(경도*2)}.json
  // 앱에는 화장실 데이터가 들어 있지 않다. 매주 바뀌는 데이터를 웹사이트에서 받아온다
  const NATIVE = !!(window.Auth && window.Auth.native);
  const DATA = NATIVE ? String((window.GHC_CONFIG || {}).WEB_URL || 'https://leeseunggyu3.github.io/toilet-adventurer/').replace(/\/?$/, '/') + 'data/' : 'data/';
  let dataIndex; // undefined = 아직 안 봄, null = 없음
  async function getIndex() {
    if (dataIndex !== undefined) return dataIndex;
    try { const r = await fetch(DATA + 'index.json', { cache: 'no-cache' }); dataIndex = r.ok ? await r.json() : null; } catch (e) { dataIndex = null; }
    if (dataIndex && !(dataIndex.region && dataIndex.tiles)) dataIndex = null;
    return dataIndex;
  }
  function covered(ix, lat, lng) {
    const g = ix.region;
    if (!(lat >= g.s && lat < g.n && lng >= g.w && lng < g.e)) return false;
    return !(ix.missing || []).some(b => lat >= b[0] && lat < b[2] && lng >= b[1] && lng < b[3]);
  }
  const tileCache = new Map();
  function getTile(key) {
    if (!tileCache.has(key)) {
      const p = fetch(`${DATA}t/${key}.json?d=${encodeURIComponent(dataIndex.at || '')}`).then(r => { if (!r.ok) throw new Error('tile ' + r.status); return r.json(); }).then(j => j.t || []);
      p.catch(() => tileCache.delete(key)); tileCache.set(key, p);
    }
    return tileCache.get(key);
  }
  function rowToToilet(r) {
    const f = r[4] || 0, tags = {};
    if (f & 1) tags.fee = 'yes'; if (f & 2) tags.wheelchair = 'yes'; if (f & 4) tags.unisex = 'yes'; if (f & 8) tags.changing_table = 'yes'; if (r[5]) tags.opening_hours = r[5];
    return { id: r[0], lat: r[1], lng: r[2], name: r[3] || '공중화장실', src: 'osm', tags };
  }
  // 이 칸(s~n, w~e)의 화장실. 미리 받아둔 데이터가 이 지역을 덮지 않거나 불러오기에 실패하면 null (→ Overpass로)
  async function fromPrebuilt(lat, lng, s, w, n, e) {
    const ix = await getIndex();
    if (!ix || !covered(ix, lat, lng)) return null;
    // 이 지점의 타일에 데이터가 없으면(바다, 다른 나라 땅, 데이터가 빈 곳) 미리 받은 데이터를 믿지 않고 Overpass로
    if (!ix.tiles[`${Math.floor(lat * 2)}_${Math.floor(lng * 2)}`]) return null;
    const keys = new Set();
    for (const a1 of [s, n]) for (const b1 of [w, e]) keys.add(`${Math.floor(a1 * 2)}_${Math.floor(b1 * 2)}`);
    try {
      let rows = [];
      for (const key of keys) if (ix.tiles[key]) rows = rows.concat(await getTile(key));
      return rows.filter(r => r[1] >= s && r[1] <= n && r[2] >= w && r[2] <= e).map(rowToToilet);
    } catch (err) { return null; }
  }

  async function loadCell(lat, lng) {
    const k = tileKey(lat, lng); if (fetched.has(k)) return; fetched.add(k);
    const gx = Math.floor(lat * 50), gy = Math.floor(lng * 50), pad = 0.003;
    const s = gx / 50 - pad, n = (gx + 1) / 50 + pad, w = gy / 50 - pad, e2 = (gy + 1) / 50 + pad;
    const q = `[out:json][timeout:20];(node["amenity"="toilets"](${s},${w},${n},${e2});way["amenity"="toilets"](${s},${w},${n},${e2}););out center 300;`;
    const cacheKey = 'ghc-osm2-' + k;
    let data = await fromPrebuilt(lat, lng, s, w, n, e2);  // 1순위: 우리 사이트에 미리 받아둔 데이터
    if (!data) try { const c = JSON.parse(localStorage.getItem(cacheKey) || 'null'); if (c && Date.now() - c.t < 7 * 864e5) data = c.d; } catch (e) {}
    if (!data) {  // 미리 받아둔 데이터가 없는 지역만 Overpass에 직접 묻는다
      try {
        const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + enc(q) });
        const j = await r.json();
        data = (j.elements || []).map(e => ({ id: (e.type === 'way' ? 'osmw' : 'osm') + e.id, lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon, name: e.tags?.name || e.tags?.['name:ko'] || '공중화장실', src: 'osm', tags: e.tags || {} })).filter(t => t.lat && t.lng);
        try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), d: data })); } catch (e) {}
      } catch (e) { fetched.delete(k); toast('화장실 데이터를 불러오지 못했어요 (네트워크)'); return; }
    }
    let cnt = 0; for (const t of data) if (!toilets.has(t.id)) { toilets.set(t.id, t); addMarker(t); cnt++; }
    return cnt;
  }
  // 현재 칸 + (가장자리에 가까우면) 이웃 칸. Overpass에 부담을 주지 않도록 한 번에 하나씩 순서대로 요청한다
  let loadChain = Promise.resolve();
  function loadAround(lat, lng) {
    const d = 0.006, pts = [[lat, lng], [lat + d, lng], [lat - d, lng], [lat, lng + d], [lat, lng - d]];
    const seen = new Set();
    for (const [a1, b1] of pts) {
      const k = tileKey(a1, b1); if (seen.has(k) || fetched.has(k)) continue; seen.add(k);
      loadChain = loadChain.then(() => loadCell(a1, b1)).then(c => { if (c) toast(`주변 화장실 ${c}곳 불러옴`); }).catch(() => {});
    }
    return loadChain;
  }
  // 예전 형식의 지도 캐시 정리 (저장 공간 확보)
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('ghc-osm-')) localStorage.removeItem(k); } } catch (e) {}
  function describe(t) {
    const tg = t.tags || {}, bits = [];
    if (tg.fee === 'yes') bits.push('유료'); if (tg.wheelchair === 'yes') bits.push('♿ 휠체어'); if (tg.opening_hours) bits.push(tg.opening_hours);
    if (tg.unisex === 'yes') bits.push('남녀공용'); if (tg.changing_table === 'yes') bits.push('기저귀교환대');
    if (t.src === 'user') bits.push(t.by ? `${t.by} 님이 등록` : '사용자 등록');
    if (t.flags) bits.push(`⚠️ 없다는 신고 ${t.flags}건`);
    return bits.join(' · ');
  }

  // ===== 마커 =====
  function cls(t) {
    if (t.src === 'user') return 'user';
    const o = Store.fresh(t.id, 'open', 6);
    return o === 0 ? 'closed' : o === 1 ? 'ok' : '';
  }
  function icon(t, target) { return L.divIcon({ className: '', html: `<div class="tmark ${target ? 'target' : cls(t)}"><i>🚻</i></div>`, iconSize: [34, 34], iconAnchor: [17, 34] }); }
  function addMarker(t) {
    const m = L.marker([t.lat, t.lng], { icon: icon(t) }).addTo(layer).on('click', () => openSheet(t));
    markers.set(t.id, m);
  }
  function restyle() { for (const [id, m] of markers) m.setIcon(icon(toilets.get(id), sel && sosList[sosIdx] === toilets.get(id) && !$('sos').classList.contains('hidden'))); }

  // ===== 내 위치 =====
  function locate(first) {
    if (!navigator.geolocation) { toast('이 기기는 위치를 지원하지 않아요'); return; }
    navigator.geolocation.getCurrentPosition(pos => {
      me = [pos.coords.latitude, pos.coords.longitude];
      drawMe(pos.coords.accuracy);
      if (first) map.setView(me, 16); else map.panTo(me);
      loadAround(me[0], me[1]);
    }, err => {
      const inApp = /FBAN|FBAV|Instagram|KAKAOTALK|Line\/|NAVER\(inapp|wv\)/i.test(navigator.userAgent);
      const msg = err.code === 1
        ? (inApp ? '인앱 브라우저는 위치를 못 써요. 크롬/사파리로 열어주세요' : '위치 권한이 꺼져 있어요. 주소창 자물쇠 → 권한 → 위치 허용 후 📍')
        : err.code === 3 ? 'GPS 신호를 못 잡았어요 (실내?). 📍 눌러 다시 시도' : '위치를 가져올 수 없어요. 폰 위치(GPS)가 켜져 있나요?';
      toast(msg, 4500);
      if (!location.protocol.startsWith('https') && location.hostname !== 'localhost') toast('HTTPS가 아니면 위치를 쓸 수 없어요', 4000);
      if (first) loadAround(...DEFAULT);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 });
  }
  function drawMe(acc) {
    if (!meMarker) { meMarker = L.marker(me, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(map); meAcc = L.circle(me, { radius: acc || 30, color: '#2b7cff', weight: 1, fillOpacity: .08 }).addTo(map); }
    else { meMarker.setLatLng(me); meAcc.setLatLng(me).setRadius(acc || 30); }
  }
  if (navigator.geolocation) navigator.geolocation.watchPosition(p => { me = [p.coords.latitude, p.coords.longitude]; drawMe(p.coords.accuracy); }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
  map.on('moveend', () => { const c = map.getCenter(); if (map.getZoom() >= 14) loadAround(c.lat, c.lng); });

  // ===== 길찾기 링크 =====
  function navLinks(t, k, n, g) {
    $(k).href = `https://map.kakao.com/link/to/${enc(t.name)},${t.lat},${t.lng}`;
    $(n).href = `https://map.naver.com/p/directions/-/${t.lng},${t.lat},${enc(t.name)},,/-/walk`;
    $(g).href = `https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lng}&travelmode=walking`;
  }

  // ===== 상세 시트 =====
  function openSheet(t) {
    sel = t; $('sos').classList.add('hidden'); $('sheet').classList.remove('hidden');
    $('shName').textContent = t.name;
    const d = me ? dist(me[0], me[1], t.lat, t.lng) : null;
    $('shMeta').textContent = [d != null ? `${fmtD(d)} · 도보 ${walkMin(d)}분` : '', describe(t)].filter(Boolean).join(' · ');
    renderStatus(t); renderFlagNote(t); loadPhotos(t);
    navLinks(t, 'navKakao', 'navNaver', 'navGoogle');
    const vb = $('verifyBtn'); vb.disabled = !Store.canVerify(t.id);
    vb.textContent = vb.disabled ? '✅ 오늘 이미 인증했어요' : `✅ 도착 인증 (${50 + rb('range')}m 이내) +30💰`;
    document.querySelectorAll('.reports button').forEach(b => { const f = Store.fresh(t.id, b.dataset.k, 12); b.classList.toggle('done', f !== null && String(f) === b.dataset.v); });
    map.panTo([t.lat, t.lng]);
  }
  function renderStatus(t) {
    const L2 = { open: ['열려있음', '잠김/폐쇄'], paper: ['휴지 있음', '휴지 없음'], clean: ['깨끗함', '더러움'], queue: ['줄 없음', '줄 김'] };
    const el = $('shStatus'); el.innerHTML = '';
    let any = false;
    for (const k in L2) {
      const f = Store.fresh(t.id, k, 12); if (f === null) continue; any = true;
      const good = (k === 'queue') ? f === 0 : f === 1;
      const r = Store.reportsFor(t.id)[k]; const ago = Math.round((Date.now() - r.t) / 60000);
      const s = document.createElement('span'); s.className = good ? 'good' : 'bad'; s.textContent = `${good ? L2[k][0] : L2[k][1]} · ${ago < 60 ? ago + '분 전' : Math.round(ago / 60) + '시간 전'}`; el.appendChild(s);
    }
    if (!any) { const s = document.createElement('span'); s.textContent = '아직 최근 상태 보고가 없어요 — 첫 보고자가 되어보세요'; el.appendChild(s); }
  }
  $('shClose').onclick = () => { $('sheet').classList.add('hidden'); sel = null; };
  document.querySelectorAll('.reports button').forEach(b => b.onclick = () => {
    if (!sel) return;
    const near = me && dist(me[0], me[1], sel.lat, sel.lng) < 150;
    Store.report(sel.id, b.dataset.k, +b.dataset.v);
    window.Backend.postReport(sel.id, b.dataset.k, +b.dataset.v).catch(e => toast('보고 공유 실패: ' + String(e.message || e).slice(0, 100), 6000));
    renderStatus(sel); restyle();
    document.querySelectorAll('.reports button').forEach(x => { if (x.dataset.k === b.dataset.k) x.classList.toggle('done', x === b); });
    // 같은 변기의 같은 항목은 30분에 한 번만 보상 (연타로 코인을 불리지 못하게)
    const ck = sel.id + ':' + b.dataset.k, cd = (ach.rcd || (ach.rcd = {}));
    if (Date.now() - (cd[ck] || 0) < 30 * 60000) { achSave(); return toast('보고를 고쳤어요 (같은 항목 보상은 30분마다)'); }
    cd[ck] = Date.now(); for (const key in cd) if (Date.now() - cd[key] > 2 * HOUR) delete cd[key];
    achEvent('rep');
    reward(5, near ? '현장 보고!' : '상태 보고');
    checkDaily();
  });
  let missionDone = null; // 방금 인증으로 끝낸 미션의 변기 (서버 지갑에서는 인증 기록이 올라간 뒤 보상을 청구한다)
  $('verifyBtn').onclick = () => {
    if (!sel) return;
    if (!me) return toast('위치를 먼저 켜주세요');
    const d = dist(me[0], me[1], sel.lat, sel.lng);
    const lim = 50 + rb('range');
    if (d > lim) return toast(`${fmtD(d)} 떨어져 있어요. ${lim}m 안에서 인증!`);
    Store.verify(sel.id); achEvent('visit', sel.id); reward(30, '도착 인증!'); checkDaily();
    if (mission && mission.id === sel.id) { missionDone = sel.id; if (!serverMode) reward(mission.bonus, '미션 완료!'); mission = null; $('mission').classList.add('hidden'); }
    openSheet(sel);
  };
  $('flagBtn').onclick = () => { if (!sel) return; Store.flag(sel.id); const t = sel; window.Backend.postReport(t.id, 'flagged', 1).then(() => syncShared(true)).catch(() => {}); toast('신고 접수. 도착 인증을 해본 탐험가 2명 이상이 신고하면 변기탐지에서 빠져요', 3500); };

  // ===== 없음 신고 안내 · 사진 증거 =====
  function renderFlagNote(t) {
    const el = $('flagNote');
    if (!t.flags) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.textContent = t.flagged
      ? `⚠️ 탐험가 ${t.flags}명이 "여기 화장실이 없다"고 해서 변기탐지에서 빠져 있어요. 실제로 있다면 도착 인증이나 "있어요 사진"으로 알려주세요. 바로 다시 안내돼요.`
      : `⚠️ "여기 화장실이 없다"는 신고가 ${t.flags}건 있어요. 지금 있다면 도착 인증이나 "있어요 사진"으로 알려주세요.`;
  }
  let photoKind = 'exists', photoRows = [];
  async function loadPhotos(t) {
    const el = $('photos'); el.innerHTML = '';
    let rows = []; try { rows = await window.Backend.listPhotos(t.id); } catch (e) {}
    if (sel !== t) return;
    photoRows = rows;
    el.innerHTML = rows.length
      ? rows.map((p, i) => { const src = jpeg(p.thumb) || jpeg(p.data); return `<button class="ph ${p.kind === 'gone' ? 'gone' : ''}" data-i="${i}">${src ? `<img src="${src}" alt="" loading="lazy">` : '<b>📷</b>'}<span>${p.kind === 'gone' ? '없어짐' : '있음'}</span></button>`; }).join('')
      : '<div class="none">아직 사진이 없어요</div>';
    el.querySelectorAll('.ph').forEach(b => b.onclick = () => openPhoto(photoRows[+b.dataset.i]));
  }
  const jpeg = d => typeof d === 'string' && d.startsWith('data:image/jpeg;base64,') ? d : '';
  let viewing = null;
  async function openPhoto(p) {
    viewing = p; $('photoBig').src = jpeg(p.thumb) || jpeg(p.data);
    $('photoMeta').textContent = `${p.kind === 'gone' ? '없어졌어요' : '있어요'} · ${p.nick || '탐험가'} · ${ago(p.at)}`;
    $('photoReport').classList.toggle('hidden', p.user_id === B.me().id);
    $('photoView').classList.remove('hidden');
    if (!jpeg(p.data)) { try { p.data = await window.Backend.photoData(p.id); } catch (e) {} if (viewing === p && jpeg(p.data)) $('photoBig').src = p.data; }
  }
  $('photoClose').onclick = () => { $('photoView').classList.add('hidden'); $('photoBig').src = ''; viewing = null; };
  $('photoReport').onclick = async () => {
    if (!viewing) return;
    try { const hid = await window.Backend.reportPhoto(viewing.id); toast(hid ? '신고가 모여 사진을 숨겼어요' : '신고했어요. 2명 이상 신고하면 숨겨져요', 3000); }
    catch (e) { toast('신고 실패: ' + String(e.message || e).slice(0, 120), 5000); }
    $('photoClose').onclick(); if (sel) loadPhotos(sel);
  };
  // 사진 줄이기: 긴 변 720px JPEG로 다시 그린다. 다시 그리면 사진 속 위치 정보(EXIF)가 사라진다
  // 원본은 약 110KB 이하, 목록용 미리보기(긴 변 160px)는 약 12KB 이하
  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new Error('사진을 읽지 못했어요')); im.src = url; });
      const draw = (max, qlt) => {
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(img.naturalWidth * k)); cv.height = Math.max(1, Math.round(img.naturalHeight * k));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        return cv.toDataURL('image/jpeg', qlt);
      };
      let data = null;
      for (const [max, qlt] of [[640, .6], [560, .5], [480, .42], [400, .38]]) { const d = draw(max, qlt); if (d.length <= 110000) { data = d; break; } }
      if (!data) throw new Error('사진이 너무 커요');
      let thumb = draw(160, .55); if (thumb.length > 16000) thumb = draw(120, .4);
      return { data, thumb: thumb.length <= 16000 ? thumb : null };
    } finally { URL.revokeObjectURL(url); }
  }
  function pickPhoto(kind) {
    if (!sel) return;
    if (me && dist(me[0], me[1], sel.lat, sel.lng) > 200) return toast('사진은 그 화장실 근처(200m 안)에서 올릴 수 있어요');
    photoKind = kind; $('photoFile').value = ''; $('photoFile').click();
  }
  $('photoYes').onclick = () => pickPhoto('exists');
  $('photoNo').onclick = () => pickPhoto('gone');
  $('photoFile').onchange = async () => {
    const f = $('photoFile').files[0], t = sel; if (!f || !t) return;
    let pic; try { pic = await shrink(f); } catch (e) { return toast(String(e.message || e)); }
    try {
      await window.Backend.postPhoto(t.id, photoKind, pic.data, pic.thumb);
      toast(photoKind === 'exists' ? '📷 고마워요! 이 화장실이 있다는 증거가 올라갔어요' : '📷 고마워요! 없어졌다는 증거가 올라갔어요', 3000);
      loadPhotos(t); syncShared(true);
    } catch (e) { toast('사진 올리기 실패: ' + String(e.message || e).slice(0, 140), 6000); }
  };

  // ===== 변기탐지 =====
  $('sosBtn').onclick = () => {
    if (!me) { toast('내 위치를 찾는 중…'); locate(true); return; }
    sosList = [...toilets.values()].filter(t => !t.flagged && Store.fresh(t.id, 'open', 6) !== 0)
      .map(t => ({ t, d: dist(me[0], me[1], t.lat, t.lng) })).sort((a, b) => a.d - b.d).slice(0, 5).map(x => x.t);
    if (!sosList.length) { toast('주변 화장실 데이터가 아직 없어요'); loadAround(me[0], me[1]); return; }
    sosIdx = 0; showSos();
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
  };
  function showSos() {
    const t = sosList[sosIdx]; sel = t;
    $('sheet').classList.add('hidden'); $('sos').classList.remove('hidden');
    const d = dist(me[0], me[1], t.lat, t.lng);
    $('sosDist').textContent = `${fmtD(d)} · ${walkMin(d)}분`;
    $('sosName').textContent = t.name; $('sosMeta').textContent = describe(t) || '정보 없음 — 도착하면 상태 보고 부탁!';
    navLinks(t, 'sosKakao', 'sosNaver', 'sosGoogle');
    if (routeLine) routeLine.remove();
    routeLine = L.polyline([me, [t.lat, t.lng]], { color: '#ff3b3b', weight: 4, dashArray: '8 8' }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [60, 60], maxZoom: 17 });
    restyle();
  }
  $('sosNext').onclick = () => { sosIdx = (sosIdx + 1) % sosList.length; showSos(); };
  $('sosClose').onclick = () => { $('sos').classList.add('hidden'); if (routeLine) routeLine.remove(); routeLine = null; sel = null; restyle(); };

  // ===== 등록 =====
  $('addBtn').onclick = () => { $('crosshair').classList.remove('hidden'); $('addDlg').classList.remove('hidden'); };
  $('addCancel').onclick = () => { $('crosshair').classList.add('hidden'); $('addDlg').classList.add('hidden'); };
  $('addOk').onclick = () => {
    const c = map.getCenter(); const name = $('addName').value.trim() || '사용자 등록 화장실';
    const t = { id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), lat: c.lat, lng: c.lng, name, src: 'user', tags: { access: $('addFree').checked ? 'yes' : 'customers' } };
    Store.addToilet(t); toilets.set(t.id, t); addMarker(t);
    window.Backend.addToilet(t).catch(e => toast('등록 공유 실패: ' + String(e.message || e).slice(0, 100), 6000));
    $('addCancel').onclick(); $('addName').value = '';
    achEvent('reg');
    // 등록 보상은 하루 3번까지 (엉터리 등록으로 코인을 불리지 못하게)
    const rd = ach.regDay && ach.regDay.d === todayStr() ? ach.regDay : (ach.regDay = { d: todayStr(), n: 0 });
    rd.n++; achSave();
    if (rd.n <= 3) reward(50, '등록 완료!'); else toast('등록 완료! (등록 보상은 하루 3번까지)');
  };
  for (const t of Store.userToilets()) { toilets.set(t.id, t); addMarker(t); }

  // ===== 미션 =====
  $('missionBtn').onclick = () => {
    if (!me) return toast('위치를 먼저 켜주세요');
    const cands = [...toilets.values()].filter(t => { const d = dist(me[0], me[1], t.lat, t.lng); return d > 120 && d < 900 && Store.canVerify(t.id); });
    if (!cands.length) return toast('900m 안에 미션 가능한 화장실이 없어요');
    const t = cands[(Math.random() * cands.length) | 0], d = dist(me[0], me[1], t.lat, t.lng);
    mission = { id: t.id, bonus: 40 };
    $('missionText').textContent = `${t.name}까지 가서 도착 인증하면 +${mission.bonus}💰 (${fmtD(d)})`;
    $('mission').classList.remove('hidden');
    markers.get(t.id)?.setIcon(icon(t, true));
  };
  $('missionGo').onclick = () => { if (mission) openSheet(toilets.get(mission.id)); };
  $('missionX').onclick = () => { mission = null; $('mission').classList.add('hidden'); restyle(); };

  // ===== 일일 퀘스트 =====
  function checkDaily() {
    const n = Store.dailyTick();
    if (n === 3) reward(60, '일일 퀘스트 완료 (3회 보고)!');
  }

  $('locBtn').onclick = () => locate(false);

  // ===== 서버 공유: 상태 보고 · 신고 · 사용자 등록 화장실 =====
  let syncBusy = false, lastSync = 0, syncAgain = false;
  async function syncShared(force) {
    const SB = window.Backend;
    if (SB.demo) return;
    if (syncBusy) { if (force) syncAgain = true; return; }  // 진행 중이면 끝난 뒤 한 번 더
    if (!force && Date.now() - lastSync < 20000) return;
    syncBusy = true; lastSync = Date.now();
    try {
      const c = map.getCenter();
      const ut = await SB.toiletsIn(c.lat, c.lng, 0.05);
      for (const r of ut) if (!toilets.has(r.id)) { const t = { id: r.id, lat: r.lat, lng: r.lng, name: r.name, src: 'user', by: r.nick, tags: { access: r.access } }; toilets.set(t.id, t); addMarker(t); }
      // 지도 가운데와 내 위치 주변 변기만 묻는다 (사람이 많아져도 한 사람이 받는 양이 늘지 않게)
      const ids = nearIds(c);
      const [reps, flags] = await Promise.all([SB.recentReports(ids), SB.toiletFlags(ids)]);
      for (const id of ids) { const t = toilets.get(id), f = flags[id]; if (t) { t.flags = f ? f.flags : 0; t.flagged = !!(f && f.hidden); } }
      if (sel && !$('sheet').classList.contains('hidden')) renderFlagNote(sel);
      const changed = Store.mergeRemote(reps);
      if (changed || ut.length) restyle();
      if (changed && sel && !$('sheet').classList.contains('hidden')) renderStatus(sel);
    } catch (e) { console.warn('sync failed', e); }
    syncBusy = false;
    if (syncAgain) { syncAgain = false; syncShared(true); }
  }
  function nearIds(c) {
    const pts = [[c.lat, c.lng]]; if (me) pts.push(me);
    const out = [];
    for (const t of toilets.values()) {
      let d = Infinity; for (const p of pts) d = Math.min(d, dist(p[0], p[1], t.lat, t.lng));
      if (d < 2500) out.push([d, t.id]);
    }
    return out.sort((a, b) => a[0] - b[0]).slice(0, 200).map(x => x[1]);
  }
  map.on('moveend', () => syncShared(false));
  setInterval(() => { if (!document.hidden) syncShared(false); }, 45000);
  setTimeout(() => syncShared(true), 3000);

  // =====================================================================
  // 커뮤니티: 변기 레벨 · 변기 이야기 · 동네 광장 · 탐험가 수첩
  // =====================================================================
  const B = window.Backend;
  const statsCache = new Map(); // toilet_id -> stats
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`; };
  if (B.demo) setTimeout(() => toast('데모 모드: 채팅은 이 기기에서만 보여요 (config.js에 Supabase 키를 넣으면 공유)', 3500), 2500);
  else B.listMessages('area:ping').catch(e => setTimeout(() => toast('서버 연결 실패: ' + String(e.message || e).slice(0, 80), 6000), 2500));

  // ---- 변기 레벨 카드 ----
  async function loadToiletLevel(t) {
    let s = statsCache.get(t.id);
    if (!s) { try { s = await B.toiletStats(t.id); } catch (e) { s = { xp: 0, level: 1, visits: 0, explorers: 0, first_nick: null, mine: 0 }; } statsCache.set(t.id, s); }
    if (sel !== t) return;
    renderToiletLevel(s);
    markers.get(t.id)?.setIcon(icon(t));
  }
  function renderToiletLevel(s) {
    $('tlLv').textContent = s.level;
    const cur = (s.level - 1) ** 2 * 25, nxt = s.level ** 2 * 25;
    $('tlFill').style.width = `${Math.min(100, ((s.xp - cur) / (nxt - cur)) * 100)}%`;
    $('tlPower').textContent = `변기력 ${s.xp}`; $('tlVisits').textContent = `방문 ${s.visits}회`; $('tlExp').textContent = `탐험가 ${s.explorers}명`; $('tlMine').textContent = `나 ${s.mine}회`;
    $('tlFirst').textContent = s.first_nick ? `🏁 1호 탐험가: ${s.first_nick}` : '🏁 아직 아무도 인증하지 않은 미개척 변기! 첫 탐험가가 되어보세요';
  }
  // 마커에 레벨 뱃지
  const _icon = icon;
  icon = function (t, target) {
    const s = statsCache.get(t.id);
    const lv = s && s.level > 1 ? `<span class="lv">${s.level}</span>` : '';
    return L.divIcon({ className: '', html: `<div class="tmark ${target ? 'target' : cls(t)}"><i>🚻</i>${lv}</div>`, iconSize: [34, 34], iconAnchor: [17, 34] });
  };

  // 도착 인증 → 변기 XP 반영 (기존 verify 핸들러를 감싼다)
  const _verify = $('verifyBtn').onclick;
  $('verifyBtn').onclick = async () => {
    const before = sel && Store.canVerify(sel.id);
    _verify();
    if (sel && before && !Store.canVerify(sel.id)) {
      const vt = sel; // 기다리는 동안 다른 변기를 열어도 이 변기 기준으로 처리
      try {
        const prev = statsCache.get(vt.id);
        const s = await B.recordVisit(vt.id, vt.name, serverMode ? -new Date().getTimezoneOffset() : undefined, vt.lat, vt.lng);
        statsCache.set(vt.id, s); if (sel === vt) renderToiletLevel(s); markers.get(vt.id)?.setIcon(icon(vt));
        if (serverMode && missionDone === vt.id) { missionDone = null; try { applyWallet(await B.claimMission(vt.id)); toast('🎯 미션 완료! +40💰', 2500); } catch (e) { toast('미션 보상 실패: ' + String(e.message || e).slice(0, 100), 6000); } }
        if (s.visits === 1) { achEvent('first'); reward(40, '🏁 이 변기의 1호 탐험가!'); }
        syncShared(true);
        if (prev && s.level > prev.level) setTimeout(() => toast(`⚡ 이 변기의 등급이 올랐어요! ${s.level}등급`, 3000), 2400);
      } catch (e) {
        console.error(e);
        // 서버가 받아주지 않은 인증은 기기에서도 취소한다 (오늘 다시 시도할 수 있게)
        if (vt) { Store.unverify(vt.id); ach.v = ach.v.filter(x => !(x[0] === vt.id && Date.now() - x[1] < 60000)); achSave(); if (sel === vt) openSheet(vt); }
        toast('인증 실패: ' + String(e.message || e).slice(0, 140), 9000);
      }
    }
  };

  // ---- 탭 ----
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b));
    $('tab-status').classList.toggle('hidden', b.dataset.tab !== 'status');
    $('tab-talk').classList.toggle('hidden', b.dataset.tab !== 'talk');
    if (b.dataset.tab === 'talk' && sel) loadChat('toilet:' + sel.id, 'toiletChat');
  });

  // ---- 채팅 공통 ----
  let replyTo = null, chatTimer = null;
  const myId = B.me().id;
  const chatCache = new Map();
  async function loadChat(channel, elId, force) {
    const el = $(elId); let rows = [];
    // 1분에 한 번만 전체(최근 80개)를 받고, 그 사이에는 새 글만 받는다. 전체를 받을 때 "도움됐어요" 수도 새로 반영된다
    const cc = chatCache.get(channel);
    try {
      if (cc && cc.rows.length && !force && B.listMessagesSince && Date.now() - cc.full < 60000) {
        const have = new Set(cc.rows.map(r => r.id));
        rows = cc.rows.concat((await B.listMessagesSince(channel, cc.rows[cc.rows.length - 1].at)).filter(r => !have.has(r.id))).slice(-80);
        chatCache.set(channel, { rows, full: cc.full });
      } else { rows = await B.listMessages(channel); chatCache.set(channel, { rows, full: Date.now() }); }
    } catch (e) { if (!cc) el.innerHTML = '<div class="empty">채팅을 불러오지 못했어요</div>'; return; }
    const sig = channel + '|' + rows.length + '|' + (rows.length ? rows[rows.length - 1].id : '') + '|' + rows.reduce((n, r) => n + (r.helpful || 0), 0);
    if (!force && el.dataset.sig === sig) return;
    const atBottom = el.dataset.sig === undefined || !el.dataset.sig.startsWith(channel + '|') || el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    el.dataset.sig = sig;
    if (elId === 'toiletChat') $('talkCnt').textContent = rows.length || '';
    if (!rows.length) { el.innerHTML = `<div class="empty">아직 조용해요. 첫 마디를 남겨보세요 🚽</div>`; return; }
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    el.innerHTML = rows.map(r => {
      const mine = r.user_id === myId;
      const parent = r.parent && byId[r.parent];
      const canHelp = parent && parent.user_id === myId && !mine && !(ach.thanked || {})[r.id];
      return `<div class="msg ${mine ? 'mine' : ''} ${r.kind === 'question' ? 'question' : ''}" data-id="${r.id}">
        <div class="who">${r.kind === 'question' ? '<span>❓</span> ' : ''}<span class="nicklink" data-raw data-uid="${esc(r.user_id)}" data-nick="${esc(r.nick)}">${esc(r.nick)}</span><span>${ago(r.at)}</span></div>
        ${parent ? `<div data-raw style="font-size:11px;opacity:.7;margin-bottom:3px">↳ ${esc(parent.text.slice(0, 30))}</div>` : ''}
        <div data-raw>${esc(r.text)}</div>
        ${r.helpful ? `<div class="help">👍 도움됐어요 ${r.helpful}</div>` : ''}
        <div class="act">${!mine ? `<button data-reply="${r.id}">답하기</button>` : ''}${canHelp ? `<button data-help="${r.id}">👍 도움됐어요</button>` : ''}</div>
      </div>`;
    }).join('');
    if (atBottom || force) el.scrollTop = el.scrollHeight;
    el.querySelectorAll('.nicklink').forEach(s => s.onclick = () => openPeek(s.dataset.uid, s.dataset.nick));
    el.querySelectorAll('[data-reply]').forEach(b => b.onclick = () => { replyTo = b.dataset.reply; const inp = el.nextElementSibling.querySelector('input'); inp.placeholder = '답글 작성 중…'; inp.focus(); });
    el.querySelectorAll('[data-help]').forEach(b => b.onclick = async () => { (ach.thanked || (ach.thanked = {}))[b.dataset.help] = 1; achSave(); b.remove(); try { await B.markHelpful(b.dataset.help); toast('👍 고마움을 전했어요. 답해준 탐험가가 보상을 받아요'); } catch (e) { toast('전달 실패'); } loadChat(channel, elId, true); });
    // 내 답변이 "도움됐어요"를 받았으면 보상 (답변 하나당 한 번)
    const paid = ach.helpPaid || (ach.helpPaid = {}); let helped = 0;
    for (const r of rows) if (r.user_id === myId && r.kind === 'answer' && r.helpful > 0 && !paid[r.id]) { paid[r.id] = 1; helped++; }
    if (helped) { achSave(); reward(15 * helped, `내 답변이 도움이 됐대요! (${helped}건)`); }
  }
  async function send(channel, inputId, elId, toilet_id, text) {
    text = (text || $(inputId).value).trim(); if (!text) return;
    const kind = replyTo ? 'answer' : /[?？]|나요|있어요|어디|추천|where|anyone|どこ|ありますか|ですか/i.test(text) ? 'question' : 'chat';
    try { await B.postMessage({ channel, toilet_id, text, kind, parent: replyTo }); } catch (e) { console.error(e); return toast('전송 실패: ' + String(e.message || e).slice(0, 140), 9000); }
    $(inputId).value = ''; $(inputId).placeholder = inputId === 'toiletMsg' ? '이 변기에 남길 말…' : '동네 탐험가들에게…'; replyTo = null;
    $(elId).dataset.sig = '';
    achEvent('talk');
    // 이야기 보상은 하루 10번까지
    const td = ach.talkDay && ach.talkDay.d === todayStr() ? ach.talkDay : (ach.talkDay = { d: todayStr(), n: 0 });
    td.n++; achSave();
    if (td.n <= 10) reward(kind === 'answer' ? 5 : 2, kind === 'answer' ? '답변!' : '이야기 남김');
    loadChat(channel, elId);
  }
  $('toiletForm').onsubmit = e => { e.preventDefault(); if (sel) send('toilet:' + sel.id, 'toiletMsg', 'toiletChat', sel.id); };
  $('areaForm').onsubmit = e => { e.preventDefault(); send(areaChannel(), 'areaMsg', 'areaChat', null); };
  document.querySelectorAll('#tab-talk .chips button').forEach(b => b.onclick = () => { if (sel) send('toilet:' + sel.id, 'toiletMsg', 'toiletChat', sel.id, b.dataset.q); });
  document.querySelectorAll('#area .chips button').forEach(b => b.onclick = () => send(areaChannel(), 'areaMsg', 'areaChat', null, b.dataset.q));

  // ---- 동네 광장 ----
  function areaChannel() { const c = me || DEFAULT; return 'area:' + tileKey(c[0], c[1]); }
  $('areaBtn').onclick = () => {
    closeSheets(); $('area').classList.remove('hidden');
    $('areaMeta').textContent = me ? '내 위치 기준 약 2km 격자 안의 탐험가들' : '위치를 켜면 우리 동네 채널로 연결돼요';
    loadChat(areaChannel(), 'areaChat');
    clearInterval(chatTimer); chatTimer = setInterval(() => { if ($('area').classList.contains('hidden')) clearInterval(chatTimer); else if (!document.hidden) loadChat(areaChannel(), 'areaChat'); }, 6000);
  };
  $('areaClose').onclick = () => { $('area').classList.add('hidden'); clearInterval(chatTimer); };
  function closeSheets() { if (deco) endDeco(); ['sheet', 'sos', 'area', 'profile', 'help', 'peek', 'shop', 'photoView'].forEach(id => $(id).classList.add('hidden')); }


  // =====================================================================
  // 칭호 · 스티커 · 프로필 카드
  // =====================================================================
  const HOUR = 3600e3;
  const achLoad = () => { try { return Object.assign({ v: [], rep: 0, talk: 0, reg: 0, first: 0, tut: false, got: {}, title: null, stickers: [] }, JSON.parse(localStorage.getItem('ghc-ach') || '{}')); } catch (e) { return { v: [], rep: 0, talk: 0, reg: 0, first: 0, tut: false, got: {}, title: null, stickers: [] }; } };
  let ach = achLoad();
  const achSave = () => { try { localStorage.setItem('ghc-ach', JSON.stringify(ach)); } catch (e) {} };
  const distinct = () => new Set(ach.v.map(x => x[0])).size;
  // 어떤 인증 시점을 끝으로 하는 window 시간 안에 서로 다른 변기 n곳을 인증했는가
  const burst = (n, win) => ach.v.some(([, t]) => new Set(ach.v.filter(([, u]) => u <= t && u > t - win).map(x => x[0])).size >= n);
  // 달성 조건. 이름·설명·스티커·분류는 titles.js에 있다 (그 파일만 고치면 이름이 바뀐다)
  const COND = {
    tut: () => ach.tut, v1: () => ach.v.length >= 1,
    d3: () => distinct() >= 3, d10: () => distinct() >= 10, d30: () => distinct() >= 30,
    r1: () => ach.rep >= 1, r10: () => ach.rep >= 10, r50: () => ach.rep >= 50,
    t10: () => ach.talk >= 10, g1: () => ach.reg >= 1, f1: () => ach.first >= 1,
    s3: () => burst(3, 2 * HOUR), s5: () => burst(5, 24 * HOUR),
    n1: () => ach.v.some(([, t]) => new Date(t).getHours() < 5),
    k3: () => Store.xp >= 1000,
  };
  const L10N = window.I18N || { pick: (o, f) => o && o[f], tr: s => s, lang: 'ko' };
  const TITLES = (window.GHC_TITLES || []).filter(t => COND[t.id]).map(t => Object.assign({}, t, { name: L10N.pick(t, 'name'), desc: L10N.pick(t, 'desc'), ok: () => serverMode ? !!(srv && srv.titles.includes(t.id)) : COND[t.id]() }));
  const CATS = (window.GHC_TITLE_CATS || []).map(c => Object.assign({}, c, { name: L10N.pick(c, 'name') }));
  const TITLE = Object.fromEntries(TITLES.map(t => [t.id, t]));
  // 유물: 얻기 어려운 일부 칭호에만 딸려 온다. 여러 개를 함께 장착할 수 있고, 효과는 일부러 작게 잡았다
  // 유물 효과는 일부러 작다. 인증 거리(열쇠 꾸러미)를 빼면 전부 '오늘의 보너스'에 조금씩 더해지고, 서버가 칭호를 확인한 유물만 적용된다
  const RELIC_FX = {
    d10: { fx: '도착 인증 가능 거리 +5m', e: { range: 5 } },
    d30: { fx: '오늘의 보너스 +5', e: { bonus: 5 } },
    r50: { fx: '오늘의 보너스 +3', e: { bonus: 3 } },
    s3:  { fx: '오늘의 보너스 +3', e: { bonus: 3 } },
    s5:  { fx: '오늘의 보너스 +5', e: { bonus: 5 } },
    n1:  { fx: '오늘의 보너스 +3', e: { bonus: 3 } },
    k3:  { fx: '오늘의 보너스 +5', e: { bonus: 5 } },
  };
  const RELICS = {}; for (const id in RELIC_FX) if (TITLE[id]) RELICS[id] = Object.assign({ ic: '🏺', name: '이름 없는 유물' }, (window.GHC_RELICS || {})[id], RELIC_FX[id], { name: L10N.pick((window.GHC_RELICS || {})[id], 'name') || '이름 없는 유물' });
  const ownedRelics = () => Object.keys(RELICS).filter(id => ach.got[id]);
  const equippedRelics = () => (ach.relics || []).filter(id => RELICS[id] && ach.got[id]);
  // 장착한 유물의 효과 합계
  function rb(k) { return equippedRelics().reduce((n, id) => n + (RELICS[id].e[k] || 0), 0); }
  function renderRelics() {
    const own = ownedRelics(), eq = new Set(equippedRelics());
    $('relicCount').textContent = own.length ? `장착 ${eq.size} / 보유 ${own.length}` : '';
    $('relics').innerHTML = Object.keys(RELICS).map(id => { const r = RELICS[id], has = !!ach.got[id];
      return `<button class="ttl ${has ? 'got' : 'locked'} ${eq.has(id) ? 'on' : ''}" data-r="${id}" ${has ? '' : 'disabled'}><span class="ttl-st">${has ? r.ic : '🔒'}</span><span class="ttl-tx"><b>${r.name}</b><small>${has ? r.fx : `칭호 「${TITLE[id].name}」을 얻으면 해금 · ${r.fx}`}</small></span>${eq.has(id) ? '<i>장착</i>' : ''}</button>`; }).join('');
    $('relics').querySelectorAll('.ttl.got').forEach(b => b.onclick = () => {
      const id = b.dataset.r, cur = new Set(equippedRelics()); cur.has(id) ? cur.delete(id) : cur.add(id);
      ach.relics = [...cur]; achSave(); queueProfileSync(); renderRelics();
      toast(cur.has(id) ? `${RELICS[id].ic} ${RELICS[id].name} 장착 · ${RELICS[id].fx}` : `${RELICS[id].name} 해제`);
    });
  }
  // =====================================================================
  // 코인 상점: 전부 꾸미기 아이템 (능력치 영향 없음)
  // =====================================================================
  const SHOP = {
    bg: { name: '카드 배경', items: [
      { id: 'bg0', name: '기본', price: 0, css: '' },
      { id: 'bg_night', name: '밤하늘', price: 150, css: 'radial-gradient(circle at 20% 20%, rgba(255,255,255,.35) 0 1px, transparent 2px), radial-gradient(circle at 70% 35%, rgba(255,255,255,.3) 0 1px, transparent 2px), radial-gradient(circle at 45% 75%, rgba(255,255,255,.25) 0 1px, transparent 2px), linear-gradient(160deg,#0b1026,#27306b)' },
      { id: 'bg_onsen', name: '온천', price: 200, css: 'radial-gradient(circle at 80% 10%, rgba(255,255,255,.4), transparent 40%), linear-gradient(160deg,#2f6f7a,#8ac6c0 60%,#e8d9b5)' },
      { id: 'bg_forest', name: '숲', price: 200, css: 'radial-gradient(circle at 15% 85%, rgba(190,255,170,.3), transparent 45%), linear-gradient(160deg,#12301f,#2f7a4a)' },
      { id: 'bg_sunset', name: '노을', price: 250, css: 'linear-gradient(170deg,#3a1c5a,#c2456b 55%,#f6a35c)' },
      { id: 'bg_neon', name: '네온', price: 400, css: 'radial-gradient(circle at 85% 20%, rgba(0,255,220,.45), transparent 40%), radial-gradient(circle at 10% 90%, rgba(255,0,200,.4), transparent 45%), linear-gradient(135deg,#120b2e,#2a0f4a)' },
      { id: 'bg_gold', name: '황금 변기', price: 1500, css: 'radial-gradient(circle at 80% 15%, rgba(255,255,255,.55), transparent 35%), linear-gradient(135deg,#6b4a0f,#d9a72e 50%,#8a6414)' },
    ] },
    frame: { name: '아이콘 테두리', items: [
      { id: 'fr0', name: '기본', price: 0, css: '' },
      { id: 'fr_gold', name: '금테', price: 200, css: 'box-shadow:0 0 0 3px #ffd54a, 0 0 12px rgba(255,213,74,.7)' },
      { id: 'fr_wave', name: '물결', price: 300, css: 'box-shadow:0 0 0 3px #7ee8fa, 0 0 0 6px rgba(126,232,250,.35), 0 0 0 9px rgba(126,232,250,.15)' },
      { id: 'fr_rainbow', name: '무지개', price: 600, css: 'box-shadow:0 0 0 2px #ff5a5a, 0 0 0 4px #ffd54a, 0 0 0 6px #5be37d, 0 0 0 8px #5aa9ff' },
    ] },
    color: { name: '닉네임 색', items: [
      { id: 'co0', name: '기본', price: 0, css: '' },
      { id: 'co_sky', name: '하늘', price: 100, css: '#8fe3ff' },
      { id: 'co_mint', name: '민트', price: 100, css: '#9cf0b0' },
      { id: 'co_pink', name: '분홍', price: 100, css: '#ffa6d1' },
      { id: 'co_gold', name: '금빛', price: 300, css: '#ffd54a' },
    ] },
    pack: { name: '스티커 묶음', items: [
      { id: 'pk_sea', name: '바다 묶음', price: 250, st: ['🌊', '🫧', '🐳', '🐚'] },
      { id: 'pk_night', name: '밤 묶음', price: 250, st: ['⭐', '🌌', '🦉', '☄️'] },
      { id: 'pk_party', name: '축하 묶음', price: 350, st: ['🎉', '✨', '💎', '🏆'] },
    ] },
  };
  const SHOP_ITEM = {}; for (const k in SHOP) for (const it of SHOP[k].items) SHOP_ITEM[it.id] = Object.assign({ kind: k }, it);
  const DEFAULTS = { bg: 'bg0', frame: 'fr0', color: 'co0' };
  const shopSt = () => (ach.shop || (ach.shop = { owned: {}, bg: 'bg0', frame: 'fr0', color: 'co0', bonusDay: '' }));
  const owns = id => SHOP_ITEM[id] && (SHOP_ITEM[id].price === 0 || !!shopSt().owned[id]);
  const cssOf = (kind, id) => (SHOP_ITEM[id] && SHOP_ITEM[id].kind === kind ? SHOP_ITEM[id].css : '') || '';
  const packStickers = () => SHOP.pack.items.filter(p => owns(p.id)).flatMap(p => p.st);
  const todayStr = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const DAILY_BONUS = 50;
  let shopTab = 'bg';
  function renderShop() {
    const s = shopSt();
    $('shopCoins').textContent = `💰 ${Store.coins.toLocaleString()}`;
    const claimed = serverMode ? !!(srv && srv.bonus_today) : s.bonusDay === todayStr();
    $('bonusBtn').disabled = claimed; $('bonusBtn').textContent = claimed ? '오늘의 보너스 받음 · 내일 다시' : `🎁 오늘의 보너스 받기 +${DAILY_BONUS + rb('bonus')}💰`;
    $('shopTabs').innerHTML = Object.keys(SHOP).map(k => `<button class="${shopTab === k ? 'on' : ''}" data-k="${k}">${SHOP[k].name}</button>`).join('');
    $('shopTabs').querySelectorAll('button').forEach(b => b.onclick = () => { shopTab = b.dataset.k; renderShop(); });
    $('shopList').innerHTML = SHOP[shopTab].items.map(it => {
      const has = owns(it.id), using = shopTab !== 'pack' && s[shopTab] === it.id;
      const prev = shopTab === 'bg' ? `<span class="pv" style="background:${it.css || 'linear-gradient(135deg,#1b2a3a,#3a2d6a)'}"></span>`
        : shopTab === 'frame' ? `<span class="pv round" style="${it.css}">🚽</span>`
        : shopTab === 'color' ? `<span class="pv txt" style="color:${it.css || '#fff'}">가</span>`
        : `<span class="pv pk">${it.st.join('')}</span>`;
      const btn = shopTab === 'pack' ? (has ? '<i>보유 중</i>' : `<button data-buy="${it.id}">💰 ${it.price}</button>`)
        : using ? '<i>적용 중</i>' : has ? `<button data-use="${it.id}">적용</button>` : `<button data-buy="${it.id}">💰 ${it.price}</button>`;
      return `<div class="shop-item">${prev}<span class="nm">${it.name}</span>${btn}</div>`;
    }).join('');
    $('shopList').querySelectorAll('[data-buy]').forEach(b => b.onclick = async () => {
      const it = SHOP_ITEM[b.dataset.buy];
      if (Store.coins < it.price) return toast(`코인이 ${(it.price - Store.coins).toLocaleString()} 부족해요`);
      if (serverMode) {
        b.disabled = true;
        try { applyWallet(await B.buyItem(it.id)); } catch (e) { b.disabled = false; return toast('구매 실패: ' + String(e.message || e).slice(0, 100), 5000); }
        if (!owns(it.id)) return toast('구매가 반영되지 않았어요. 잠시 후 다시 시도해 주세요', 4000);
      } else {
        if (!Store.spend(it.price)) return;
        s.owned[it.id] = 1;
      }
      if (it.kind !== 'pack') s[it.kind] = it.id;
      achSave(); refreshHUD(); queueProfileSync(); renderShop();
      toast(it.kind === 'pack' ? `${it.name} 구매! 스티커 꾸미기에서 쓸 수 있어요` : `${it.name} 구매하고 적용했어요`, 2800);
    });
    $('shopList').querySelectorAll('[data-use]').forEach(b => b.onclick = () => { const it = SHOP_ITEM[b.dataset.use]; s[it.kind] = it.id; achSave(); queueProfileSync(); renderShop(); toast(`${it.name} 적용`); });
  }
  function openShop() { closeSheets(); $('shop').classList.remove('hidden'); renderShop(); }
  // 보너스: 지금은 하루 한 번 무료. 앱 출시 후에는 grantBonus를 보상형 광고 시청 완료에 연결한다
  async function grantBonus() {
    const s = shopSt();
    if (serverMode) {
      if (srv.bonus_today) return;
      $('bonusBtn').disabled = true;
      try { const d = applyWallet(await B.claimBonus()); renderShop(); toast(d > 0 ? `🎁 오늘의 보너스 +${d}💰` : '오늘의 보너스는 이미 받았어요', 2500); }
      catch (e) { renderShop(); toast('보너스 실패: ' + String(e.message || e).slice(0, 100), 5000); }
      return;
    }
    if (s.bonusDay === todayStr()) return;
    const amt = DAILY_BONUS + rb('bonus');
    s.bonusDay = todayStr(); achSave(); Store.earn(amt, 0); refreshHUD(); renderShop(); toast(`🎁 오늘의 보너스 +${amt}💰`);
  }
  // 서버 지갑 값이 새로 들어올 때: 보유 상품과 칭호를 서버 기준으로 맞춘다
  function onWallet() {
    const s = shopSt();
    s.owned = Object.fromEntries((srv.owned || []).map(id => [id, 1]));
    for (const k of ['bg', 'frame', 'color']) if (!owns(s[k])) s[k] = DEFAULTS[k];  // 서버가 모르는 상품은 적용 해제
    achSave(); achCheck();
    if (ach.tut && !srv.titles.includes('tut') && !onWallet.tutSent) { onWallet.tutSent = true; B.claimTut().then(applyWallet).catch(() => {}); }
    if (!$('shop').classList.contains('hidden')) renderShop();
    queueProfileSync();
  }
  $('bonusBtn').onclick = grantBonus;
  $('shopClose').onclick = () => $('shop').classList.add('hidden');
  $('shopBtn').onclick = openShop; $('coinBtn').onclick = openShop;

  const STICKER_OK = new Set(TITLES.map(t => t.st).concat(SHOP.pack.items.flatMap(p => p.st)));
  function achCheck() {
    let news = 0;
    for (const t of TITLES) if (!ach.got[t.id] && t.ok()) { ach.got[t.id] = Date.now(); if (!ach.title) ach.title = t.id; news++; const d = 2600 + news * 2300; const rl = RELICS[t.id]; setTimeout(() => toast(rl ? `🏅 칭호 획득: ${t.name} · 스티커 ${t.st} · 유물 ${rl.name} 해금` : `🏅 칭호 획득: ${t.name} · 스티커 ${t.st} 해금`, 4200), d); }
    achSave(); if (news) queueProfileSync();
  }
  function achEvent(kind, id) {
    if (kind === 'visit') ach.v.push([id, Date.now()]); else if (kind === 'tut') ach.tut = true; else ach[kind] = (ach[kind] || 0) + 1;
    if (ach.v.length > 400) ach.v = ach.v.slice(-400);
    achCheck();
  }
  // ---- 내 프로필 데이터 (서버에 올라가는 모양) ----
  function myProfile() {
    const m = B.me();
    return { nick: m.nick, avatar: m.avatar, title: ach.title, titles: Object.keys(ach.got), rank: rankName(), power: Store.xp, relics: equippedRelics(), bg: shopSt().bg, frame: shopSt().frame, color: shopSt().color, stickers: ach.stickers, found: distinct() };
  }
  let syncT = null;
  // 바뀐 게 있을 때만 서버에 올린다 (지갑을 새로 볼 때마다 같은 카드를 다시 올리지 않게)
  let profSent = null;
  function queueProfileSync() {
    clearTimeout(syncT);
    syncT = setTimeout(() => { const p = myProfile(), sig = JSON.stringify(p); if (sig === profSent) return; B.saveProfile(p).then(() => { profSent = sig; }).catch(e => console.warn('profile sync', e)); }, 1500);
  }
  // ---- 프로필 카드 그리기 ----
  function cleanStickers(list) { return (Array.isArray(list) ? list : []).filter(s => s && STICKER_OK.has(s.s) && isFinite(s.x) && isFinite(s.y)).slice(0, 10).map(s => ({ s: s.s, x: Math.max(4, Math.min(96, +s.x)), y: Math.max(8, Math.min(92, +s.y)), z: Math.max(0.5, Math.min(2.5, +s.z || 1)) })); }
  function drawBoard(el, p, stickers, mine) {
    const t = TITLE[p.title];
    el.style.background = cssOf('bg', p.bg);
    el.innerHTML = `<div class="b-main"><div class="me-avatar" style="${cssOf('frame', p.frame)}" ${mine ? 'id="meAvatar"' : ''}>${esc(p.avatar || '🚽')}</div><div>
        ${t ? `<div class="b-title">「${esc(t.name)}」</div>` : ''}
        <div class="me-name" data-raw="exact" style="${cssOf('color', p.color) ? 'color:' + cssOf('color', p.color) : ''}" ${mine ? 'id="meName"' : ''}>${esc(p.nick || '이름 없는 탐험가')}</div>
        <div class="me-sub">${esc(p.rank || '잠든 물방울')} · 변기력 ${(+p.power || 0).toLocaleString()}</div></div></div>`
      + cleanStickers(stickers).map((s, i) => `<span class="stk" data-i="${i}" style="left:${s.x}%;top:${s.y}%;font-size:${Math.round(30 * s.z)}px">${s.s}</span>`).join('');
  }
  let titleCat = 'all';
  function drawTitles(el, gotIds, equipped, mine, cat) {
    const got = new Set(gotIds);
    const list = (mine ? TITLES : TITLES.filter(t => got.has(t.id))).filter(t => !cat || cat === 'all' || t.cat === cat);
    el.innerHTML = list.length ? list.map(t => `<button class="ttl ${got.has(t.id) ? 'got' : 'locked'} ${equipped === t.id ? 'on' : ''}" data-t="${t.id}" ${mine && got.has(t.id) ? '' : 'disabled'}>
        <span class="ttl-st">${got.has(t.id) ? t.st : '🔒'}</span><span class="ttl-tx"><b>${esc(t.name)}</b><small>${esc(t.desc)}${RELICS[t.id] ? ' · 유물 ' + RELICS[t.id].ic : ''}</small></span>${equipped === t.id ? '<i>대표</i>' : ''}</button>`).join('') : '<div class="empty">아직 획득한 칭호가 없어요</div>';
  }
  // ---- 스티커 꾸미기 (붙이기 → 끌기 → 확인) ----
  let deco = null, decoSel = -1;
  function renderDeco() {
    drawBoard($('myBoard'), myProfile(), deco, true);
    $('myBoard').classList.add('editing');
    $('myBoard').querySelectorAll('.stk').forEach(el => {
      const i = +el.dataset.i; el.classList.toggle('sel', i === decoSel);
      el.onpointerdown = ev => {
        ev.preventDefault(); decoSel = i; el.setPointerCapture(ev.pointerId);
        $('myBoard').querySelectorAll('.stk').forEach(x => x.classList.toggle('sel', x === el));
        const box = $('myBoard').getBoundingClientRect();
        const move = e => { const x = Math.max(4, Math.min(96, (e.clientX - box.left) / box.width * 100)), y = Math.max(8, Math.min(92, (e.clientY - box.top) / box.height * 100)); deco[i].x = Math.round(x * 10) / 10; deco[i].y = Math.round(y * 10) / 10; el.style.left = x + '%'; el.style.top = y + '%'; };
        const up = () => { el.onpointermove = null; el.onpointerup = null; el.onpointercancel = null; };
        el.onpointermove = move; el.onpointerup = up; el.onpointercancel = up;
      };
    });
    const mineSt = TITLES.filter(t => ach.got[t.id]).map(t => t.st).concat(packStickers());
    $('tray').innerHTML = mineSt.length ? mineSt.map(s => `<button data-s="${s}">${s}</button>`).join('') : '<div class="empty" style="padding:8px 0">아직 해금한 스티커가 없어요. 칭호를 얻으면 생겨요</div>';
    $('tray').querySelectorAll('button').forEach(b => b.onclick = () => { if (deco.length >= 10) return toast('스티커는 10개까지 붙일 수 있어요'); deco.push({ s: b.dataset.s, x: 50, y: 50, z: 1 }); decoSel = deco.length - 1; renderDeco(); });
  }
  function endDeco() { deco = null; decoSel = -1; $('decoPanel').classList.add('hidden'); $('boardTools').classList.remove('hidden'); $('myBoard').classList.remove('editing'); renderMe(); }
  $('decoBtn').onclick = () => { deco = cleanStickers(ach.stickers); decoSel = -1; $('decoPanel').classList.remove('hidden'); $('boardTools').classList.add('hidden'); renderDeco(); };
  $('decoDel').onclick = () => { if (decoSel < 0) return toast('뗄 스티커를 먼저 눌러주세요'); deco.splice(decoSel, 1); decoSel = -1; renderDeco(); };
  function decoScale(f) { if (decoSel < 0) return toast('크기를 바꿀 스티커를 먼저 눌러주세요'); const s = deco[decoSel]; s.z = Math.round(Math.max(0.5, Math.min(2.5, (s.z || 1) * f)) * 100) / 100; renderDeco(); }
  $('decoBig').onclick = () => decoScale(1.2);
  $('decoSmall').onclick = () => decoScale(1 / 1.2);
  $('decoCancel').onclick = endDeco;
  $('decoOk').onclick = () => { ach.stickers = cleanStickers(deco); achSave(); queueProfileSync(); endDeco(); toast('✨ 프로필 카드에 스티커를 붙였어요'); };
  // ---- 다른 탐험가 프로필 보기 ----
  async function openPeek(userId, fallbackNick) {
    if (userId === myId) return $('profBtn').onclick();
    closeSheets(); $('peek').classList.remove('hidden');
    $('peekMeta').textContent = '불러오는 중…'; $('peekBoard').innerHTML = ''; $('peekTitles').innerHTML = ''; $('peekRelics').innerHTML = '';
    let p = null; try { p = await B.getProfile(userId); } catch (e) {}
    if (!p || !p.nick) { $('peekMeta').textContent = '아직 프로필 카드를 만들지 않은 탐험가예요'; drawBoard($('peekBoard'), { nick: fallbackNick, avatar: '🚽' }, [], false); $('peekTitles').innerHTML = '<div class="empty">공개된 칭호가 없어요</div>'; return; }
    $('peekMeta').textContent = `발견한 변기 ${+p.found || 0}곳 · 칭호 ${(p.titles || []).length}개`;
    drawBoard($('peekBoard'), p, p.stickers, false);
    drawTitles($('peekTitles'), p.titles || [], p.title, false);
    const pr = (p.relics || []).filter(id => RELICS[id]);
    $('peekRelics').innerHTML = pr.length ? pr.map(id => `<span>${RELICS[id].ic} ${RELICS[id].name}</span>`).join('') : '<span class="locked">장착한 유물 없음</span>';
  }
  $('peekClose').onclick = () => $('peek').classList.add('hidden');
  setTimeout(achCheck, 3500); // 이미 조건을 채운 칭호는 시작할 때 바로 지급
  if (!B.demo && B.walletState) refreshWallet().catch(e => { if (!e.missing) console.warn('wallet', e); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && serverMode) refreshWallet().catch(() => {}); });

  // =====================================================================
  // 계정: 게스트 / 구글 로그인
  // =====================================================================
  const A = window.Auth;
  let acctBusy = false, acctHold = false, lastSaved = '', lastSavedAt = 0;
  function renderAcct() {
    const el = $('acct'); if (!A.enabled) { el.innerHTML = ''; return; }
    if (A.signedIn) {
      el.innerHTML = `<div class="acct-in"><b>🔐 ${esc(A.email || '구글 계정')}</b><span id="acctNote">${lastSavedAt ? '계정에 저장됨 · ' + ago(new Date(lastSavedAt).toISOString()) : '로그인됨'}</span></div><div class="acct-btns"><button id="acctSave">지금 저장</button><button id="acctOut">로그아웃</button></div>`;
      $('acctSave').onclick = () => saveAcct(true);
      $('acctOut').onclick = async () => { await saveAcct(false); await A.signOut(); renderAcct(); toast('로그아웃했어요. 이 기기에는 기록이 그대로 남아 있어요', 3500); };
    } else {
      el.innerHTML = `<div class="acct-in"><b>게스트로 이용 중</b><span>기록이 이 기기에만 있어요. 로그인하면 기기를 바꿔도 이어집니다</span></div><div class="acct-btns"><button id="acctIn" class="g">구글로 로그인</button></div>`;
      $('acctIn').onclick = () => A.signIn();
    }
  }
  async function saveAcct(manual) {
    if (!A.enabled || !A.signedIn || acctBusy || acctHold) return;
    const st = A.localState(), sig = JSON.stringify(st);
    if (!manual && sig === lastSaved) return;
    acctBusy = true;
    try { await A.saveAccount(st); lastSaved = sig; lastSavedAt = Date.now(); if (manual) toast('☁️ 계정에 저장했어요'); if (!$('profile').classList.contains('hidden')) renderAcct(); }
    catch (e) { if (manual) toast('저장 실패: ' + String(e.message || e).slice(0, 120), 7000); else console.warn('account save', e); }
    acctBusy = false;
  }
  async function afterSignIn() {
    try {
      await A.fetchUser();
      const cloud = await A.loadAccount(), local = A.localState();
      if (!cloud) { await saveAcct(false); toast(`🔐 로그인 완료. 지금까지의 기록을 계정에 연결했어요`, 4000); }
      else if (cloud.state['ghc-uid'] === local['ghc-uid']) { lastSavedAt = new Date(cloud.updated_at).getTime(); await saveAcct(false); toast('🔐 로그인 완료', 2500); }
      else {
        acctHold = true;
        const c = A.summary(cloud.state), l = A.summary(local);
        $('pickCloud').innerHTML = `<small>계정에 저장된 기록</small><b>${esc(c.avatar)} ${esc(c.nick)}</b><span>변기력 ${c.xp.toLocaleString()} · ${ago(cloud.updated_at)} 저장</span>`;
        $('pickLocal').innerHTML = `<small>이 기기의 기록</small><b>${esc(l.avatar)} ${esc(l.nick)}</b><span>변기력 ${l.xp.toLocaleString()}</span>`;
        $('acctDlg').classList.remove('hidden');
        $('useCloud').onclick = () => { A.applyState(cloud.state); location.reload(); };
        $('useLocal').onclick = async () => { acctHold = false; $('acctDlg').classList.add('hidden'); await saveAcct(true); };
      }
    } catch (e) { toast('로그인 처리 실패: ' + String(e.message || e).slice(0, 120), 8000); }
    renderAcct();
  }
  if (A.enabled) {
    if (A.loginError) setTimeout(() => toast('로그인 실패: ' + String(A.loginError).slice(0, 120), 8000), 1500);
    if (A.justSignedIn) setTimeout(afterSignIn, 800);
    else if (A.signedIn) A.fetchUser().catch(() => {}).then(renderAcct);
    setInterval(() => saveAcct(false), 60000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveAcct(false); });
  }

  // ---- 탐험가 수첩 ----
  $('profBtn').onclick = async () => {
    closeSheets(); $('profile').classList.remove('hidden');
    renderMe();
    let v = []; try { v = await B.myVisits(); } catch (e) {}
    const total = v.reduce((a, x) => a + x.count, 0);
    $('stToilets').textContent = v.length; $('stVisits').textContent = total; $('stCoins').textContent = Store.coins.toLocaleString();
    achCheck();
    $('dex').innerHTML = v.length ? v.map(x => `<div><span>🚻 <span data-raw="exact">${esc(x.toilet_name || x.toilet_id)}</span></span><small>${x.count}회 · ${ago(x.last)}</small></div>`).join('') : '<div class="empty">아직 도감이 비어 있어요. 도착 인증으로 첫 변기를 등록하세요!</div>';
  };
  $('profClose').onclick = () => $('profile').classList.add('hidden');
  const AVATARS = ['🚽', '🧻', '🪠', '🧼', '🚿', '🛁', '🧽', '🪣', '💩', '🧴', '🚰', '💧', '🫧', '🧭', '🗺️', '🔦', '🏕️', '🥾', '🎒', '⛑️', '🦝', '🐸', '🐧', '🦆', '🐙', '🦖', '🐢', '🦊', '👻', '👽', '🤖', '🥷', '🧙', '🦸', '🧑‍🚀', '🕵️'];
  function renderMe() {
    renderAcct();
    const m = B.me();
    achCheck();
    if (!deco) drawBoard($('myBoard'), myProfile(), ach.stickers, true);
    $('titleCats').innerHTML = [{ id: 'all', name: '전체' }].concat(CATS).map(c => { const all = TITLES.filter(t => c.id === 'all' || t.cat === c.id); if (!all.length) return ''; return `<button class="${titleCat === c.id ? 'on' : ''}" data-c="${c.id}">${esc(c.name)} <small>${all.filter(t => ach.got[t.id]).length}/${all.length}</small></button>`; }).join('');
    $('titleCats').querySelectorAll('button').forEach(b => b.onclick = () => { titleCat = b.dataset.c; renderMe(); });
    drawTitles($('titles'), Object.keys(ach.got), ach.title, true, titleCat);
    $('titleCount').textContent = `${Object.keys(ach.got).length} / ${TITLES.length}`;
    $('titles').querySelectorAll('.ttl.got').forEach(b => b.onclick = () => { ach.title = b.dataset.t; achSave(); queueProfileSync(); renderMe(); toast(`대표 칭호: 「${TITLE[b.dataset.t].name}」`); });
    renderRelics();
    $('profRank').textContent = '채팅에서 닉네임을 누르면 서로의 프로필 카드를 볼 수 있어요';
    $('nickInput').value = m.nick;
    $('avatars').innerHTML = AVATARS.map(x => `<button class="${x === m.avatar ? 'on' : ''}" data-a="${x}">${x}</button>`).join('');
    $('avatars').querySelectorAll('button').forEach(b => b.onclick = () => { B.setAvatar(b.dataset.a); renderMe(); queueProfileSync(); toast(`프로필 아이콘 변경: ${b.dataset.a}`); });
  }
  $('nickSave').onclick = () => {
    const n = $('nickInput').value.replace(/\s+/g, ' ').trim().slice(0, 16);
    if (n.length < 2) return toast('닉네임은 2글자 이상으로 해주세요');
    B.setNick(n); renderMe(); queueProfileSync(); toast(`닉네임 변경: ${n}`);
  };

  // ---- 도움말: 튜토리얼 / 사용법 ----
  const TUT = [
    ['🧭', '당신은 변기 탐험가', '이 지도의 핀 하나하나가 변기입니다. 동네 변기를 발견하고, 방문하고, 기록을 남기는 것이 탐험가의 일이에요.'],
    ['📡', '급하면 변기탐지', '아래 "변기탐지" 버튼을 누르면 가장 가까운 화장실과 길찾기가 바로 나옵니다. 급할 땐 이것 하나만 기억하세요.'],
    ['✅', '도착하면 인증', '변기 50m 안에서 "도착 인증"을 누르면 코인과 변기력을 얻고, 그 변기의 변기력도 쌓여 등급이 오릅니다. 첫 인증자는 1호 탐험가!'],
    ['🧻', '상태를 알려주세요', '휴지 있음, 잠김, 깨끗함 같은 상태를 버튼 하나로 보고하면 다음 사람이 헛걸음하지 않아요. 보고할 때마다 코인.'],
    ['💬', '동네 탐험가와 대화', '변기마다 "변기 이야기" 채팅이 있고, 💬 버튼은 주변 2km "동네 광장"입니다. 질문에 답해 주면 보상을 받아요.'],
    ['🚀', '준비 완료', '먼저 📍로 내 위치를 잡고, 가까운 핀을 눌러 보세요. 이 안내는 ❓ 버튼에서 언제든 다시 볼 수 있습니다.'],
  ];
  let tutI = 0;
  function renderTut() {
    const [e, t, b] = TUT[tutI];
    $('tutEmoji').textContent = e; $('tutTitle').textContent = t; $('tutBody').textContent = b;
    $('tutDots').innerHTML = TUT.map((_, i) => `<i class="${i === tutI ? 'on' : ''}"></i>`).join('');
    $('tutPrev').disabled = tutI === 0;
    $('tutNext').textContent = tutI === TUT.length - 1 ? '탐험 시작!' : '다음';
  }
  function helpTab(name) {
    document.querySelectorAll('.htab').forEach(x => x.classList.toggle('on', x.dataset.htab === name));
    $('htab-tut').classList.toggle('hidden', name !== 'tut'); $('htab-guide').classList.toggle('hidden', name !== 'guide');
    $('htab-fb').classList.toggle('hidden', name !== 'fb');
  }
  function openHelp(tab) { closeSheets(); $('help').classList.remove('hidden'); tutI = 0; renderTut(); helpTab(tab); }
  function closeHelp() { $('help').classList.add('hidden'); try { localStorage.setItem('ghc-tut-done', '1'); } catch (e) {} }
  document.querySelectorAll('.htab').forEach(b => b.onclick = () => helpTab(b.dataset.htab));
  $('helpBtn').onclick = () => openHelp('tut');
  document.querySelectorAll('.langs button').forEach(b => { b.classList.toggle('on', b.dataset.lang === L10N.lang); b.onclick = () => window.I18N && window.I18N.set(b.dataset.lang); });
  if (L10N.lang !== 'ko') $('privacyLink').href = 'privacy-en.html';
  $('helpClose').onclick = closeHelp;
  $('tutPrev').onclick = () => { if (tutI > 0) { tutI--; renderTut(); } };
  $('tutNext').onclick = () => { if (tutI < TUT.length - 1) { tutI++; renderTut(); } else { closeHelp(); achEvent('tut'); if (serverMode) B.claimTut().then(applyWallet).catch(() => {}); } };
  // 의견 보내기
  const VERSION = '__VERSION__';
  $('verLabel').textContent = VERSION.startsWith('__') ? '개발용' : VERSION;
  $('fbSend').onclick = async () => {
    const text = $('fbText').value.trim(); if (text.length < 3) return toast('내용을 조금만 더 적어주세요');
    $('fbSend').disabled = true;
    try { await B.postFeedback(text, VERSION); $('fbText').value = ''; toast('🙏 의견 고마워요! 개발자에게 전달됐어요', 3000); }
    catch (e) { toast('전송 실패: ' + String(e.message || e).slice(0, 120), 7000); }
    $('fbSend').disabled = false;
  };
  // 첫 방문이면 튜토리얼 자동 표시
  let tutDone = false; try { tutDone = !!localStorage.getItem('ghc-tut-done'); } catch (e) {}
  if (!tutDone) setTimeout(() => openHelp('tut'), 1200);

  // 시트 열릴 때 변기 레벨/채팅 로드 (openSheet 확장)
  const _open = openSheet;
  openSheet = function (t) {
    _open(t);
    document.querySelector('.tab[data-tab="status"]').click();
    renderToiletLevel(statsCache.get(t.id) || { xp: 0, level: 1, visits: 0, explorers: 0, first_nick: null, mine: 0 });
    loadToiletLevel(t);
    B.listMessages('toilet:' + t.id).then(r => { $('talkCnt').textContent = r.length || ''; }).catch(() => {});
  };

  // ===== 시작 =====
  refreshHUD();
  locate(true);
  setTimeout(() => { if (!me) loadAround(...DEFAULT); }, 9000);
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // 안드로이드 뒤로 가기: 열린 창이 있으면 닫고, 없으면 앱을 나간다
  if (NATIVE) {
    const P = window.Capacitor.Plugins || {};
    try {
      P.App && P.App.addListener('backButton', () => {
        const open = ['photoView', 'acctDlg', 'addDlg', 'mission', 'shop', 'peek', 'sheet', 'sos', 'area', 'profile', 'help'].find(id => $(id) && !$(id).classList.contains('hidden'));
        if (open === 'photoView' || open === 'acctDlg' || open === 'addDlg' || open === 'mission') $(open).classList.add('hidden');
        else if (open) closeSheets();
        else P.App.exitApp();
      });
    } catch (e) {}
  }
})();
