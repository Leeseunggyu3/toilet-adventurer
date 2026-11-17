/* 배포 설정.
   Supabase 프로젝트를 만들고 아래 두 값을 채우면 채팅·변기 XP·탐험가 기록이 모든 사용자에게 공유됩니다.
   비어 있으면 "데모 모드" (이 기기 안에서만 동작). 스키마: supabase/schema.sql */
window.GHC_CONFIG = {
  SUPABASE_URL: 'https://tsokzvlszcodqqejsnoe.supabase.co',      // 예: 'https://abcdefgh.supabase.co'
  SUPABASE_ANON_KEY: 'sb_publishable_O9PHZVfHx20CFcMIPsQNtg_EN0_bjKU', // Project Settings → API → anon public
  GOOGLE_LOGIN: true,    // false로 바꾸면 로그인 버튼이 숨겨진다 (게스트만 사용)
  AD_BANNER: { enabled: false, client: '', slot: '' },  // 광고 심사 승인 후 채운다 (ads.js 참고)
  // 안드로이드 앱 보상형 광고 (애드몹). TESTING이 true면 구글 시험 광고만 나온다.
  // 내 광고를 내가 누르면 정책 위반이니, 플레이 스토어 정식 출시 때만 false로 바꾼다
  ADMOB: { APP_ID: 'ca-app-pub-9172087324454924~8470291923', REWARDED: 'ca-app-pub-9172087324454924/5174703884', TESTING: true },
  WEB_URL: 'https://leeseunggyu3.github.io/toilet-adventurer/',  // 안드로이드 앱이 화장실 데이터를 받아오는 웹 주소 (도메인을 바꾸면 여기도)
};
