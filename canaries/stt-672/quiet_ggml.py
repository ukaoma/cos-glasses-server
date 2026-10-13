"""Per-chunk ggml Silero v5.1.2 (the model whisper-server --vad loads) on canary-5 chunks:
all Silero-negative chunks plus a fixed random sample of speech chunks. Read-only."""
import json, random, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
rows = json.load(open('/Users/ukaoma/cos-data/asr-bakeoff/runs/qc_c/qc_c_chunks.json'))
src = Path.home() / '.cos-glasses/data/meeting-audio'
VM = str(Path.home() / '.local/share/whisper-models/ggml-silero-v5.1.2.bin')
present = [r for r in rows if (src / r['sid'] / r['chunk']).exists()]
neg = [r for r in present if r['q_silero']]; pos = [r for r in present if not r['q_silero']]
random.Random(7).shuffle(pos); sample = neg + pos[:1500]
def one(r):
    out = subprocess.run(['nice', '-n', '15', '/opt/homebrew/bin/whisper-vad-speech-segments', '-np', '-t', '1', '-vm', VM, '-vt', '0.5', '-f', str(src / r['sid'] / r['chunk'])], capture_output=True, text=True).stdout
    segs = [(float(a), float(b)) for a, b in re.findall(r'start = ([\d.]+), end = ([\d.]+)', out)]
    return r['sid'] + '/' + r['chunk'], sum(b - a for a, b in segs) / 100.0
with ThreadPoolExecutor(4) as ex:
    res = dict(ex.map(one, sample))
json.dump(res, open(sys.argv[1], 'w'))
for T in (0.5, 1.0):
    rn = sum(res[r['sid'] + '/' + r['chunk']] < T for r in neg) / len(neg)
    fp = sum(res[r['sid'] + '/' + r['chunk']] < T for r in pos[:1500]) / 1500
    print(T, round(rn, 3), round(fp, 4), len(neg))
