import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import importlib.util
spec = importlib.util.spec_from_file_location('ex', str(Path(__file__).parent / 'explore_resolver.py'))
src = open(Path(__file__).parent / 'explore_resolver.py').read().replace('\nmain()\n', '\n')
ns = {'__file__': str(Path(__file__).parent / 'explore_resolver.py')}; exec(src, ns)
score = ns['score']; bk = sys.modules['bk']
V = [tuple(score.norm(t).split()) for t in bk.vocab_terms()]
V = [v for v in V if v]
def has_vocab(words):
    s = ' ' + ' '.join(words) + ' '
    return any(' ' + ' '.join(v) + ' ' in s for v in V)
def vocab_set(words):
    s = ' ' + ' '.join(words) + ' '
    return {v for v in V if ' ' + ' '.join(v) + ' ' in s}
RULES = {
  'p_fill': lambda p, q: q if not p else p,
  'p_fill_vocabsub': lambda p, q: q if (not p or (vocab_set(q) - vocab_set(p))) else p,
  'q_primary': lambda p, q: q,
  'q_vocab': lambda p, q: p if (vocab_set(p) - vocab_set(q)) else q,
  'q_fill': lambda p, q: p if not q else q,
  'q_vocab_fill': lambda p, q: p if (not q or (vocab_set(p) - vocab_set(q))) else q,
}
for ds in ('silver', 'silverE'):
    S = json.load(open(ns['ROOT'] / f'refs/{ds}_set.json'))['windows']
    P = ns['load'](ds, 'H0ts'); Q = ns['load'](ds, 'H3u')
    for name, rule in RULES.items():
        rows = []
        for w in S:
            pt = score.norm(P[w['id']]['text']).split(); qt = score.norm(Q[w['id']]['text']).split()
            rows.append(score.score_pair(w['ref'], ' '.join(ns['resolve'](pt, qt, rule))))
        A = score.agg(rows)
        print(f"{ds:7s} {name:16s} WER {A['WER']*100:5.2f} S {A['SUB']*100:4.1f} D {A['DEL']*100:4.1f} I {A['INS']*100:4.1f} entR {A['ent_recall']*100:5.1f} entP {A['ent_precision']*100:5.1f}", flush=True)
