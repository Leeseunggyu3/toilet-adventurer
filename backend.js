/* backend.js — 공유 데이터(채팅, 변기 XP, 탐험가 기록).
   두 구현이 같은 인터페이스를 가진다:
   - LocalBackend : 데모. localStorage + BroadcastChannel (같은 기기 탭끼리만 공유)
   - SupabaseBackend : 실서비스. PostgREST만 사용 (SDK 없음)
   인터페이스:
     me() -> {id, nick}            setNick(nick)
     listMessages(channel, since?) -> [{id, channel, toilet_id, user_id, nick, text, kind, parent, helpful, at}]
     postMessage({channel, toilet_id, text, kind, parent})
     markHelpful(messageId)
     recordVisit(toilet_id, toilet_name) -> {xp, visits, explorers, first_nick, mine}
     toiletStats(toilet_id) -> 같은 형태
     myVisits() -> [{toilet_id, toilet_name, count, last}]
*/
(() => {
  const uid = (() => { try { let u = localStorage.getItem('ghc-uid'); if (!u) { u = 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem('ghc-uid', u); } return u; } catch (e) { return 'anon'; } })();
  // 처음 만들어지는 닉네임은 그 사람의 언어로 (이후에는 사용자가 바꾸기 전까지 그대로)
  const NICK_WORDS = {
    ko: [['용감한', '수상한', '빠른', '졸린', '전설의', '친절한', '배고픈', '반짝이는', '조용한', '급한'], ['변기탐험가', '휴지수호자', '물내림장인', '칸막이요정', '비데마스터', '화장실레인저']],
    en: [['Brave', 'Sneaky', 'Swift', 'Sleepy', 'Legendary', 'Kind', 'Hungry', 'Sparkly', 'Quiet', 'Urgent'], ['Explorer', 'PaperGuard', 'FlushMaster', 'StallSprite', 'BidetHero', 'LooRanger']],
    ja: [['勇敢な', 'あやしい', '素早い', '眠たい', '伝説の', 'やさしい', '腹ぺこ', 'きらめく', '静かな', 'あせる'], ['トイレ探検家', '紙の守護者', '水流の達人', '個室の妖精', 'ビデマスター', 'トイレレンジャー']],
  };
  const [ADJ, NOUN] = NICK_WORDS[(window.I18N && window.I18N.lang) || 'ko'] || NICK_WORDS.ko;
  const defaultNick = () => { let h = 0; for (const c of uid) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `${ADJ[h % ADJ.length]}${(window.I18N && window.I18N.lang) === 'ja' ? '' : ' '}${NOUN[(h >>> 4) % NOUN.length]} #${(h % 9000) + 1000}`; };
  const getNick = () => { try { return localStorage.getItem('ghc-nick') || defaultNick(); } catch (e) { return defaultNick(); } };
  const getAvatar = () => { try { return localStorage.getItem('ghc-avatar') || '🚽'; } catch (e) { return '🚽'; } };
  // 서버에는 "아이콘 이름" 한 덩어리로 저장한다 (스키마 변경 없이 채팅·1호 탐험가 기록에 아이콘이 따라간다)
  const fullNick = () => `${getAvatar()} ${getNick()}`;
  // 프로필 수정용 비밀 열쇠: 이 기기에만 저장되고 서버에는 해시만 남는다 (남이 내 프로필을 덮어쓰지 못하게)
  const secret = (() => { try { let k = localStorage.getItem('ghc-secret'); if (!k) { k = Array.from(crypto.getRandomValues(new Uint8Array(24)), x => x.toString(16).padStart(2, '0')).join(''); localStorage.setItem('ghc-secret', k); } return k; } catch (e) { return 'nosecret-' + uid + '-padpadpad'; } })();

  // ---------- 데모(로컬) ----------
  class LocalBackend {
    constructor() {
      this.demo = true;
      try { this.db = JSON.parse(localStorage.getItem('ghc-local-db') || 'null') || { messages: [], visits: [] }; } catch (e) { this.db = { messages: [], visits: [] }; }
      try { this.bc = new BroadcastChannel('ghc'); this.bc.onmessage = () => { try { this.db = JSON.parse(localStorage.getItem('ghc-local-db')) || this.db; } catch (e) {} }; } catch (e) {}
    }
    _save() { try { localStorage.setItem('ghc-local-db', JSON.stringify(this.db)); this.bc && this.bc.postMessage(1); } catch (e) {} }
    me() { return { id: uid, nick: getNick(), avatar: getAvatar(), full: fullNick() }; }
    setNick(n) { try { localStorage.setItem('ghc-nick', n); } catch (e) {} }
    setAvatar(a) { try { localStorage.setItem('ghc-avatar', a); } catch (e) {} }
    async listMessages(channel) { return this.db.messages.filter(m => m.channel === channel).slice(-80); }
    async postMessage(m) { const row = Object.assign({ id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), user_id: uid, nick: fullNick(), helpful: 0, at: new Date().toISOString() }, m); this.db.messages.push(row); this._save(); return row; }
    async markHelpful(id) { const m = this.db.messages.find(x => x.id === id); if (m) { m.helpful = (m.helpful || 0) + 1; this._save(); } }
    async recordVisit(toilet_id, toilet_name) { this.db.visits.push({ toilet_id, toilet_name, user_id: uid, nick: fullNick(), at: new Date().toISOString() }); this._save(); return this.toiletStats(toilet_id); }
    async toiletStats(toilet_id) { const v = this.db.visits.filter(x => x.toilet_id === toilet_id); return statsFrom(v); }
    async myVisits() { return groupMine(this.db.visits.filter(v => v.user_id === uid)); }
    // 데모 모드에서는 보고/등록 공유가 없다 (store.js의 로컬 저장만 사용)
    async postReport() {} async recentReports() { return []; } async flagCounts() { return {}; }
    async toiletFlags() { return {}; }
    async listPhotos(toilet_id) { return (this.db.photos || []).filter(p => p.toilet_id === toilet_id).slice(-6).reverse(); }
    async postPhoto(toilet_id, kind, data, thumb) { (this.db.photos || (this.db.photos = [])).push({ id: Date.now(), toilet_id, kind, data, thumb, user_id: uid, nick: fullNick(), at: new Date().toISOString() }); this._save(); }
    async photoData(id) { const p = (this.db.photos || []).find(x => x.id === id); return p ? p.data : null; }
    async reportPhoto() { return false; }
    async addToilet() {} async toiletsIn() { return []; }
    async saveProfile(data) { (this.db.profiles || (this.db.profiles = {}))[uid] = data; this._save(); }
    async getProfile(id) { return (this.db.profiles || {})[id] || null; }
    async postFeedback(text, version) { (this.db.feedback || (this.db.feedback = [])).push({ text, version, at: new Date().toISOString() }); this._save(); }
  }

  // ---------- Supabase ----------
  class SupabaseBackend {
    constructor(url, key) { this.demo = false; this.url = url.replace(/\/$/, ''); this.h = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }; }
    async _get(path) { const r = await fetch(`${this.url}/rest/v1/${path}`, { headers: this.h }); if (!r.ok) throw new Error(await r.text()); return r.json(); }
    async _post(table, body) {
      // null 필드는 보내지 않고, 응답 본문도 요구하지 않는다 (실패 지점 최소화)
      const clean = {}; for (const k in body) if (body[k] !== null && body[k] !== undefined) clean[k] = body[k];
      const r = await fetch(`${this.url}/rest/v1/${table}`, { method: 'POST', headers: Object.assign({ Prefer: 'return=minimal' }, this.h), body: JSON.stringify(clean) });
      if (!r.ok) { let t = await r.text(); try { const j = JSON.parse(t); t = `[${r.status} ${j.code || ''}] ${j.message || t}`; } catch (e) { t = `[${r.status}] ${t}`; } throw new Error(t); }
      return clean;
    }
    me() { return { id: uid, nick: getNick(), avatar: getAvatar(), full: fullNick() }; }
    setNick(n) { try { localStorage.setItem('ghc-nick', n); } catch (e) {} }
    setAvatar(a) { try { localStorage.setItem('ghc-avatar', a); } catch (e) {} }
    async listMessages(channel) { return (await this._get(`messages?channel=eq.${encodeURIComponent(channel)}&order=at.desc&limit=80`)).reverse(); }
    // since 이후에 올라온 글만 (열어둔 채팅을 몇 초마다 다시 볼 때 전송량을 줄인다)
    async listMessagesSince(channel, since) { return this._get(`messages?channel=eq.${encodeURIComponent(channel)}&at=gte.${encodeURIComponent(since)}&order=at.asc&limit=80`); }
    // ---- 본인 확인이 붙은 쓰기 (schema_v7). 서버에 v7이 없으면(404) 예전 방식으로 직접 쓴다 ----
    async _signed(name, body, legacy) {
      if (this.signed !== false) {
        const r = await fetch(`${this.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: this.h, body: JSON.stringify(Object.assign({ p_user: uid, p_secret: secret }, body)) });
        if (r.ok) { this.signed = true; return; }
        if (r.status !== 404) { const t = await r.text(); let m = t; try { m = JSON.parse(t).message || t; } catch (e) {} throw new Error(String(m).slice(0, 200)); }
        this.signed = false;
      }
      return legacy();
    }
    async postMessage(m) {
      return this._signed('post_message', { p_channel: m.channel, p_text: m.text, p_kind: m.kind || 'chat', p_toilet: m.toilet_id || null, p_parent: m.parent || null, p_nick: fullNick() },
        () => this._post('messages', Object.assign({ user_id: uid, nick: fullNick() }, m)));
    }
    async markHelpful(id) { await fetch(`${this.url}/rest/v1/rpc/mark_helpful`, { method: 'POST', headers: this.h, body: JSON.stringify({ mid: id }) }); }
    async recordVisit(toilet_id, toilet_name, tz, lat, lng) {
      await this._signed('post_visit', { p_toilet: toilet_id, p_name: toilet_name || null, p_nick: fullNick(), p_tz: tz === undefined ? null : tz, p_lat: lat === undefined ? null : lat, p_lng: lng === undefined ? null : lng },
        () => this._post('visits', { toilet_id, toilet_name, user_id: uid, nick: fullNick(), tz }));
      return this.toiletStats(toilet_id);
    }
    // ---- 서버 지갑 (schema_v6): 코인·변기력·칭호·구매를 서버가 계산한다 ----
    async _rpc(name, body) {
      const r = await fetch(`${this.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: this.h, body: JSON.stringify(body) });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
      if (!r.ok) { const err = new Error((j && j.message) || `[${r.status}] ${t.slice(0, 120)}`); err.status = r.status; err.missing = r.status === 404; throw err; }
      if (!j || typeof j !== 'object') { const err = new Error('서버 응답을 읽지 못했어요'); err.missing = true; throw err; }
      return j;
    }
    walletState() { return this._rpc('wallet_state', { p_user: uid }); }
    claimBonus() { return this._rpc('claim_bonus', { p_user: uid, p_secret: secret }); }
    claimMission(toilet) { return this._rpc('claim_mission', { p_user: uid, p_secret: secret, p_toilet: toilet }); }
    claimTut() { return this._rpc('claim_tut', { p_user: uid, p_secret: secret }); }
    buyItem(item) { return this._rpc('buy_item', { p_user: uid, p_secret: secret, p_item: item }); }
    // v8: 서버가 센 숫자만 받는다. v8 전에는 방문 기록을 받아 기기에서 센다
    async toiletStats(toilet_id) {
      if (this.statsV8 !== false) {
        const r = await fetch(`${this.url}/rest/v1/rpc/toilet_stats`, { method: 'POST', headers: this.h, body: JSON.stringify({ p_toilet: toilet_id, p_user: uid }) });
        if (r.ok) { this.statsV8 = true; const j = await r.json(); return statsOf(+j.visits || 0, +j.explorers || 0, j.first_nick || null, +j.mine || 0); }
        if (r.status !== 404) throw new Error(`[${r.status}] 변기 기록을 불러오지 못했어요`);
        this.statsV8 = false;
      }
      return statsFrom(await this._get(`visits?toilet_id=eq.${encodeURIComponent(toilet_id)}&select=user_id,nick,at&order=at.asc&limit=2000`));
    }
    async myVisits() { return groupMine(await this._get(`visits?user_id=eq.${uid}&select=toilet_id,toilet_name,at&order=at.desc&limit=1000`)); }
    async postReport(toilet_id, k, v) {
      return this._signed('post_report', { p_toilet: toilet_id, p_k: k, p_v: v, p_nick: fullNick() },
        () => this._post('reports', { toilet_id, k, v, user_id: uid, nick: fullNick() }));
    }
    // 최근 12시간 상태 보고 (신고 제외). 최신순이라 병합 시 가장 새 값이 남는다
    // ids: 지금 지도 주변 변기들. 전 세계 보고를 매번 받지 않는다 (사용자가 늘어도 한 사람이 받는 양은 그대로)
    async recentReports(ids) {
      if (!ids || !ids.length) return [];
      const since = new Date(Date.now() - 12 * 3600e3).toISOString();
      return this._get(`reports?toilet_id=${inList(ids)}&k=neq.flagged&at=gte.${encodeURIComponent(since)}&select=toilet_id,k,v,at&order=at.desc&limit=1000`);
    }
    // "화장실 없음" 신고: 변기별 서로 다른 신고자 수
    // "없음" 신고 집계 (v8): 서버가 믿을 만한 신고만 세고, 반박 증거가 생기면 무효로 처리한다. v8이 없으면 예전 방식으로 센다
    async toiletFlags(ids) {
      if (!ids || !ids.length) return {};
      if (this.flagsV8 !== false) {
        const r = await fetch(`${this.url}/rest/v1/rpc/toilet_flags`, { method: 'POST', headers: this.h, body: JSON.stringify({ p_ids: ids }) });
        if (r.ok) { this.flagsV8 = true; const out = {}; for (const x of await r.json()) out[x.toilet_id] = { flags: x.flags, hidden: x.hidden }; return out; }
        if (r.status !== 404) throw new Error(`[${r.status}] 신고 집계 실패`);
        this.flagsV8 = false;
      }
      const c = await this.flagCounts(ids), out = {};
      for (const id in c) out[id] = { flags: c[id], hidden: c[id] >= 2 };
      return out;
    }
    async listPhotos(toilet_id) {
      // 목록에는 미리보기만. 원본은 눌렀을 때 photoData로 받는다
      try { return await this._get(`photos?toilet_id=eq.${encodeURIComponent(toilet_id)}&select=id,toilet_id,kind,thumb,user_id,nick,at&order=at.desc&limit=6`); }
      catch (e) { return []; }  // v8 전에는 사진 기능 없음
    }
    async photoData(id) { const rows = await this._get(`photos?id=eq.${encodeURIComponent(id)}&select=data`); return rows[0] ? rows[0].data : null; }
    async postPhoto(toilet_id, kind, data, thumb) { return this._rpcSigned('post_photo', { p_toilet: toilet_id, p_kind: kind, p_data: data, p_nick: fullNick(), p_thumb: thumb || null }); }
    async reportPhoto(id) { return this._rpcSigned('report_photo', { p_photo: id }); }
    async _rpcSigned(name, body) {
      const r = await fetch(`${this.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: this.h, body: JSON.stringify(Object.assign({ p_user: uid, p_secret: secret }, body)) });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
      if (r.status === 404) throw new Error('사진 기능이 아직 서버에 준비되지 않았어요');
      if (!r.ok) throw new Error(String((j && j.message) || t).slice(0, 160));
      return j;
    }
    async flagCounts(ids) {
      const rows = await this._get(`reports?toilet_id=${inList(ids)}&k=eq.flagged&select=toilet_id,user_id&limit=2000`);
      const m = {}; for (const r of rows) (m[r.toilet_id] || (m[r.toilet_id] = new Set())).add(r.user_id);
      const out = {}; for (const id in m) out[id] = m[id].size; return out;
    }
    async saveProfile(data) {
      const r = await fetch(`${this.url}/rest/v1/rpc/save_profile`, { method: 'POST', headers: this.h, body: JSON.stringify({ p_user: uid, p_secret: secret, p_data: data }) });
      if (!r.ok) throw new Error(`[${r.status}] ${(await r.text()).slice(0, 200)}`);
    }
    async getProfile(id) { const rows = await this._get(`profiles?user_id=eq.${encodeURIComponent(id)}&select=user_id,data,updated_at`); return rows[0] ? rows[0].data : null; }
    async postFeedback(text, version) { return this._post('feedback', { text, version, user_id: uid, nick: fullNick(), ua: navigator.userAgent.slice(0, 200) }); }
    async addToilet(t) {
      return this._signed('post_toilet', { p_id: t.id, p_lat: t.lat, p_lng: t.lng, p_name: t.name, p_access: t.tags?.access || 'yes', p_nick: fullNick() },
        () => this._post('toilets', { id: t.id, lat: t.lat, lng: t.lng, name: t.name, access: t.tags?.access || 'yes', user_id: uid, nick: fullNick() }));
    }
    async toiletsIn(lat, lng, d) { return this._get(`toilets?lat=gte.${lat - d}&lat=lte.${lat + d}&lng=gte.${lng - d}&lng=lte.${lng + d}&select=id,lat,lng,name,access,nick&limit=500`); }
  }

  // PostgREST in.(…) 목록. 변기 id는 영문·숫자라 따옴표로 감싸 안전하게 보낸다
  function inList(ids) { return 'in.' + encodeURIComponent('(' + ids.map(x => '"' + String(x).replace(/["\\]/g, '') + '"').join(',') + ')'); }
  // 변기 XP: 방문 1회 = 10xp, 서로 다른 탐험가 1명 = +15xp 보너스
  function statsOf(visits, explorers, first_nick, mine) {
    const xp = visits * 10 + explorers * 15;
    return { xp, level: toiletLevel(xp), visits, explorers, first_nick, mine };
  }
  function statsFrom(v) { return statsOf(v.length, new Set(v.map(x => x.user_id)).size, v[0]?.nick || null, v.filter(x => x.user_id === uid).length); }
  function toiletLevel(xp) { return Math.min(99, Math.floor(Math.sqrt(xp / 25)) + 1); }
  function groupMine(rows) { const m = {}; for (const r of rows) { const g = m[r.toilet_id] || (m[r.toilet_id] = { toilet_id: r.toilet_id, toilet_name: r.toilet_name, count: 0, last: r.at }); g.count++; if (r.at > g.last) g.last = r.at; } return Object.values(m).sort((a, b) => b.count - a.count); }

  const cfg = window.GHC_CONFIG || {};
  window.Backend = (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) ? new SupabaseBackend(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : new LocalBackend();
  window.Backend.toiletLevel = toiletLevel;
})();
