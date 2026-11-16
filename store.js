/* store.js — 데이터 계층.
   v0: 이 기기의 localStorage만 사용 (내 보고/등록/코인).
   v1: 아래 LocalStore와 같은 인터페이스로 SupabaseStore를 만들어 교체하면
       보고·등록이 모든 사용자에게 공유됨. app.js는 Store API만 호출한다. */

const Store = (() => {
  const KEY = 'ghc-v0';
  let s = { coins: 0, xp: 0, reports: {}, toilets: {}, verified: {}, daily: { day: '', done: 0 }, quests: 0 };
  try { const raw = localStorage.getItem(KEY); if (raw) s = Object.assign(s, JSON.parse(raw)); } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} };
  // 하루의 기준은 사용자의 현지 날짜
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });

  return {
    get coins() { return s.coins; },
    get xp() { return s.xp; },
    earn(c, xp = c) { s.coins += c; s.xp += xp; save(); },
    spend(c) { if (s.coins < c) return false; s.coins -= c; save(); return true; },
    // 서버 지갑 사용 시: 서버가 계산한 값을 그대로 보여주기 위한 캐시
    setWallet(coins, xp) { s.coins = coins; s.xp = xp; save(); },

    // 상태 보고: { open, paper, clean, queue } 각 0/1, 시각
    report(id, k, v) {
      const r = s.reports[id] || {};
      r[k] = { v, t: Date.now() };
      s.reports[id] = r; save();
    },
    reportsFor(id) { return s.reports[id] || {}; },
    // 마지막 보고가 n시간 이내면 유효
    fresh(id, k, hours = 12) {
      const r = (s.reports[id] || {})[k];
      return r && (Date.now() - r.t) < hours * 3600e3 ? r.v : null;
    },

    // 사용자 등록 화장실
    addToilet(t) { s.toilets[t.id] = t; save(); },
    userToilets() { return Object.values(s.toilets); },
    // 서버에서 받은 보고를 병합 (더 최신인 것만 반영). 바뀐 게 있으면 true
    mergeRemote(rows) {
      let changed = false;
      for (const x of rows) {
        const r = s.reports[x.toilet_id] || (s.reports[x.toilet_id] = {});
        const tms = new Date(x.at).getTime();
        if (!r[x.k] || r[x.k].t < tms) { r[x.k] = { v: x.v, t: tms }; changed = true; }
      }
      if (changed) save();
      return changed;
    },
    flag(id) { const t = s.toilets[id]; if (t) { t.flagged = true; save(); } else { s.reports[id] = Object.assign(s.reports[id] || {}, { flagged: { v: 1, t: Date.now() } }); save(); } },

    // 도착 인증 (하루 1회/장소)
    canVerify(id) { return (s.verified[id] || '') !== today(); },
    verify(id) { s.verified[id] = today(); save(); },
    unverify(id) { delete s.verified[id]; save(); },  // 서버가 인증을 거절했을 때 되돌린다

    // 일일 퀘스트
    dailyProgress() { if (s.daily.day !== today()) { s.daily = { day: today(), done: 0 }; save(); } return s.daily.done; },
    dailyTick() { this.dailyProgress(); s.daily.done++; save(); return s.daily.done; },
  };
})();
