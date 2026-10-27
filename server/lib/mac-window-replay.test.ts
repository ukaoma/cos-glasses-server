// 6.93.0: the I/O half of window replay, with fake diarizers. Fictional audio only (signed constants).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEMOTRON_CHANNELS, NEMOTRON_TMP_PREFIX } from './nemotron-cli.js'
import { LIVE_BUDGET_MS, liveBudgetForAudioSec, type LiveDiarizeOutcome } from './nemotron-live.js'
import { emptyMacWindowVoices, type MacWindowResult } from './mac-window-voices.js'
import {
  __resetMacWindowCountersForTests,
  macLiveVoicesSnapshot,
  macWindowDisabledFor,
  MAC_WINDOW_BACKOFF_OF_LAST,
  MAC_WINDOW_BACKOFF_TIMEOUTS,
  macWindowStateFor,
  macWindowWithheldReason,
  noteMacWindowWithheld,
  startMacWindowDiarize,
} from './mac-window-replay.js'
import { activityOf, wavOf } from './__fixtures__/nemotron-helpers.js'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
beforeEach(() => __resetMacWindowCountersForTests())
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir }
const sha = (wav: Buffer) => createHash('sha256').update(wav).digest('hex')

/** A session dir holding chunks 0..n-1: positive samples = voice A, negative = voice B. */
function session(signs: number[]) {
  const dir = temp('mac-window-replay-')
  const wavs = signs.map((sign, i) => {
    const wav = wavOf(6, () => sign * (400 + i))
    writeFileSync(join(dir, `chunk_${String(i).padStart(4, '0')}.wav`), wav)
    return wav
  })
  return { dir, wavs }
}

/** What the CLI would answer for a WAV: each frame's slot from that frame's sample sign (A on `pos`, B on 5). */
function runFor(path: string, pos = 1): LiveDiarizeOutcome {
  const wav = readFileSync(path)
  const samples = (wav.length - 44) / 2
  const frames = 1 + Math.floor((samples + 112) / 160)
  const probs = new Float32Array(frames * NEMOTRON_CHANNELS).fill(0.02)
  for (let f = 0; f < frames - 1; f++) probs[f * NEMOTRON_CHANNELS + (wav.readInt16LE(44 + f * 320) >= 0 ? pos : 5)] = 0.9
  return { ok: true, run: { frames, probs, wallMs: 25, loadSec: 0, audioSec: samples / 16000 } }
}

/** Drive chunks 0..k-1 through the module with a state carried forward; return the last job's pieces. */
async function drive(opts: {
  signs: number[]
  windowRun?: (path: string, timeoutMs: number) => Promise<LiveDiarizeOutcome>
  chunkRun?: (path: string) => Promise<LiveDiarizeOutcome>
  upTo?: number
  sessionId?: string
}) {
  const { dir, wavs } = session(opts.signs)
  const lines: string[] = []
  const windowCalls: Array<{ path: string; timeoutMs: number; existed: boolean }> = []
  const chunkCalls: string[] = []
  let state = emptyMacWindowVoices()
  let last: { outcome: LiveDiarizeOutcome; labels: Array<string | null>; result: MacWindowResult | null } | null = null
  const upTo = opts.upTo ?? opts.signs.length
  for (let k = 0; k < upTo; k++) {
    const job = startMacWindowDiarize({
      sessionId: opts.sessionId ?? 'mac_test',
      sessionDir: dir, chunkIndex: k, audio: wavs[k], audioSha256: sha(wavs[k]), state,
      diarizeWindow: async (path, timeoutMs) => {
        windowCalls.push({ path, timeoutMs, existed: existsSync(path) })
        return opts.windowRun ? opts.windowRun(path, timeoutMs) : runFor(path)
      },
      diarizeChunk: async path => { chunkCalls.push(path); return opts.chunkRun ? opts.chunkRun(path) : runFor(path, 2) },
      log: line => lines.push(line),
    })!
    const outcome = await job.diarize
    const result = job.result()
    if (result) state = result.state
    last = { outcome, labels: result ? Array.from({ length: NEMOTRON_CHANNELS }, (_, slot) => result.labelOf(slot)) : [], result }
  }
  return { dir, lines, windowCalls, chunkCalls, last: last!, state }
}

