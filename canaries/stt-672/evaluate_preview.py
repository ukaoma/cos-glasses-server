"""Preview-lane evaluation (6.72.0): Parakeet v2 / Ultra vs Whisper Turbo on the bake-off live
lane, per stored 6 s chunk, through the shipped decode paths (preview-run.mts outputs).

WER on SILVER (39 windows, 13 meetings) with paired meeting bootstrap vs turbo-raw (today's
preview); entity recall pooled with SILVER-E; CLEAN stratum E any-output share; per-chunk compute
p50/p95 (spawn + highpass + decode, wall clock); estimated word emission delay (chunk end minus the
word's start, using Parakeet v2 word starts as the timing reference for every arm, plus that arm's
compute for the chunk), over SILVER and SILVER-E chunks each arm decoded. Gates: canaries/gates.py live lane with turbo-raw as the baseline.
Usage: venv/bin/python evaluate_preview.py OUT.json [contention.json]
"""
import json, sys
from pathlib import Path
import numpy as np
ROOT = Path(os.environ.get('ASR_BAKEOFF_ROOT', str(Path.home() / 'cos-data/asr-bakeoff'))); EVAL = Path(os.environ.get('STT672_EVAL_DIR', str(Path.home() / 'cos-data/stt-672-eval')))
GATES = Path(os.environ['ASR_GATES_DIR'])  # the bake-off canaries/ folder holding gates.py
sys.path.insert(0, str(ROOT / 'scripts')); sys.path.insert(0, str(GATES))
import score, bk, gates  # noqa: E402
import os
ARMS = os.environ.get('ARMS', 'turbo-raw,turbo-hp,parakeet-v2,parakeet-ultra').split(',')
BASE = os.environ.get('BASE', 'turbo-raw')
TIMING_REF = os.environ.get('TIMING_REF', 'parakeet-v2')
REPS = 4000


def load(arm):
    out = {}
    p = EVAL / 'runs' / f'preview_{arm}.jsonl'
    if not p.exists():
        return None
    for l in open(p):
        if l.startswith('{'):
            d = json.loads(l); out[d['id']] = d
    return out


def window_text(R, ds, w):
    return ' '.join((R.get(f"{ds}|{w['id']}|{c['idx']}") or {}).get('text', '') for c in w['chunks']).strip()


def complete(R, ds, w):
    return all(f"{ds}|{w['id']}|{c['idx']}" in R and 'error' not in R[f"{ds}|{w['id']}|{c['idx']}"] for c in w['chunks'])


