/* titles.js — 칭호와 유물의 "이름표" 파일.
   ┌─────────────────────────────────────────────────────────────────────┐
   │ 이름을 바꾸고 싶으면 이 파일만 고치면 됩니다.                              │
   │  · name  : 칭호 이름        ← 마음대로 바꿔도 됨                         │
   │  · desc  : 획득 조건 설명    ← 문구만 바꿔도 됨 (실제 조건은 안 바뀜)       │
   │  · st    : 해금되는 스티커 (이모지 1개)                                  │
   │  · cat   : 분류 (아래 CATS의 id 중 하나)                                │
   │  · id    : 바꾸지 마세요. 이미 획득한 사람의 기록이 이 id로 저장돼 있어요.   │
   │  · name_en / name_ja / desc_en / desc_ja : 영어·일본어 이름 (없으면 한국어로 표시) │
   │ 실제 달성 조건(몇 곳, 몇 회, 몇 시간)은 app.js의 COND에 있습니다.          │
   └─────────────────────────────────────────────────────────────────────┘ */
window.GHC_TITLE_CATS = [
  { id: 'start',  name: '입문', name_en: 'Basics', name_ja: '入門' },
  { id: 'find',   name: '발견', name_en: 'Discovery', name_ja: '発見' },
  { id: 'report', name: '보고', name_en: 'Reports', name_ja: '報告' },
  { id: 'social', name: '교류', name_en: 'Social', name_ja: '交流' },
  { id: 'speed',  name: '시간', name_en: 'Time', name_ja: '時間' },
  { id: 'rank',   name: '경지', name_en: 'Stage', name_ja: '境地' },
];

