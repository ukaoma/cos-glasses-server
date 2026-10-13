"""HQ evaluation for 6.72.0: resolver and Parakeet-as-primary on the bake-off silver
corpus (39 windows), SILVER-E (110) and stratum E, scored with the bake-off scorer and
qualified with the bake-off gates (canaries/gates.py). Numbers only leave this script.

The resolver arms run the SHIPPED TypeScript resolver through resolve-batch.ts.
Baselines can be swapped: gates.evaluate always compares against 'H0', so each
comparison is built with the chosen baseline under that key.

Usage: venv/bin/python evaluate_hq.py --out results.json [--timed-dir DIR]
"""
import argparse, json, os, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path('/Users/ukaoma/cos-data/asr-bakeoff')
GATES = Path('/Users/ukaoma/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff/operations/personal/wk41_2026/asr-bakeoff/canaries')
HERE = Path(__file__).resolve().parent
WORKTREE = HERE.parent.parent
sys.path.insert(0, str(ROOT / 'scripts')); sys.path.insert(0, str(GATES))
import score, bk, gates  # noqa: E402

REPS = 4000


def load(ds, arm, base=ROOT / 'runs'):
    d = base / ds / arm
    out = {}
    for f in d.glob('*.json'):
        if f.name == 'RECEIPT.json':
            continue
        j = json.load(open(f)); out[j['id']] = j
    return out


def pk_words(run):
    """Parakeet saved word timings (window clock) as resolver words."""
    words = []
    for u in run['units']:
        for w in u.get('words') or []:
            words.append({'word': w[0], 'start': float(w[1]), 'end': float(w[2]), 'probability': float(w[3]) if w[3] is not None else None})
    return words


def run_resolver(jobs):
    """Pipe jobs through the shipped resolver. Fails loudly on any count mismatch."""
    env = dict(os.environ, COS_PROFILE_PATH=str(ROOT / 'tmp/profile/.cos-profile.json'))
    scratch = tempfile.mkdtemp(prefix='stt672-eval-')
    env.update(COS_DATA_DIR=scratch, HOME=scratch)
    inp = '\n'.join(json.dumps(j) for j in jobs) + '\n'
    p = subprocess.run(['node', '--import', 'tsx/esm', str(HERE / 'resolve-batch.ts')], input=inp, capture_output=True,
                       text=True, env=env, cwd=str(WORKTREE))
    rows = [json.loads(x) for x in p.stdout.splitlines() if x.startswith('{')]
    if p.returncode != 0 or len(rows) != len(jobs):
        raise RuntimeError(f'resolver bridge failed rc={p.returncode} rows={len(rows)}/{len(jobs)}: {p.stderr[-800:]}')
    return {r['id']: r for r in rows}


def corrected_parakeet(runs):
    """Same deterministic name corrections production applies to every engine."""
    ids = sorted(runs)
    out = run_resolver([{'id': i, 'onlyCorrect': True, 'correctSecond': True,
                         'second': {'engine': 'parakeet', 'text': runs[i]['text'], 'words': pk_words(runs[i])}} for i in ids])
    return {i: {'text': out[i]['text'], 'words': out[i]['words'] or []} for i in ids}


def build_arms(ds, timed=None):
    H0ts = load(ds, 'H0ts'); U = load(ds, 'H3u'); V2 = load(ds, 'H3v2')
    ids = sorted(set(H0ts) & set(U) & set(V2))
    Uc = corrected_parakeet({i: U[i] for i in ids}); V2c = corrected_parakeet({i: V2[i] for i in ids})
    arms = {'LV3': {i: H0ts[i]['text'] for i in ids}, 'PKU_raw': {i: U[i]['text'] for i in ids}, 'PKV2_raw': {i: V2[i]['text'] for i in ids},
            'PKU': {i: Uc[i]['text'] for i in ids}, 'PKV2': {i: V2c[i]['text'] for i in ids}}

    def lv3(i):
        t = (timed or {}).get(i)
        return {'engine': 'large-v3', 'text': t['text'], 'words': t['words']} if t else {'engine': 'large-v3', 'text': H0ts[i]['text']}

    def pk(engine, C, i):
        return {'engine': engine, 'text': C[i]['text'], 'words': C[i]['words']}
    plans = {
        'RES_LV3_PKU': lambda i: (lv3(i), pk('parakeet-ultra', Uc, i)),
        'RES_LV3_PKV2': lambda i: (lv3(i), pk('parakeet-v2', V2c, i)),
        'RES_PKU_LV3': lambda i: (pk('parakeet-ultra', Uc, i), lv3(i)),
    }
    stats = {}
    for name, make in plans.items():
        jobs = []
        for i in ids:
            pri, sec = make(i)
            jobs.append({'id': i, 'primary': pri, 'second': sec})
        out = run_resolver(jobs)
        arms[name] = {i: out[i]['text'] for i in ids}
        stats[name] = {
            'windows': len(ids),
            'disagreements': sum(out[i]['disagreements'] for i in ids),
            'words_from_second': sum(out[i]['wordsFromSecond'] for i in ids),
            'timed_primary_windows': sum(1 for i in ids if (timed or {}).get(i)),
            'by_reason': {k: sum(out[i]['byReason'].get(k, 0) for i in ids) for k in ('gap_fill', 'vocabulary', 'protected', 'kept')},
        }
    return ids, arms, stats


