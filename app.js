/* Toilet Adventurer — app.js */
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
  // 계통: 어떤 행동을 많이 하느냐에 따라 발현되는 탐험가의 성질
  const STYLES = {
    report: ['💧', '맑음', '변기의 상태를 꿰뚫어 보는 자. 상태 보고를 많이 할수록 깊어진다'],
    visit:  ['👣', '발자국', '직접 걸어가 닿는 자. 도착 인증을 많이 할수록 깊어진다'],
    talk:   ['🔔', '메아리', '말로 길을 여는 자. 이야기와 답변을 많이 할수록 깊어진다'],
    found:  ['🕯️', '등불', '없던 곳을 밝히는 자. 화장실 등록과 1호 탐험으로 깊어진다'],
  };
  const styleCounts = () => { try { return JSON.parse(localStorage.getItem('ghc-style') || '{}'); } catch (e) { return {}; } };
  function bump(k) { const c = styleCounts(); const before = myStyle(); c[k] = (c[k] || 0) + 1; try { localStorage.setItem('ghc-style', JSON.stringify(c)); } catch (e) {} const after = myStyle(); if (after && (!before || before[1] !== after[1])) setTimeout(() => toast(`${after[0]} 계통 발현: ${after[1]}`, 3500), 2200); }
  function myStyle() { const c = styleCounts(); const total = Object.values(c).reduce((x, y) => x + y, 0); if (total < 5) return null; const top = Object.keys(STYLES).sort((x, y) => (c[y] || 0) - (c[x] || 0))[0]; return STYLES[top]; }
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
  function reward(c, why) { Store.earn(c); refreshHUD(); toast(`+${c}💰 ${why}`); }

  // ===== 화장실 데이터 (OSM Overpass, 사용자 등록) =====
  function tileKey(lat, lng) { return `${Math.floor(lat * 50)}:${Math.floor(lng * 50)}`; } // ~2km 격자
  async function loadAround(lat, lng) {
    const k = tileKey(lat, lng); if (fetched.has(k)) return; fetched.add(k);
    const d = 0.012; // 약 1.3km
    const q = `[out:json][timeout:20];(node["amenity"="toilets"](${lat - d},${lng - d},${lat + d},${lng + d});way["amenity"="toilets"](${lat - d},${lng - d},${lat + d},${lng + d}););out center 200;`;
    const cacheKey = 'ghc-osm-' + k;
    let data = null;
    try { const c = JSON.parse(localStorage.getItem(cacheKey) || 'null'); if (c && Date.now() - c.t < 7 * 864e5) data = c.d; } catch (e) {}
    if (!data) {
      try {
        const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + enc(q) });
        const j = await r.json();
        data = (j.elements || []).map(e => ({ id: 'osm' + e.id, lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon, name: e.tags?.name || e.tags?.['name:ko'] || '공중화장실', src: 'osm', tags: e.tags || {} })).filter(t => t.lat && t.lng);
        try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), d: data })); } catch (e) {}
      } catch (e) { fetched.delete(k); toast('화장실 데이터를 불러오지 못했어요 (네트워크)'); return; }
    }
    let n = 0; for (const t of data) if (!toilets.has(t.id)) { toilets.set(t.id, t); addMarker(t); n++; }
    if (n) toast(`주변 화장실 ${n}곳 불러옴`);
  }
  function describe(t) {
    const tg = t.tags || {}, bits = [];
    if (tg.fee === 'yes') bits.push('유료'); if (tg.wheelchair === 'yes') bits.push('♿ 휠체어'); if (tg.opening_hours) bits.push(tg.opening_hours);
    if (tg.unisex === 'yes') bits.push('남녀공용'); if (tg.changing_table === 'yes') bits.push('기저귀교환대');
    if (t.src === 'user') bits.push(t.by ? `${t.by} 님이 등록` : '사용자 등록');
    if (t.flagged) bits.push('⚠️ 없다는 신고 있음');
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
    renderStatus(t);
    navLinks(t, 'navKakao', 'navNaver', 'navGoogle');
    const vb = $('verifyBtn'); vb.disabled = !Store.canVerify(t.id);
    vb.textContent = vb.disabled ? '✅ 오늘 이미 인증했어요' : '✅ 도착 인증 (50m 이내) +30💰';
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
    bump('report'); achEvent('rep');
    reward(near ? 10 : 3, near ? '현장 보고!' : '보고 (현장이면 10💰)');
    checkDaily();
  });
  $('verifyBtn').onclick = () => {
    if (!sel) return;
    if (!me) return toast('위치를 먼저 켜주세요');
    const d = dist(me[0], me[1], sel.lat, sel.lng);
    if (d > 50) return toast(`${fmtD(d)} 떨어져 있어요. 50m 안에서 인증!`);
    Store.verify(sel.id); bump('visit'); achEvent('visit', sel.id); reward(30, '도착 인증!'); checkDaily();
    if (mission && mission.id === sel.id) { reward(mission.bonus, '미션 완료!'); mission = null; $('mission').classList.add('hidden'); }
    openSheet(sel);
  };
  $('flagBtn').onclick = () => { if (!sel) return; Store.flag(sel.id); window.Backend.postReport(sel.id, 'flagged', 1).catch(() => {}); toast('신고 접수. 여러 명이 신고하면 지도에서 내려가요'); };

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
    const t = { id: 'u' + Date.now(), lat: c.lat, lng: c.lng, name, src: 'user', tags: { access: $('addFree').checked ? 'yes' : 'customers' } };
    Store.addToilet(t); toilets.set(t.id, t); addMarker(t);
    window.Backend.addToilet(t).catch(e => toast('등록 공유 실패: ' + String(e.message || e).slice(0, 100), 6000));
    $('addCancel').onclick(); $('addName').value = '';
    bump('found'); achEvent('reg');
    reward(50, '등록 완료! 검증되면 +50 더');
  };
  for (const t of Store.userToilets()) { toilets.set(t.id, t); addMarker(t); }

  // ===== 미션 =====
  $('missionBtn').onclick = () => {
    if (!me) return toast('위치를 먼저 켜주세요');
    const cands = [...toilets.values()].filter(t => { const d = dist(me[0], me[1], t.lat, t.lng); return d > 120 && d < 900 && Store.canVerify(t.id); });
    if (!cands.length) return toast('900m 안에 미션 가능한 화장실이 없어요');
    const t = cands[(Math.random() * cands.length) | 0], d = dist(me[0], me[1], t.lat, t.lng);
    mission = { id: t.id, bonus: 40 + Math.round(d / 20) };
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
  const FLAG_HIDE = 2; // 서로 다른 탐험가 2명 이상이 "없음" 신고하면 변기탐지 후보에서 제외
  let syncBusy = false, lastSync = 0;
  async function syncShared(force) {
    const SB = window.Backend;
    if (SB.demo || syncBusy || (!force && Date.now() - lastSync < 20000)) return;
    syncBusy = true; lastSync = Date.now();
    try {
      const c = map.getCenter();
      const [reps, flags, ut] = await Promise.all([SB.recentReports(), SB.flagCounts(), SB.toiletsIn(c.lat, c.lng, 0.05)]);
      for (const r of ut) if (!toilets.has(r.id)) { const t = { id: r.id, lat: r.lat, lng: r.lng, name: r.name, src: 'user', by: r.nick, tags: { access: r.access } }; toilets.set(t.id, t); addMarker(t); }
      for (const t of toilets.values()) t.flagged = (flags[t.id] || 0) >= FLAG_HIDE;
      const changed = Store.mergeRemote(reps);
      if (changed || ut.length) restyle();
      if (changed && sel && !$('sheet').classList.contains('hidden')) renderStatus(sel);
    } catch (e) { console.warn('sync failed', e); }
    syncBusy = false;
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
  else B.listMessages('area:ping').then(() => setTimeout(() => toast('🌐 탐험가 서버 연결됨', 2500), 2500)).catch(e => setTimeout(() => toast('서버 연결 실패: ' + String(e.message || e).slice(0, 80), 6000), 2500));

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
      try {
        const s = await B.recordVisit(sel.id, sel.name);
        const prev = statsCache.get(sel.id);
        statsCache.set(sel.id, s); renderToiletLevel(s); markers.get(sel.id)?.setIcon(icon(sel));
        if (s.visits === 1) { bump('found'); achEvent('first'); reward(40, '🏁 이 변기의 1호 탐험가!'); unlock('first'); }
        if (prev && s.level > prev.level) { reward(20, `⚡ 변기 등급 상승! ${s.level}등급`); }
        if (s.mine >= 10) unlock('regular');
      } catch (e) { console.error(e); toast('방문 기록 실패: ' + String(e.message || e).slice(0, 140), 9000); }
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
  async function loadChat(channel, elId) {
    const el = $(elId); let rows = [];
    try { rows = await B.listMessages(channel); } catch (e) { el.innerHTML = '<div class="empty">채팅을 불러오지 못했어요</div>'; return; }
    if (elId === 'toiletChat') $('talkCnt').textContent = rows.length || '';
    if (!rows.length) { el.innerHTML = `<div class="empty">아직 조용해요. 첫 마디를 남겨보세요 🚽</div>`; return; }
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    el.innerHTML = rows.map(r => {
      const mine = r.user_id === myId;
      const parent = r.parent && byId[r.parent];
      const canHelp = parent && parent.user_id === myId && !mine && !r._thanked;
      return `<div class="msg ${mine ? 'mine' : ''} ${r.kind === 'question' ? 'question' : ''}" data-id="${r.id}">
        <div class="who"><span class="nicklink" data-uid="${esc(r.user_id)}" data-nick="${esc(r.nick)}">${r.kind === 'question' ? '❓ ' : ''}${esc(r.nick)}</span><span>${ago(r.at)}</span></div>
        ${parent ? `<div style="font-size:11px;opacity:.7;margin-bottom:3px">↳ ${esc(parent.text.slice(0, 30))}</div>` : ''}
        <div>${esc(r.text)}</div>
        ${r.helpful ? `<div class="help">👍 도움됐어요 ${r.helpful}</div>` : ''}
        <div class="act">${!mine ? `<button data-reply="${r.id}">답하기</button>` : ''}${canHelp ? `<button data-help="${r.id}">👍 도움됐어요 (+15💰)</button>` : ''}</div>
      </div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
    el.querySelectorAll('.nicklink').forEach(s => s.onclick = () => openPeek(s.dataset.uid, s.dataset.nick));
    el.querySelectorAll('[data-reply]').forEach(b => b.onclick = () => { replyTo = b.dataset.reply; const inp = el.nextElementSibling.querySelector('input'); inp.placeholder = '답글 작성 중…'; inp.focus(); });
    el.querySelectorAll('[data-help]').forEach(b => b.onclick = async () => { await B.markHelpful(b.dataset.help); b.remove(); toast('👍 답해준 탐험가에게 +15💰 전달!'); loadChat(channel, elId); });
  }
  async function send(channel, inputId, elId, toilet_id, text) {
    text = (text || $(inputId).value).trim(); if (!text) return;
    const kind = replyTo ? 'answer' : /\?|나요|있어요|어디|추천/.test(text) ? 'question' : 'chat';
    try { await B.postMessage({ channel, toilet_id, text, kind, parent: replyTo }); } catch (e) { console.error(e); return toast('전송 실패: ' + String(e.message || e).slice(0, 140), 9000); }
    $(inputId).value = ''; $(inputId).placeholder = inputId === 'toiletMsg' ? '이 변기에 남길 말…' : '동네 탐험가들에게…'; replyTo = null;
    bump('talk'); achEvent('talk');
    reward(kind === 'answer' ? 5 : 2, kind === 'answer' ? '답변!' : '이야기 남김');
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
    clearInterval(chatTimer); chatTimer = setInterval(() => { if (!$('area').classList.contains('hidden')) loadChat(areaChannel(), 'areaChat'); else clearInterval(chatTimer); }, 6000);
  };
  $('areaClose').onclick = () => { $('area').classList.add('hidden'); clearInterval(chatTimer); };
  function closeSheets() { if (deco) endDeco(); ['sheet', 'sos', 'area', 'profile', 'help', 'peek'].forEach(id => $(id).classList.add('hidden')); }


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
  const TITLES = [
    { id: 'tut', name: '갓 눈뜬 자', desc: '튜토리얼을 끝까지 마친다', st: '🌱', ok: () => ach.tut },
    { id: 'v1', name: '첫 발자국', desc: '처음으로 도착 인증을 한다', st: '👣', ok: () => ach.v.length >= 1 },
    { id: 'd3', name: '골목의 순례자', desc: '서로 다른 변기 3곳 발견', st: '🚪', ok: () => distinct() >= 3 },
    { id: 'd10', name: '열 개의 문을 연 자', desc: '서로 다른 변기 10곳 발견', st: '🗝️', ok: () => distinct() >= 10 },
    { id: 'd30', name: '서른 문의 주인', desc: '서로 다른 변기 30곳 발견', st: '👑', ok: () => distinct() >= 30 },
    { id: 'r1', name: '물을 읽는 자', desc: '처음으로 상태 보고를 한다', st: '💧', ok: () => ach.rep >= 1 },
    { id: 'r10', name: '맑은 눈', desc: '상태 보고 10회', st: '👁️', ok: () => ach.rep >= 10 },
    { id: 'r50', name: '천 갈래 물길을 보는 자', desc: '상태 보고 50회', st: '🔮', ok: () => ach.rep >= 50 },
    { id: 't10', name: '메아리꾼', desc: '이야기를 10번 남긴다', st: '🔔', ok: () => ach.talk >= 10 },
    { id: 'g1', name: '등불지기', desc: '지도에 없던 화장실을 등록한다', st: '🕯️', ok: () => ach.reg >= 1 },
    { id: 'f1', name: '개척자', desc: '어느 변기의 1호 탐험가가 된다', st: '🚩', ok: () => ach.first >= 1 },
    { id: 's3', name: '질풍수류', desc: '2시간 안에 서로 다른 변기 3곳 인증', st: '⚡', ok: () => burst(3, 2 * HOUR) },
    { id: 's5', name: '하루 다섯 문', desc: '24시간 안에 서로 다른 변기 5곳 인증', st: '🌪️', ok: () => burst(5, 24 * HOUR) },
    { id: 'n1', name: '심야의 방랑자', desc: '자정에서 새벽 5시 사이에 도착 인증', st: '🌙', ok: () => ach.v.some(([, t]) => new Date(t).getHours() < 5) },
    { id: 'k3', name: '소용돌이를 건넌 자', desc: "경지 '소용돌이'에 이른다", st: '🌀', ok: () => Store.xp >= 1000 },
  ];
  const TITLE = Object.fromEntries(TITLES.map(t => [t.id, t]));
  const STICKER_OK = new Set(TITLES.map(t => t.st));
  function achCheck() {
    let news = 0;
    for (const t of TITLES) if (!ach.got[t.id] && t.ok()) { ach.got[t.id] = Date.now(); if (!ach.title) ach.title = t.id; news++; const d = 2600 + news * 2300; setTimeout(() => toast(`🏅 칭호 획득: ${t.name} · 스티커 ${t.st} 해금`, 3800), d); }
    achSave(); if (news) queueProfileSync();
  }
  function achEvent(kind, id) {
    if (kind === 'visit') ach.v.push([id, Date.now()]); else if (kind === 'tut') ach.tut = true; else ach[kind] = (ach[kind] || 0) + 1;
    if (ach.v.length > 400) ach.v = ach.v.slice(-400);
    achCheck();
  }
  // ---- 내 프로필 데이터 (서버에 올라가는 모양) ----
  function myProfile() {
    const m = B.me(), st = myStyle();
    return { nick: m.nick, avatar: m.avatar, title: ach.title, titles: Object.keys(ach.got), rank: $('rankLabel').textContent, power: Store.xp, style: st ? `${st[0]} ${st[1]}` : null, stickers: ach.stickers, found: distinct() };
  }
  let syncT = null;
  function queueProfileSync() { clearTimeout(syncT); syncT = setTimeout(() => B.saveProfile(myProfile()).catch(e => console.warn('profile sync', e)), 1500); }
  // ---- 프로필 카드 그리기 ----
  function cleanStickers(list) { return (Array.isArray(list) ? list : []).filter(s => s && STICKER_OK.has(s.s) && isFinite(s.x) && isFinite(s.y)).slice(0, 10).map(s => ({ s: s.s, x: Math.max(4, Math.min(96, +s.x)), y: Math.max(8, Math.min(92, +s.y)), z: Math.max(0.5, Math.min(2.5, +s.z || 1)) })); }
  function drawBoard(el, p, stickers, mine) {
    const t = TITLE[p.title];
    el.innerHTML = `<div class="b-main"><div class="me-avatar" ${mine ? 'id="meAvatar"' : ''}>${esc(p.avatar || '🚽')}</div><div>
        ${t ? `<div class="b-title">「${esc(t.name)}」</div>` : ''}
        <div class="me-name" ${mine ? 'id="meName"' : ''}>${esc(p.nick || '이름 없는 탐험가')}</div>
        <div class="me-sub">${esc(p.rank || '잠든 물방울')} · 변기력 ${(+p.power || 0).toLocaleString()}${p.style ? ' · ' + esc(p.style) + ' 계통' : ''}</div></div></div>`
      + cleanStickers(stickers).map((s, i) => `<span class="stk" data-i="${i}" style="left:${s.x}%;top:${s.y}%;font-size:${Math.round(30 * s.z)}px">${s.s}</span>`).join('');
  }
  function drawTitles(el, gotIds, equipped, mine) {
    const got = new Set(gotIds);
    const list = mine ? TITLES : TITLES.filter(t => got.has(t.id));
    el.innerHTML = list.length ? list.map(t => `<button class="ttl ${got.has(t.id) ? 'got' : 'locked'} ${equipped === t.id ? 'on' : ''}" data-t="${t.id}" ${mine && got.has(t.id) ? '' : 'disabled'}>
        <span class="ttl-st">${got.has(t.id) ? t.st : '🔒'}</span><span class="ttl-tx"><b>${esc(t.name)}</b><small>${esc(t.desc)}</small></span>${equipped === t.id ? '<i>대표</i>' : ''}</button>`).join('') : '<div class="empty">아직 획득한 칭호가 없어요</div>';
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
    const mineSt = TITLES.filter(t => ach.got[t.id]).map(t => t.st);
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
    $('peekMeta').textContent = '불러오는 중…'; $('peekBoard').innerHTML = ''; $('peekTitles').innerHTML = '';
    let p = null; try { p = await B.getProfile(userId); } catch (e) {}
    if (!p) { $('peekMeta').textContent = '아직 프로필 카드를 만들지 않은 탐험가예요'; drawBoard($('peekBoard'), { nick: fallbackNick, avatar: '🚽' }, [], false); $('peekTitles').innerHTML = '<div class="empty">공개된 칭호가 없어요</div>'; return; }
    $('peekMeta').textContent = `발견한 변기 ${+p.found || 0}곳 · 칭호 ${(p.titles || []).length}개`;
    drawBoard($('peekBoard'), p, p.stickers, false);
    drawTitles($('peekTitles'), p.titles || [], p.title, false);
  }
  $('peekClose').onclick = () => $('peek').classList.add('hidden');
  setTimeout(achCheck, 3500); // 이미 조건을 채운 칭호는 시작할 때 바로 지급

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
  const BADGES = { first: '🏁 1호 탐험가', regular: '🪑 단골 (한 변기 10회)', ten: '🔟 변기 10곳 발견', fifty: '5️⃣0️⃣ 변기 50곳 발견', helper: '🤝 동네 해결사', reporter: '📣 상태 보고 30회' };
  const unlocked = () => { try { return JSON.parse(localStorage.getItem('ghc-badges') || '{}'); } catch (e) { return {}; } };
  function unlock(k) { const u = unlocked(); if (u[k]) return; u[k] = 1; try { localStorage.setItem('ghc-badges', JSON.stringify(u)); } catch (e) {} toast(`🏅 뱃지 획득: ${BADGES[k]}`, 2500); }
  $('profBtn').onclick = async () => {
    closeSheets(); $('profile').classList.remove('hidden');
    renderMe();
    let v = []; try { v = await B.myVisits(); } catch (e) {}
    const total = v.reduce((a, x) => a + x.count, 0);
    $('stToilets').textContent = v.length; $('stVisits').textContent = total; $('stCoins').textContent = Store.coins.toLocaleString();
    if (v.length >= 10) unlock('ten'); if (v.length >= 50) unlock('fifty');
    const u = unlocked();
    achCheck();
    $('dex').innerHTML = v.length ? v.map(x => `<div><span>🚻 ${esc(x.toilet_name || x.toilet_id)}</span><small>${x.count}회 · ${ago(x.last)}</small></div>`).join('') : '<div class="empty">아직 도감이 비어 있어요. 도착 인증으로 첫 변기를 등록하세요!</div>';
  };
  $('profClose').onclick = () => $('profile').classList.add('hidden');
  const AVATARS = ['🚽', '🧻', '🪠', '🧼', '🚿', '🛁', '🧽', '🪣', '💩', '🧴', '🚰', '💧', '🫧', '🧭', '🗺️', '🔦', '🏕️', '🥾', '🎒', '⛑️', '🦝', '🐸', '🐧', '🦆', '🐙', '🦖', '🐢', '🦊', '👻', '👽', '🤖', '🥷', '🧙', '🦸', '🧑‍🚀', '🕵️'];
  function renderMe() {
    renderAcct();
    const m = B.me();
    achCheck();
    if (!deco) drawBoard($('myBoard'), myProfile(), ach.stickers, true);
    drawTitles($('titles'), Object.keys(ach.got), ach.title, true);
    $('titleCount').textContent = `${Object.keys(ach.got).length} / ${TITLES.length}`;
    $('titles').querySelectorAll('.ttl.got').forEach(b => b.onclick = () => { ach.title = b.dataset.t; achSave(); queueProfileSync(); renderMe(); toast(`대표 칭호: 「${TITLE[b.dataset.t].name}」`); });
    const st = myStyle();
    $('meStyle').innerHTML = st ? `<b>${st[0]} ${st[1]} 계통</b><span>${st[2]}</span>` : `<b>❔ 계통 미발현</b><span>보고·인증·이야기·등록을 합쳐 5번 하면 당신의 계통이 드러납니다</span>`;
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
  $('helpClose').onclick = closeHelp;
  $('tutPrev').onclick = () => { if (tutI > 0) { tutI--; renderTut(); } };
  $('tutNext').onclick = () => { if (tutI < TUT.length - 1) { tutI++; renderTut(); } else { closeHelp(); achEvent('tut'); } };
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
