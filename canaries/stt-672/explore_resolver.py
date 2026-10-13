"""Exploration only: which disagreement classes between large-v3 (fixed) and Parakeet
help or hurt against the silver reference. Numbers only to stdout."""
import json, sys
from pathlib import Path
ROOT = Path('/Users/ukaoma/cos-data/asr-bakeoff')
sys.path.insert(0, str(ROOT / 'scripts'))
import score

def load(ds, arm):
    d = ROOT / 'runs' / ds / arm
    return {json.load(open(f))['id']: json.load(open(f)) for f in d.glob('*.json') if f.name != 'RECEIPT.json'}

def align(a, b):
    n, m = len(a), len(b)
    D = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1): D[i][0] = i
    for j in range(m + 1): D[0][j] = j
    for i in range(1, n + 1):
        ai = a[i - 1]; row = D[i]; prev = D[i - 1]
        for j in range(1, m + 1):
            row[j] = min(prev[j - 1] + (ai != b[j - 1]), prev[j] + 1, row[j - 1] + 1)
    ops = []; i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and D[i][j] == D[i - 1][j - 1] + (a[i - 1] != b[j - 1]):
            ops.append(('=' if a[i - 1] == b[j - 1] else 's', i - 1, j - 1)); i -= 1; j -= 1
        elif i > 0 and D[i][j] == D[i - 1][j] + 1:
            ops.append(('p', i - 1, None)); i -= 1
        else:
            ops.append(('q', None, j - 1)); j -= 1
    return ops[::-1]

def runs(ops):
    out = []; cur = None
    for op in ops:
        k = op[0]
        if k == '=':
            if cur: out.append(cur); cur = None
            out.append(('=', [op]))
            continue
        if cur and cur[0] == 'd':
            cur[1].append(op)
        else:
            if cur: out.append(cur)
            cur = ('d', [op])
    if cur: out.append(cur)
    return out

def resolve(P, Q, rule):
    ops = align(P, Q); out = []
    for kind, group in runs(ops):
        if kind == '=':
            out.append(P[group[0][1]]); continue
        pw = [P[o[1]] for o in group if o[1] is not None]
        qw = [Q[o[2]] for o in group if o[2] is not None]
        out.extend(rule(pw, qw))
    return out

RULES = {
    'primary': lambda p, q: p,
    'second': lambda p, q: q,
    'fill_gaps': lambda p, q: q if not p else p,
    'fill_gaps_ge2': lambda p, q: q if (not p and len(q) >= 2) else p,
    'fill_gaps_ge3': lambda p, q: q if (not p and len(q) >= 3) else p,
    'fill_gaps_ge4': lambda p, q: q if (not p and len(q) >= 4) else p,
    'longer': lambda p, q: q if len(q) > len(p) else p,
    'longer_by2': lambda p, q: q if len(q) >= len(p) + 2 else p,
    'longer_by3': lambda p, q: q if len(q) >= len(p) + 3 else p,
}

def main():
    for ds in ('silver', 'silverE'):
        S = json.load(open(ROOT / f'refs/{ds}_set.json'))['windows']
        for sec in ('H3u', 'H3v2'):
            P = load(ds, 'H0ts'); Q = load(ds, sec)
            for name, rule in RULES.items():
                rows = []
                for w in S:
                    if w['id'] not in P or w['id'] not in Q: continue
                    pt = score.norm(P[w['id']]['text']).split(); qt = score.norm(Q[w['id']]['text']).split()
                    rows.append(score.score_pair(w['ref'], ' '.join(resolve(pt, qt, rule))))
                A = score.agg(rows)
                print(f"{ds:7s} {sec:5s} {name:14s} n={len(rows):3d} WER {A['WER']*100:5.2f} S {A['SUB']*100:4.1f} D {A['DEL']*100:4.1f} I {A['INS']*100:4.1f} entR {A['ent_recall']*100:5.1f} entP {A['ent_precision']*100:5.1f}", flush=True)

main()
