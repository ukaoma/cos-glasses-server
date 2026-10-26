import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MacStreamDiarizer, validateStreamRequest, type StreamRequest, type StreamReceipt } from './mac-stream-diarizer.js'

const captureId = 'mac_00000000-0000-4000-8000-000000000001'
const generation = '00000000-0000-4000-8000-000000000002'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
function open(): StreamRequest { return { version: 1, op: 'open', captureId, generation, requestId: id(10), startSample: 0, firstChunkIndex: 77 } }
function append(n = 0): StreamRequest {
  const pcm = Buffer.alloc(192_000, n + 1)
  return { version: 1, op: 'append', captureId, generation, requestId: id(11 + n), originalChunkIndex: 77 + n,
    startSample: n * 96_000, sampleCount: 96_000, audioSHA256: sha(`wav${n}`), pcmSHA256: sha(pcm), pcmS16LEBase64: pcm.toString('base64') }
}
function terminal(op: 'finish' | 'abort'): StreamRequest { return { version: 1, op, captureId, generation, requestId: id(100) } }
function fixture() {
  let through = 0; let index = 76; let frame = 0; let initial = 0
  const exchange = vi.fn(async (r: Readonly<StreamRequest>): Promise<StreamReceipt> => {
    if (r.op === 'open') { through = initial = r.startSample!; frame = initial / 160; index = r.firstChunkIndex! - 1 }
    if (r.op === 'append') { through += r.sampleCount!; index = r.originalChunkIndex! }
    const count = r.op === 'append' ? Math.floor((through / 160 - frame) / 256) * 256
      : r.op === 'finish' ? initial / 160 + (through > initial ? 1 + Math.floor((through - initial + 112) / 160) : 0) - frame : 0
    const receipt: StreamReceipt = { version: 1, op: r.op, captureId: r.captureId, generation: r.generation, requestId: r.requestId,
      state: r.op === 'finish' ? 'finished' : r.op === 'abort' ? 'aborted' : 'open', consumedThroughSample: through,
      consumedThroughChunkIndex: index, frameStart: frame, frameCount: count, numSpeakers: 8, probabilities: Array(count * 8).fill(0.5) }
    frame += count
    return receipt
  })
  const accept = vi.fn()
  return { exchange, accept, bridge: new MacStreamDiarizer({ exchange, accept, deadlineMs: 100 }) }
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

describe('isolated continuous diarizer protocol', () => {
  it('feeds six original appends once, drains one exact tail and replays finish without native advancement', async () => {
    const f = fixture(); await f.bridge.request(open())
    for (let i = 0; i < 6; i++) await f.bridge.request(append(i))
    const finish = await f.bridge.request(terminal('finish'))
    expect(finish.frameStart + finish.frameCount).toBe(3601)
    expect(await f.bridge.request(terminal('finish'))).toEqual(finish)
    expect(f.exchange).toHaveBeenCalledTimes(8); expect(f.accept).toHaveBeenCalledTimes(8)
    await expect(f.bridge.request(append(6))).rejects.toThrow('terminal')
  })
  it('semantic exact retry survives object key reordering and never appends twice', async () => {
    const f = fixture(); await f.bridge.request(open()); const a = append(); const r = await f.bridge.request(a)
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as StreamRequest
    expect(await f.bridge.request(reordered)).toEqual(r); expect(f.exchange).toHaveBeenCalledTimes(2)
    r.probabilities[0] = 1
    expect((await f.bridge.request(a)).probabilities[0]).toBe(0.5)
  })
  it('rejects replay outside last receipt cache and conflicting reused request ID before exchange', async () => {
    const f = fixture(); await f.bridge.request(open()); await f.bridge.request(append()); await f.bridge.request(append(1))
    await expect(f.bridge.request(append())).rejects.toThrow('request_conflict_or_evicted')
    await expect(f.bridge.request({ ...append(2), requestId: open().requestId })).rejects.toThrow('request_conflict_or_evicted')
    expect(f.exchange).toHaveBeenCalledTimes(3)
  })
  it.each([
    ['gap', { startSample: 1 }], ['out of order', { originalChunkIndex: 78 }],
    ['wrong capture', { captureId: 'mac_00000000-0000-4000-8000-000000000009' }],
    ['wrong generation', { generation: id(40) }],
  ])('rejects %s without native mutation', async (_, change) => {
    const f = fixture(); await f.bridge.request(open())
    await expect(f.bridge.request({ ...append(), ...change })).rejects.toThrow()
    expect(f.exchange).toHaveBeenCalledTimes(1); expect(f.bridge.status).toBe('open')
  })
  it('rejects repeated PCM with a different WAV header and new index', async () => {
    const f = fixture(); await f.bridge.request(open()); await f.bridge.request(append())
    await expect(f.bridge.request({ ...append(), requestId: id(99), originalChunkIndex: 78, startSample: 96_000, audioSHA256: sha('other-header') })).rejects.toThrow('repeated_pcm')
    expect(f.exchange).toHaveBeenCalledTimes(2)
  })
  it.each([
    ['bad PCM hash', { pcmSHA256: sha('wrong') }], ['oversize', { sampleCount: 96_001 }],
    ['base64 junk', { pcmS16LEBase64: '!!!!' }], ['base64 noncanonical', { pcmS16LEBase64: 'AA==' }],
    ['unknown fields', { sourcePath: '/live.wav' }], ['bad ID', { requestId: 'not-uuid' }],
  ])('rejects %s at input boundary', (_, change) => {
    expect(() => validateStreamRequest({ ...append(), ...change })).toThrow()
  })
  it('retains only one uncommitted result and retries persistence without a second append', async () => {
    const f = fixture(); await f.bridge.request(open())
    f.accept.mockImplementationOnce(() => { throw new Error('disk full') })
    await expect(f.bridge.request(append())).rejects.toThrow('disk full')
    await expect(f.bridge.request(append(1))).rejects.toThrow('uncommitted')
    await f.bridge.request(append()); expect(f.exchange).toHaveBeenCalledTimes(2)
    expect(f.accept).toHaveBeenCalledTimes(3)
  })
  it('cancels an awaited append and prevents late acceptance', async () => {
    const f = fixture(); await f.bridge.request(open()); const wait = deferred<StreamReceipt>()
    const receipt = await f.exchange(append())
    f.exchange.mockImplementationOnce(() => wait.promise)
    const pending = f.bridge.request(append()); const rejected = expect(pending).rejects.toThrow('cancelled')
    f.bridge.cancel(); wait.resolve(receipt); await rejected
    expect(f.accept).toHaveBeenCalledTimes(1); expect(f.bridge.status).toBe('failed')
    await expect(f.bridge.request(append())).rejects.toThrow('generation_ended')
  })
  it('wrong-scope abort cannot cancel another capture', async () => {
    const f = fixture(); await f.bridge.request(open()); const wait = deferred<StreamReceipt>()
    const receipt = await f.exchange(append()); f.exchange.mockImplementationOnce(() => wait.promise)
    const pending = f.bridge.request(append())
    await expect(f.bridge.request({ ...terminal('abort'), generation: id(99) })).rejects.toThrow('scope')
    wait.resolve(receipt); await pending; expect(f.bridge.status).toBe('open')
  })
  it('bounds one queued request and fences the active result on overflow', async () => {
    const f = fixture(); await f.bridge.request(open()); const wait = deferred<StreamReceipt>()
    f.exchange.mockImplementationOnce(() => wait.promise)
    const first = expect(f.bridge.request(append())).rejects.toThrow('cancelled')
    const second = expect(f.bridge.request(append(1))).rejects.toThrow('cancelled')
    await expect(f.bridge.request(append(2))).rejects.toThrow('queue_overflow')
    await Promise.all([first, second]); expect(f.accept).toHaveBeenCalledTimes(1)
  })
  it('drains a single queued input serially', async () => {
    const f = fixture(); await f.bridge.request(open()); const wait = deferred<StreamReceipt>()
    const receipt = await f.exchange(append()); f.exchange.mockImplementationOnce(() => wait.promise)
    const first = f.bridge.request(append()); const second = f.bridge.request(append(1))
    wait.resolve(receipt); await first; expect((await second).consumedThroughChunkIndex).toBe(78)
  })
  it('enforces timeout even when an injected transport ignores cancellation', async () => {
    const accept = vi.fn(); const b = new MacStreamDiarizer({ exchange: () => new Promise(() => {}), accept, deadlineMs: 5 })
    await expect(b.request(open())).rejects.toThrow('timeout'); expect(b.status).toBe('failed'); expect(accept).not.toHaveBeenCalled()
  })
  it.each(['NaN', 'sparse', 'future', 'shape', 'scope', 'cursor'])('poisons generation for malformed %s output', async kind => {
    const f = fixture(); await f.bridge.request(open()); const r = await f.exchange(append())
    if (kind === 'NaN') r.probabilities[0] = NaN
    if (kind === 'sparse') delete r.probabilities[0]
    if (kind === 'future') r.consumedThroughSample++
    if (kind === 'shape') r.frameCount++
    if (kind === 'scope') r.generation = id(90)
    if (kind === 'cursor') r.frameStart++
    f.exchange.mockResolvedValueOnce(r)
    await expect(f.bridge.request(append())).rejects.toThrow(); expect(f.bridge.status).toBe('failed')
    expect(f.accept).toHaveBeenCalledTimes(1)
  })
  it('requires full final coverage rather than accepting an empty successful finish', async () => {
    const f = fixture(); await f.bridge.request(open()); await f.bridge.request(append())
    const r = await f.exchange(terminal('finish')); r.frameCount = 0; r.probabilities = []
    f.exchange.mockResolvedValueOnce(r)
    await expect(f.bridge.request(terminal('finish'))).rejects.toThrow('finish_coverage')
  })
  it('caches an idle abort receipt and never flushes native tail', async () => {
    const f = fixture(); await f.bridge.request(open()); await f.bridge.request(append())
    const a = await f.bridge.request(terminal('abort')); expect(a.frameCount).toBe(0)
    expect(await f.bridge.request(terminal('abort'))).toEqual(a); expect(f.exchange).toHaveBeenCalledTimes(3)
  })
  it('supports a fresh nonzero generation origin without frame offset drift', async () => {
    const f = fixture(); await f.bridge.request({ ...open(), startSample: 960_000 })
    await f.bridge.request({ ...append(), startSample: 960_000 })
    const r = await f.bridge.request(terminal('finish')); expect(r.frameStart + r.frameCount).toBe(6601)
  })
})

describe('atomic acceptance boundary', () => {
  it('refuses an accidentally asynchronous persistence callback', async () => {
    const f = fixture()
    const bridge = new MacStreamDiarizer({ exchange: f.exchange, accept: async () => {}, deadlineMs: 100 })
    await expect(bridge.request(open())).rejects.toThrow('async_accept'); expect(bridge.status).toBe('failed')
  })
  it('fences publication if the owner cancels reentrantly during durable acceptance', async () => {
    const f = fixture(); let bridge!: MacStreamDiarizer
    bridge = new MacStreamDiarizer({ exchange: f.exchange, accept: () => bridge.cancel() })
    await expect(bridge.request(open())).rejects.toThrow('cancelled'); expect(bridge.status).toBe('failed')
  })
  it('abort during append invalidates generation without tail publication', async () => {
    const f = fixture(); await f.bridge.request(open()); f.exchange.mockImplementationOnce(() => new Promise(() => {}))
    const pending = expect(f.bridge.request(append())).rejects.toThrow('cancelled')
    await expect(f.bridge.request(terminal('abort'))).rejects.toThrow('cancelled'); await pending
    expect(f.accept).toHaveBeenCalledTimes(1); expect(f.bridge.status).toBe('failed')
  })
  it('requires first original index and rejects fractional origins before exchange', () => {
    const o = open(); delete o.firstChunkIndex
    expect(() => validateStreamRequest(o)).toThrow()
    expect(() => validateStreamRequest({ ...open(), startSample: 1 })).toThrow('start_sample')
  })
})

it('retains only validated wire fields, ignoring prototype instrumentation and arbitrary extras', async () => {
  const f = fixture(); const raw = await f.exchange(open())
  f.exchange.mockResolvedValueOnce(Object.assign(raw, { appendCallCount: 0, finishCallCount: 0, nativeElapsedMs: 1, unwanted: 'x'.repeat(10000) }))
  const receipt = await f.bridge.request(open())
  expect(Object.hasOwn(receipt, 'unwanted')).toBe(false)
  expect(Object.hasOwn(receipt, 'appendCallCount')).toBe(false)
})
