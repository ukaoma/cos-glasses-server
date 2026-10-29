import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { startMacSpeakerLiveCompute, takeMacSpeakerLivePublication, type MacSpeakerLiveComputeInput } from './mac-speaker-live-compute.js'
import { appendMacSpeakerLiveEvidence, createMacSpeakerLiveState, hashMacSpeakerLive } from './mac-speaker-live-memory.js'
import { planMacSpeakerWindows } from './mac-speaker-windows.js'

const h = hashMacSpeakerLive
const vector = (second = false) => [second ? 0 : 1, second ? 1 : 0, ...Array(190).fill(0)]
function fixture(): MacSpeakerLiveComputeInput {
  const captureId = 'mac_11111111-1111-4111-8111-111111111111', generation = 'adversarial-generation'
  const modelSHA256 = h('model')
  const bytes = Buffer.from(JSON.stringify({ profiles: [
    { name: 'Avery Sample', embeddings: [vector()] },
    { name: 'Blake Sample', embeddings: [vector(true)] },
  ] }))
  const profileSHA256 = createHash('sha256').update(bytes).digest('hex')
  const profiles = JSON.parse(bytes.toString()).profiles.map((p: object) => ({ ...p, profileSHA256 }))
  const rawChunks = Array.from({ length: 10 }, (_, chunkIndex) => ({ chunkIndex, audioSHA256: h(`wav${chunkIndex}`), pcmSHA256: h(`pcm${chunkIndex}`), sampleRate: 16000 as const, channels: 1 as const, format: 'pcm_s16le' as const, sampleCount: 96000, verified: true as const }))
  const chunksIndexed = rawChunks.map(r => ({ i: r.chunkIndex, c: { speaker: 'Voice 7', text: `Unchanged source ${r.chunkIndex}.`, elapsed: r.chunkIndex * 6000, audioDurationMs: 6000, audioSha256: r.audioSHA256, speakerPolicy: 'high-confidence' as const, similarity: 0, segments: [{ speaker: 'Voice 7', text: `Unchanged source ${r.chunkIndex}.`, startSec: 0, endSec: 6, similarity: 0 }] } }))
  const plan = planMacSpeakerWindows({ sidecar: { sessionId: captureId, chunkEntries: chunksIndexed.map(e => ({ chunkIndex: e.i, chunk: e.c })) }, rawChunks, correctionHistory: 'verified-clear' })
  let state = createMacSpeakerLiveState(captureId, generation, modelSHA256, profileSHA256, 7)
  for (const window of plan.windows) {
    const receipt = { windowId: window.id, windowBindingSHA256: window.bindingSHA256, modelSHA256, audioSHA256: h(`aggregate${window.id}`), pcmSHA256: h(`aggregate-pcm${window.id}`), sampleCount: 480000, embedding: vector(), halfEmbeddings: [vector(), vector()] as const }
    state = appendMacSpeakerLiveEvidence(state, { window, receipt, nativeReceiptSHA256: h({ window, receipt }) }, profiles, state.voiceHighWater)
  }
  expect(state.projections).toHaveLength(10)
  return { captureId, generation, modelSHA256, profileSHA256, profileJSONBytes: Uint8Array.from(bytes), chunksIndexed, rawChunks, state, sourceBindingSHA256: h(chunksIndexed), fileBindingsSHA256: h('immutable-resource-stamps'), revision: state.revision, voiceHighWater: state.voiceHighWater, humanHistory: false }
}
const binding = (input: MacSpeakerLiveComputeInput) => ({ captureId: input.captureId, generation: input.generation, sourceBindingSHA256: input.sourceBindingSHA256, fileBindingsSHA256: input.fileBindingsSHA256, revision: input.revision, voiceHighWater: input.voiceHighWater, mode: 'mac-native-v1' as const })

