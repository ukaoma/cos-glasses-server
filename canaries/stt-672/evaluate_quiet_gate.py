"""Canary 5: quiet gate on the bake-off 14,622-chunk table (qc_c_chunks.json).

Labels come from the bake-off: Silero v5.1.2 (threshold 0.5) over each concatenated
session, chunk speech seconds < 0.5 means "Silero-negative". The candidate is the
SHIPPED gate (decideQuiet in stt-live.ts, the in-process sherpa Silero per chunk),
run through quiet-gate.ts on the chunk WAVs that still exist on disk (read-only).
Pass: fires on >= 80% of Silero-negative chunks and <= 2% of speech chunks; RMS-150
must fail (it is the 'must catch' control). Numbers only.
"""
import json, os, subprocess, sys, tempfile
import os
from pathlib import Path

ROOT = Path(os.environ.get('ASR_BAKEOFF_ROOT', str(Path.home() / 'cos-data/asr-bakeoff')))
SRC = Path.home() / '.cos-glasses/data/meeting-audio'
HERE = Path(__file__).resolve().parent


def wilson(k, n, z=1.96):
    if not n:
        return (None, None)
    p = k / n; den = 1 + z * z / n; c = (p + z * z / (2 * n)) / den
    h = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / den
    return (max(0.0, c - h), min(1.0, c + h))


def main(out):
    rows = json.load(open(ROOT / 'runs/qc_c/qc_c_chunks.json'))
    jobs = [{'key': f"{r['sid']}/{r['chunk']}", 'path': str(SRC / r['sid'] / r['chunk'])} for r in rows]
    scratch = tempfile.mkdtemp(prefix='stt672-quiet-')
    env = dict(os.environ, COS_DATA_DIR=scratch, HOME=scratch, COS_PROFILE_PATH=str(Path(scratch) / 'p.json'))
    p = subprocess.run(['nice', '-n', '10', 'node', '--import', 'tsx/esm', str(HERE / 'quiet-gate.ts')],
                       input='\n'.join(json.dumps(j) for j in jobs) + '\n', capture_output=True, text=True, env=env, cwd=str(HERE.parent.parent))
    res = {}
    for line in p.stdout.splitlines():
        if line.startswith('{'):
            d = json.loads(line); res[d['key']] = d
    if p.returncode != 0 or len(res) != len(jobs):
        raise SystemExit(f'gate bridge failed rc={p.returncode} {len(res)}/{len(jobs)} {p.stderr[-500:]}')
    present = [r for r in rows if not res[f"{r['sid']}/{r['chunk']}"].get('missing')]
    neg = [r for r in present if r['q_silero']]; pos = [r for r in present if not r['q_silero']]
    def rate(sel, field):
        k = sum(1 for r in sel if res[f"{r['sid']}/{r['chunk']}"][field]); return k, len(sel)
    out_d = {'table_chunks': len(rows), 'chunks_on_disk': len(present), 'sessions_on_disk': len({r['sid'] for r in present}),
             'silero_negative': len(neg), 'speech': len(pos)}
    for name, field in (('silero_gate', 'isQuiet'), ('rms150_gate', 'rmsQuiet')):
        kn, nn = rate(neg, field); kp, np_ = rate(pos, field)
        out_d[name] = {'fires_on_nonspeech': kn / nn if nn else None, 'fires_on_nonspeech_ci': wilson(kn, nn),
                       'false_fire_on_speech': kp / np_ if np_ else None, 'false_fire_on_speech_ci': wilson(kp, np_),
                       'passes_canary_5': bool(nn and np_ and kn / nn >= 0.8 and kp / np_ <= 0.02)}
    ms = sorted(res[f"{r['sid']}/{r['chunk']}"]['ms'] for r in present)
    out_d['gate_ms_p50'] = ms[len(ms) // 2]; out_d['gate_ms_p95'] = ms[int(len(ms) * 0.95)]
    out_d['fallback_rms_chunks'] = sum(1 for r in present if res[f"{r['sid']}/{r['chunk']}"]['gate'] != 'silero')
    json.dump(out_d, open(out, 'w'), indent=1)
    print(json.dumps(out_d, indent=1))


if __name__ == '__main__':
    main(sys.argv[1])
