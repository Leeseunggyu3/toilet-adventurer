// cap add android 직후 실행: 위치 권한, 구글 로그인 복귀 주소(딥링크)를 안드로이드 설정에 넣는다
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const mf = join(app, 'android/app/src/main/AndroidManifest.xml');
let x = readFileSync(mf, 'utf8');
const perms = ['android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_FINE_LOCATION'];
for (const p of perms) if (!x.includes(p)) x = x.replace('<uses-permission android:name="android.permission.INTERNET" />', `<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="${p}" />`);
if (!x.includes('android.hardware.location.gps')) x = x.replace('</manifest>', '    <uses-feature android:name="android.hardware.location.gps" android:required="false" />\n</manifest>');
const deep = `
            <!-- 구글 로그인 후 바깥 브라우저에서 앱으로 돌아오는 주소 -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="com.toiletadventure.app" android:host="auth" />
            </intent-filter>
`;
if (!x.includes('android:scheme="com.toiletadventure.app"')) {
  const i = x.indexOf('</activity>'); if (i < 0) throw new Error('MainActivity를 찾지 못함');
  x = x.slice(0, i) + deep + '        ' + x.slice(i);
}
// 애드몹 앱 ID (config.js의 ADMOB.APP_ID). 이게 없으면 광고 SDK가 앱을 바로 꺼버린다
const cfgText = readFileSync(join(app, '..', 'config.js'), 'utf8');
const admobId = (cfgText.match(/APP_ID:\s*'(ca-app-pub-[0-9]+~[0-9]+)'/) || [])[1];
if (!admobId) throw new Error('config.js에서 애드몹 APP_ID를 찾지 못함');
if (!x.includes('com.google.android.gms.ads.APPLICATION_ID')) x = x.replace('<activity', `<meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="${admobId}" />\n        <activity`);
for (const must of [...perms, 'com.toiletadventure.app', admobId]) if (!x.includes(must)) throw new Error('적용 실패: ' + must);
writeFileSync(mf, x);
// 버전: CI 실행 번호를 versionCode로 (스토어 업데이트는 번호가 올라가야 한다)
const code = process.env.APP_VERSION_CODE, name = process.env.APP_VERSION_NAME;
if (code) {
  const g = join(app, 'android/app/build.gradle'); let s = readFileSync(g, 'utf8');
  s = s.replace(/versionCode \d+/, `versionCode ${+code}`).replace(/versionName "[^"]*"/, `versionName "${name || '1.0.' + code}"`);
  writeFileSync(g, s);
}
console.log('안드로이드 설정 적용 완료');
// 시험용 서명: 저장소에 있는 공개 시험 열쇠(debug.keystore, 비밀번호 android)로 항상 같은 서명을 한다.
// 그래야 새 버전을 지우지 않고 덮어 설치할 수 있다. 플레이 스토어용 진짜 열쇠는 아래(비밀값)로 따로 쓴다
{
  const g = join(app, 'android/app/build.gradle'); let s = readFileSync(g, 'utf8');
  if (!s.includes('debug.keystore')) {
    s = s.replace(/\n    buildTypes \{/, `
    signingConfigs {
        debug {
            storeFile file("../../debug.keystore")
            storePassword "android"
            keyAlias "androiddebugkey"
            keyPassword "android"
        }
    }
    buildTypes {`);
    if (!s.includes('debug.keystore')) throw new Error('시험용 서명 설정 적용 실패');
    writeFileSync(g, s);
  }
}
// 서명: GitHub 비밀값(ANDROID_KEYSTORE_*)이 있으면 항상 같은 열쇠로 서명한다 (업데이트를 덮어 설치할 수 있게)
if (process.env.KEYSTORE_FILE) {
  const g = join(app, 'android/app/build.gradle'); let s = readFileSync(g, 'utf8');
  if (!s.includes('KEYSTORE_FILE')) {
    s = s.replace(/\n    signingConfigs \{/, `
    signingConfigs {
        release {
            storeFile file(System.getenv("KEYSTORE_FILE"))
            storePassword System.getenv("KEYSTORE_PASS")
            keyAlias System.getenv("KEY_ALIAS")
            keyPassword System.getenv("KEYSTORE_PASS")
        }`);
    s = s.replace(/release \{\n(\s+)minifyEnabled false/, 'release {\n$1signingConfig signingConfigs.release\n$1minifyEnabled false');
    if (!s.includes('signingConfig signingConfigs.release')) throw new Error('서명 설정 적용 실패');
    writeFileSync(g, s);
  }
  console.log('서명 설정 적용');
}