describe('live compute publication authority under hostile callers and worker lifecycle', () => {
  it('certifies only the real opaque token once, keeping public result mutations private', async () => {
    const input = fixture(), expected = binding(input)
    const session = await startMacSpeakerLiveCompute(input)
    const result = await session.finish()
    expect(takeMacSpeakerLivePublication({ kind: 'mac-speaker-live-compute' }, expected)).toBeNull()
    expect(takeMacSpeakerLivePublication(structuredClone(result.capability), expected)).toBeNull()
    result.state.projections[0].displayLabel = 'Forged Person'
    result.state.evidence[0].window.sources[0].audioSHA256 = h('forged-source')
    const publication = takeMacSpeakerLivePublication(result.capability, expected)!
    expect(publication.speakerProjectedChunksIndexed.map(e => e.c.speaker)).toEqual(Array(10).fill('Avery Sample'))
    expect(publication.speakerProjectedChunksIndexed.map(e => e.c.text)).toEqual(input.chunksIndexed.map(e => e.c.text))
    expect(publication.macSpeakerLive!.evidence[0].window.sources[0].audioSHA256).toBe(input.rawChunks[0].audioSHA256)
    expect(takeMacSpeakerLivePublication(result.capability, expected)).toBeNull()
  })

  it.each(['captureId', 'generation', 'sourceBindingSHA256', 'fileBindingsSHA256', 'revision', 'voiceHighWater', 'mode'] as const)('rejects and consumes a capability with stale %s', async key => {
    const input = fixture(), expected = binding(input), session = await startMacSpeakerLiveCompute(input)
    const result = await session.finish()
    const stale = { ...expected, [key]: typeof expected[key] === 'number' ? Number(expected[key]) + 1 : `${expected[key]}-changed` }
    expect(takeMacSpeakerLivePublication(result.capability, stale as typeof expected)).toBeNull()
    expect(takeMacSpeakerLivePublication(result.capability, expected)).toBeNull()
  })

  it('cannot rebind prepared source A to mutable caller source B across the worker await', async () => {
    const input = fixture(), original = binding(input), session = await startMacSpeakerLiveCompute(input)
    input.captureId = 'mac_22222222-2222-4222-8222-222222222222'
    input.generation = 'replacement-generation'
    input.sourceBindingSHA256 = h('replacement-source')
    input.fileBindingsSHA256 = h('replacement-files')
    input.revision += 50; input.voiceHighWater += 20
    const result = await session.finish()
    expect(result.state.captureId).toBe(original.captureId)
    expect(takeMacSpeakerLivePublication(result.capability, original)?.speakerGeneration).toBe(original.generation)
    expect(takeMacSpeakerLivePublication(result.capability, binding(input))).toBeNull()
  })

  it('rejects byte-profile drift before it can certify the supplied state', async () => {
    const input = fixture()
    input.profileJSONBytes = Uint8Array.from(Buffer.from('{"profiles":[]}'))
    await expect(startMacSpeakerLiveCompute(input)).rejects.toThrow('compute_profile_bytes_changed')
    const next = await startMacSpeakerLiveCompute(fixture()); await next.close()
  })

  it('does not retain a publication after cancellation or accept an unrequested receipt', async () => {
    const cancelled = await startMacSpeakerLiveCompute(fixture())
    await cancelled.close()
    await expect(cancelled.finish()).rejects.toThrow('compute_not_available')
    const input = fixture(), next = await startMacSpeakerLiveCompute(input)
    await expect(next.finish(input.state!.evidence[0].receipt)).rejects.toThrow('compute_unrequested_receipt')
    const after = await startMacSpeakerLiveCompute(fixture()); await after.close()
  })

  it('holds admission until a timed-out real worker has confirmed exit', async () => {
    let exited = false
    const worker = new Worker('setInterval(()=>{}, 1000)', { eval: true })
    worker.once('exit', () => { exited = true })
    await expect(startMacSpeakerLiveCompute(fixture(), { timeoutMs: 30, workerFactory: () => worker })).rejects.toThrow('compute_timeout')
    expect(exited).toBe(true)
    const after = await startMacSpeakerLiveCompute(fixture()); await after.close()
  })

  it('releases the lane after a worker exits between prepare and finish, with no publication', async () => {
    const worker = new Worker(`const {parentPort}=require('node:worker_threads');parentPort.once('message',m=>{parentPort.postMessage({id:m.id,job:m.job,ok:true,value:{plannedWindows:0,pendingWindows:0,rejectedChunks:0}});setTimeout(()=>process.exit(0),5)})`, { eval: true })
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()))
    const session = await startMacSpeakerLiveCompute(fixture(), { workerFactory: () => worker })
    try {
      await exited
      await expect(session.finish()).rejects.toThrow()
      const after = await startMacSpeakerLiveCompute(fixture()); await after.close()
    } finally { await session.close() }
  })
})
