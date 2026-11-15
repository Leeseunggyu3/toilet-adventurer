/* 급해요 시티 v0 — app.js */
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
  const RANKS = [[0, '수습 화장실 지킴이'], [100, '동네 화장실 지킴이'], [400, '구역 순찰대장'], [1000, '시티 레인저'], [2500, '방광의 수호자'], [6000, '전설의 화장실 마스터']];
  function refreshHUD() {
    $('coins').textContent = Store.coins.toLocaleString();
    const lvl = Math.floor(Math.sqrt(Store.xp / 50)) + 1, cur = (lvl - 1) ** 2 * 50, nxt = lvl ** 2 * 50;
    $('level').textContent = lvl; $('xpfill').style.width = `${((Store.xp - cur) / (nxt - cur)) * 100}%`;
    let r = RANKS[0][1]; for (const [x, n] of RANKS) if (Store.xp >= x) r = n;
    $('rankLabel').textContent = r;
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
    if (t.src === 'user') bits.push(t.flagged ? '⚠️ 신고됨' : '사용자 등록 (검증 대기)');
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
    }, () => { toast('위치 권한이 없어 기본 위치로 시작해요'); loadAround(...DEFAULT); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 });
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
    renderStatus(sel); restyle();
    document.querySelectorAll('.reports button').forEach(x => { if (x.dataset.k === b.dataset.k) x.classList.toggle('done', x === b); });
    reward(near ? 10 : 3, near ? '현장 보고!' : '보고 (현장이면 10💰)');
    checkDaily();
  });
  $('verifyBtn').onclick = () => {
    if (!sel) return;
    if (!me) return toast('위치를 먼저 켜주세요');
    const d = dist(me[0], me[1], sel.lat, sel.lng);
    if (d > 50) return toast(`${fmtD(d)} 떨어져 있어요. 50m 안에서 인증!`);
    Store.verify(sel.id); reward(30, '도착 인증!'); checkDaily();
    if (mission && mission.id === sel.id) { reward(mission.bonus, '미션 완료!'); mission = null; $('mission').classList.add('hidden'); }
    openSheet(sel);
  };
  $('flagBtn').onclick = () => { if (!sel) return; Store.flag(sel.id); toast('신고 접수. 여러 명이 신고하면 지도에서 내려가요'); };

  // ===== 급해요 =====
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
    $('addCancel').onclick(); $('addName').value = '';
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

  // ===== 시작 =====
  refreshHUD();
  locate(true);
  setTimeout(() => { if (!me) loadAround(...DEFAULT); }, 9000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
