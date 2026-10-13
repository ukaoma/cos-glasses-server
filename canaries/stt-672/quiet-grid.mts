// Grid over sherpa Silero settings for the quiet gate canary. stdin JSONL {key,path}; stdout JSONL {key, r:{cfg:sec}}
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')
const MODEL = new URL('../../server/models/silero_vad.onnx', import.meta.url).pathname
const cfgs: Array<[string, number, number]> = []
for (const th of [0.5, 0.6, 0.7, 0.8]) for (const ms of [0.25, 0.5]) cfgs.push([`${th}/${ms}`, th, ms])
const vads = cfgs.map(([, th, ms]) => new sherpa.Vad({ sileroVad: { model: MODEL, threshold: th, minSilenceDuration: 0.3, minSpeechDuration: ms, windowSize: 512 }, sampleRate: 16000, numThreads: 1, provider: 'cpu' }, 10))
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  const job = JSON.parse(line)
  let w: Buffer
  try { w = readFileSync(job.path) } catch { process.stdout.write(JSON.stringify({ key: job.key, missing: true }) + '\n'); continue }
  const i16 = new Int16Array(w.buffer.slice(w.byteOffset + 44, w.byteOffset + w.length - ((w.length - 44) % 2)))
  const f32 = Float32Array.from(i16, x => x / 32768)
  const r: Record<string, number> = {}
  cfgs.forEach(([name], i) => {
    const vad = vads[i]; vad.reset(); let total = 0
    const drain = () => { while (!vad.isEmpty()) { total += vad.front().samples.length; vad.pop() } }
    for (let o = 0; o + 512 <= f32.length; o += 512) { vad.acceptWaveform(f32.subarray(o, o + 512)); drain() }
    vad.flush(); drain(); r[name] = total / 16000
  })
  process.stdout.write(JSON.stringify({ key: job.key, r }) + '\n')
}
