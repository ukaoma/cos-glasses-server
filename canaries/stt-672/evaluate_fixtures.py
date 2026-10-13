"""The 10/13 diagnostic fixtures (negation "lacking/having", units "months/minutes"), decoded
through the shipped paths (decode.mts: large-v3 timestamps+highpass, Parakeet Ultra and v2), then
resolved by the shipped resolver. Counts only: which windows carry the provisional caption's
wording ("lacking", "months") and whether the resolver ever changed a negation or unit token."""
import json, os, re, subprocess, sys, tempfile
import os
from pathlib import Path
HERE = Path(__file__).resolve().parent
EVAL = Path(os.environ.get('STT672_EVAL_DIR', str(Path.home() / 'cos-data/stt-672-eval')))
rows = [json.loads(l) for l in open(EVAL / 'runs/fixtures.jsonl') if l.startswith('{')]
by = {}
for r in rows:
    by.setdefault(r['id'], {})[r['engine']] = r
NEG = {'lacking', 'having'}; UNIT = {'months', 'minutes'}
def keys(t): return [re.sub(r'[^a-z]', '', w.lower()) for w in t.split()]
jobs = []
for i, d in sorted(by.items()):
    p = d['large-v3']
    for sec in ('parakeet-v2', 'parakeet-ultra'):
        jobs.append({'id': f'{i}|lv3+{sec}', 'primary': {'engine': 'large-v3', 'text': p['text'], 'words': p['words']}, 'second': {'engine': sec, 'text': d[sec]['text'], 'words': d[sec]['words']}, 'correctSecond': True})
    jobs.append({'id': f'{i}|pku+lv3', 'primary': {'engine': 'parakeet-ultra', 'text': d['parakeet-ultra']['text'], 'words': d['parakeet-ultra']['words']}, 'second': {'engine': 'large-v3', 'text': p['text'], 'words': p['words']}})
s = tempfile.mkdtemp(); env = dict(os.environ, COS_DATA_DIR=s, HOME=s, COS_PROFILE_PATH=str(ROOT / 'tmp/profile/.cos-profile.json'))
out = subprocess.run(['node', '--import', 'tsx/esm', str(HERE / 'resolve-batch.ts')], input='\n'.join(map(json.dumps, jobs)) + '\n', capture_output=True, text=True, env=env, cwd=str(HERE.parent.parent))
res = {json.loads(l)['id']: json.loads(l) for l in out.stdout.splitlines() if l.startswith('{')}
assert len(res) == len(jobs), out.stderr[-400:]
neg_windows = [i for i, d in by.items() if any(k in NEG for e in d.values() for k in keys(e['text']))]
unit_windows = [i for i, d in by.items() if any(k in UNIT for e in d.values() for k in keys(e['text']))]
summary = {'windows': len(by), 'negation_windows': len(neg_windows), 'unit_windows': len(unit_windows), 'arms': {}}
def tally(texts, wins):
    t = {}
    for w in wins:
        ks = set(keys(texts[w]))
        for k in sorted(NEG | UNIT):
            if k in ks: t[k] = t.get(k, 0) + 1
    return t
arms = {'large-v3': {i: d['large-v3']['text'] for i, d in by.items()}, 'parakeet-ultra': {i: d['parakeet-ultra']['text'] for i, d in by.items()},
        'parakeet-v2': {i: d['parakeet-v2']['text'] for i, d in by.items()},
        'resolver lv3+v2': {i: res[f'{i}|lv3+parakeet-v2']['text'] for i in by}, 'resolver lv3+ultra': {i: res[f'{i}|lv3+parakeet-ultra']['text'] for i in by},
        'resolver ultra+lv3': {i: res[f'{i}|pku+lv3']['text'] for i in by}}
for name, texts in arms.items():
    summary['arms'][name] = {'negation_tokens': tally(texts, neg_windows), 'unit_tokens': tally(texts, unit_windows)}
# flips introduced by the resolver relative to its own primary
flips = {}
for name, prim in (('resolver lv3+v2', 'large-v3'), ('resolver lv3+ultra', 'large-v3'), ('resolver ultra+lv3', 'parakeet-ultra')):
    n = 0
    for i in by:
        a = [k for k in keys(arms[prim][i]) if k in NEG | UNIT]; b = [k for k in keys(arms[name][i]) if k in NEG | UNIT]
        n += a != b
    flips[name] = n
summary['resolver_changed_negation_or_unit_windows'] = flips
summary['protected_regions'] = {k: sum(v['protected'] for kk, v in res.items() if kk.endswith(k)) for k in ('lv3+parakeet-v2', 'lv3+parakeet-ultra', 'pku+lv3')}
json.dump(summary, open(sys.argv[1], 'w'), indent=1)
print(json.dumps(summary, indent=1))
