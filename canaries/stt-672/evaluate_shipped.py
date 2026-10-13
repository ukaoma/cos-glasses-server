"""Score the shipped-path HQ arms (shipped-hq.mts MODE=arms output) with the bake-off scorer
and gates. Baseline: Large-v3 alone through the same code. Also the paired difference between
the two resolver second opinions (Ultra vs v2), CLEAN and REAL stratum E, collapsed windows,
CPU and Metal compute from the decode timings, and the negation/unit fixture tallies.
Usage: venv/bin/python evaluate_shipped.py ARMS.json DECODE_TIMING.json [more timing files] OUT.json"""
import json, re, sys
from pathlib import Path
ROOT = Path('/Users/ukaoma/cos-data/asr-bakeoff')
GATES = Path('/Users/ukaoma/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff/operations/personal/wk41_2026/asr-bakeoff/canaries')
sys.path.insert(0, str(ROOT / 'scripts')); sys.path.insert(0, str(GATES))
import score, bk, gates  # noqa: E402
REPS = 4000
NEG = {'lacking', 'having'}; UNIT = {'months', 'minutes'}


def main(arms_path, timing_paths, out_path):
    A = json.load(open(arms_path))['arms']
    sets = {ds: json.load(open(ROOT / f'refs/{ds}_set.json'))['windows'] for ds in ('silver', 'silverE', 'stratE')}
    names = list(A)
    res = {'arms': names, 'tables': {}, 'comparisons': {}, 'pooled_entities': {}, 'stratE': {}, 'counts': {}, 'gates': {}, 'paired': {}}
    rows = {}
    for ds in ('silver', 'silverE'):
        S = [w for w in sets[ds] if all(w['id'] in A[n].get(ds, {}) for n in names)]
        rows[ds] = {n: [score.score_pair(w['ref'], A[n][ds][w['id']]['text']) for w in S] for n in names}
        rows[ds + '_blocks'] = [w['sid'] for w in S]
        res['tables'][ds] = {}
        for n in names:
            T = score.agg(rows[ds][n]); T['windows'] = len(S); T['complete'] = len(S) == len(sets[ds])
            T['WER_ci'] = score.bootstrap_ci(rows[ds][n], rows[ds + '_blocks'], 'WER', reps=REPS)
            T['collapsed_windows'] = sum(1 for w in S if len(score.norm(A[n][ds][w['id']]['text']).split()) < 0.5 * len(score.norm(w['ref']).split()))
            res['tables'][ds][n] = T
        for n in names:
            c = {}
            for key in ('fallbacks', 'secondFailures', 'applied', 'wordsFromSecond', 'segments', 'decoded'):
                c[key] = sum(A[n][ds][w['id']].get(key, 0) for w in S)
            reasons = {}
            for w in S:
                for k, v in A[n][ds][w['id']].get('reasons', {}).items():
                    reasons[k] = reasons.get(k, 0) + v
            c['reasons'] = reasons
            res['counts'].setdefault(ds, {})[n] = c
    vocab_norm = [tuple(score.norm(v).split()) for v in bk.vocab_terms()]
    for n in names:
        e = {}
        for kind in ('clean', 'real'):
            W = [w for w in sets['stratE'] if w['id'] in A[n].get('stratE', {}) and ((kind == 'clean' and w['kind'] in ('tone', 'music')) or w['kind'] == kind)]
            texts = [score.norm(A[n]['stratE'][w['id']]['text']) for w in W]
            e[kind] = {'units': len(W), 'any_output_share': (sum(1 for t in texts if t.split()) / len(W)) if W else None,
                       'vocab_echo_units': sum(1 for t in texts if any(' ' + ' '.join(v) + ' ' in ' ' + t + ' ' for v in vocab_norm))}
        res['stratE'][n] = e
    H0nv = {}
    for f in (ROOT / 'runs/stratE/H0nv').glob('*.json'):
        if f.name != 'RECEIPT.json':
            j = json.load(open(f)); H0nv[j['id']] = j['text']
    clean_ids = [w['id'] for w in sets['stratE'] if w['kind'] in ('tone', 'music')]
    pc = {'units': len(clean_ids), 'any_output_share': sum(1 for i in clean_ids if score.norm(H0nv.get(i, '')).split()) / len(clean_ids)}
    # compute (RTF) per engine and device from the decode timings
    timing = []
    for p in timing_paths:
        timing += json.load(open(p)).get('timing', [])
    rtf = {}
    for kind in sorted({t['kind'] for t in timing}):
        xs = [t for t in timing if t['kind'] == kind and not t['cached'] and t['audioSec'] > 0]
        if xs:
            rtf[kind] = {'decodes': len(xs), 'rtf': sum(t['ms'] for t in xs) / 1000 / sum(t['audioSec'] for t in xs)}
    res['decode_rtf'] = rtf
    base = 'LV3'
    for n in names:
        if n == base:
            continue
        c = {'n_windows': len(rows['silver'][n]), 'n_meetings': len(set(rows['silver_blocks']))}
        for m in ('WER', 'DEL', 'INS', 'SUB'):
            c[m] = score.bootstrap_diff(rows['silver'][base], rows['silver'][n], rows['silver_blocks'], m, reps=REPS)
        c['silverE_WER'] = score.bootstrap_diff(rows['silverE'][base], rows['silverE'][n], rows['silverE_blocks'], 'WER', reps=REPS)
        res['comparisons'][n] = c
        ra = rows['silver'][base] + rows['silverE'][base]; rb = rows['silver'][n] + rows['silverE'][n]; bl = rows['silver_blocks'] + rows['silverE_blocks']
        T = score.agg(rb)
        res['pooled_entities'][n] = {'n_mentions': T['ent_ref'], 'recall': T['ent_recall'], 'precision': T['ent_precision'], 'diff': score.bootstrap_diff(ra, rb, bl, 'ent_recall', reps=REPS)}
        parts = {'RES_LV3_U': ['lv3ts', 'parakeet-ultra'], 'RES_LV3_V2': ['lv3ts', 'parakeet-v2'], 'PKU': ['parakeet-ultra'], 'PKU_LV3': ['parakeet-ultra', 'lv3ts']}.get(n, ['lv3ts'])
        rt = sum(rtf[k]['rtf'] for k in parts if k in rtf) if all(k in rtf for k in parts) else None
        row = dict(res['tables']['silver'][n]); row['latency'] = {'rtf': rt}
        g = {'silver_table': {n: row}, 'comparisons': {f'HQ:{n}': c}, 'pooled_entities': {f'HQ:{n}': res['pooled_entities'][n]},
             'stratE': {n: {'clean': res['stratE'][n]['clean']}, 'H0': {'clean': res['stratE'][base]['clean']}, 'H0nv': {'clean': pc}}}
        res['gates'][n] = gates.evaluate(g, {}, 'HQ', n)
    T = score.agg(rows['silver'][base] + rows['silverE'][base])
    res['pooled_entities'][base] = {'n_mentions': T['ent_ref'], 'recall': T['ent_recall'], 'precision': T['ent_precision']}
    if 'RES_LV3_U' in names and 'RES_LV3_V2' in names:
        res['paired']['V2_minus_U'] = {'silver': score.bootstrap_diff(rows['silver']['RES_LV3_U'], rows['silver']['RES_LV3_V2'], rows['silver_blocks'], 'WER', reps=REPS),
                                       'silverE': score.bootstrap_diff(rows['silverE']['RES_LV3_U'], rows['silverE']['RES_LV3_V2'], rows['silverE_blocks'], 'WER', reps=REPS)}
    # fixtures
    fx = {}
    for n in names:
        F = A[n].get('fixtures', {})
        def keys(t): return [re.sub(r'[^a-z]', '', x.lower()) for x in t.split()]
        tally = {}
        for i, v in F.items():
            for k in keys(v['text']):
                if k in NEG | UNIT: tally[k] = tally.get(k, 0) + 1
        fx[n] = {'windows': len(F), 'tokens': tally}
    if 'LV3' in A and A['LV3'].get('fixtures'):
        for n in names:
            changed = 0
            for i, v in A[n].get('fixtures', {}).items():
                prim = A['PKU' if n.startswith('PKU') else 'LV3']['fixtures'].get(i, {}).get('text', '')
                a = [k for k in re.findall(r'[a-z]+', prim.lower()) if k in NEG | UNIT]; b = [k for k in re.findall(r'[a-z]+', v['text'].lower()) if k in NEG | UNIT]
                changed += a != b
            fx[n]['windows_changed_vs_own_primary'] = changed
    res['fixtures'] = fx
    json.dump(res, open(out_path, 'w'), indent=1, default=float)
    for ds in ('silver', 'silverE'):
        for n in names:
            T = res['tables'][ds][n]
            print(f"{ds:7s} {n:11s} WER {T['WER']*100:5.2f} [{T['WER_ci'][0]*100:.1f},{T['WER_ci'][1]*100:.1f}] S/D/I {T['SUB']*100:.1f}/{T['DEL']*100:.1f}/{T['INS']*100:.1f} entR {T['ent_recall']*100:.1f} entP {T['ent_precision']*100:.1f} coll {T['collapsed_windows']} n={T['windows']}")
    for n, c in res['comparisons'].items():
        w = c['WER']; p = res['pooled_entities'][n]
        print(f"LV3->{n:10s} rel {w['rel']*100:+.1f}% [{w['rel_ci'][0]*100:+.1f},{w['rel_ci'][1]*100:+.1f}] silverE {c['silverE_WER']['rel']*100:+.1f}% [{c['silverE_WER']['rel_ci'][0]*100:+.1f},{c['silverE_WER']['rel_ci'][1]*100:+.1f}] entR {p['recall']*100:.1f} d {p['diff']['diff']*100:+.1f} [{p['diff']['ci'][0]*100:+.1f},{p['diff']['ci'][1]*100:+.1f}] P {p['precision']*100:.1f} {'PASS' if res['gates'][n]['silver_qualified'] else 'fail: ' + ','.join(k for k, x in res['gates'][n]['checks'].items() if not x['passed'])}")
    for k, v in res['paired'].items():
        print(k, {ds: (round(x['diff'] * 100, 2), [round(y * 100, 2) for y in x['ci']]) for ds, x in v.items()})
    for n in names:
        print('E', n, res['stratE'][n], 'fixtures', fx.get(n))
    print('rtf', json.dumps(rtf))
    print('counts', json.dumps(res['counts']))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2:-1], sys.argv[-1])
