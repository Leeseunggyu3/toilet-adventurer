"""화장실 데이터 미리 받기 (매주 GitHub Actions에서 실행, .github/workflows/toilet-data.yml).

Geofabrik이 매일 내놓는 나라별 OpenStreetMap 파일(.osm.pbf)에서 amenity=toilets만 골라
0.5도×0.5도 칸(타일)별 JSON으로 나눠 저장한다. 앱은 이 파일을 먼저 쓰고,
타일이 없는 곳(다른 나라, 데이터가 비는 곳)만 Overpass에 직접 묻는다.

실행: python tools/build_toilet_data.py <출력 폴더> <파일.osm.pbf> [<파일> ...]
환경 변수: MIN_TOTAL (이보다 적게 나오면 이상하다고 보고 발행하지 않음, 기본 5000)
"""
import json, math, os, sys, time
from datetime import datetime, timezone
import osmium

def main():
    out, inputs = sys.argv[1], sys.argv[2:]
    min_total = int(os.environ.get('MIN_TOTAL', '5000'))
    t0 = time.time()
    rows = {}
    for path in inputs:
        n0 = len(rows)
        fp = osmium.FileProcessor(path).with_locations().with_filter(osmium.filter.TagFilter(('amenity', 'toilets')))
        for o in fp:
            if o.is_node():
                if not o.location.valid(): continue
                lat, lng, oid = o.location.lat, o.location.lon, 'osm%d' % o.id
            elif o.is_way():
                pts = [(n.location.lat, n.location.lon) for n in o.nodes if n.location.valid()]
                if len(pts) > 1 and pts[0] == pts[-1]: pts = pts[:-1]  # 닫힌 도형은 첫 점이 두 번 들어 있다
                if not pts: continue
                lat, lng, oid = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), 'osmw%d' % o.id
            else:
                continue  # 관계(relation)로 그려진 화장실은 아주 드물어서 뺀다
            t = o.tags
            flags = (1 if t.get('fee') == 'yes' else 0) | (2 if t.get('wheelchair') == 'yes' else 0) | (4 if t.get('unisex') == 'yes' else 0) | (8 if t.get('changing_table') == 'yes' else 0)
            name = t.get('name') or t.get('name:ko') or t.get('name:en') or ''
            rows[oid] = [oid, round(lat, 6), round(lng, 6), name[:80], flags, (t.get('opening_hours') or '')[:60]]
        print('%s: %d곳 (%.1f분)' % (path, len(rows) - n0, (time.time() - t0) / 60), flush=True)

    total = len(rows)
    print('합계 %d곳' % total, flush=True)
    if total < min_total:
        print('화장실이 %d곳뿐이라 이상하다고 보고 발행하지 않습니다 (기준 %d)' % (total, min_total), file=sys.stderr)
        sys.exit(1)

    tiles = {}
    for r in rows.values():
        tiles.setdefault('%d_%d' % (math.floor(r[1] * 2), math.floor(r[2] * 2)), []).append(r)
    os.makedirs(os.path.join(out, 't'), exist_ok=True)
    counts = {}
    for key, rs in tiles.items():
        rs.sort(key=lambda r: r[0])
        with open(os.path.join(out, 't', key + '.json'), 'w', encoding='utf-8') as f:
            json.dump({'v': 1, 't': rs}, f, ensure_ascii=False, separators=(',', ':'))
        counts[key] = len(rs)
    lats = [r[1] for r in rows.values()]; lngs = [r[2] for r in rows.values()]
    index = {
        'v': 1, 'at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'OpenStreetMap (Geofabrik extracts: %s)' % ', '.join(os.path.basename(p) for p in inputs),
        'license': 'ODbL 1.0', 'tile': 0.5, 'total': total, 'missing': [],
        # 앱은 이 범위 안에서, 타일이 있는 곳만 이 데이터를 쓴다
        'region': {'s': math.floor(min(lats)), 'w': math.floor(min(lngs)), 'n': math.floor(max(lats)) + 1, 'e': math.floor(max(lngs)) + 1},
        'tiles': counts,
    }
    with open(os.path.join(out, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(out, 'LICENSE.txt'), 'w', encoding='utf-8') as f:
        f.write('This folder contains information from OpenStreetMap (https://www.openstreetmap.org), which is made available here under the Open Database License (ODbL) 1.0: https://opendatacommons.org/licenses/odbl/1-0/\n© OpenStreetMap contributors. Extracts by Geofabrik (https://download.geofabrik.de).\n')
    print('완료: %s, 타일 %d개 (%.1f분)' % (out, len(counts), (time.time() - t0) / 60), flush=True)

if __name__ == '__main__':
    main()
