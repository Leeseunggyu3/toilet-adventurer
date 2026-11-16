/* 배포 설정.
   Supabase 프로젝트를 만들고 아래 두 값을 채우면 채팅·변기 XP·탐험가 기록이 모든 사용자에게 공유됩니다.
   비어 있으면 "데모 모드" (이 기기 안에서만 동작). 스키마: supabase/schema.sql */
window.GHC_CONFIG = {
  SUPABASE_URL: 'https://tsokzvlszcodqqejsnoe.supabase.co',      // 예: 'https://abcdefgh.supabase.co'
  SUPABASE_ANON_KEY: 'sb_publishable_O9PHZVfHx20CFcMIPsQNtg_EN0_bjKU', // Project Settings → API → anon public
  GOOGLE_LOGIN: true,    // false로 바꾸면 로그인 버튼이 숨겨진다 (게스트만 사용)
};