describe('startMacWindowDiarize', () => {
  it('labels a carried voice, runs the chunk alone only when a slot is carried, and sizes the timeout from the window', async () => {
    const r = await drive({ signs: [1, 1, 1] })
    // Chunk 0 has no overlap: no carried slot, no run of the chunk alone. Chunks 1 and 2 carry A.
    expect(r.chunkCalls.map(p => p.slice(-14))).toEqual(['chunk_0001.wav', 'chunk_0002.wav'])
    expect(r.windowCalls.map(c => c.timeoutMs)).toEqual([liveBudgetForAudioSec(6), liveBudgetForAudioSec(12), liveBudgetForAudioSec(18)])
    expect(r.windowCalls.map(c => c.timeoutMs)).toEqual([1500, 3000, 4500])
    expect(r.windowCalls.every(c => c.existed && c.path.endsWith('/window.wav'))).toBe(true)
    expect(r.windowCalls.some(c => existsSync(c.path))).toBe(false) // window WAV removed
    expect(r.last.labels[1]).toBe('Voice 1')
    expect(r.last.outcome).toMatchObject({ ok: true })
  })

  it('a window of 30 s is given five chunks of budget, not the per-chunk 1.5 s (QA W4)', async () => {
    const r = await drive({ signs: [1, 1, 1, 1, 1, 1] })
    expect(r.windowCalls.at(-1)!.timeoutMs).toBe(7500)
    expect(r.windowCalls.at(-1)!.timeoutMs).toBeGreaterThan(LIVE_BUDGET_MS)
  })

  it('a window timeout falls back to the per-chunk run, commits no window state, and says why (not bad_output)', async () => {
    const r = await drive({
      signs: [1, 1],
      windowRun: async (path, ms) => (path ? { ok: false as const, reason: 'timeout' as const, ms, detail: 'budget' } : runFor(path)),
    })
    expect(r.last.outcome).toMatchObject({ ok: true }) // the per-chunk run answered
    expect(r.last.result).toBeNull() // nothing committed: the window never advanced
    expect(r.state.recent).toHaveLength(0)
    expect(r.chunkCalls).toHaveLength(2)
    expect(r.lines.filter(l => l.includes('fallback=timeout'))).toHaveLength(2)
    expect(r.lines.join('\n')).not.toContain('bad_output')
    expect(macLiveVoicesSnapshot({ COS_MAC_LIVE_VOICES: 'window' }).window).toMatchObject({ runs: 0, fallbacks: { timeout: 2, geometry: 0 } })
  })

  it('a refused window geometry is its own reason, and the chunk still gets the per-chunk run', async () => {
    const r = await drive({
      signs: [1],
      windowRun: async path => { const o = runFor(path); return o.ok ? { ok: true, run: { ...o.run, frames: o.run.frames + 3, probs: new Float32Array((o.run.frames + 3) * NEMOTRON_CHANNELS) } } : o },
    })
    expect(r.last.outcome).toMatchObject({ ok: true })
    expect(r.last.result).toBeNull()
    expect(r.lines.join('\n')).toContain('fallback=geometry')
    expect(macLiveVoicesSnapshot({ COS_MAC_LIVE_VOICES: 'window' }).window?.fallbacks).toEqual({ timeout: 0, geometry: 1 })
  })

  it('any other window failure is the outcome as it is: no hidden second run', async () => {
    const r = await drive({ signs: [1], windowRun: async () => ({ ok: false, reason: 'cli_failed', detail: 'exit 1' }) })
    expect(r.last.outcome).toMatchObject({ ok: false, reason: 'cli_failed' })
    expect(r.chunkCalls).toHaveLength(0)
    const busy = await drive({ signs: [1], windowRun: async () => ({ ok: false, reason: 'busy' }) })
    expect(busy.last.outcome).toMatchObject({ ok: false, reason: 'busy' })
    expect(busy.chunkCalls).toHaveLength(0)
  })

  it('when the chunk alone cannot be run, carried slots are withheld: no label, no proof (fails closed)', async () => {
    const r = await drive({ signs: [1, 1, 1], chunkRun: async () => ({ ok: false, reason: 'busy' }) })
    expect(r.last.labels.every(l => l === null)).toBe(true)
    expect(r.state.voices).toBe(0)
    expect(macLiveVoicesSnapshot({ COS_MAC_LIVE_VOICES: 'window' }).window).toMatchObject({ agreementUnavailable: 1, withheld: 1 }) // chunk 2 then has too little tracked overlap to carry, so nothing is asked of it
  })

  it('when the chunk alone splits the carried voice in two, the number is withheld', async () => {
    // Chunk 2's own run puts the first and second half of A on different channels.
    const r = await drive({
      signs: [1, 1, 1],
      chunkRun: async path => path.endsWith('chunk_0002.wav') ? { ok: true, run: { ...activityOf(6, [[3, 0, 3], [4, 3, 6]]), wallMs: 20, loadSec: 0, audioSec: 6 } } : runFor(path, 2),
    })
    expect(r.last.labels[1]).toBeNull()
    expect(r.state.voices).toBe(1) // chunk 1 earned it; chunk 2 did not
  })

  it('logs one counts-only line per window run: no text, no audio, no names', async () => {
    const r = await drive({ signs: [1, 1] })
    const window = r.lines.filter(l => l.startsWith('[mac-window] chunk #'))
    expect(window).toHaveLength(2)
    expect(window[1]).toMatch(/^\[mac-window\] chunk #1 window 2 chunks 12\.0s \d+ ms overlap=1 carried=1 withheld=0 created=0 confirmed=1 evicted=0 capped=0 tracks=1 voices=1 alone=ok$/)
    expect(macLiveVoicesSnapshot({ COS_MAC_LIVE_VOICES: 'window' }).window).toMatchObject({ runs: 2, carried: 1, confirmed: 1, created: 1, withheld: 0 })
  })

  it('returns null with no durable WAV to read; leaves no temp directory behind on any path', async () => {
    const before = readdirSync(tmpdir()).filter(n => n.startsWith(NEMOTRON_TMP_PREFIX + 'window-')).length
    const r = await drive({ signs: [1, 1], windowRun: async () => ({ ok: false, reason: 'timeout', ms: 1 }) })
    expect(r.windowCalls.every(c => !existsSync(c.path))).toBe(true)
    expect(readdirSync(tmpdir()).filter(n => n.startsWith(NEMOTRON_TMP_PREFIX + 'window-')).length).toBe(before)
    const dir = temp('mac-window-empty-')
    mkdirSync(dir, { recursive: true })
    expect(startMacWindowDiarize({
      sessionId: 'mac_empty', sessionDir: dir, chunkIndex: 0, audio: Buffer.alloc(10), audioSha256: sha(Buffer.alloc(1)), state: emptyMacWindowVoices(),
      diarizeWindow: async () => ({ ok: false, reason: 'busy' }), diarizeChunk: async () => ({ ok: false, reason: 'busy' }),
    })).toBeNull()
  })
})

describe('repeated window timeouts stop the window for that capture (QA R3, W11)', () => {
  const timeout = async (_path: string, ms: number): Promise<LiveDiarizeOutcome> => ({ ok: false, reason: 'timeout', ms })

  it('2 of the last 3 window runs timing out disable the window for the capture, once, with a counts-only line', async () => {
    expect([MAC_WINDOW_BACKOFF_TIMEOUTS, MAC_WINDOW_BACKOFF_OF_LAST]).toEqual([2, 3])
    const r = await drive({ signs: [1, 1, 1], upTo: 1, windowRun: timeout, sessionId: 'mac_slow' })
    expect(macWindowDisabledFor('mac_slow')).toBe(false) // one is not enough
    const second = await drive({ signs: [1, 1, 1], upTo: 2, windowRun: timeout, sessionId: 'mac_slow' })
    expect(macWindowDisabledFor('mac_slow')).toBe(true)
    expect(second.lines.filter(l => l.includes('window disabled after 2 of the last 2 window runs timed out'))).toHaveLength(1)
    expect(second.lines.join('\n')).toMatch(/\[mac-window\] capture mac_slow window disabled after 2 of the last 2 window runs timed out; per-chunk runs only/)
    expect(r.lines.some(l => l.includes('disabled'))).toBe(false)
    // A third timeout is not logged again.
    const third = await drive({ signs: [1], windowRun: timeout, sessionId: 'mac_slow' })
    expect(third.lines.some(l => l.includes('disabled'))).toBe(false)
    expect(macLiveVoicesSnapshot({ COS_MAC_LIVE_VOICES: 'window' }).window?.disabledCaptures).toBe(1)
  })

  it('alternating timeout, clean, timeout also disables it (W11: a streak would never trip on this)', async () => {
    await drive({ signs: [1], windowRun: timeout, sessionId: 'mac_alt' })
    await drive({ signs: [1], sessionId: 'mac_alt' }) // a clean window run
    expect(macWindowDisabledFor('mac_alt')).toBe(false)
    const r = await drive({ signs: [1], windowRun: timeout, sessionId: 'mac_alt' })
    expect(macWindowDisabledFor('mac_alt')).toBe(true)
    expect(r.lines.join('\n')).toContain('window disabled after 2 of the last 3 window runs timed out')
  })

  it('a timeout that has left the last three runs no longer counts, and one capture never disables another', async () => {
    await drive({ signs: [1], windowRun: timeout, sessionId: 'mac_a' })
    await drive({ signs: [1], sessionId: 'mac_a' })
    await drive({ signs: [1], sessionId: 'mac_a' })
    await drive({ signs: [1], sessionId: 'mac_a' }) // the first timeout is now 4 runs back
    await drive({ signs: [1], windowRun: timeout, sessionId: 'mac_a' })
    expect(macWindowDisabledFor('mac_a')).toBe(false)
    await drive({ signs: [1], windowRun: timeout, sessionId: 'mac_b' })
    expect(macWindowDisabledFor('mac_a')).toBe(false)
    expect(macWindowDisabledFor('mac_b')).toBe(false)
    await drive({ signs: [1], windowRun: timeout, sessionId: 'mac_b' })
    expect(macWindowDisabledFor('mac_b')).toBe(true)
    expect(macWindowDisabledFor('mac_a')).toBe(false)
  })

  it('a non-timeout failure counts as a run but not as a timeout', async () => {
    await drive({ signs: [1], windowRun: timeout, sessionId: 'mac_c' })
    await drive({ signs: [1], windowRun: async () => ({ ok: false, reason: 'busy' }), sessionId: 'mac_c' })
    await drive({ signs: [1], sessionId: 'mac_c' })
    await drive({ signs: [1], windowRun: async () => ({ ok: false, reason: 'busy' }), sessionId: 'mac_c' })
    await drive({ signs: [1], windowRun: timeout, sessionId: 'mac_c' })
    expect(macWindowDisabledFor('mac_c')).toBe(false) // the earlier timeout is out of the last three
  })
})

describe('withheld state is never silent (QA W8) and never throws (QA N3)', () => {
  it('names why a capture\'s window labels are withheld, once per capture and reason', () => {
    expect(macWindowWithheldReason(undefined, [{ speaker: 'Ext' }])).toBeNull()
    expect(macWindowWithheldReason(emptyMacWindowVoices(), [])).toBeNull()
    expect(macWindowWithheldReason({ version: 1, kind: 'window', nextTrack: 0, voices: 7, tracks: [], recent: [{ chunk: 9, frames: 'AA==' }] }, [])).toBe('corrupt_state')
    expect(macWindowWithheldReason(undefined, [{ speaker: 'Ext' }, { speaker: 'Voice 4' }])).toBe('earlier_voice_labels')
    expect(macWindowWithheldReason(undefined, [{ speaker: 'Ext', segments: [{ speaker: 'Voice 2' }] }])).toBe('earlier_voice_labels')
    const lines: string[] = []
    noteMacWindowWithheld('mac_x', 'corrupt_state', l => lines.push(l))
    noteMacWindowWithheld('mac_x', 'corrupt_state', l => lines.push(l))
    noteMacWindowWithheld('mac_x', 'earlier_voice_labels', l => lines.push(l))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('mac_x window labels withheld (corrupt_state)')
    expect(macLiveVoicesSnapshot({ COS_MAC_LIVE_VOICES: 'window' }).window?.stateWithheld).toEqual({ corrupt_state: 1, earlier_voice_labels: 1 })
  })

  it('a recovered chunk whose segments is not an array is shape-checked, not thrown on', () => {
    for (const segments of ['text', 5, {}, { some: () => true }, [null], [{ speaker: 3 }]]) {
      expect(() => macWindowStateFor(undefined, [{ speaker: 'Ext', segments }])).not.toThrow()
      expect(macWindowStateFor(undefined, [{ speaker: 'Ext', segments }])).toEqual(emptyMacWindowVoices())
    }
    expect(macWindowStateFor(undefined, [null, undefined])).toEqual(emptyMacWindowVoices())
  })

  it('health: the switch state, and the window counts only while the window path is on', () => {
    expect(macLiveVoicesSnapshot({}).mode).toBe('window') // on by default (6.93.0)
    expect(macLiveVoicesSnapshot({})).toHaveProperty('window')
    expect(macLiveVoicesSnapshot({ COS_MAC_LIVE_VOICES: 'off' })).toEqual({ mode: 'off' })
    expect(macLiveVoicesSnapshot({ COS_MAC_LIVE_VOICES: 'anchors' })).toEqual({ mode: 'anchors' })
    expect(macLiveVoicesSnapshot({ COS_MAC_LIVE_VOICES: 'window', COS_MAC_VOICE_LABELS: '0' })).toEqual({ mode: 'off' })
    expect(macLiveVoicesSnapshot({ COS_MAC_LIVE_VOICES: 'window' }).window).toMatchObject({ runs: 0, fallbacks: { timeout: 0, geometry: 0 } })
  })
})
