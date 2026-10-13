// Offline decode through the SHIPPED code paths (evaluation only, never the live server).
// stdin JSONL {id, wav, engine: large-v3|parakeet-ultra|parakeet-v2, frontEnd: highpass|full|raw, context?, lane?}
// stdout JSONL {id, engine, text, words, wallMs, feMs, error?}
// Refuses to start while a real recording is live unless ALLOW_LIVE=1 (low duty cycle runs only).
import { readFileSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { asrFrontEnd } from '../../server/lib/stt-live.js'
import { transcribeParakeet } from '../../server/lib/parakeet.js'
import { transcribeHighQuality } from '../../server/lib/whisper-local.js'

// Never send audio to the user's live whisper-servers (8177/8178/3141): refuse at the transport.
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input)
  if (/127\.0\.0\.1:(8177|8178|3141|3143)|localhost:(8177|8178|3141|3143)/.test(url)) throw new Error(`refused live endpoint ${url}`)
  return realFetch(input, init)
}) as typeof fetch

const ACTIVE = process.env.REAL_ACTIVE_DIR
const live = () => { try { return ACTIVE ? readdirSync(ACTIVE).length > 0 : false } catch { return true } }
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  if (!line.trim()) continue
  const job = JSON.parse(line)
  if (live() && process.env.ALLOW_LIVE !== '1') { console.error('a real recording is live; refusing'); process.exit(3) }
  const raw = readFileSync(job.wav)
  const t0 = performance.now()
  const input = job.frontEnd === 'raw' ? raw : await asrFrontEnd(raw, job.frontEnd)
  const feMs = performance.now() - t0
  const t1 = performance.now()
  try {
    if (job.engine.startsWith('parakeet')) {
      const r = await transcribeParakeet(input, { model: job.engine, lane: job.lane ?? 'batch', timeoutMs: 180_000 })
      process.stdout.write(JSON.stringify({ id: job.id, engine: job.engine, text: r.text, words: r.words, wallMs: r.wallMs, procSec: r.processingSec, feMs }) + '\n')
    } else {
      const r = await transcribeHighQuality(input, job.context, { priority: 'batch', timestamps: job.engine === 'large-v3' })
      process.stdout.write(JSON.stringify({ id: job.id, engine: job.engine, text: r.text, words: r.spokenWords ?? [], tokens: (r.words ?? []).length, timestamps: r.timestamps, wallMs: Math.round(performance.now() - t1), feMs }) + '\n')
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: job.id, engine: job.engine, error: String(e).slice(0, 300) }) + '\n')
  }
  if (process.env.PACE_MS) await new Promise(r => setTimeout(r, Number(process.env.PACE_MS)))
}
