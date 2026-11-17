"""데이터 미리 받기 스크립트 점검. 작은 가짜 OSM 파일로 타일 나누기, 도형 중심 계산, 발행 기준을 확인한다."""
import json, os, shutil, subprocess, sys, tempfile
here = os.path.dirname(os.path.abspath(__file__))
script = os.path.join(here, '..', 'tools', 'build_toilet_data.py')
ok_all = []
def check(name, ok, detail=''):
    ok_all.append(ok); print(('✅ ' if ok else '❌ ') + name + ((' — ' + str(detail)) if detail != '' else ''))
d = tempfile.mkdtemp()
nodes = ['<node id="1" lat="37.5665" lon="126.978"><tag k="amenity" v="toilets"/><tag k="name:ko" v="시청 화장실"/><tag k="fee" v="yes"/><tag k="changing_table" v="yes"/><tag k="opening_hours" v="24/7"/></node>',
         '<node id="2" lat="35.0" lon="135.0"/>', '<node id="3" lat="35.0" lon="135.002"/>', '<node id="4" lat="35.002" lon="135.002"/>', '<node id="5" lat="35.002" lon="135.0"/>',
         '<node id="6" lat="35.5" lon="139.5"><tag k="amenity" v="cafe"/></node>']
for i in range(30): nodes.append('<node id="%d" lat="%f" lon="139.7"><tag k="amenity" v="toilets"/><tag k="name" v="도쿄%d"/><tag k="wheelchair" v="yes"/></node>' % (100 + i, 35.6 + i * 0.001, i))
way = '<way id="10"><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="5"/><nd ref="2"/><tag k="amenity" v="toilets"/></way>'
src = os.path.join(d, 'a.osm')
open(src, 'w', encoding='utf-8').write('<?xml version="1.0" encoding="UTF-8"?><osm version="0.6">' + ''.join(nodes) + way + '</osm>')
out = os.path.join(d, 'out')
r = subprocess.run([sys.executable, script, out, src], env=dict(os.environ, MIN_TOTAL='10'), capture_output=True, text=True)
check('정상 실행', r.returncode == 0, r.stderr[-200:])
ix = json.load(open(os.path.join(out, 'index.json')))
check('합계 32곳 (카페는 제외)', ix['total'] == 32, ix['total'])
check('도쿄 30곳은 타일 71_279에', ix['tiles'].get('71_279') == 30, ix['tiles'])
seoul = json.load(open(os.path.join(out, 't', '75_253.json')))['t']
check('서울: id osm1, 이름 name:ko, 표시 9(유료+기저귀), 개방시간', seoul == [['osm1', 37.5665, 126.978, '시청 화장실', 9, '24/7']], seoul)
kyoto = json.load(open(os.path.join(out, 't', '70_270.json')))['t']
check('건물로 그려진 화장실(way)은 osmw + 도형 중심', len(kyoto) == 1 and kyoto[0][0] == 'osmw10' and abs(kyoto[0][1] - 35.001) < 1e-6 and abs(kyoto[0][2] - 135.001) < 1e-6, kyoto)
check('범위(region)가 데이터를 덮음', ix['region'] == {'s': 35, 'w': 126, 'n': 38, 'e': 140}, ix['region'])
check('출처·라이선스 표기', os.path.exists(os.path.join(out, 'LICENSE.txt')) and ix['license'] == 'ODbL 1.0')
r2 = subprocess.run([sys.executable, script, os.path.join(d, 'out2'), src], env=dict(os.environ, MIN_TOTAL='1000'), capture_output=True, text=True)
check('너무 적으면 발행하지 않음', r2.returncode != 0 and not os.path.exists(os.path.join(d, 'out2', 'index.json')))
shutil.rmtree(d)
bad = ok_all.count(False); print('\n%d/%d 통과' % (len(ok_all) - bad, len(ok_all))); sys.exit(1 if bad else 0)
