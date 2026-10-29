"""Expected decisions for the synthetic meeting, from the research tool itself.

usage: npx tsx server/lib/__fixtures__/speaker-shadow/dump-synthetic-inputs.ts <synthetic-inputs.json>
       COS_SPEAKER_SHADOW_RESEARCH_DIR=<community-1-fluidaudio-v1> \\
         python3 -I synthetic_python_decide.py <synthetic-inputs.json> > synthetic-python-decide.json

Imports community-1-fluidaudio-v1/scripts/hybrid.py read-only and runs decide() on the
synthetic meeting (server/lib/__fixtures__/speaker-shadow/synthetic-meeting.ts, dumped to
JSON) and on boundary variants. Each variant carries its own segs, native turns and embedding
changes, so the TypeScript test feeds decide() exactly what Python saw. Synthetic data only.
"""
import copy, json, os, struct, sys
from pathlib import Path
R = Path(os.environ['COS_SPEAKER_SHADOW_RESEARCH_DIR'])
sys.path.insert(0, str(R / 'scripts')); sys.path.insert(0, str(R))
import hybrid
from adapt import to_turns

SR = 16000
base = json.load(open(sys.argv[1]))
f32 = lambda x: struct.unpack('f', struct.pack('f', x))[0]

def run(segs, native, drop=(), extra=()):
    nat = [(s['speakerId'], f32(s['startTimeSeconds']), f32(s['endTimeSeconds'])) for s in native]
    regular, clipped, _ = to_turns(nat, base['total'] / SR)
    emb = [e for i, e in enumerate(base['embeddings']) if i not in set(drop)] + list(extra)
    D = hybrid.decide([tuple(s) for s in segs], base['total'], regular, emb, 15.0, 0.8)
    return {'segs': segs, 'native': native, 'dropEmbeddings': sorted(drop), 'extraEmbeddings': list(extra),
            'itemVoices': [x['voice'] for x in D['items']],
            'rows': {v: {k: r[k] for k in ('seconds', 'coveredFraction', 'topCluster', 'majority', 'fragmentEmbeddings', 'otherClusterMembers', 'outlier', 'eligible', 'reasons')} for v, r in D['rows'].items()},
            'groups': D['groups'], 'rejected': D['rejected'], 'remap': D['remap'], 'proposed': D['proposed'], 'accepted': D['accepted'],
            'agree': D['agree'], 'withOut': D['withOut'], 'items': len(D['items']), 'voiceBefore': D['voiceBefore'], 'voiceAfter': D['voiceAfter']}

variants = {'base': run(base['segs'], base['native'])}
# Voice 13 trimmed by 80 samples: 239,920 samples = 14.995 s, which Python rounds to 14.99 (fails the floor).
segs = copy.deepcopy(base['segs'])
last = max(i for i, s in enumerate(segs) if s[2] == 'Voice 13'); segs[last][1] -= 80
variants['voice13_14995'] = run(segs, base['native'])
# Voice 6's FluidAudio split moved so S2 holds 0.7996 of it: rounded to 0.8 it PASSES majority 0.8.
native = copy.deepcopy(base['native'])
for s in native:
    if s['speakerId'] == 'S2' and s['startTimeSeconds'] == 130: s['endTimeSeconds'] = 145.992
    if s['speakerId'] == 'S3' and s['startTimeSeconds'] == 142: s['startTimeSeconds'] = 145.992
variants['voice6_majority_07996'] = run(base['segs'], native)
# Thin embeddings: Voice 13 keeps 2 windows (fragment < 3), and Voice 12's cluster keeps only
# 4 other windows (others < 5). Both fail (c) as "insufficient embeddings" with a top cluster.
rows = base['embeddings']
in_span = lambda e, a, b: a <= e['startTime'] and e['endTime'] <= b
v13 = [i for i, e in enumerate(rows) if in_span(e, 325, 340)]
v11 = [i for i, e in enumerate(rows) if in_span(e, 235, 265)]
ext = [i for i, e in enumerate(rows) if in_span(e, 285, 325)]
variants['thin_embeddings'] = run(base['segs'], base['native'], v13[2:] + v11[4:] + ext)
# A window straddling Voice 7 (0.5 s) and a named label (1.5 s): no Voice holds half of it,
# so it belongs to no voice (only Voice labels compete), though it is a member of S1.
straddle = dict(base['embeddings'][0], startTime=169.5, endTime=171.5, cluster=0)
variants['straddling_window'] = run(base['segs'], base['native'], (), [straddle])
# Voice 11 cut to 15 s: the later Voice 12 (20 s) is now the longest eligible voice on S4, so it is the anchor.
segs = [s for s in base['segs'] if not (s[2] == 'Voice 11' and s[0] >= 250 * SR)]
variants['later_longer'] = run(segs, base['native'])
print(json.dumps({'source': 'community-1-fluidaudio-v1/scripts/hybrid.py decide() on CPython ' + sys.version.split()[0], 'variants': variants}, indent=1))
