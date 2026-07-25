#!/bin/bash
# Bootstrap pinned Cos Local TTS venv under ~/.local/share/cos-tts-models/.venv
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
MODEL_DIR="${COS_TTS_MODEL_DIR:-$HOME/.local/share/cos-tts-models}"
VENV="$MODEL_DIR/.venv"
PY="${COS_TTS_BOOTSTRAP_PYTHON:-}"
if [[ -z "$PY" ]]; then
  if command -v python3.13 >/dev/null 2>&1; then PY="$(command -v python3.13)"
  elif command -v python3.12 >/dev/null 2>&1; then PY="$(command -v python3.12)"
  elif command -v python3.11 >/dev/null 2>&1; then PY="$(command -v python3.11)"
  elif command -v python3 >/dev/null 2>&1; then PY="$(command -v python3)"
  else
    echo "[cos-tts] Python 3.11-3.13 is required for local Kokoro" >&2
    exit 2
  fi
fi
PY_MINOR="$($PY -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
case "$PY_MINOR" in
  3.11|3.12|3.13) ;;
  *)
    echo "[cos-tts] unsupported Python $PY_MINOR; install Python 3.11, 3.12, or 3.13" >&2
    exit 2
    ;;
esac
mkdir -p "$MODEL_DIR"
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "[cos-tts] creating venv at $VENV with $PY"
  "$PY" -m venv "$VENV"
fi
"$VENV/bin/pip" install --disable-pip-version-check 'pip==25.1.1' 'wheel==0.45.1'
"$VENV/bin/pip" install -r "$ROOT/requirements.txt"
echo "[cos-tts] bootstrap complete: $VENV/bin/python"
