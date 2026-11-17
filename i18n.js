/* i18n.js — 다국어 (한국어 · English · 日本語)
   원칙: 앱의 원문은 한국어다. 화면에 한국어 글자가 나타나면 dict.js의 사전을 보고 바꿔 끼운다.
   - 앱 코드는 그대로 한국어로 화면을 그리면 되고, 이 파일이 화면에 나타나는 순간 번역한다 (MutationObserver)
   - 사용자가 쓴 글(채팅, 닉네임)은 data-raw 표시가 있어 절대 번역하지 않는다
   - data-raw="exact": 통째로 사전에 있는 경우에만 번역 (화장실 이름: 기본 이름 "공중화장실"만 번역, 실제 이름은 그대로)
   - data-i18n-html: 굵은 글씨 등이 섞인 문단은 HTML 통째로 사전에서 찾는다
   - 사전 열쇠에 {0}, {1}이 있으면 틀(패턴)로 쓰인다. 예: '주변 화장실 {0}곳 불러옴'
   - 언어: 저장된 선택 > 브라우저 언어(ko/ja, 나머지는 en) */
window.I18N = (() => {
  const SUP = { ko: 0, en: 1, ja: 2 };
  let lang = null;
  try { lang = localStorage.getItem('ghc-lang'); } catch (e) {}
  if (!(lang in SUP)) {
    const n = String((navigator.languages && navigator.languages[0]) || navigator.language || 'ko').toLowerCase();
    lang = n.startsWith('ko') ? 'ko' : n.startsWith('ja') ? 'ja' : 'en';
  }
  document.documentElement.lang = lang;
  const col = SUP[lang] - 1;  // 사전 값 배열에서의 위치 (en = 0, ja = 1). 한국어면 -1 (번역 안 함)
  const D = window.GHC_DICT || {};
  const exact = new Map(), html = new Map(), pats = [];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (col >= 0) for (const k in D) {
    const v = D[k] && D[k][col]; if (!v) continue;
    if (k.includes('<')) { html.set(k, v); continue; }
    if (/\{\d\}/.test(k)) {
      const order = []; let src = '';
      for (const part of k.split(/(\{\d\})/)) { const m = part.match(/^\{(\d)\}$/); if (m) { order.push(+m[1]); src += '([\\s\\S]+?)'; } else src += esc(part); }
      pats.push({ re: new RegExp('^' + src + '$'), v, order, weight: k.replace(/\{\d\}/g, '').length, dot: k.includes(' · ') });
    } else exact.set(k, v);
  }
  pats.sort((a, b) => b.weight - a.weight);  // 글자가 많은(구체적인) 틀부터 맞춰 본다
  const HANGUL = /[가-힣]/;

  function tr(s, depth = 0, exactOnly = false) {
    if (col < 0 || !s || depth > 4 || !HANGUL.test(s)) return s;
    const m0 = s.match(/^(\s*)([\s\S]*?)(\s*)$/), lead = m0[1], core = m0[2], tail = m0[3];
    let out = exact.get(core);
    if (out === undefined && !exactOnly) {
      const dotted = core.includes(' · ');
      for (const p of pats) {
        if (dotted && !p.dot) continue;  // 가운데점으로 이어진 글은 '·'가 들어 있는 틀만 통째로 맞춰 보고, 나머지는 조각별로
        const m = core.match(p.re);
        if (m) { out = p.v.replace(/\{(\d)\}/g, (_, i) => { const g = m[1 + p.order.indexOf(+i)]; return g === undefined ? '' : tr(g, depth + 1); }); break; }
      }
      // "24m · 도보 1분 · 유료"처럼 가운데점으로 이어 붙인 글은 조각마다 번역
      if (out === undefined && core.includes(' · ')) {
        const parts = core.split(' · '), tp = parts.map(x => tr(x, depth + 1));
        if (tp.some((x, i) => x !== parts[i])) out = tp.join(' · ');
      }
    }
    return out === undefined ? s : lead + out + tail;
  }
  // 앱 코드에서 직접 쓸 때: t('주변 화장실 {0}곳', 3) 대신 그냥 tr('주변 화장실 3곳')으로 써도 된다
  const t = (s, ...args) => tr(args.length ? s.replace(/\{(\d)\}/g, (_, i) => args[+i]) : s);

  const SKIP = 'script,style,#map,[data-raw]:not([data-raw="exact"])';
  const ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  function trText(n) {
    const p = n.parentElement; if (!p || p.closest(SKIP)) return;
    const exactOnly = !!p.closest('[data-raw="exact"]');
    const v = tr(n.data, 0, exactOnly); if (v !== n.data) n.data = v;
  }
  function trAttrs(el) { for (const a of ATTRS) { const v0 = el.getAttribute(a); if (v0 && HANGUL.test(v0)) { const v = tr(v0); if (v !== v0) el.setAttribute(a, v); } } }
  function walk(root) {
    if (root.nodeType === 3) return trText(root);
    if (root.nodeType !== 1 || root.closest(SKIP)) return;
    if (root.hasAttribute('data-i18n-html')) { const k = root.innerHTML.trim(), v = html.get(k); if (v) { root.innerHTML = v; return; } }
    trAttrs(root);
    for (const el of root.querySelectorAll('[data-i18n-html]')) { if (el.closest(SKIP)) continue; const v = html.get(el.innerHTML.trim()); if (v) el.innerHTML = v; }
    for (const el of root.querySelectorAll('[' + ATTRS.join('],[') + ']')) if (!el.closest(SKIP)) trAttrs(el);
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const list = [];
    for (let n = it.nextNode(); n; n = it.nextNode()) if (HANGUL.test(n.data)) list.push(n);
    list.forEach(trText);
  }
  function start() {
    if (col < 0) return;
    document.title = tr(document.title);
    walk(document.body);
    new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'characterData') { if (HANGUL.test(m.target.data)) trText(m.target); }
        else if (m.type === 'attributes') { if (m.target.nodeType === 1 && !m.target.closest(SKIP)) trAttrs(m.target); }
        else for (const n of m.addedNodes) walk(n);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  function set(l) { if (!(l in SUP)) return; try { localStorage.setItem('ghc-lang', l); } catch (e) {} location.reload(); }
  // 칭호·유물처럼 데이터 파일에 언어별 칸(name_en, name_ja)이 있는 경우 고르는 도우미
  const pick = (o, f) => (lang !== 'ko' && o && o[f + '_' + lang]) || (o && o[f]);
  return { lang, tr, t, pick, set, start, has: k => exact.has(k) || html.has(k) };
})();

// 화면 번역 시작 (index.html에서 앱 스크립트보다 먼저 실린다. 이후 앱이 그리는 글은 바뀌는 즉시 번역된다)
window.I18N.start();
