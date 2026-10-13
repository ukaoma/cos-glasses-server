// Shipped-path HQ evaluation: every arm runs through transcribeSegments (production 30 s
// windows from segmentTranscriptChunks, the job plan, asrFrontEnd, the HQ window decode,
// the resolver, corrections, stripOverlap, speaker mapping) with the real decoders behind a
// disk cache, so an arm that differs only in plan reuses the same decodes.
//
// One approximation, stated in the report: the cache key is the decoder's input audio and
// its options, not the 250-character prompt context. Large-v3's prompt context in a resolver
// arm is therefore the one from the first arm that decoded that window (Large-v3 alone).
//
// argv: MODE=decode|arms  SETS=silver,silverE  ARMS=json list of [name, plan]
// Never touches the user's live servers. Refuses during a recording unless ALLOW_LIVE=1.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { segmentTranscriptChunks, transcribeSegments, type HqDecodeDeps, type HqJobPlan } from '../../server/lib/meeting-batch-transcribe.js'
import { transcribeHighQuality } from '../../server/lib/whisper-local.js'
import { transcribeParakeet } from '../../server/lib/parakeet.js'
import { asrFrontEnd } from '../../server/lib/stt-live.js'
import { getVocabulary } from '../../server/lib/profile.js'

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input)
  // Only the user's public health read is allowed (the live-impact guard below).
  if (/127\.0\.0\.1:(8177|8178|3141|3143)/.test(url) && !/127\.0\.0\.1:3141\/api\/health$/.test(url)) throw new Error(`refused live endpoint ${url}`)
  return realFetch(input, init)
}) as typeof fetch

const ROOT = process.env.ASR_BAKEOFF_ROOT ?? join(homedir(), 'cos-data/asr-bakeoff')
const EVAL = process.env.STT672_EVAL_DIR ?? join(homedir(), 'cos-data/stt-672-eval')
const CACHE = join(EVAL, 'runs', 'shipped_cache')
const ACTIVE = join(process.env.REAL_HOME ?? homedir(), '.cos-glasses/data/active-sessions')
const live = () => { try { return readdirSync(ACTIVE).length > 0 } catch { return true } }
mkdirSync(CACHE, { recursive: true })
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const MODE = process.env.MODE ?? 'decode'
const timing: Array<{ kind: string; ms: number; audioSec: number; cached: boolean }> = []
const audioSec = (wav: Buffer) => Math.max(0, wav.length - 44) / 32_000

function cached<T>(kind: string, key: string, wav: Buffer, run: () => Promise<T>): Promise<T> {
  const file = join(CACHE, `${kind}-${key}.json`)
  if (existsSync(file)) {
    const hit = JSON.parse(readFileSync(file, 'utf8'))
    timing.push({ kind, ms: hit.__ms, audioSec: audioSec(wav), cached: true })
    if (hit.__error) return Promise.reject(Object.assign(new Error(hit.__error), { reason: hit.__reason }))
    return Promise.resolve(hit.value as T)
  }
  if (MODE === 'arms' && process.env.ALLOW_MISS !== '1') return Promise.reject(new Error(`cache miss ${kind} ${key}`))
  if (live() && process.env.ALLOW_LIVE !== '1') { console.error('a real recording is live; refusing'); process.exit(3) }
  const t0 = performance.now()
  return run().then(value => {
    const ms = performance.now() - t0
    writeFileSync(file, JSON.stringify({ __ms: ms, value }))
    timing.push({ kind, ms, audioSec: audioSec(wav), cached: false })
    return value
  }, (error: any) => {
    const ms = performance.now() - t0
    writeFileSync(file, JSON.stringify({ __ms: ms, __error: String(error?.message ?? error), __reason: error?.reason }))
    throw error
  })
}

