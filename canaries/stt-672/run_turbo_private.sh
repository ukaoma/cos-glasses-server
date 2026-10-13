#!/bin/zsh
# Private Turbo whisper-server on 18377 with the exact meeting-preview sidecar args, for the
# preview-lane baseline. Never touches the user's 8177/8178. Stopped by PID when done.
set -u
E=/Users/ukaoma/cos-data/stt-672-eval
M=$HOME/.local/share/whisper-models
/opt/homebrew/bin/whisper-server -m $M/ggml-large-v3-turbo.bin -t 16 -l en -fa --no-speech-thold 0.7 --host 127.0.0.1 --port 18377 --vad --vad-model $M/ggml-silero-v5.1.2.bin > $E/runs/private_turbo.log 2>&1 &
SRV=$!
echo "private turbo pid $SRV"
until curl -s -m 1 http://127.0.0.1:18377/health | grep -q ok; do sleep 1; if ! kill -0 $SRV 2>/dev/null; then echo "server died"; exit 1; fi; done
# Scope while a recording may be live: turbo-raw needs SILVER-E and stratum E only (SILVER uses
# the saved bake-off L4 arm, same server args); turbo-hp runs everywhere. Paced to keep GPU duty low.
PRIVATE_TURBO_PORT=18377 python3 canaries/stt-672/run_preview.py turbo-raw silverE,stratE ${PACE:-0.6} > $E/runs/preview_turbo-raw.log 2>&1
PRIVATE_TURBO_PORT=18377 python3 canaries/stt-672/run_preview.py turbo-hp silver,stratE,silverE ${PACE:-0.6} > $E/runs/preview_turbo-hp.log 2>&1
kill $SRV; wait $SRV 2>/dev/null; echo "private turbo stopped"
