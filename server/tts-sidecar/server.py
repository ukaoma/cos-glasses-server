#!/usr/bin/env python3
"""COS Glasses local TTS sidecar — Kokoro-82M MLX.

OpenAI-shaped POST /v1/audio/speech + GET /health.
Owned by cos-glasses-server (port 8179).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Iterator

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

os.environ.setdefault("ESPEAK_DATA_PATH", "/opt/homebrew/share/espeak-ng-data")
os.environ.setdefault("PHONEMIZER_ESPEAK_PATH", "/opt/homebrew/bin/espeak-ng")

ENGINE = "kokoro"
PROTOCOL = "cos-tts-v1"
AUTH_TOKEN = os.environ.get("COS_TTS_AUTH_TOKEN", "")
MODEL_ID = os.environ.get("COS_TTS_KOKORO_MODEL", "mlx-community/Kokoro-82M-bf16")
DEFAULT_VOICE = os.environ.get("COS_TTS_KOKORO_VOICE", "am_echo")
SAMPLE_RATE = 24_000

_model = None
_lock = threading.Lock()
_ready = False
_load_error: str | None = None
_loaded_at: float | None = None

app = FastAPI(title="COS Local TTS", version="0.1.0")


class SpeechRequest(BaseModel):
    model: str = "tts-1"
    input: str = Field(..., min_length=1)
    voice: str = DEFAULT_VOICE
    response_format: str = "mp3"
    speed: float = 1.0
    # OpenAI instructions — accepted and ignored (no error).
    instructions: str | None = None


def _authorize(authorization: str | None) -> None:
    if not AUTH_TOKEN or authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


def _ensure_ffmpeg() -> None:
    from shutil import which

    if which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH — required for non-wav formats")


def _ensure_espeak() -> None:
    from shutil import which

    if which("espeak-ng") is None and which("espeak") is None:
        raise RuntimeError("espeak-ng not found — required for Kokoro G2P")


def load_model() -> None:
    global _model, _ready, _load_error, _loaded_at
    try:
        _ensure_ffmpeg()
        _ensure_espeak()
        from mlx_audio.tts.utils import load_model as mlx_load

        t0 = time.perf_counter()
        _model = mlx_load(MODEL_ID)
        # Warm preferred voice; fall back if missing.
        voice = DEFAULT_VOICE
        for candidate in (DEFAULT_VOICE, "am_echo", "am_michael", "af_heart"):
            try:
                list(_model.generate(text="Warmup.", voice=candidate, lang_code="a", speed=1.0))
                voice = candidate
                break
            except Exception:
                continue
        os.environ["COS_TTS_KOKORO_VOICE"] = voice
        _loaded_at = time.time()
        _ready = True
        _load_error = None
        print(f"[cos-tts] Kokoro ready voice={voice} model={MODEL_ID} cold={time.perf_counter() - t0:.2f}s")
    except Exception as e:
        _ready = False
        _load_error = str(e)
        print(f"[cos-tts] load failed: {e}")
        raise


def synthesize(text: str, voice: str, speed: float) -> np.ndarray:
    if _model is None:
        raise RuntimeError("model not loaded")
    requested = voice or DEFAULT_VOICE
    voices_to_try = [requested]
    fallback = os.environ.get("COS_TTS_KOKORO_VOICE", DEFAULT_VOICE)
    if fallback not in voices_to_try:
        voices_to_try.append(fallback)
    if "am_echo" not in voices_to_try:
        voices_to_try.append("am_echo")

    last_err: Exception | None = None
    for candidate in voices_to_try:
        pieces: list[np.ndarray] = []
        try:
            with _lock:
                for result in _model.generate(
                    text=text,
                    voice=candidate,
                    lang_code="a",
                    speed=float(speed) if speed else 1.0,
                ):
                    pieces.append(np.array(result.audio, dtype=np.float32))
            if not pieces:
                return np.zeros(1, dtype=np.float32)
            if candidate != requested:
                print(f"[cos-tts] voice {requested!r} missing; used {candidate!r}")
            return np.concatenate(pieces)
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"Kokoro voice failed for {requested!r}: {last_err}")


def encode_audio(audio: np.ndarray, fmt: str) -> tuple[bytes, str]:
    fmt = (fmt or "mp3").lower()
    mime = {
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "flac": "audio/flac",
        "opus": "audio/ogg",
        "aac": "audio/aac",
        "pcm": "audio/pcm",
    }.get(fmt)
    if mime is None:
        raise HTTPException(status_code=400, detail=f"unsupported response_format: {fmt}")

    if fmt == "pcm":
        pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()
        return pcm, mime

    with tempfile.TemporaryDirectory(prefix="cos-tts-") as tmp:
        wav_path = Path(tmp) / "out.wav"
        sf.write(str(wav_path), audio, SAMPLE_RATE)
        if fmt == "wav":
            return wav_path.read_bytes(), mime

        out_path = Path(tmp) / f"out.{fmt}"
        cmd = ["ffmpeg", "-y", "-i", str(wav_path)]
        if fmt == "mp3":
            cmd += ["-codec:a", "libmp3lame", "-q:a", "4"]
        elif fmt == "flac":
            cmd += ["-codec:a", "flac"]
        elif fmt == "opus":
            cmd += ["-codec:a", "libopus"]
        elif fmt == "aac":
            cmd += ["-codec:a", "aac"]
        cmd.append(str(out_path))
        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"ffmpeg encode failed: {proc.stderr.decode()[:300]}",
            )
        return out_path.read_bytes(), mime


@app.on_event("startup")
def _startup() -> None:
    load_model()


@app.get("/health")
def health(authorization: str | None = Header(default=None)):
    _authorize(authorization)
    return {
        "ready": _ready,
        "protocol": PROTOCOL,
        "engine": ENGINE,
        "model": MODEL_ID,
        "voice": os.environ.get("COS_TTS_KOKORO_VOICE", DEFAULT_VOICE),
        "ffmpeg": True,
        "espeak": True,
        "port": int(os.environ.get("COS_TTS_PORT", "8179")),
        "loaded_at": _loaded_at,
        "error": _load_error,
    }


@app.post("/v1/audio/speech")
def speech(req: SpeechRequest, authorization: str | None = Header(default=None)):
    _authorize(authorization)
    # instructions intentionally ignored for local path
    _ = req.instructions
    if not _ready or _model is None:
        raise HTTPException(status_code=503, detail=_load_error or "local TTS not ready")
    text = req.input.strip()
    if not text:
        raise HTTPException(status_code=400, detail="input is required")
    if len(text) > 4000:
        text = text[:4000]
    try:
        audio = synthesize(text, req.voice, req.speed)
        body, mime = encode_audio(audio, req.response_format)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)[:300]) from e
    return Response(content=body, media_type=mime)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8179)
    args = parser.parse_args()
    os.environ["COS_TTS_PORT"] = str(args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
