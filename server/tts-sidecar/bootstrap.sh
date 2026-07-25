#!/bin/bash
# Bootstrap pinned Cos Local TTS venv under ~/.local/share/cos-tts-models/.venv
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
MODEL_DIR="${COS_TTS_MODEL_DIR:-$HOME/.local/share/cos-tts-models}"
VENV="$MODEL_DIR/.venv"
PY="${COS_TTS_BOOTSTRAP_PYTHON:-}"

# The pinned stack has one strict intersection: numpy 2.4.6 requires 3.11+ and
# misaki 0.9.4 requires <3.13. Select by the interpreter's real version instead
# of trusting its filename so a newer `python3` alias cannot poison bootstrap.
python_minor() {
  "$1" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null
}

python_is_compatible() {
  local minor
  minor="$(python_minor "$1")" || return 1
  [[ "$minor" == "3.11" || "$minor" == "3.12" ]]
}

if [[ -n "$PY" ]]; then
  if [[ ! -x "$PY" ]] || ! python_is_compatible "$PY"; then
    PY_MINOR="$(python_minor "$PY" 2>/dev/null || echo unknown)"
    echo "[cos-tts] COS_TTS_BOOTSTRAP_PYTHON is Python $PY_MINOR; pinned Kokoro requires Python 3.11 or 3.12" >&2
    exit 2
  fi
else
  for candidate in python3.12 python3.11 python3; do
    candidate_path="$(command -v "$candidate" 2>/dev/null || true)"
    if [[ -n "$candidate_path" ]] && python_is_compatible "$candidate_path"; then
      PY="$candidate_path"
      break
    fi
  done
  if [[ -z "$PY" ]]; then
    echo "[cos-tts] compatible Python not found; install Python 3.12 with: brew install python@3.12" >&2
    exit 2
  fi
fi

mkdir -p "$MODEL_DIR"
if [[ -x "$VENV/bin/python" ]] && ! python_is_compatible "$VENV/bin/python"; then
  VENV_MINOR="$(python_minor "$VENV/bin/python" 2>/dev/null || echo unknown)"
  echo "[cos-tts] rebuilding incompatible Python $VENV_MINOR venv"
  rm -rf -- "$VENV"
elif [[ -d "$VENV" && ! -x "$VENV/bin/python" ]]; then
  echo "[cos-tts] rebuilding incomplete venv"
  rm -rf -- "$VENV"
fi
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "[cos-tts] creating venv at $VENV with $PY"
  "$PY" -m venv "$VENV"
fi
"$VENV/bin/pip" install --disable-pip-version-check 'pip==25.1.1' 'wheel==0.45.1'
"$VENV/bin/pip" install -r "$ROOT/requirements.txt"
echo "[cos-tts] bootstrap complete: $VENV/bin/python"
