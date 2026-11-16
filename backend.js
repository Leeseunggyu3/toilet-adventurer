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
  const ADJ = ['용감한', '수상한', '빠른', '졸린', '전설의', '친절한', '배고픈', '반짝이는', '조용한', '급한'];
  const NOUN = ['변기탐험가', '휴지수호자', '물내림장인', '칸막이요정', '비데마스터', '화장실레인저'];
  const defaultNick = () => { let h = 0; for (const c of uid) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `${ADJ[h % ADJ.length]} ${NOUN[(h >>> 4) % NOUN.length]} #${(h % 9000) + 1000}`; };
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
    async postMessage(m) { return this._post('messages', Object.assign({ user_id: uid, nick: fullNick() }, m)); }
    async markHelpful(id) { await fetch(`${this.url}/rest/v1/rpc/mark_helpful`, { method: 'POST', headers: this.h, body: JSON.stringify({ mid: id }) }); }
    async recordVisit(toilet_id, toilet_name) { await this._post('visits', { toilet_id, toilet_name, user_id: uid, nick: fullNick() }); return this.toiletStats(toilet_id); }
    async toiletStats(toilet_id) { return statsFrom(await this._get(`visits?toilet_id=eq.${encodeURIComponent(toilet_id)}&select=user_id,nick,at&order=at.asc&limit=2000`)); }
    async myVisits() { return groupMine(await this._get(`visits?user_id=eq.${uid}&select=toilet_id,toilet_name,at&order=at.desc&limit=1000`)); }
    async postReport(toilet_id, k, v) { return this._post('reports', { toilet_id, k, v, user_id: uid, nick: fullNick() }); }
    // 최근 12시간 상태 보고 (신고 제외). 최신순이라 병합 시 가장 새 값이 남는다
    async recentReports() {
      const since = new Date(Date.now() - 12 * 3600e3).toISOString();
      return this._get(`reports?k=neq.flagged&at=gte.${encodeURIComponent(since)}&select=toilet_id,k,v,at&order=at.desc&limit=1000`);
    }
    // "화장실 없음" 신고: 변기별 서로 다른 신고자 수
    async flagCounts() {
      const rows = await this._get(`reports?k=eq.flagged&select=toilet_id,user_id&limit=2000`);
      const m = {}; for (const r of rows) (m[r.toilet_id] || (m[r.toilet_id] = new Set())).add(r.user_id);
      const out = {}; for (const id in m) out[id] = m[id].size; return out;
    }
    async saveProfile(data) {
      const r = await fetch(`${this.url}/rest/v1/rpc/save_profile`, { method: 'POST', headers: this.h, body: JSON.stringify({ p_user: uid, p_secret: secret, p_data: data }) });
      if (!r.ok) throw new Error(`[${r.status}] ${(await r.text()).slice(0, 200)}`);
    }
    async getProfile(id) { const rows = await this._get(`profiles?user_id=eq.${encodeURIComponent(id)}&select=user_id,data,updated_at`); return rows[0] ? rows[0].data : null; }
    async postFeedback(text, version) { return this._post('feedback', { text, version, user_id: uid, nick: fullNick(), ua: navigator.userAgent.slice(0, 200) }); }
    async addToilet(t) { return this._post('toilets', { id: t.id, lat: t.lat, lng: t.lng, name: t.name, access: t.tags?.access || 'yes', user_id: uid, nick: fullNick() }); }
    async toiletsIn(lat, lng, d) { return this._get(`toilets?lat=gte.${lat - d}&lat=lte.${lat + d}&lng=gte.${lng - d}&lng=lte.${lng + d}&select=id,lat,lng,name,access,nick&limit=500`); }
  }

  // 변기 XP: 방문 1회 = 10xp, 서로 다른 탐험가 1명 = +15xp 보너스
  function statsFrom(v) {
    const ex = new Set(v.map(x => x.user_id));
    const xp = v.length * 10 + ex.size * 15;
    return { xp, level: toiletLevel(xp), visits: v.length, explorers: ex.size, first_nick: v[0]?.nick || null, mine: v.filter(x => x.user_id === uid).length };
  }
  function toiletLevel(xp) { return Math.min(99, Math.floor(Math.sqrt(xp / 25)) + 1); }
  function groupMine(rows) { const m = {}; for (const r of rows) { const g = m[r.toilet_id] || (m[r.toilet_id] = { toilet_id: r.toilet_id, toilet_name: r.toilet_name, count: 0, last: r.at }); g.count++; if (r.at > g.last) g.last = r.at; } return Object.values(m).sort((a, b) => b.count - a.count); }

  const cfg = window.GHC_CONFIG || {};
  window.Backend = (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) ? new SupabaseBackend(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : new LocalBackend();
  window.Backend.toiletLevel = toiletLevel;
})();
