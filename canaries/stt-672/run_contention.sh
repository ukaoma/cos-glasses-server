#!/bin/zsh
# Private Large-v3 whisper-server on 18278 (live commit args) + shipped diarizer + Parakeet preview.
set -u
E=${STT672_EVAL_DIR:-$HOME/cos-data/stt-672-eval}
M=$HOME/.local/share/whisper-models
if [ -n "$(ls $HOME/.cos-glasses/data/active-sessions 2>/dev/null)" ]; then echo "recording live; refusing"; exit 3; fi
/opt/homebrew/bin/whisper-server -m $M/ggml-large-v3.bin -t 16 -l en -fa --no-speech-thold 0.7 --host 127.0.0.1 --port 18278 --vad --vad-model $M/ggml-silero-v5.1.2.bin > $E/runs/private_live.log 2>&1 &
SRV=$!
until curl -s -m 1 http://127.0.0.1:18278/health | grep -q ok; do sleep 1; if ! kill -0 $SRV 2>/dev/null; then echo "server died"; exit 1; fi; done
mkdir -p $E/contention-home
for model in parakeet-v2 parakeet-ultra; do
  HOME=$E/contention-home COS_DATA_DIR=$E/data PRIVATE_LIVE_PORT=18278 CHUNKS=$E/contention_chunks.json PREVIEW_MODEL=$model \
    DIAR_CLI=$E/data/stt/parakeet/current/bin/fluidaudiocli DIAR_MODELS=$E/diarizer-models \
    node --import tsx/esm canaries/stt-672/contention.mts > $E/runs/contention_$model.json 2> $E/runs/contention_$model.err
  echo "$model exit $?"
done
kill $SRV; wait $SRV 2>/dev/null; echo "private live stopped"
