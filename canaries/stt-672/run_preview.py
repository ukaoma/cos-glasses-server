"""Drive preview-run.mts over silver / SILVER-E / stratum E chunks with a live-recording guard.
Writes raw outputs (transcript text) ONLY to the private eval dir. Numbers come from evaluate_preview.py."""
import json, os, subprocess, sys, time, urllib.request
from pathlib import Path
ROOT = Path('/Users/ukaoma/cos-data/asr-bakeoff'); EVAL = Path('/Users/ukaoma/cos-data/stt-672-eval')
HERE = Path(__file__).resolve().parent

def diarizer_timeouts():
    """Live-impact signal from the user's public health: diarizer timeouts plus live Whisper failures."""
    try:
        d = json.load(urllib.request.urlopen('http://127.0.0.1:3141/api/health', timeout=3))
        return d['readiness']['diarizer']['chunks']['reasons'].get('timeout', 0) + 100 * d['whisper_health'].get('consecutiveFailures', 0)
    except Exception:
        return None

def main(arm, sets, pace):
    out = EVAL / 'runs' / f'preview_{arm}.jsonl'
    done = set()
    if out.exists():
        for l in open(out):
            if l.startswith('{'):
                d = json.loads(l)
                if 'error' not in d: done.add(d['id'])
    jobs = []
    for ds in sets:
        W = json.load(open(ROOT / f'refs/{ds}_set.json'))['windows']
        for w in W:
            for c in w['chunks']:
                jid = f"{ds}|{w['id']}|{c['idx']}"
                if jid not in done: jobs.append({'id': jid, 'wav': str(ROOT / c['file']), 'arm': arm})
    print(arm, 'jobs', len(jobs), 'already', len(done), flush=True)
    env = dict(os.environ, COS_DATA_DIR=str(EVAL / 'data'), COS_PROFILE_PATH=str(ROOT / 'tmp/profile/.cos-profile.json'))
    p = subprocess.Popen(['nice', '-n', '5', 'node', '--import', 'tsx/esm', str(HERE / 'preview-run.mts')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env, cwd=str(HERE.parent.parent), bufsize=1)
    base = diarizer_timeouts(); paused = 0
    with open(out, 'a') as f:
        for i, j in enumerate(jobs):
            if i % 25 == 0:
                t = diarizer_timeouts()
                if base is not None and t is not None and t > base:
                    print(f'live diarizer timeouts rose {base}->{t}; pausing 120 s and doubling pace', flush=True)
                    time.sleep(120); pace = min(pace * 2, 4.0); base = t; paused += 1
            p.stdin.write(json.dumps(j) + '\n'); p.stdin.flush()
            while True:
                line = p.stdout.readline()
                if not line: raise SystemExit('runner died')
                if line.startswith('{'): f.write(line); f.flush(); break
            time.sleep(pace)
    p.stdin.close(); p.wait()
    print(arm, 'finished; pauses', paused, 'diarizer timeouts', base, '->', diarizer_timeouts(), flush=True)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2].split(','), float(sys.argv[3]) if len(sys.argv) > 3 else 0.3)
