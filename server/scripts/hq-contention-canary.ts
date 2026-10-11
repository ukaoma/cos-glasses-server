import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { transcribeHighQuality } from '../lib/whisper-local.js'
import { killNemotronChildren, runNemotronCli } from '../lib/nemotron-cli.js'

const root = process.env.COS_ASR_CANARY_ROOT
const [input, liveInput, output] = process.argv.slice(2)
const port = Number(process.env.COS_ASR_CANARY_PORT)
const activeDir = process.env.COS_ASR_CANARY_ACTIVE_DIR
if (!root || !process.env.COS_DATA_DIR || !process.env.COS_PROFILE_PATH || !activeDir || port !== 18278) throw new Error('Explicit private canary environment and live-session guard required')
for (const path of [input, liveInput, output, process.env.COS_DATA_DIR, process.env.COS_PROFILE_PATH]) {
  const rel = path && relative(resolve(root), resolve(path))
  if (!rel || rel.startsWith('..') || rel.startsWith('/')) throw new Error('Private canary paths required')
}
if (!process.env.COS_NEMOTRON_CLI || !process.env.COS_NEMOTRON_MODELS) throw new Error('Explicit offline diarizer required')
const samples = [], diarizerMs = [], healthMs = []
const controller = new AbortController()
const guard = () => {
  if (existsSync(activeDir) && readdirSync(activeDir).length) {
    controller.abort(); killNemotronChildren()
    throw new Error('Private canary stopped: actual meeting active')
  }
}
guard()
const watch = setInterval(() => { try { guard() } catch { /* aborted; the owned work will fail */ } }, 100)
watch.unref()
let done = false
const start = Date.now()
const batch = transcribeHighQuality(readFileSync(input), undefined, {
  priority: 'batch', forceCpu: true, threads: 6, backgroundCpu: true, signal: controller.signal,
}).then(result => ({ ok: true, wallMs: Date.now() - start, result }), e => ({ ok: false, error: String(e) })).finally(() => { done = true })
await new Promise(r => setTimeout(r, 1500))
for (let i = 0; i < 50 && !done; i++) {
  guard()
  const wav = readFileSync(liveInput), form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'chunk.wav')
  form.append('response_format', 'json')
  form.append('suppress_non_speech', 'true')
  const t = Date.now()
  const infer = fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) }).then(async response => {
    const body = await response.json()
    if (!response.ok || typeof body.text !== 'string') throw new Error('Private live ASR invalid response')
    return Date.now() - t
  })
  const diarizer = runNemotronCli({
    cli: process.env.COS_NEMOTRON_CLI, modelsDir: process.env.COS_NEMOTRON_MODELS,
    wavPath: liveInput, timeoutMs: 10000, computeUnits: 'ane',
  })
  const [ms, tracks] = await Promise.all([infer, diarizer])
  samples.push(ms); diarizerMs.push(tracks.wallMs)
  const h = Date.now()
  const response = await fetch('http://127.0.0.1:3141/api/health', { signal: AbortSignal.timeout(2000) })
  if (!response.ok) throw new Error('Actual API health failed during private canary')
  await response.arrayBuffer(); healthMs.push(Date.now() - h)
}
const result = await batch
clearInterval(watch)
guard()
writeFileSync(output, JSON.stringify({ batch: result, liveMs: samples, diarizerMs, healthMs }))
