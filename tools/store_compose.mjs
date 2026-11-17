// 스토어용 이미지 꾸미기: 원본 스크린샷 위에 한 줄 소개를 얹고, 대표 이미지(1024x500)와 아이콘(512)을 만든다.
// 실행: node tools/store_compose.mjs <원본폴더> <출력폴더>
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [RAW, OUT] = [process.argv[2] || 'store-shots', process.argv[3] || 'store-final'];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(OUT, { recursive: true });
const b64 = p => 'data:image/png;base64,' + readFileSync(p).toString('base64');

const CAP = {
  ko: { tag: '급할 때, 가장 가까운 화장실', shots: [
    ['1-map', '급할 때', '가장 가까운 화장실을 지도에서'],
    ['2-detect', '📡 변기탐지', '한 번 누르면 거리·시간·길찾기까지'],
    ['3-toilet', '휴지 있음? 줄 김?', '탐험가들이 알려주는 실시간 상태'],
    ['4-chat', '동네 광장', '근처 탐험가들과 바로 묻고 답하기'],
    ['5-profile', '칭호와 스티커', '나만의 탐험가 수첩 꾸미기'],
    ['6-shop', '코인 상점', '인증하고 보고하면 코인이 쌓여요'],
  ] },
  en: { tag: 'Find the nearest toilet, fast', shots: [
    ['1-map', 'Gotta go?', 'Nearest toilets right on the map'],
    ['2-detect', '📡 Toilet Radar', 'One tap: distance, time, directions'],
    ['3-toilet', 'Paper? Long line?', 'Live status from fellow explorers'],
    ['4-chat', 'Neighborhood Square', 'Ask and answer with explorers nearby'],
    ['5-profile', 'Titles & stickers', 'Decorate your Explorer’s Notebook'],
    ['6-shop', 'Coin Shop', 'Check in and report to earn coins'],
  ] },
  ja: { tag: '急な時、いちばん近いトイレへ', shots: [
    ['1-map', '急な時に', 'いちばん近いトイレを地図で'],
    ['2-detect', '📡 トイレ探知', 'ワンタップで距離・時間・経路まで'],
    ['3-toilet', '紙ある？混んでる？', '探検家が教えるリアルタイム情報'],
    ['4-chat', 'ご近所広場', '近くの探検家とすぐに質問・回答'],
    ['5-profile', '称号とステッカー', '自分だけの探検家手帳をデコ'],
    ['6-shop', 'コインショップ', 'チェックインと報告でコインが貯まる'],
  ] },
};
const FONT = `font-family: 'Noto Sans CJK KR', 'Noto Sans KR', 'Noto Sans JP', 'Apple SD Gothic Neo', sans-serif;`;
const BG = 'linear-gradient(160deg, #5b3df5 0%, #8a3df5 45%, #ff3b3b 100%)';
const icon = b64(join(root, 'app/assets/icon-only.png'));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
const render = async (w, h, html, path) => {
  const pg = await browser.newPage({ viewport: { width: w, height: h } });
  await pg.setContent(`<html><head><style>*{margin:0;box-sizing:border-box}body{width:${w}px;height:${h}px;overflow:hidden;${FONT}}</style></head><body>${html}</body></html>`);
  await pg.waitForTimeout(300);
  await pg.screenshot({ path }); await pg.close(); console.log('🖼', path);
};

for (const [lang, C] of Object.entries(CAP)) {
  for (const [name, title, sub] of C.shots) {
    const raw = join(RAW, `${lang}-${name}.png`); if (!existsSync(raw)) { console.log('없음:', raw); continue; }
    await render(1080, 1920, `
      <div style="width:1080px;height:1920px;background:${BG};display:flex;flex-direction:column;align-items:center;">
        <div style="height:400px;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;text-align:center;padding:0 60px">
          <div style="font-size:92px;font-weight:900;letter-spacing:-1px;line-height:1.1;text-shadow:0 4px 18px rgba(0,0,0,.18)">${title}</div>
          <div style="font-size:46px;font-weight:600;margin-top:22px;opacity:.95">${sub}</div>
        </div>
        <div style="width:860px;height:1529px;border-radius:56px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.35);border:10px solid #10131a;background:#10131a">
          <img src="${b64(raw)}" style="width:100%;display:block">
        </div>
      </div>`, join(OUT, `${lang}-${name}.png`));
  }
  // 대표 이미지 (Feature graphic) 1024x500
  await render(1024, 500, `
    <div style="width:1024px;height:500px;background:${BG};display:flex;align-items:center;padding:0 70px;gap:56px;color:#fff">
      <img src="${icon}" style="width:250px;height:250px;border-radius:56px;box-shadow:0 18px 50px rgba(0,0,0,.3)">
      <div>
        <div style="font-size:74px;font-weight:900;letter-spacing:-1px;line-height:1.05">Toilet<br>Adventure</div>
        <div style="font-size:36px;font-weight:700;margin-top:20px;opacity:.95">${C.tag}</div>
      </div>
    </div>`, join(OUT, `${lang}-feature-1024x500.png`));
}
// 앱 아이콘 512x512
await render(512, 512, `<img src="${icon}" style="width:512px;height:512px;display:block">`, join(OUT, 'icon-512.png'));
await browser.close();
