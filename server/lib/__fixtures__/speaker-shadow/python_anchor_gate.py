"""Independent Wave-1 gate reference over read-only research decide() output.

COS_SPEAKER_SHADOW_RESEARCH_DIR=<community-1-fluidaudio-v1> python3 -I \
  python_anchor_gate.py <inputs.json> [<historical-synthetic-variants.json>]

No audio/model execution. With variants, writes the synthetic parity fixture;
without variants, writes one private cached-meeting reference. Historical
research fixtures remain unchanged. Gate(d) compares the unrounded ratio.
"""
import json, math, os, struct, sys
from pathlib import Path

research = Path(os.environ['COS_SPEAKER_SHADOW_RESEARCH_DIR'])
sys.dont_write_bytecode = True
sys.path[:0] = [str(research / 'scripts'), str(research)]
import hybrid
from adapt import to_turns

def reference(inputs):
    f32 = lambda x: struct.unpack('f', struct.pack('f', x))[0]
    native = [(s['speakerId'], f32(s['startTimeSeconds']), f32(s['endTimeSeconds'])) for s in inputs['native']]
    turns, _, _ = to_turns(native, inputs['total'] / 16000)
    d = hybrid.decide([tuple(s) for s in inputs['segs']], inputs['total'], turns, inputs['embeddings'], 15.0, .8)
    rows = d['rows']
    vectors = {v: [x['vec'] for x in d['items'] if x['voice'] == v] for v in rows}
    for r in rows.values():
        r['anchorRatio'] = None
        r['anchorRatioPass'] = None
    rejected, remap = [], {}
    for group in d['groups']:
        anchor = group['anchor']
        if anchor:
            a = vectors[anchor]
            for v in group['voices']:
                if v == anchor:
                    continue
                b, ratio = vectors[v], None
                valid = lambda x: len(x) == 256 and any(n != 0 for n in x) and all(math.isfinite(n) for n in x)
                if len(a) >= 3 and len(b) >= 3 and all(valid(x) for x in a + b):
                    centroid = hybrid.mean_dir(a)
                    spread = hybrid.p95([hybrid.cosdist(x, centroid) for x in a])
                    distance = hybrid.cosdist(hybrid.mean_dir(b), centroid)
                    if math.isfinite(spread) and spread > 0 and math.isfinite(distance) and distance >= -1e-12:
                        candidate = max(0, distance) / spread
                        if math.isfinite(candidate):
                            ratio = candidate
                r = rows[v]
                r['anchorRatio'] = ratio
                r['anchorRatioPass'] = ratio is not None and ratio <= 1.5
                if r['eligible'] and not r['anchorRatioPass']:
                    r['eligible'] = False
                    r['reasons'].append('(d) anchor ratio evidence unavailable' if ratio is None else '(d) anchor ratio %.4f > 1.50' % ratio)
        merged = [v for v in group['voices'] if v != anchor and rows[v]['eligible']]
        group['mergedIntoAnchor'] = merged
        remap.update({v: anchor for v in merged})
        # Research rejection order follows production label insertion order.
        for v, r in rows.items():
            if v not in group['voices']:
                continue
            if not r['eligible']:
                rejected.append({'voice': v, 'cluster': group['cluster'], 'reasons': r['reasons']})
            elif v == anchor and not merged:
                rejected.append({'voice': v, 'cluster': group['cluster'], 'reasons': ['no other eligible voice in this cluster']})
    return {'rows': rows, 'groups': d['groups'], 'rejected': rejected, 'remap': remap,
            'accepted': len(remap), 'proposed': d['proposed'], 'voiceBefore': d['voiceBefore'],
            'voiceAfter': len({remap.get(v, v) for v in rows})}

if __name__ == '__main__':
    inputs = json.loads(Path(sys.argv[1]).read_text())
    if len(sys.argv) == 3:
        historical = json.loads(Path(sys.argv[2]).read_text())
        variants = {}
        for name, v in historical['variants'].items():
            dropped = set(v['dropEmbeddings'])
            variants[name] = reference({**inputs, 'segs': v['segs'], 'native': v['native'],
                'embeddings': [e for i, e in enumerate(inputs['embeddings']) if i not in dropped] + v['extraEmbeddings']})
        output = {'source': 'CPython ' + sys.version.split()[0] + ': research (a)-(c), independent unrounded anchor gate (d)', 'variants': variants}
    else:
        output = reference(inputs)
    print(json.dumps(output, indent=1, allow_nan=False))
