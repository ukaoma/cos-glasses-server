// Test-only builders for Nemotron activity and audio. Not imported by server code.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NEMOTRON_CHANNELS } from '../nemotron-cli.js'
import { pcm16ToWav, type Activity } from '../nemotron-segments.js'

/** Activity where each [channel, startSec, endSec] span is active at probability p. */
export function activityOf(durationSec: number, spans: Array<[number, number, number]>, p = 0.9): Activity {
  const frames = Math.round(durationSec * 100) + 1
  const probs = new Float32Array(frames * NEMOTRON_CHANNELS).fill(0.02)
  for (const [channel, start, end] of spans) {
    for (let f = Math.round(start * 100); f < Math.min(frames, Math.round(end * 100)); f++) probs[f * NEMOTRON_CHANNELS + channel] = p
  }
  return { frames, probs }
}

/** A 16 kHz mono WAV whose samples carry `value(t)` so a fake voiceprint can tell voices apart. */
export function wavOf(durationSec: number, value: (sec: number) => number): Buffer {
  const n = Math.round(durationSec * 16_000)
  const pcm = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) pcm.writeInt16LE(value(i / 16_000), i * 2)
  return pcm16ToWav(pcm)
}

/** The fake voiceprint: names a WAV by the sign of its first sample. */
export function signVoiceprint(names: { positive: string; negative: string }, similarity = 0.8) {
  return (wav: Buffer): { speaker: string; similarity: number } | null => {
    if (wav.length < 46) return null
    return wav.readInt16LE(44) >= 0 ? { speaker: names.positive, similarity } : { speaker: names.negative, similarity }
  }
}

/** Preds bytes exactly as `--dump-preds` writes them. */
export function predsBytes(a: Activity): Buffer {
  const out = Buffer.alloc(a.probs.length * 4)
  for (let i = 0; i < a.probs.length; i++) out.writeFloatLE(a.probs[i], i * 4)
  return out
}

/** A home with an installed CLI file and a complete FluidAudio cache. Nothing in it runs. Caller removes it. */
export function fakeNemotronHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'nemotron-home-'))
  mkdirSync(join(home, '.cos-glasses', 'bin'), { recursive: true })
  writeFileSync(join(home, '.cos-glasses', 'bin', 'fluidaudiocli'), '')
  const cache = join(home, 'Library', 'Application Support', 'FluidAudio', 'Models', 'nemotron-3-diarization')
  mkdirSync(join(cache, 'monolithic', 'v2', 'Nemotron3Diarizer_fast32.mlmodelc'), { recursive: true })
  writeFileSync(join(cache, 'monolithic', 'v2', 'Nemotron3Diarizer_fast32.mlmodelc', 'coremldata.bin'), 'x')
  writeFileSync(join(cache, 'learnable_sil_emb.bin'), 'x')
  return home
}