def compute_rtf(ds, arm_parts):
    comp = 0.0; audio = 0.0
    for part in arm_parts:
        runs = load(ds, part)
        for r in runs.values():
            for u in r['units']:
                c = u.get('proc_s') if u.get('proc_s') is not None else u.get('wall', 0) + u.get('fe_s', 0)
                comp += c or 0
    S = json.load(open(ROOT / f'refs/{ds}_set.json'))['windows']
    audio = sum(w.get('dur') or 0 for w in S)
    return comp / audio if audio else None


def collapsed(ref_by_id, arm):
    n = 0
    for i, t in arm.items():
        r = len(score.norm(ref_by_id[i]).split()); h = len(score.norm(t).split())
        if r and h < 0.5 * r:
            n += 1
    return n


def stratE_arm(name, parts):
    """Stratum E any-output share. Resolver arms resolve the two saved E outputs."""
    E = json.load(open(ROOT / 'refs/stratE_set.json'))['windows']
    vocab_norm = [tuple(score.norm(v).split()) for v in bk.vocab_terms()]
    if len(parts) == 1:
        runs = load('stratE', parts[0]); texts = {i: r['text'] for i, r in runs.items()}
    else:
        pe, pa, se, sa = parts
        A = load('stratE', pa); B = load('stratE', sa); ids = sorted(set(A) & set(B))
        def side(engine, R):
            if engine.startswith('parakeet'):
                C = corrected_parakeet({i: R[i] for i in ids})
                return lambda i: {'engine': engine, 'text': C[i]['text'], 'words': C[i]['words']}
            return lambda i: {'engine': engine, 'text': R[i]['text']}
        fp = side(pe, A); fs = side(se, B)
        jobs = [{'id': i, 'primary': fp(i), 'second': fs(i)} for i in ids]
        out = run_resolver(jobs); texts = {i: out[i]['text'] for i in ids}
    res = {}
    for kind in ('clean', 'real', 'all'):
        ids = [u['id'] for u in E if u['id'] in texts and (kind == 'all' or (kind == 'clean' and u['kind'] in ('tone', 'music')) or u['kind'] == kind)]
        anyout = sum(1 for i in ids if score.norm(texts[i]).split())
        echo = sum(1 for i in ids if any(' ' + ' '.join(v) + ' ' in ' ' + score.norm(texts[i]) + ' ' for v in vocab_norm))
        res[kind] = {'units': len(ids), 'any_output_share': anyout / len(ids) if ids else None, 'vocab_echo_units': echo}
    return res


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--out', required=True); ap.add_argument('--timed-dir')
    a = ap.parse_args()
    timed = {}
    if a.timed_dir:
        for ds in ('silver', 'silverE'):
            d = Path(a.timed_dir) / ds
            timed[ds] = {json.load(open(f))['id']: json.load(open(f)) for f in d.glob('*.json')} if d.exists() else {}
    rows = {}; tables = {}; stats = {}; meta = {}
    for ds in ('silver', 'silverE'):
        S = json.load(open(ROOT / f'refs/{ds}_set.json'))['windows']
        ids, arms, st = build_arms(ds, timed.get(ds))
        ref = {w['id']: w['ref'] for w in S}; blk = {w['id']: w['sid'] for w in S}
        order = [w['id'] for w in S if w['id'] in ids]
        rows[ds] = {name: [score.score_pair(ref[i], arm[i]) for i in order] for name, arm in arms.items()}
        meta[ds] = {'ids': order, 'blocks': [blk[i] for i in order]}
        tables[ds] = {}
        for name, R in rows[ds].items():
            A = score.agg(R); A['windows'] = len(order); A['complete'] = len(order) == len(S)
            A['WER_ci'] = score.bootstrap_ci(R, meta[ds]['blocks'], 'WER', reps=REPS)
            A['collapsed_windows'] = collapsed(ref, {i: arms[name][i] for i in order})
            tables[ds][name] = A
        stats[ds] = st
    # Paired comparisons vs two baselines, silver WER and pooled entities.
    comps = {}; pooled = {}
    arms = list(rows['silver'])
    for base in ('LV3', 'PKU'):
        for arm in arms:
            if arm == base:
                continue
            c = {'n_windows': len(meta['silver']['ids']), 'n_meetings': len(set(meta['silver']['blocks']))}
            for m in ('WER', 'DEL', 'INS', 'SUB'):
                c[m] = score.bootstrap_diff(rows['silver'][base], rows['silver'][arm], meta['silver']['blocks'], m, reps=REPS)
            cE = {m: score.bootstrap_diff(rows['silverE'][base], rows['silverE'][arm], meta['silverE']['blocks'], m, reps=REPS) for m in ('WER',)}
            c['silverE_WER'] = cE['WER']
            comps[f'{base}->{arm}'] = c
            ra = rows['silver'][base] + rows['silverE'][base]; rb = rows['silver'][arm] + rows['silverE'][arm]
            bl = meta['silver']['blocks'] + meta['silverE']['blocks']
            A = score.agg(rb)
            pooled[f'{base}->{arm}'] = {'n_mentions': A['ent_ref'], 'recall': A['ent_recall'], 'precision': A['ent_precision'],
                                        'recall_ci': score.bootstrap_ci(rb, bl, 'ent_recall', reps=REPS),
                                        'diff': score.bootstrap_diff(ra, rb, bl, 'ent_recall', reps=REPS)}
    E = {'LV3': stratE_arm('LV3', ['H0ts']), 'PKU': stratE_arm('PKU', ['H3u']), 'PKV2': stratE_arm('PKV2', ['H3v2']),
         'RES_LV3_PKU': stratE_arm('RES_LV3_PKU', ['large-v3', 'H0ts', 'parakeet-ultra', 'H3u']),
         'RES_LV3_PKV2': stratE_arm('RES_LV3_PKV2', ['large-v3', 'H0ts', 'parakeet-v2', 'H3v2']),
         'RES_PKU_LV3': stratE_arm('RES_PKU_LV3', ['parakeet-ultra', 'H3u', 'large-v3', 'H0ts']),
         'H0nv': stratE_arm('H0nv', ['H0nv'])}
    rtf = {'LV3': compute_rtf('silver', ['H0ts']), 'PKU': compute_rtf('silver', ['H3u']), 'PKV2': compute_rtf('silver', ['H3v2'])}
    rtf.update({'RES_LV3_PKU': rtf['LV3'] + rtf['PKU'], 'RES_LV3_PKV2': rtf['LV3'] + rtf['PKV2'], 'RES_PKU_LV3': rtf['LV3'] + rtf['PKU'],
                'PKU_raw': rtf['PKU'], 'PKV2_raw': rtf['PKV2']})
    verdicts = {}
    for base in ('LV3', 'PKU'):
        for arm in arms:
            if arm == base:
                continue
            row = dict(tables['silver'][arm]); row['latency'] = {'rtf': rtf.get(arm)}
            res = {'silver_table': {arm: row}, 'comparisons': {f'HQ:{arm}': comps[f'{base}->{arm}']},
                   'pooled_entities': {f'HQ:{arm}': pooled[f'{base}->{arm}']},
                   'stratE': {arm: {'clean': E.get(arm, E.get(arm.replace('_raw', ''), {})).get('clean', {})},
                              'H0': {'clean': E[base]['clean']}, 'H0nv': {'clean': E['H0nv']['clean']}}}
            verdicts[f'{base}->{arm}'] = gates.evaluate(res, {}, 'HQ', arm)
    json.dump({'tables': tables, 'comparisons': comps, 'pooled_entities': pooled, 'stratE': E, 'rtf': rtf,
               'resolver_stats': stats, 'gates': verdicts, 'timed_primary': bool(a.timed_dir), 'reps': REPS},
              open(a.out, 'w'), indent=1, default=float)
    for ds in ('silver', 'silverE'):
        for name, A in tables[ds].items():
            print(f"{ds:7s} {name:13s} WER {A['WER']*100:5.2f} [{A['WER_ci'][0]*100:.1f},{A['WER_ci'][1]*100:.1f}] S/D/I {A['SUB']*100:.1f}/{A['DEL']*100:.1f}/{A['INS']*100:.1f} entR {A['ent_recall']*100:.1f} entP {A['ent_precision']*100:.1f} collapsed {A['collapsed_windows']}")
    for k, c in comps.items():
        w = c['WER']; p = pooled[k]['diff']
        print(f"{k:22s} rel {w['rel']*100:+.1f}% [{w['rel_ci'][0]*100:+.1f},{w['rel_ci'][1]*100:+.1f}] silverE rel {c['silverE_WER']['rel']*100:+.1f}% [{c['silverE_WER']['rel_ci'][0]*100:+.1f},{c['silverE_WER']['rel_ci'][1]*100:+.1f}] entR d {p['diff']*100:+.1f} [{p['ci'][0]*100:+.1f},{p['ci'][1]*100:+.1f}] entP {pooled[k]['precision']*100:.1f} gates {'PASS' if verdicts[k]['silver_qualified'] else 'fail: ' + ','.join(n for n, x in verdicts[k]['checks'].items() if not x['passed'])}")
    for k, v in E.items():
        print('E', k, v['clean'])
    print('stats', json.dumps(stats))


if __name__ == '__main__':
    main()