def main(out, contention=None):
    sets = {ds: json.load(open(ROOT / f'refs/{ds}_set.json'))['windows'] for ds in ('silver', 'silverE', 'stratE')}
    runs = {a: load(a) for a in ARMS}
    runs = {a: r for a, r in runs.items() if r}
    ref_t = runs.get(TIMING_REF) or (load(TIMING_REF) or {})
    res = {'arms': list(runs), 'tables': {}, 'comparisons': {}, 'pooled_entities': {}, 'stratE': {}, 'latency': {}, 'gates': {}}
    rows = {}
    # turbo-raw on SILVER is the saved bake-off L4 arm (same private-server args, raw audio, no prompt).
    L4 = {}
    for f in (ROOT / 'runs/silver/L4').glob('*.json'):
        if f.name != 'RECEIPT.json':
            j = json.load(open(f)); L4[j['id']] = j['text']
    use_l4 = lambda a, ds: a == 'turbo-raw' and ds == 'silver'  # turbo-post carries its own cleaned L4 rows
    for ds in ('silver', 'silverE'):
        S = sets[ds]
        ids = [w for w in S if all((w['id'] in L4) if use_l4(a, ds) else complete(r, ds, w) for a, r in runs.items())]
        rows[ds] = {a: [score.score_pair(w['ref'], L4[w['id']] if use_l4(a, ds) else window_text(r, ds, w)) for w in ids] for a, r in runs.items()}
        rows[ds + '_blocks'] = [w['sid'] for w in ids]
        res['tables'][ds] = {}
        for a in runs:
            A = score.agg(rows[ds][a]); A['windows'] = len(ids); A['complete'] = len(ids) == len(S)
            A['WER_ci'] = score.bootstrap_ci(rows[ds][a], rows[ds + '_blocks'], 'WER', reps=REPS)
            res['tables'][ds][a] = A
    res['L4_saved_silver_WER'] = score.agg([score.score_pair(w['ref'], L4[w['id']]) for w in sets['silver'] if w['id'] in L4])['WER']
    base = BASE
    for a in runs:
        if a == base or base not in runs:
            continue
        c = {'n_windows': len(rows['silver'][a]), 'n_meetings': len(set(rows['silver_blocks']))}
        for m in ('WER', 'DEL', 'INS', 'SUB'):
            c[m] = score.bootstrap_diff(rows['silver'][base], rows['silver'][a], rows['silver_blocks'], m, reps=REPS)
        res['comparisons'][a] = c
        ra = rows['silver'][base] + rows['silverE'][base]; rb = rows['silver'][a] + rows['silverE'][a]; bl = rows['silver_blocks'] + rows['silverE_blocks']
        A = score.agg(rb)
        res['pooled_entities'][a] = {'n_mentions': A['ent_ref'], 'recall': A['ent_recall'], 'precision': A['ent_precision'], 'diff': score.bootstrap_diff(ra, rb, bl, 'ent_recall', reps=REPS)}
    if base in runs:
        A = score.agg(rows['silver'][base] + rows['silverE'][base])
        res['pooled_entities'][base] = {'n_mentions': A['ent_ref'], 'recall': A['ent_recall'], 'precision': A['ent_precision']}
    # stratum E
    vocab_norm = [tuple(score.norm(v).split()) for v in bk.vocab_terms()]
    for a, r in runs.items():
        out_e = {}
        for kind in ('clean', 'real'):
            W = [w for w in sets['stratE'] if (kind == 'clean' and w['kind'] in ('tone', 'music')) or w['kind'] == kind]
            W = [w for w in W if complete(r, 'stratE', w)]
            texts = [score.norm(window_text(r, 'stratE', w)) for w in W]
            out_e[kind] = {'units': len(W), 'any_output_share': sum(1 for t in texts if t.split()) / len(W) if W else None,
                           'vocab_echo_units': sum(1 for t in texts if any(' ' + ' '.join(v) + ' ' in ' ' + t + ' ' for v in vocab_norm))}
        res['stratE'][a] = out_e
    # latency
    for a, r in runs.items():
        ms = [d['ms'] / 1000 for k, d in r.items() if 'error' not in d and 'ms' in d and (k.startswith('silver|') or k.startswith('silverE|'))]
        errs = sum(1 for d in r.values() if 'error' in d)
        delays = []
        for ds in ('silver', 'silverE'):
            for w in sets[ds]:
                for c in w['chunks']:
                    k = f"{ds}|{w['id']}|{c['idx']}"
                    if k not in r or 'error' in r[k] or k not in ref_t:
                        continue
                    for wd in ref_t[k].get('words') or []:
                        if 'ms' in r[k]: delays.append(max(0.0, c['dur'] - wd['start']) + r[k]['ms'] / 1000)
        if not ms:
            res['latency'][a] = {'chunks': 0, 'errors': errs}
            continue
        res['latency'][a] = {'chunks': len(ms), 'errors': errs, 'unit_compute_p50': float(np.percentile(ms, 50)), 'unit_compute_p95': float(np.percentile(ms, 95)),
                             'unit_compute_max': float(max(ms)), 'emission_delay_p50': float(np.percentile(delays, 50)) if delays else None,
                             'emission_delay_p95': float(np.percentile(delays, 95)) if delays else None}
    # gates (live lane, turbo-raw as the baseline under the 'L0' key)
    H0nv = {}
    for f in (ROOT / 'runs/stratE/H0nv').glob('*.json'):
        if f.name != 'RECEIPT.json':
            j = json.load(open(f)); H0nv[j['id']] = j['text']
    clean_ids = [w['id'] for w in sets['stratE'] if w['kind'] in ('tone', 'music')]
    pc = {'units': len(clean_ids), 'any_output_share': sum(1 for i in clean_ids if score.norm(H0nv.get(i, '')).split()) / len(clean_ids)}
    for a in res['comparisons']:
        row = dict(res['tables']['silver'][a]); row['latency'] = res['latency'][a]
        g = {'silver_table': {a: row}, 'comparisons': {f'Live:{a}': res['comparisons'][a]}, 'pooled_entities': {f'Live:{a}': res['pooled_entities'][a]},
             'stratE': {a: {'clean': res['stratE'][a]['clean']}, 'L0': {'clean': res['stratE'][base]['clean']}, 'H0nv': {'clean': pc}}}
        res['gates'][a] = gates.evaluate(g, {}, 'Live', a)
    if contention:
        res['contention'] = json.load(open(contention))
    json.dump(res, open(out, 'w'), indent=1, default=float)
    print('L4 saved silver WER', round(res['L4_saved_silver_WER'] * 100, 2))
    for ds in ('silver', 'silverE'):
        for a, A in res['tables'][ds].items():
            print(f"{ds:7s} {a:15s} WER {A['WER']*100:5.2f} [{A['WER_ci'][0]*100:.1f},{A['WER_ci'][1]*100:.1f}] S/D/I {A['SUB']*100:.1f}/{A['DEL']*100:.1f}/{A['INS']*100:.1f} n={A['windows']} entR {A['ent_recall']*100:.1f}")
    for a, c in res['comparisons'].items():
        w = c['WER']; p = res['pooled_entities'][a]
        print(f"{a:15s} rel vs turbo-raw {w['rel']*100:+.1f}% [{w['rel_ci'][0]*100:+.1f},{w['rel_ci'][1]*100:+.1f}] entR {p['recall']*100:.1f} (n={p['n_mentions']}) d {p['diff']['diff']*100:+.1f} [{p['diff']['ci'][0]*100:+.1f},{p['diff']['ci'][1]*100:+.1f}] entP {p['precision']*100:.1f} gates {'PASS' if res['gates'][a]['silver_qualified'] else 'fail: ' + ','.join(n for n, x in res['gates'][a]['checks'].items() if not x['passed'])}")
    for a in runs:
        print(a, 'E', res['stratE'][a], 'lat', {k: round(v, 3) if isinstance(v, float) else v for k, v in res['latency'][a].items()})


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
