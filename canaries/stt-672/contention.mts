// Synthetic contention: private Large-v3 whisper-server (live commit stand-in, PRIVATE_LIVE_PORT),
// the shipped Nemotron diarizer run (runNemotronCli, ANE, nice 10) and the shipped Parakeet preview
// (transcribeParakeet, preview lane) on the same chunks. Arms: each solo, then all three at once per
// chunk, the way a live meeting chunk lands. Never touches the user's 8177/8178/3141.
// Env: PRIVATE_LIVE_PORT, CHUNKS (json list of wav paths), DIAR_CLI, DIAR_MODELS, HOME (private), COS_DATA_DIR (eval).
import { readFileSync } from 'node:fs'
import { runNemotronCli } from '../../server/lib/nemotron-cli.js'
import { transcribeParakeet } from '../../server/lib/parakeet.js'
import { asrFrontEnd } from '../../server/lib/stt-live.js'

const PORT = Number(process.env.PRIVATE_LIVE_PORT)
if (!PORT || [8177, 8178, 3141, 3143].includes(PORT)) throw new Error('need a private port')
const chunks: string[] = JSON.parse(readFileSync(process.env.CHUNKS!, 'utf8'))
const live = async (wav: Buffer) => {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'recording.wav')
  form.append('response_format', 'json'); form.append('suppress_non_speech', 'true')
  const t = performance.now()
  const r = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`live ${r.status}`)
  await r.json(); return performance.now() - t
}
const diar = async (path: string) => {
  const t = performance.now()
  await runNemotronCli({ cli: process.env.DIAR_CLI!, modelsDir: process.env.DIAR_MODELS!, wavPath: path, timeoutMs: 1500, computeUnits: 'ane', niceness: 10 })
  return performance.now() - t
}
const preview = async (wav: Buffer) => {
  const t = performance.now()
  const input = await asrFrontEnd(wav, 'highpass')
  await transcribeParakeet(input, { model: (process.env.PREVIEW_MODEL ?? 'parakeet-v2') as any, lane: 'preview', timeoutMs: 1500 })
  return performance.now() - t
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null }
const summary = (xs: number[], fails: number) => ({ n: xs.length, failures: fails, p50_ms: pct(xs, 0.5), p95_ms: pct(xs, 0.95), max_ms: xs.length ? Math.max(...xs) : null })
async function arm(name: string, kinds: Array<'live' | 'diar' | 'preview'>) {
  const out: Record<string, number[]> = { live: [], diar: [], preview: [] }, fails: Record<string, number> = { live: 0, diar: 0, preview: 0 }
  for (const path of chunks) {
    const wav = readFileSync(path)
    await Promise.all(kinds.map(async k => {
      try { out[k].push(k === 'live' ? await live(wav) : k === 'diar' ? await diar(path) : await preview(wav)) } catch { fails[k]++ }
    }))
    await new Promise(r => setTimeout(r, 200))
  }
  return Object.fromEntries(kinds.map(k => [k, summary(out[k], fails[k])]))
}
// warm everything first (CoreML compile, Metal load)
for (const p of chunks.slice(0, 2)) { const w = readFileSync(p); await live(w).catch(() => 0); await runNemotronCli({ cli: process.env.DIAR_CLI!, modelsDir: process.env.DIAR_MODELS!, wavPath: p, timeoutMs: 120_000, computeUnits: 'ane' }).catch(e => console.error('diar warm', String(e))); await transcribeParakeet(await asrFrontEnd(w, 'highpass'), { model: (process.env.PREVIEW_MODEL ?? 'parakeet-v2') as any, lane: 'warmup', timeoutMs: 120_000 }).catch(e => console.error('pk warm', String(e))) }
const result = {
  chunks: chunks.length,
  solo: { live: (await arm('live', ['live'])).live, diar: (await arm('diar', ['diar'])).diar, preview: (await arm('preview', ['preview'])).preview },
  concurrent: await arm('all', ['live', 'diar', 'preview']),
  concurrentNoPreview: await arm('base', ['live', 'diar']),
}
console.log(JSON.stringify(result))
