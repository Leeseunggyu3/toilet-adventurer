// 웹사이트 파일을 앱 안(www/)으로 복사한다. 화장실 데이터(data/)는 넣지 않는다 (앱이 웹에서 매주 새로 받음)
// 사용: node scripts/copy-web.mjs [버전]
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const app = join(dirname(fileURLToPath(import.meta.url)), '..'), root = join(app, '..'), www = join(app, 'www');
const FILES = ['index.html', 'style.css', 'icon.svg', 'manifest.webmanifest', 'privacy.html', 'privacy-en.html',
  'config.js', 'store.js', 'titles.js', 'dict.js', 'i18n.js', 'auth.js', 'backend.js', 'app.js', 'ads.js', 'vendor'];
rmSync(www, { recursive: true, force: true }); mkdirSync(www);
for (const f of FILES) { if (!existsSync(join(root, f))) throw new Error('없는 파일: ' + f); cpSync(join(root, f), join(www, f), { recursive: true }); }
const v = process.argv[2];
if (v) {
  const ih = join(www, 'index.html'); writeFileSync(ih, readFileSync(ih, 'utf8').replace(/\?v=[0-9a-z]+"/g, `?v=${v}"`));
  const aj = join(www, 'app.js'); writeFileSync(aj, readFileSync(aj, 'utf8').replace('__VERSION__', v));
}
console.log('www 준비 완료', FILES.length, '항목', v ? '버전 ' + v : '');
