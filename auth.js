/* auth.js — 구글 로그인 (Supabase Auth, SDK 없이) + 계정 저장.
   게스트: 기기에 저장된 탐험가 기록만 사용 (기존 방식).
   로그인: 그 기록 묶음을 구글 계정에 저장해 두고, 다른 기기에서 로그인하면 불러온다.
   저장되는 것은 아래 KEYS의 값 전부 (탐험가 ID, 프로필 열쇠, 닉네임, 아이콘, 칭호, 스티커, 코인, 변기력). */
window.Auth = (() => {
  const cfg = window.GHC_CONFIG || {};
  const URL0 = (cfg.SUPABASE_URL || '').replace(/\/$/, ''), KEY = cfg.SUPABASE_ANON_KEY || '';
  const enabled = !!(URL0 && KEY && cfg.GOOGLE_LOGIN);
  const SKEY = 'ghc-auth';
  const KEYS = ['ghc-uid', 'ghc-secret', 'ghc-nick', 'ghc-avatar', 'ghc-ach', 'ghc-v0', 'ghc-style', 'ghc-badges', 'ghc-tut-done'];
  let sess = null; try { sess = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) {}
  const keep = () => { try { sess ? localStorage.setItem(SKEY, JSON.stringify(sess)) : localStorage.removeItem(SKEY); } catch (e) {} };
  let justSignedIn = false, loginError = null;

  // 안드로이드 앱 안인지. 앱에서는 구글이 앱 속 화면 로그인을 막아서, 바깥 브라우저로 로그인하고 앱 주소로 돌아온다
  const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const APP_RETURN = 'com.toiletadventure.app://auth';
  // 구글에서 돌아오면 주소 뒤(#)에 토큰이 붙어 온다 → 저장
  function takeHash(h) {
    if (!h.includes('access_token=') && !h.includes('error')) return false;
    const p = new URLSearchParams(h);
    if (p.get('access_token')) {
      sess = { access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_at: Date.now() + (+p.get('expires_in') || 3600) * 1000, email: null };
      keep(); justSignedIn = true;
    } else if (p.get('error_description') || p.get('error')) loginError = p.get('error_description') || p.get('error');
    return true;
  }
  if (takeHash(location.hash.startsWith('#') ? location.hash.slice(1) : '')) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
  // 앱: 로그인 결과를 받고 다시 시작했을 때 이어서 처리
  try { const j = sessionStorage.getItem('ghc-just'); if (j) { sessionStorage.removeItem('ghc-just'); if (j === '1') justSignedIn = true; else loginError = j; } } catch (e) {}
  if (NATIVE) {
    const P = window.Capacitor.Plugins || {};
    const onUrl = url => {
      if (!url || !url.startsWith(APP_RETURN)) return;
      const i = url.indexOf('#'), q = url.indexOf('?');
      const before = justSignedIn;
      if (!takeHash(i >= 0 ? url.slice(i + 1) : q >= 0 ? url.slice(q + 1) : '')) return;
      try { sessionStorage.setItem('ghc-just', justSignedIn && !before ? '1' : (loginError || '1')); } catch (e) {}
      try { P.Browser && P.Browser.close(); } catch (e) {}
      location.reload();
    };
    try { P.App && P.App.addListener('appUrlOpen', e => onUrl(e && e.url)); } catch (e) {}
    try { P.App && P.App.getLaunchUrl().then(r => { if (r && r.url && !sessionStorage.getItem('ghc-launch-done')) { sessionStorage.setItem('ghc-launch-done', '1'); onUrl(r.url); } }).catch(() => {}); } catch (e) {}
  }

  // 토큰 갱신은 한 번에 하나만 (동시에 두 번 갱신하면 서버가 같은 갱신 토큰 재사용으로 보고 로그인을 끊을 수 있다)
  let refreshing = null;
  function token() { return refreshing || (refreshing = token0().finally(() => { refreshing = null; })); }
  async function token0() {
    if (!sess) return null;
    if (sess.expires_at - Date.now() < 60000) {
      if (!sess.refresh_token) { sess = null; keep(); return null; }
      const r = await fetch(`${URL0}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: sess.refresh_token }) });
      if (!r.ok) { if (r.status === 400 || r.status === 401) { sess = null; keep(); } return null; }
      const j = await r.json();
      sess = { access_token: j.access_token, refresh_token: j.refresh_token || sess.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, email: sess.email };
      keep();
    }
    return sess.access_token;
  }
  async function hdr() { const t = await token(); if (!t) throw new Error('로그인이 만료됐어요. 다시 로그인해 주세요'); return { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }; }

  const localState = () => { const s = {}; for (const k of KEYS) { try { const v = localStorage.getItem(k); if (v !== null) s[k] = v; } catch (e) {} } return s; };
  const summary = st => { let nick = st['ghc-nick'] || '이름 없는 탐험가', xp = 0; try { xp = JSON.parse(st['ghc-v0'] || '{}').xp || 0; } catch (e) {} return { nick, avatar: st['ghc-avatar'] || '🚽', xp }; };

  return {
    enabled, KEYS, localState, summary,
    get signedIn() { return !!sess; },
    get email() { return sess && sess.email; },
    get justSignedIn() { return justSignedIn; },
    get loginError() { return loginError; },
    native: NATIVE,
    signIn() {
      const back = NATIVE ? APP_RETURN : location.origin + location.pathname;
      const url = `${URL0}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(back)}`;
      const P = NATIVE && window.Capacitor.Plugins;
      if (P && P.Browser) P.Browser.open({ url }).catch(() => { location.href = url; }); else location.href = url;
    },
    async deleteAccount() {
      if (!sess) return;
      const r = await fetch(`${URL0}/rest/v1/rpc/delete_my_account`, { method: 'POST', headers: await hdr(), body: '{}' });
      if (!r.ok) throw new Error(`[${r.status}] ${(await r.text()).slice(0, 160)}`);
      sess = null; keep();
    },
    async signOut() { try { const h = await hdr(); await fetch(`${URL0}/auth/v1/logout`, { method: 'POST', headers: h }); } catch (e) {} sess = null; keep(); },
    async fetchUser() { const r = await fetch(`${URL0}/auth/v1/user`, { headers: await hdr() }); if (!r.ok) throw new Error(`[${r.status}] 사용자 정보를 가져오지 못했어요`); const j = await r.json(); sess.email = j.email || '구글 계정'; keep(); return sess.email; },
    async loadAccount() { const r = await fetch(`${URL0}/rest/v1/accounts?select=state,updated_at`, { headers: await hdr() }); if (!r.ok) throw new Error(`[${r.status}] ${(await r.text()).slice(0, 160)}`); const rows = await r.json(); return rows[0] || null; },
    async saveAccount(state) {
      const h = await hdr(); h.Prefer = 'resolution=merge-duplicates,return=minimal';
      const r = await fetch(`${URL0}/rest/v1/accounts?on_conflict=auth_uid`, { method: 'POST', headers: h, body: JSON.stringify({ state, updated_at: new Date().toISOString() }) });
      if (!r.ok) throw new Error(`[${r.status}] ${(await r.text()).slice(0, 160)}`);
    },
    // 계정에 저장된 기록을 이 기기에 덮어쓴다 (호출한 쪽에서 새로고침)
    applyState(state) { for (const k of KEYS) { try { if (state[k] !== undefined) localStorage.setItem(k, state[k]); else localStorage.removeItem(k); } catch (e) {} } },
  };
})();
