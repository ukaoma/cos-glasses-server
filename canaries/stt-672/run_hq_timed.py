"""Re-decode the HQ lane through the SHIPPED large-v3 path (timestamps + VAD remap, highpass
front end, the production prompt and corrections from the bake-off profile snapshot), so the
resolver can be evaluated with real primary word clocks. Windows are decoded in order with the
previous window's text as context and stripOverlap applied, as meeting HQ does.
Refuses to run while a real recording is live (decode.mts guard). Outputs stay private."""
import json, os, subprocess, sys
import os
from pathlib import Path
ROOT = Path(os.environ.get('ASR_BAKEOFF_ROOT', str(Path.home() / 'cos-data/asr-bakeoff'))); EVAL = Path(os.environ.get('STT672_EVAL_DIR', str(Path.home() / 'cos-data/stt-672-eval')))
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'scripts'))
import bk  # stripOverlap replica used by the bake-off H0 arms

def main(sets):
    env = dict(os.environ, COS_DATA_DIR=str(EVAL / 'data'), COS_PROFILE_PATH=str(ROOT / 'tmp/profile/.cos-profile.json'),
               REAL_ACTIVE_DIR=str(Path.home() / '.cos-glasses/data/active-sessions'),
               # Same production code path; Metal is its opt-in device (COS_BATCH_HQ_METAL=1), as in the bake-off H0ts arm.
               COS_BATCH_HQ_METAL=os.environ.get('COS_BATCH_HQ_METAL', '1'))
    p = subprocess.Popen(['nice', '-n', '10', 'node', '--import', 'tsx/esm', str(HERE / 'decode.mts')], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         text=True, env=env, cwd=str(HERE.parent.parent), bufsize=1)
    for ds in sets:
        od = EVAL / 'runs' / 'hq_timed' / ds; od.mkdir(parents=True, exist_ok=True)
        for w in json.load(open(ROOT / f'refs/{ds}_set.json'))['windows']:
            of = od / f"{w['id']}.json"
            if of.exists():
                continue
            texts, words, units, prev, offset = [], [], [], None, 0.0
            for sub in w['hq_subs']:
                job = {'id': f"{w['id']}|{sub['k']}", 'wav': str(ROOT / sub['file']), 'engine': 'large-v3', 'frontEnd': 'highpass', 'context': (prev or '')[-250:] or None}
                p.stdin.write(json.dumps(job) + '\n'); p.stdin.flush()
                while True:
                    line = p.stdout.readline()
                    if not line: raise SystemExit('decoder stopped (a recording may have started)')
                    if line.startswith('{'): r = json.loads(line); break
                if 'error' in r: raise SystemExit(f"decode failed {job['id']}: {r['error']}")
                t = bk.strip_overlap(r['text'], prev) if prev and hasattr(bk, 'strip_overlap') else r['text']
                texts.append(t); prev = r['text'] if not t else t
                words += [dict(x, start=x['start'] + offset, end=x['end'] + offset) for x in r['words']]
                units.append({'k': sub['k'], 'wallMs': r['wallMs'], 'dur': sub['dur'], 'timestamps': r.get('timestamps'), 'words': len(r['words'])})
                offset += sub['dur']
            json.dump({'id': w['id'], 'text': ' '.join(x for x in texts if x), 'words': words, 'units': units}, open(of, 'w'))
            print(ds, w['id'], 'done', flush=True)
    p.stdin.close(); p.wait()

if __name__ == '__main__':
    main(sys.argv[1].split(','))