const deps: HqDecodeDeps = {
  whisper: (wav, ctx, opts) => cached(`lv3${opts?.timestamps ? 'ts' : 'nt'}${opts?.forceCpu ? 'cpu' : ''}`, sha(wav), wav, () => transcribeHighQuality(wav, ctx, opts)),
  parakeet: (wav, opts) => cached(opts.model, sha(wav), wav, () => transcribeParakeet(wav, opts)),
  frontEnd: (audio, fe) => asrFrontEnd(audio, fe),
  vocabulary: () => getVocabulary(),
}

// Live-impact guard for runs during a recording: the user's diarizer timeouts and live
// Whisper failures must not rise; if they do, pause two minutes (three strikes: stop).
async function liveSignal(): Promise<number | null> {
  try {
    const d: any = await (await realFetch('http://127.0.0.1:3141/api/health', { signal: AbortSignal.timeout(3000) })).json()
    return (d?.readiness?.diarizer?.chunks?.reasons?.timeout ?? 0) + 100 * (d?.whisper_health?.consecutiveFailures ?? 0)
  } catch { return null }
}
let baseline = await liveSignal(), strikes = 0
async function guard(): Promise<void> {
  const now = await liveSignal()
  if (baseline !== null && now !== null && now > baseline) {
    strikes++
    console.error(`live signal rose ${baseline} -> ${now}; pausing 120 s (strike ${strikes})`)
    if (strikes >= 3) { console.error('stopping: three strikes'); process.exit(4) }
    await new Promise(r => setTimeout(r, 120_000))
    baseline = await liveSignal()
  }
}

const sets = (process.env.SETS ?? 'silver,silverE').split(',')
const arms: Array<[string, HqJobPlan]> = JSON.parse(process.env.ARMS ?? '[["LV3",{"engine":"large-v3","secondOpinion":"off","resolver":false,"frontEnd":"highpass"}]]')
const out: Record<string, Record<string, Record<string, unknown>>> = {}
for (const ds of sets) {
  // A set name, or file:/abs/path.json for an ad hoc set (chunk files absolute).
  const W = JSON.parse(readFileSync(ds.startsWith('file:') ? ds.slice(5) : join(ROOT, 'refs', `${ds}_set.json`), 'utf8')).windows
  for (const w of W) {
    if (MODE === 'decode') await guard()
    const dir = mkdtempSync(join(tmpdir(), 'stt672-shipped-'))
    try {
      const t0 = w.chunks[0].start
      const entries = w.chunks.map((c: any) => {
        symlinkSync(c.file.startsWith('/') ? c.file : join(ROOT, c.file), join(dir, `chunk_${String(c.idx).padStart(4, '0')}.wav`))
        return { chunkIndex: c.idx, chunk: { text: 'x', speaker: 'MU', elapsed: Math.round((c.start - t0 + c.dur) * 1000), similarity: 1 } }
      })
      const segments = segmentTranscriptChunks(entries as any)
      for (const [name, plan] of arms) {
        const results = await transcribeSegments(dir, segments, entries as any, undefined, plan, deps)
        const stt = results.map(r => r.stt)
        ;((out[name] ??= {})[ds.startsWith('file:') ? 'fixtures' : ds] ??= {})[w.id] = {
          text: results.map(r => r.text).join(' '),
          segments: segments.length, decoded: results.length,
          fallbacks: stt.filter(s => s?.fallbackReason).length,
          secondFailures: stt.filter(s => s?.secondOpinion?.error).length,
          applied: stt.filter(s => s?.resolver.applied).length,
          wordsFromSecond: stt.reduce((n, s) => n + (s?.resolver.wordsFromSecond ?? 0), 0),
          reasons: stt.flatMap(s => s?.disagreements ?? []).reduce((m: Record<string, number>, d) => { const k = `${d.reason ?? 'kept'}:${d.taken}`; m[k] = (m[k] ?? 0) + 1; return m }, {}),
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
    console.error(`${ds.startsWith('file:') ? 'fixtures' : ds} ${w.id} done`)
  }
}
writeFileSync(process.env.OUT ?? join(EVAL, 'runs', `shipped_${MODE}.json`), JSON.stringify({ arms: out, timing }))
console.error('finished')
