/** Explicit offline native probe. Inputs/outputs stay outside the public repo.
 * Does not start the API, live Whisper, sync, LLMs or touch saved meetings. */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { transcribeHighQuality } from '../lib/whisper-local.js'
import { metalBatchInFlight, preemptMetalBatchForLive, registerLiveActivityProbe } from '../lib/whisper-metal-gate.js'

const root = process.env.COS_ASR_CANARY_ROOT
const activeDir = process.env.COS_ASR_CANARY_ACTIVE_DIR
if (!root || !process.env.COS_DATA_DIR || !process.env.COS_PROFILE_PATH || !activeDir) throw new Error('Explicit isolated canary paths and live-session guard required')
const [input, output, mode = 'cpu'] = process.argv.slice(2)
const inside = (path: string) => { const p = relative(resolve(root), resolve(path)); return p && !p.startsWith('..') && !p.startsWith('/') }
if (!input || !output || !inside(input) || !inside(output)) throw new Error('Canary paths must be under the private canary root')
if (!inside(process.env.COS_DATA_DIR) || !inside(process.env.COS_PROFILE_PATH)) throw new Error('Data and profile must be isolated under the private canary root')
if (existsSync(activeDir) && readdirSync(activeDir).length) throw new Error('Actual meeting active')
if (!['cpu', 'metal', 'abort', 'preempt'].includes(mode)) throw new Error('Unknown native canary mode')
mkdirSync(process.env.COS_DATA_DIR, { recursive: true })
const buffer = readFileSync(input), before = Date.now(), controller = new AbortController()
const watch = setInterval(() => {
  try { if (existsSync(activeDir) && readdirSync(activeDir).length) controller.abort() }
  catch { controller.abort() }
}, 100)
registerLiveActivityProbe(() => null)
let timer: ReturnType<typeof setInterval> | undefined
if (mode === 'abort') setTimeout(() => controller.abort(), 50)
if (mode === 'preempt') timer = setInterval(() => { if (metalBatchInFlight()) { preemptMetalBatchForLive('native_canary'); clearInterval(timer) } }, 10)
try {
  const result = await transcribeHighQuality(buffer, undefined, {
    priority: 'batch', forceCpu: mode === 'cpu' || mode === 'abort', threads: 6,
    signal: controller.signal,
  })
  writeFileSync(output, JSON.stringify({ ok: true, mode, wallMs: Date.now() - before, result }))
} catch (e) {
  writeFileSync(output, JSON.stringify({ ok: false, mode, wallMs: Date.now() - before, error: e instanceof Error ? e.name : 'unknown', message: e instanceof Error ? e.message : String(e) }))
} finally { if (timer) clearInterval(timer); clearInterval(watch) }
