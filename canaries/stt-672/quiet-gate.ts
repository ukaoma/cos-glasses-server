// Canary 5 for the SHIPPED quiet gate (server/lib/stt-live.ts decideQuiet).
// stdin: JSONL {key, path}; stdout: JSONL {key, isQuiet, speechSec, gate, rms, ms}.
// Read-only over the audio. Needs a scratch COS_DATA_DIR.
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { initSileroVAD } from '../../server/lib/vad-silero.js'
import { decideQuiet } from '../../server/lib/stt-live.js'

if (!initSileroVAD()) { console.error('Silero VAD did not initialise'); process.exit(2) }
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  if (!line.trim()) continue
  const job = JSON.parse(line)
  let wav: Buffer
  try { wav = readFileSync(job.path) } catch { process.stdout.write(JSON.stringify({ key: job.key, missing: true }) + '\n'); continue }
  const t0 = performance.now()
  const silero = decideQuiet(wav, 'silero')
  const ms = performance.now() - t0
  const rms = decideQuiet(wav, 'rms')
  process.stdout.write(JSON.stringify({ key: job.key, isQuiet: silero.isQuiet, speechSec: silero.speechSec, gate: silero.gate, rmsQuiet: rms.isQuiet, rms: Math.round(silero.rms), ms: Math.round(ms * 10) / 10 }) + '\n')
}
