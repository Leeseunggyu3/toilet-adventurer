/* ads.js — 배너 광고 자리 (웹용). 기본은 꺼져 있다.
   켜는 법: 광고 심사가 승인되면 config.js의 AD_BANNER에 값을 채운다.
     AD_BANNER: { enabled: true, client: 'ca-pub-0000000000000000', slot: '0000000000' }
   원칙: 지도 화면과 변기탐지 결과에는 광고를 넣지 않는다. 급한 사람의 화면을 가리지 않기 위해서다.
         광고는 수첩 · 동네 광장 · 도움말 · 상점 창의 맨 아래에만 들어간다. */
(() => {
  const ad = (window.GHC_CONFIG || {}).AD_BANNER || {};
  const PLACES = ['profile', 'area', 'help', 'shop'];
  if (!ad.enabled || !/^ca-pub-\d+$/.test(ad.client || '') || !/^\d+$/.test(ad.slot || '')) return;
  const s = document.createElement('script');
  s.async = true; s.crossOrigin = 'anonymous';
  s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(ad.client);
  document.head.appendChild(s);
  const filled = new Set();
  function fill(id) {
    const sheet = document.getElementById(id);
    if (!sheet || filled.has(id) || sheet.classList.contains('hidden')) return;
    filled.add(id);
    const box = document.createElement('div'); box.className = 'ad-slot';
    box.innerHTML = '<small>광고</small><ins class="adsbygoogle" style="display:block" data-ad-client="' + ad.client + '" data-ad-slot="' + ad.slot + '" data-ad-format="horizontal" data-full-width-responsive="true"></ins>';
    sheet.appendChild(box);
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
  }
  // 창이 처음 열릴 때 그 창에만 광고를 채운다
  const mo = new MutationObserver(() => PLACES.forEach(fill));
  PLACES.forEach(id => { const el = document.getElementById(id); if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] }); });
})();
