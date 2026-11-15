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

  // ---------- 데모(로컬) ----------
  class LocalBackend {
    constructor() {
      this.demo = true;
      try { this.db = JSON.parse(localStorage.getItem('ghc-local-db') || 'null') || { messages: [], visits: [] }; } catch (e) { this.db = { messages: [], visits: [] }; }
      try { this.bc = new BroadcastChannel('ghc'); this.bc.onmessage = () => { try { this.db = JSON.parse(localStorage.getItem('ghc-local-db')) || this.db; } catch (e) {} }; } catch (e) {}
    }
    _save() { try { localStorage.setItem('ghc-local-db', JSON.stringify(this.db)); this.bc && this.bc.postMessage(1); } catch (e) {} }
    me() { return { id: uid, nick: getNick() }; }
    setNick(n) { try { localStorage.setItem('ghc-nick', n); } catch (e) {} }
    async listMessages(channel) { return this.db.messages.filter(m => m.channel === channel).slice(-80); }
    async postMessage(m) { const row = Object.assign({ id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), user_id: uid, nick: getNick(), helpful: 0, at: new Date().toISOString() }, m); this.db.messages.push(row); this._save(); return row; }
    async markHelpful(id) { const m = this.db.messages.find(x => x.id === id); if (m) { m.helpful = (m.helpful || 0) + 1; this._save(); } }
    async recordVisit(toilet_id, toilet_name) { this.db.visits.push({ toilet_id, toilet_name, user_id: uid, nick: getNick(), at: new Date().toISOString() }); this._save(); return this.toiletStats(toilet_id); }
    async toiletStats(toilet_id) { const v = this.db.visits.filter(x => x.toilet_id === toilet_id); return statsFrom(v); }
    async myVisits() { return groupMine(this.db.visits.filter(v => v.user_id === uid)); }
  }

  // ---------- Supabase ----------
  class SupabaseBackend {
    constructor(url, key) { this.demo = false; this.url = url.replace(/\/$/, ''); this.h = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }; }
    async _get(path) { const r = await fetch(`${this.url}/rest/v1/${path}`, { headers: this.h }); if (!r.ok) throw new Error(await r.text()); return r.json(); }
    async _post(table, body) { const r = await fetch(`${this.url}/rest/v1/${table}`, { method: 'POST', headers: Object.assign({ Prefer: 'return=representation' }, this.h), body: JSON.stringify(body) }); if (!r.ok) throw new Error(await r.text()); return (await r.json())[0]; }
    me() { return { id: uid, nick: getNick() }; }
    setNick(n) { try { localStorage.setItem('ghc-nick', n); } catch (e) {} }
    async listMessages(channel) { return (await this._get(`messages?channel=eq.${encodeURIComponent(channel)}&order=at.desc&limit=80`)).reverse(); }
    async postMessage(m) { return this._post('messages', Object.assign({ user_id: uid, nick: getNick() }, m)); }
    async markHelpful(id) { await fetch(`${this.url}/rest/v1/rpc/mark_helpful`, { method: 'POST', headers: this.h, body: JSON.stringify({ mid: id }) }); }
    async recordVisit(toilet_id, toilet_name) { await this._post('visits', { toilet_id, toilet_name, user_id: uid, nick: getNick() }); return this.toiletStats(toilet_id); }
    async toiletStats(toilet_id) { return statsFrom(await this._get(`visits?toilet_id=eq.${encodeURIComponent(toilet_id)}&select=user_id,nick,at&order=at.asc&limit=2000`)); }
    async myVisits() { return groupMine(await this._get(`visits?user_id=eq.${uid}&select=toilet_id,toilet_name,at&order=at.desc&limit=1000`)); }
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
