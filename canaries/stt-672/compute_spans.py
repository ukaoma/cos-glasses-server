"""Speech spans for the resolver's gap-fill gate, as the primary's own VAD sees them: ggml Silero
v5.1.2 (the model whisper-cli --vad loads, its default thresholds) over each HQ window after the
highpass front end. Window clock: sub-window offsets accumulate as in run_hq_timed.py."""
import json, re, subprocess, sys, tempfile
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
ROOT = Path(os.environ.get('ASR_BAKEOFF_ROOT', str(Path.home() / 'cos-data/asr-bakeoff'))); EVAL = Path(os.environ.get('STT672_EVAL_DIR', str(Path.home() / 'cos-data/stt-672-eval')))
VM = str(Path.home() / '.local/share/whisper-models/ggml-silero-v5.1.2.bin')
tmp = Path(tempfile.mkdtemp(prefix='stt672-spans-'))

def spans(wav):
    hp = tmp / (Path(wav).parent.name + '_' + Path(wav).name)
    subprocess.run(['nice', '-n', '15', 'ffmpeg', '-loglevel', 'error', '-y', '-i', wav, '-af', 'highpass=f=80', '-ar', '16000', '-ac', '1', str(hp)], check=True)
    out = subprocess.run(['nice', '-n', '15', '/opt/homebrew/bin/whisper-vad-speech-segments', '-np', '-t', '2', '-vm', VM, '-f', str(hp)], capture_output=True, text=True).stdout
    hp.unlink()
    return [(float(a) / 100, float(b) / 100) for a, b in re.findall(r'start = ([\d.]+), end = ([\d.]+)', out)]

def window(ds_w):
    ds, w = ds_w
    off = 0.0; out = []
    for sub in w['hq_subs']:
        out += [(a + off, b + off) for a, b in spans(str(ROOT / sub['file']))]
        off += sub['dur']
    return ds, w['id'], out

jobs = [(ds, w) for ds in sys.argv[1].split(',') for w in json.load(open(ROOT / f'refs/{ds}_set.json'))['windows']]
with ThreadPoolExecutor(3) as ex:
    res = list(ex.map(window, jobs))
outd = {}
for ds, i, sp in res:
    outd.setdefault(ds, {})[i] = sp
json.dump(outd, open(EVAL / 'runs' / 'speech_spans.json', 'w'))
print({ds: len(v) for ds, v in outd.items()})