window.GHC_TITLES = [
  // ── 입문 ──
  { id: 'tut', cat: 'start',  name: '갓 눈뜬 자',            desc: '튜토리얼을 끝까지 마친다',               st: '🌱',
      name_en: 'Newly Awakened', desc_en: 'Finish the tutorial', name_ja: '目覚めし者', desc_ja: 'チュートリアルを最後まで終える' },
  { id: 'v1',  cat: 'start',  name: '첫 발자국',             desc: '처음으로 도착 인증을 한다',              st: '👣',
      name_en: 'First Footstep', desc_en: 'Make your first arrival check-in', name_ja: 'はじめの一歩', desc_ja: 'はじめて到着チェックインする' },
  // ── 발견 ──
  { id: 'd3',  cat: 'find',   name: '골목의 순례자',          desc: '서로 다른 변기 3곳 발견',               st: '🚪',
      name_en: 'Alley Pilgrim', desc_en: 'Discover 3 different toilets', name_ja: '路地の巡礼者', desc_ja: '別々のトイレを3か所発見' },
  { id: 'd10', cat: 'find',   name: '열 개의 문을 연 자',      desc: '서로 다른 변기 10곳 발견',              st: '🗝️',
      name_en: 'Opener of Ten Doors', desc_en: 'Discover 10 different toilets', name_ja: '十の扉を開きし者', desc_ja: '別々のトイレを10か所発見' },
  { id: 'd30', cat: 'find',   name: '서른 문의 주인',         desc: '서로 다른 변기 30곳 발견',              st: '👑',
      name_en: 'Master of Thirty Doors', desc_en: 'Discover 30 different toilets', name_ja: '三十の扉の主', desc_ja: '別々のトイレを30か所発見' },
  { id: 'g1',  cat: 'find',   name: '등불지기',              desc: '지도에 없던 화장실을 등록한다',           st: '🕯️',
      name_en: 'Lamplighter', desc_en: "Register a toilet that wasn't on the map", name_ja: '灯火の番人', desc_ja: '地図になかったトイレを登録する' },
  { id: 'f1',  cat: 'find',   name: '개척자',                desc: '어느 변기의 1호 탐험가가 된다',           st: '🚩',
      name_en: 'Pioneer', desc_en: 'Become the first explorer of a toilet', name_ja: '開拓者', desc_ja: 'あるトイレの1番目の探検家になる' },
  // ── 보고 ──
  { id: 'r1',  cat: 'report', name: '물을 읽는 자',           desc: '처음으로 상태 보고를 한다',              st: '💧',
      name_en: 'Water Reader', desc_en: 'Send your first status report', name_ja: '水を読む者', desc_ja: 'はじめて状態を報告する' },
  { id: 'r10', cat: 'report', name: '맑은 눈',               desc: '상태 보고 10회',                       st: '👁️',
      name_en: 'Clear Eyes', desc_en: 'Send 10 status reports', name_ja: '澄んだ瞳', desc_ja: '状態報告10回' },
  { id: 'r50', cat: 'report', name: '천 갈래 물길을 보는 자',   desc: '상태 보고 50회',                       st: '🔮',
      name_en: 'Seer of a Thousand Streams', desc_en: 'Send 50 status reports', name_ja: '千の水脈を見る者', desc_ja: '状態報告50回' },
  // ── 교류 ──
  { id: 't10', cat: 'social', name: '메아리꾼',              desc: '이야기를 10번 남긴다',                  st: '🔔',
      name_en: 'Echo Keeper', desc_en: 'Post 10 messages', name_ja: 'こだまの使い', desc_ja: 'メッセージを10回書く' },
  // ── 시간 ──
  { id: 's3',  cat: 'speed',  name: '질풍수류',              desc: '2시간 안에 서로 다른 변기 3곳 인증',      st: '⚡',
      name_en: 'Gale Current', desc_en: 'Check in at 3 different toilets within 2 hours', name_ja: '疾風水流', desc_ja: '2時間以内に別々のトイレ3か所でチェックイン' },
  { id: 's5',  cat: 'speed',  name: '하루 다섯 문',           desc: '24시간 안에 서로 다른 변기 5곳 인증',     st: '🌪️',
      name_en: 'Five Doors a Day', desc_en: 'Check in at 5 different toilets within 24 hours', name_ja: '一日五つの扉', desc_ja: '24時間以内に別々のトイレ5か所でチェックイン' },
  { id: 'n1',  cat: 'speed',  name: '심야의 방랑자',          desc: '자정에서 새벽 5시 사이에 도착 인증',      st: '🌙',
      name_en: 'Midnight Wanderer', desc_en: 'Check in between midnight and 5 a.m.', name_ja: '深夜の放浪者', desc_ja: '深夜0時〜朝5時にチェックイン' },
  // ── 경지 ──
  { id: 'k3',  cat: 'rank',   name: '소용돌이를 건넌 자',      desc: "경지 '소용돌이'에 이른다",              st: '🌀',
      name_en: 'One Who Crossed the Whirlpool', desc_en: "Reach the 'Whirlpool' stage", name_ja: '渦を越えし者', desc_ja: '境地「渦」に到達する' },
];

/* 유물 이름표. 어려운 칭호(같은 id)에만 딸려 옵니다. 이름(name)과 아이콘(ic)은 바꿔도 됩니다.
   효과 수치는 app.js의 RELIC_FX에 있습니다. */
window.GHC_RELICS = {
  d10: { ic: '🗝️', name: '열쇠 꾸러미', name_en: 'Key Ring', name_ja: '鍵束' },
  d30: { ic: '👑', name: '주인의 인장', name_en: "Master's Seal", name_ja: '主の印章' },
  r50: { ic: '🔮', name: '수정 구슬', name_en: 'Crystal Ball', name_ja: '水晶玉' },
  s3:  { ic: '🪶', name: '바람 깃털', name_en: 'Wind Feather', name_ja: '風の羽根' },
  s5:  { ic: '🧭', name: '회오리 나침반', name_en: 'Whirlwind Compass', name_ja: 'つむじ風の羅針盤' },
  n1:  { ic: '🏮', name: '달빛 랜턴', name_en: 'Moonlight Lantern', name_ja: '月明かりのランタン' },
  k3:  { ic: '🌀', name: '소용돌이 조각', name_en: 'Whirlpool Shard', name_ja: '渦のかけら' },
};
