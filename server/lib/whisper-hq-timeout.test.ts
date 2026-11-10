// S1 (2026-11-09): progressive HQ checkpoint timeouts.
// Field evidence 10/26 to 11/09: 290 "whisper-cli HQ timeout (240s, model=large-v3)" against 190
// successful progressive checkpoints, all device=cpu at background QoS; 112 distinct segments
// timed out and 85 of them on all three attempts.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.doUnmock('node:child_process')
  vi.doUnmock('node:fs')
  vi.resetModules()
})

class FakeCli extends EventEmitter {
  pid = 900
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    queueMicrotask(() => { this.signalCode = signal; this.emit('close', null, signal) })
    return true
  })
}

function wav(seconds: number): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * 32_000))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

describe('an HQ timeout names what settles it', () => {
  it('keeps the historical prefix and adds audio length, device, threads and QoS', async () => {
    const children: FakeCli[] = []
    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(() => { const c = new FakeCli(); children.push(c); return c }),
      execFile: vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: any, o: string, er: string) => void) => cb(null, '', '')),
    }))
    vi.doMock('node:fs', async importOriginal => ({ ...(await importOriginal<typeof import('node:fs')>()), existsSync: () => true }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const whisper = await import('./whisper-local.js')
    const pending = whisper.transcribeHighQuality(wav(30), undefined, {
      priority: 'batch', forceCpu: true, forceCpuReason: 'progressive_checkpoint', threads: 6, backgroundCpu: true, timestamps: false,
    })
    const outcome = pending.then(() => null, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(240_000)
    const error = await outcome
    expect(children).toHaveLength(1)
    expect(whisper.isWhisperHqTimeout(error)).toBe(true)
    const message = (error as Error).message
    expect(message.startsWith('whisper-cli HQ timeout (240s, model=large-v3) ')).toBe(true)
    expect(message).toMatch(/audio=30\.0s device=cpu reason=progressive_checkpoint threads=6 qos=(background|default) elapsed=\d+ms/)
  })

  it('S1 (Q1 S1): a shutdown stop SIGKILLs an in-flight HQ child and waits for it', async () => {
    const children: FakeCli[] = []
    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(() => { const c = new FakeCli(); children.push(c); return c }),
      execFile: vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: any, o: string, er: string) => void) => cb(null, '', '')),
    }))
    vi.doMock('node:fs', async importOriginal => ({ ...(await importOriginal<typeof import('node:fs')>()), existsSync: () => true }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const whisper = await import('./whisper-local.js')
    const pending = whisper.transcribeHighQuality(wav(1), undefined, { priority: 'batch', forceCpu: true, timestamps: false }).catch(() => null)
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const result = await whisper.stopWhisperServer({ waitMs: 1_000 })
    expect(children[0]!.kill.mock.calls.map(c => c[0])).toEqual(['SIGKILL'])
    expect(result).toMatchObject({ stopped: false, exited: true, hqChildren: 1 })
    expect(log.mock.calls.some(c => /1 HQ child\(ren\) stopped \(SIGKILL; whisper-server was not running\): exited in/.test(String(c[0])))).toBe(true)
    await pending
  })

  it('wavAudioSeconds reads a 16 kHz mono 16-bit WAV', async () => {
    const { wavAudioSeconds } = await import('./whisper-local.js')
    expect(wavAudioSeconds(wav(30))).toBeCloseTo(30, 5)
    expect(wavAudioSeconds(Buffer.alloc(10))).toBe(0)
  })
})

describe('progressive checkpoint retries (S1)', () => {
  function wavChunk(fill: number): Buffer { const b = wav(0.01); b.fill(fill, 44); return b }
  const entries = () => [0, 10_000, 20_000, 30_000].map((elapsed, chunkIndex) => ({
    chunkIndex, chunk: { text: `chunk ${chunkIndex}`, speaker: 'MU', elapsed, similarity: 1 },
  }))

  async function setup() {
    const root = mkdtempSync(join(tmpdir(), 'cos-progressive-retry-'))
    for (let i = 0; i <= 3; i++) writeFileSync(join(root, `chunk_${String(i).padStart(4, '0')}.wav`), wavChunk(i))
    const batch = await import('./meeting-batch-transcribe.js')
    const whisper = await import('./whisper-local.js')
    const t = batch.__progressiveHqTesting
    const segment = batch.segmentTranscriptChunks(entries(), 30_000, false)[0]!
    const identity = t.progressiveFailureIdentity(root, segment)!
    const state = {
      sessionId: 'meeting_retry_001', audioDir: root, entries: entries(), asrCompletedIndices: [0, 1, 2, 3],
      queued: false, active: false, closed: false, inputRevision: 1, inputSignature: 'x',
      failedIdentity: undefined as string | undefined, failedAttempts: 0, retryAfter: 0,
      lastInputAt: Date.now(), idleYieldLogged: false,
    }
    return { root, t, whisper, identity, state }
  }

  it('a timeout is terminal at once: the segment is not retried after the backoff', async () => {
    const { root, t, whisper, identity, state } = await setup()
    try {
      expect(t.nextMissingSealedSegment(state)).not.toBeNull()
      const timeout = new whisper.WhisperHqTimeoutError(240_000, 'large-v3', {
        audioSeconds: 30, device: 'cpu', reason: 'progressive_checkpoint', threads: 6, backgroundQos: true, elapsedMs: 240_001,
      })
      expect(t.recordProgressiveFailure(state, identity, timeout, 1_000)).toEqual({ terminal: true, timedOut: true })
      state.retryAfter = 0 // long after any backoff
      expect(t.nextMissingSealedSegment(state)).toBeNull()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('any other failure keeps three attempts with backoff', async () => {
    const { root, t, identity, state } = await setup()
    try {
      const boom = new Error('whisper-cli HQ exit 1: something')
      expect(t.recordProgressiveFailure(state, identity, boom, 1_000)).toEqual({ terminal: false, timedOut: false })
      expect(state.retryAfter).toBe(61_000)
      state.retryAfter = 0
      expect(t.nextMissingSealedSegment(state)).not.toBeNull() // retried after the backoff
      expect(t.recordProgressiveFailure(state, identity, boom, 1_000).terminal).toBe(false)
      expect(state.retryAfter).toBe(121_000)
      expect(t.recordProgressiveFailure(state, identity, boom, 1_000).terminal).toBe(true)
      state.retryAfter = 0
      expect(t.nextMissingSealedSegment(state)).toBeNull()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
