// Isolated protocol/state machine only. No discovery, subprocess, models or live imports.
import { createHash } from 'node:crypto'

export const STREAM_MAX_SAMPLES = 96_000
export const STREAM_MAX_PCM_BYTES = STREAM_MAX_SAMPLES * 2
export type StreamOp = 'open' | 'append' | 'finish' | 'abort'
export interface StreamRequest {
  version: 1; op: StreamOp; captureId: string; generation: string; requestId: string
  startSample?: number; firstChunkIndex?: number; originalChunkIndex?: number; sampleCount?: number
  audioSHA256?: string; pcmSHA256?: string; pcmS16LEBase64?: string
}
export interface StreamReceipt {
  version: 1; op: StreamOp; captureId: string; generation: string; requestId: string
  state: 'open' | 'finished' | 'aborted'; consumedThroughSample: number; consumedThroughChunkIndex: number
  frameStart: number; frameCount: number; numSpeakers: 8; probabilities: number[]
}
export interface StreamDependencies {
  exchange(request: Readonly<StreamRequest>, signal: AbortSignal): Promise<unknown>
  // Synchronous, atomic durable acceptance. A throw leaves one staged receipt for exact retry.
  // Actual filesystem persistence and cancellation-aware CAS remain future integration work.
  accept(request: Readonly<StreamRequest>, receipt: Readonly<StreamReceipt>): void
  deadlineMs?: number
}
const SHA = /^[a-f0-9]{64}$/
const CAPTURE = /^mac_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ENVELOPE = ['version', 'op', 'captureId', 'generation', 'requestId']
const fields = (op: StreamOp): string[] => [...ENVELOPE, ...(op === 'open' ? ['startSample', 'firstChunkIndex'] : op === 'append' ? ['originalChunkIndex', 'startSample', 'sampleCount', 'audioSHA256', 'pcmSHA256', 'pcmS16LEBase64'] : [])]
const requestKey = (r: StreamRequest): string => JSON.stringify(Object.fromEntries(fields(r.op).map(k => [k, r[k as keyof StreamRequest]])))
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const fail = (reason: string): never => { throw new Error(`mac_stream_${reason}`) }
export function validateStreamRequest(request: StreamRequest): void {
  if (!request || request.version !== 1 || !['open', 'append', 'finish', 'abort'].includes(request.op)
    || !CAPTURE.test(request.captureId) || !TOKEN.test(request.generation) || !TOKEN.test(request.requestId)) fail('request')
  if (Object.keys(request).length !== fields(request.op).length || fields(request.op).some(k => !Object.hasOwn(request, k))) fail('fields')
  if (request.op === 'open') {
    if (!integer(request.startSample) || request.startSample % 160 !== 0 || request.startSample > 1_382_400_000 || !integer(request.firstChunkIndex) || request.firstChunkIndex >= 10_000_000) fail('start_sample')
  } else if (request.op === 'append') {
    if (!integer(request.originalChunkIndex) || !integer(request.startSample) || !integer(request.sampleCount)
      || request.sampleCount < 1 || request.sampleCount > STREAM_MAX_SAMPLES
      || !Number.isSafeInteger(request.startSample + request.sampleCount)
      || !SHA.test(request.audioSHA256 ?? '') || !SHA.test(request.pcmSHA256 ?? '')) fail('append_metadata')
    const encoded = request.pcmS16LEBase64
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(STREAM_MAX_PCM_BYTES / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('pcm')
    const pcm = Buffer.from(encoded!, 'base64')
    if (pcm.length !== request.sampleCount! * 2 || pcm.toString('base64') !== encoded
      || createHash('sha256').update(pcm).digest('hex') !== request.pcmSHA256) fail('pcm_hash')
  }
}
interface Pending {
  request: StreamRequest; resolve(value: StreamReceipt): void; reject(error: unknown): void
}
/** One capture generation, one exchange plus one queued request. Never resumable after failure. */
export class MacStreamDiarizer {
  private state: 'new' | 'open' | 'finished' | 'aborted' | 'failed' = 'new'
  private scope?: { captureId: string; generation: string }
  private watermark = 0
  private initialSample = 0
  private nextIndex = 0
  private nextFrame = 0
  private last?: { key: string; receipt: StreamReceipt }
  private terminal?: { key: string; receipt: StreamReceipt }
  private staged?: { key: string; request: StreamRequest; receipt: StreamReceipt }
  private active = false
  private queue?: Pending
  private controller?: AbortController
  private fence = 0
  private usedRequestIds = new Set<string>()
  private usedPCMHashes = new Set<string>()
  constructor(private readonly deps: StreamDependencies) {
    if (!Number.isSafeInteger(deps.deadlineMs ?? 1000) || (deps.deadlineMs ?? 1000) < 1 || (deps.deadlineMs ?? 1000) > 30_000) fail('deadline')
  }
  get status(): string { return this.state }
  private invalidate(): void {
    this.fence++; this.state = 'failed'; this.controller?.abort()
    this.staged = undefined
    this.queue?.reject(new Error('mac_stream_cancelled')); this.queue = undefined
  }
  /** Owner cancellation is immediate and fences an already-running/late transport callback. */
  cancel(): void { this.invalidate() }
  request(request: StreamRequest): Promise<StreamReceipt> {
    try { validateStreamRequest(request) } catch (error) { return Promise.reject(error) }
    const copy = { ...request }
    if (this.scope && (copy.captureId !== this.scope.captureId || copy.generation !== this.scope.generation)) return Promise.reject(new Error('mac_stream_scope'))
    if (this.active) {
      if (copy.op === 'abort') { this.invalidate(); return Promise.reject(new Error('mac_stream_cancelled')) }
      if (this.queue) { this.invalidate(); return Promise.reject(new Error('mac_stream_queue_overflow')) }
      return new Promise((resolve, reject) => { this.queue = { request: copy, resolve, reject } })
    }
    return this.dispatch(copy)
  }
  private async dispatch(request: StreamRequest): Promise<StreamReceipt> {
    this.active = true
    try { return await this.run(request) } finally {
      this.active = false
      const queued = this.queue; this.queue = undefined
      if (queued) void this.dispatch(queued.request).then(queued.resolve, queued.reject)
    }
  }
  private async run(request: StreamRequest): Promise<StreamReceipt> {
    const key = requestKey(request)
    if (this.state === 'failed') fail('generation_ended')
    if (this.scope && (request.captureId !== this.scope.captureId || request.generation !== this.scope.generation)) fail('scope')
    if (this.terminal) {
      if (this.terminal.key === key) return structuredClone(this.terminal.receipt)
      fail('terminal')
    }
    if (this.last?.key === key) return structuredClone(this.last.receipt)
    if (this.staged && this.staged.key !== key) fail('uncommitted')
    if (!this.staged) {
      if (this.usedRequestIds.has(request.requestId)) fail('request_conflict_or_evicted')
      if (request.op === 'append' && (this.usedPCMHashes.has(request.pcmSHA256!) || this.usedPCMHashes.size >= 4096)) fail('repeated_pcm_or_bound')
      if (request.op === 'open') {
        if (this.state !== 'new') fail('already_open')
        this.scope = { captureId: request.captureId, generation: request.generation }
      } else {
        if (this.state !== 'open') fail('not_open')
        if (request.op === 'append' && (request.startSample !== this.watermark
          || request.originalChunkIndex !== this.nextIndex)) fail('sequence')
      }
      const fence = this.fence
      const controller = this.controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const raw = await Promise.race([
          this.deps.exchange(Object.freeze({ ...request }), controller.signal),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('mac_stream_timeout')), this.deps.deadlineMs ?? 1000) }),
          new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('mac_stream_cancelled')), { once: true })),
        ])
        if (fence !== this.fence || controller.signal.aborted) fail('cancelled')
        const receipt = this.validateReceipt(request, raw)
        this.staged = { key, request, receipt }
      } catch (error) { this.invalidate(); throw error } finally { if (timer) clearTimeout(timer); this.controller = undefined }
    }
    const staged = this.staged!
    // No await between the cancellation fence, atomic durable acceptance and local publication.
    const fence = this.fence
    const accepted: unknown = this.deps.accept(Object.freeze({ ...staged.request }), Object.freeze(structuredClone(staged.receipt)))
    if (accepted && typeof (accepted as { then?: unknown }).then === 'function') { this.invalidate(); fail('async_accept') }
    if (fence !== this.fence) fail('cancelled')
    const receipt = staged.receipt
    this.scope = { captureId: request.captureId, generation: request.generation }
    this.watermark = receipt.consumedThroughSample
    this.nextFrame = receipt.frameStart + receipt.frameCount
    this.usedRequestIds.add(request.requestId)
    if (request.op === 'append') this.usedPCMHashes.add(request.pcmSHA256!)
    if (request.op === 'open') { this.nextIndex = request.firstChunkIndex!; this.initialSample = request.startSample! }
    if (request.op === 'append') this.nextIndex = request.originalChunkIndex! + 1
    this.state = receipt.state
    this.last = { key, receipt: structuredClone(receipt) }
    if (request.op === 'finish' || request.op === 'abort') this.terminal = this.last
    this.staged = undefined
    return structuredClone(receipt)
  }
  private validateReceipt(request: StreamRequest, raw: unknown): StreamReceipt {
    if (!raw || typeof raw !== 'object') fail('receipt')
    const r = raw as StreamReceipt
    const expectedEnd = request.op === 'open' ? request.startSample! : request.op === 'append' ? request.startSample! + request.sampleCount! : this.watermark
    const expectedFrame = request.op === 'open' ? request.startSample! / 160 : this.nextFrame
    const expectedIndex = request.op === 'open' ? request.firstChunkIndex! - 1 : request.op === 'append' ? request.originalChunkIndex! : this.nextIndex - 1
    const expectedState = request.op === 'finish' ? 'finished' : request.op === 'abort' ? 'aborted' : 'open'
    if (r.version !== 1 || r.op !== request.op || r.captureId !== request.captureId || r.generation !== request.generation
      || r.requestId !== request.requestId || r.state !== expectedState || r.consumedThroughChunkIndex !== expectedIndex || r.consumedThroughSample !== expectedEnd
      || r.frameStart !== expectedFrame || !integer(r.frameCount) || r.frameCount > 900 || r.numSpeakers !== 8
      || !Array.isArray(r.probabilities) || r.probabilities.length !== r.frameCount * 8
      || (request.op === 'open' || request.op === 'abort') && r.frameCount !== 0
      || (r.frameStart + r.frameCount) * 160 > expectedEnd + (request.op === 'finish' ? 160 : 0)) fail('receipt_shape')
    if (request.op === 'finish') {
      const initial = this.initialSample
      const count = expectedEnd - initial
      const exactFrames = count > 0 ? 1 + Math.floor((count + 512 - 400) / 160) : 0
      if (r.frameStart + r.frameCount !== initial / 160 + exactFrames) fail('finish_coverage')
    }
    for (let i = 0; i < r.probabilities.length; i++) {
      const p = r.probabilities[i]
      if (!Object.hasOwn(r.probabilities, i) || !Number.isFinite(p) || p < 0 || p > 1) fail('probability')
    }
    // Copy only protocol fields: ignored native instrumentation/extra payload cannot grow retained state.
    return { version: 1, op: r.op, captureId: r.captureId, generation: r.generation, requestId: r.requestId, state: r.state,
      consumedThroughSample: r.consumedThroughSample, consumedThroughChunkIndex: r.consumedThroughChunkIndex,
      frameStart: r.frameStart, frameCount: r.frameCount, numSpeakers: 8, probabilities: r.probabilities.slice() }
  }
}
