// Preview-lane decodes through the SHIPPED code: Parakeet via transcribeParakeet (preview
// lane, 1.5 s deadline, highpass front end via asrFrontEnd) and Whisper Turbo against a
// PRIVATE whisper-server (never the user's 8177/8178). One JSON line in, one out.
// stdin {id, wav, arm: parakeet-v2|parakeet-ultra|turbo-hp|turbo-raw}
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { asrFrontEnd } from '../../server/lib/stt-live.js'
import { transcribeParakeet } from '../../server/lib/parakeet.js'
import { PARAKEET_PREVIEW_TIMEOUT_MS } from '../../server/lib/stt-runtime.js'

const PORT = Number(process.env.PRIVATE_TURBO_PORT ?? 0)
if ([8177, 8178, 3141, 3143].includes(PORT)) throw new Error('refusing a live port')
async function turbo(audio: Buffer): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'recording.wav')
  form.append('response_format', 'json')
  form.append('suppress_non_speech', 'true')
  const res = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(5_000) })
  if (!res.ok) throw new Error(`private turbo ${res.status}`)
  const j = await res.json() as { text?: string }
  return String(j.text ?? '').trim()
}
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  if (!line.trim()) continue
  const job = JSON.parse(line)
  const raw = readFileSync(job.wav)
  const t0 = performance.now()
  try {
    const input = job.arm === 'turbo-raw' ? raw : await asrFrontEnd(raw, 'highpass')
    const feMs = performance.now() - t0
    if (job.arm.startsWith('parakeet')) {
      const r = await transcribeParakeet(input, { model: job.arm, lane: 'preview', timeoutMs: PARAKEET_PREVIEW_TIMEOUT_MS })
      process.stdout.write(JSON.stringify({ id: job.id, arm: job.arm, text: r.text, words: r.words, ms: performance.now() - t0, feMs, procSec: r.processingSec }) + '\n')
    } else {
      const text = await turbo(input)
      process.stdout.write(JSON.stringify({ id: job.id, arm: job.arm, text, ms: performance.now() - t0, feMs }) + '\n')
    }
  } catch (e: any) {
    process.stdout.write(JSON.stringify({ id: job.id, arm: job.arm, error: String(e?.reason ?? e).slice(0, 200), ms: performance.now() - t0 }) + '\n')
  }
}
