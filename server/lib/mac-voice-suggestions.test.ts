// On-click voice suggestions (6.96.3). Fictional people, invented audio. The extractor is a fake that reads a code
// out of the PCM, so choosing the wrong slice of a chunk produces the wrong voice and a test fails. The study parity
// on real copied audio lives in the canary, not here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SPEAKER_SHADOW_LIVE_LEASES } from './speaker-shadow.js'
import { readPcm16Mono } from './nemotron-segments.js'
import {
  HIGH_CONFIDENCE_FLOOR,
  HIGH_CONFIDENCE_MARGIN,
  VOICE_SUGGESTION_DEADLINE_MS,
  VOICE_SUGGESTION_FLOOR,
  VOICE_SUGGESTION_MARGIN,
  VOICE_SUGGESTION_NEVER_NAMES,
  VOICE_SUGGESTION_PAUSE_LEASES,
  VoiceSuggestionRunner,
  buildVoiceBank,
  combineVoiceDecisions,
  currentVoiceSuggestions,
  decideVoiceSuggestion,
  isHighConfidenceVoiceSuggestion,
  neverSuggested,
  passesVoiceSuggestionRule,
  resetVoiceSuggestionRunnerForTests,
  voiceSidecarEntries,
  voiceSuggestionPauseLease,
  voiceSuggestionRecordingLease,
  voiceUnitCandidates,
  type StoredVoiceProfile,
  type VoiceBankEntry,
  type VoiceDecision,
  type VoiceSidecarEntry,
  type VoiceSuggestionBlock,
  type VoiceSuggestionDeps,
  type VoiceSuggestionsBody,
  type VoiceUnitVector,
} from './mac-voice-suggestions.js'

const MAC = 'mac_1b2c3d4e-0000-4000-8000-00000000abcd'
const MAC2 = 'mac_1b2c3d4e-0000-4000-8000-00000000ffff'
const DIM = 192

/** Orthonormal axes, so a score is exactly the coefficient on that person's axis. */
const axis = (i: number): number[] => { const v = new Array<number>(DIM).fill(0); v[i] = 1; return v }
/** A unit vector scoring `a` against axis 0, `b` against axis 1, the rest on axis 100. */
function aimed(a: number, b = 0): number[] {
  const v = new Array<number>(DIM).fill(0)
  v[0] = a
  v[1] = b
  v[100] = Math.sqrt(Math.max(0, 1 - a * a - b * b))
  return v
}
const bankOf = (...names: string[]): VoiceBankEntry[] => names.map((name, i) => ({ name, centroid: axis(i), samples: 3 }))
const vectors = (v: number[], n: number, sec = 6): VoiceUnitVector[] => Array.from({ length: n }, () => ({ unit: v, sec }))

describe('the frozen rule', () => {
  it('is .70 and .05, exactly as fresh-ear-192-v1/policy.json froze it', () => {
    expect(VOICE_SUGGESTION_FLOOR).toBe(0.7)
    expect(VOICE_SUGGESTION_MARGIN).toBe(0.05)
    expect(VOICE_SUGGESTION_NEVER_NAMES).toEqual(['MU'])
    expect(VOICE_SUGGESTION_DEADLINE_MS).toBe(360_000)
  })

  it('is inclusive at both edges and fails just under either', () => {
    expect(passesVoiceSuggestionRule(VOICE_SUGGESTION_FLOOR, VOICE_SUGGESTION_MARGIN)).toBe(true)
    expect(passesVoiceSuggestionRule(VOICE_SUGGESTION_FLOOR - 1e-9, VOICE_SUGGESTION_MARGIN)).toBe(false)
    expect(passesVoiceSuggestionRule(VOICE_SUGGESTION_FLOOR, VOICE_SUGGESTION_MARGIN - 1e-9)).toBe(false)
  })

  it('a voice under the floor gets no suggestion even with a huge margin', () => {
    const d = decideVoiceSuggestion(['Voice 1'], vectors(aimed(0.69), 5), bankOf('Dana Reyes', 'Theo Marsh'))
    expect(d.gate).toBe('below_rule')
    expect(d.top?.name).toBe('Dana Reyes')
    expect(d.top?.score).toBeCloseTo(0.69, 6)
  })

  it('a voice over the floor passes', () => {
    const d = decideVoiceSuggestion(['Voice 1'], vectors(aimed(0.71), 5), bankOf('Dana Reyes', 'Theo Marsh'))
    expect(d.gate).toBeNull()
    expect(d.top?.name).toBe('Dana Reyes')
    expect(d.margin).toBeCloseTo(0.71, 6)
  })

  it('a clear top score with too small a margin gets no suggestion', () => {
    const d = decideVoiceSuggestion(['Voice 1'], vectors(aimed(0.72, 0.68), 5), bankOf('Dana Reyes', 'Theo Marsh'))
    expect(d.top?.score).toBeCloseTo(0.72, 6)
    expect(d.margin).toBeCloseTo(0.04, 6)
    expect(d.gate).toBe('below_rule')
    expect(decideVoiceSuggestion(['Voice 1'], vectors(aimed(0.72, 0.66), 5), bankOf('Dana Reyes', 'Theo Marsh')).gate).toBeNull()
  })

  it('needs someone to beat: one profile cannot prove a margin', () => {
    expect(decideVoiceSuggestion(['Voice 1'], vectors(aimed(0.9), 5), bankOf('Dana Reyes')).gate).toBe('below_rule')
  })
})

describe('MU is never suggested, but stays in the bank', () => {
  it('a voice closest to MU gets no suggestion, and the runner-up is not promoted', () => {
    const d = decideVoiceSuggestion(['Voice 1'], vectors(aimed(0.95, 0.1), 5), bankOf('MU', 'Dana Reyes'))
    expect(d.top?.name).toBe('MU')
    expect(d.gate).toBe('below_rule')
  })

  it('MU still counts against the margin', () => {
    // Dana leads, MU is close behind: the margin fails only because MU is in the bank.
    const close = vectors(aimed(0.8, 0.78), 5)
    expect(decideVoiceSuggestion(['Voice 1'], close, bankOf('Dana Reyes', 'MU')).gate).toBe('below_rule')
    expect(decideVoiceSuggestion(['Voice 1'], close, bankOf('Dana Reyes', 'Absent One', 'Absent Two')).gate).toBe('below_rule')
  })

  it('this Mac\'s owner label is treated the same, in any spelling of case', () => {
    expect(neverSuggested('MU')).toBe(true)
    expect(neverSuggested(' mu ')).toBe(true)
    expect(neverSuggested('Dana Reyes', 'Theo Marsh')).toBe(false)
    expect(neverSuggested('Theo Marsh', 'theo marsh')).toBe(true)
    expect(decideVoiceSuggestion(['Voice 1'], vectors(aimed(0.95), 5), bankOf('Theo Marsh', 'Dana Reyes'), 'Theo Marsh').gate).toBe('below_rule')
  })

  it('keeps MU in the bank', () => {
    expect(buildVoiceBank([{ name: 'MU', embeddings: [axis(0)], sources: ['g2-training'] }], MAC).map(b => b.name)).toEqual(['MU'])
  })
})

describe('buildVoiceBank', () => {
  it('drops any sample whose source names this capture, so naming on this call cannot echo', () => {
    const bank = buildVoiceBank([
      { name: 'Dana Reyes', embeddings: [axis(0), axis(1), axis(2)], sources: [`mac-assign:${MAC}`, `correction:${MAC}:7`, 'mac-assign:mac_other'] },
      { name: 'Only Here', embeddings: [axis(3)], sources: [`auto:${MAC}`] },
    ], MAC)
    expect(bank.map(b => b.name)).toEqual(['Dana Reyes'])
    expect(bank[0].samples).toBe(1)
    expect(bank[0].centroid[2]).toBeCloseTo(1, 9)
    expect(bank[0].centroid[0]).toBe(0)
  })

  it('reads only 192d samples, and keeps the source of each sample aligned', () => {
    const bank = buildVoiceBank([{ name: 'Dana Reyes', embeddings: [new Array(256).fill(1), axis(4), axis(5)], sources: ['fireflies', `auto:${MAC}`, 'fireflies'] }], MAC)
    expect(bank[0].samples).toBe(1)
    expect(bank[0].centroid[5]).toBeCloseTo(1, 9)
  })

  it('takes the unit-normalized mean: a loud sample does not outweigh a quiet one', () => {
    const loud = axis(0).map(x => x * 40)
    const [entry] = buildVoiceBank([{ name: 'Dana Reyes', embeddings: [loud, axis(1)] }], MAC)
    expect(entry.centroid[0]).toBeCloseTo(Math.SQRT1_2, 9)
    expect(entry.centroid[1]).toBeCloseTo(Math.SQRT1_2, 9)
  })

  it('a zero or non-finite sample is ignored, not a NaN in everyone\'s score', () => {
    const [entry] = buildVoiceBank([{ name: 'Dana Reyes', embeddings: [new Array(DIM).fill(0), [Number.NaN, ...axis(0).slice(1)], axis(6)] }], MAC)
    expect(entry.samples).toBe(1)
    expect(entry.centroid.every(Number.isFinite)).toBe(true)
  })

  it('a profile with no sources still counts', () => {
    expect(buildVoiceBank([{ name: 'Dana Reyes', embeddings: [axis(0)] }], MAC)[0].samples).toBe(1)
  })
})

describe('gates, in the study\'s order', () => {
  const bank = bankOf('Dana Reyes', 'Theo Marsh')
  const good = aimed(0.9)

  it('no audio', () => {
    expect(decideVoiceSuggestion(['Voice 1'], [], bank)).toMatchObject({ gate: 'no_usable_audio', units: 0, kept: 0 })
  })

  it('a crowd with no agreement has no dominant voice', () => {
    const crowd = [10, 20, 30, 40].map(i => ({ unit: axis(i), sec: 6 }))
    expect(decideVoiceSuggestion(['Voice 1'], crowd, bank)).toMatchObject({ gate: 'no_dominant_voice', units: 4, kept: 0 })
  })

  it('units thrown out and under two thirds kept is mixed, though the top match is still reported', () => {
    const mix = [...vectors(good, 3), ...[10, 20].map(i => ({ unit: axis(i), sec: 6 }))]
    expect(decideVoiceSuggestion(['Voice 1'], mix, bank)).toMatchObject({ gate: 'mixed_voice', units: 5, kept: 3, top: { name: 'Dana Reyes' } })
  })

  it('exactly two thirds kept is not mixed, and nothing thrown out never is', () => {
    const two = [...vectors(good, 2), { unit: axis(10), sec: 6 }]
    expect(decideVoiceSuggestion(['Voice 1'], two, bank)).toMatchObject({ gate: null, units: 3, kept: 2 })
    expect(decideVoiceSuggestion(['Voice 1'], vectors(good, 2), bank)).toMatchObject({ gate: null, units: 2, kept: 2 })
  })

  it('one unit under 6 s is too little; one unit of 6 s is enough', () => {
    expect(decideVoiceSuggestion(['Voice 1'], vectors(good, 1, 5.9), bank)).toMatchObject({ gate: 'too_little_audio', kept: 1 })
    expect(decideVoiceSuggestion(['Voice 1'], vectors(good, 1, 6), bank)).toMatchObject({ gate: null, kept: 1 })
  })

  it('two short units are enough', () => {
    expect(decideVoiceSuggestion(['Voice 1'], vectors(good, 2, 2.5), bank).gate).toBeNull()
  })
})

// ── Audio ────────────────────────────────────────────────────────────────────

const SR = 16_000
/** A WAV of parts, each a constant PCM code, so the fake extractor can see exactly what it was handed. */
function wav(...parts: Array<[seconds: number, code: number]>): Buffer {
  const samples = parts.reduce((n, [s]) => n + Math.round(s * SR), 0)
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40)
  let at = 44
  for (const [s, code] of parts) for (let i = 0; i < Math.round(s * SR); i++) { b.writeInt16LE(code, at); at += 2 }
  return b
}
/** Which person (axis) a WAV holds. Audio holding two codes returns an axis nobody owns, so a bad slice cannot pass. */
function fakeExtract(audio: Buffer): Float32Array {
  const pcm = readPcm16Mono(audio)!.pcm
  const codes = new Set<number>()
  for (let i = 0; i < pcm.length; i += 2) codes.add(pcm.readInt16LE(i))
  const v = new Float32Array(DIM)
  if (codes.size === 1) v[[...codes][0]] = 1
  else v[190] = 1
  return v
}
const CODE = { dana: 0, theo: 1, stranger: 20, ana: 2 }
const profiles = (): StoredVoiceProfile[] => [
  { name: 'MU', embeddings: [axis(5)], sources: ['g2-training'] },
  { name: 'Dana Reyes', embeddings: [axis(CODE.dana), axis(CODE.dana)], sources: ['fireflies', 'g2-training'] },
  { name: 'Theo Marsh', embeddings: [axis(CODE.theo)], sources: ['fireflies'] },
  { name: 'Ana Silva', embeddings: [axis(CODE.ana)], sources: ['fireflies'] },
]

interface Rig {
  dir: string
  runner: VoiceSuggestionRunner
  extracts: number
  yields: number
  deps: Partial<VoiceSuggestionDeps>
}
let dir = ''
let rig: Rig

function makeRig(over: Partial<VoiceSuggestionDeps> = {}): Rig {
  const r: Rig = { dir, runner: null as never, extracts: 0, yields: 0, deps: {} }
  const deps: Partial<VoiceSuggestionDeps> = {
    available: () => true,
    extract: audio => { r.extracts += 1; return fakeExtract(audio) },
    readProfiles: () => ({ profiles: profiles() }),
    audioPath: (session, raw) => { const p = join(dir, `${session}_${raw}.wav`); return existsSync(p) ? p : null },
    ownerLabel: () => 'MU',
    log: () => {},
    yieldToLoop: async () => { r.yields += 1; await new Promise<void>(resolve => setImmediate(resolve)) },
    ...over,
  }
  r.deps = deps
  r.runner = new VoiceSuggestionRunner(deps)
  return r
}

function chunkFiles(session: string, chunks: Record<number, Buffer>): void {
  for (const [raw, data] of Object.entries(chunks)) writeFileSync(join(dir, `${session}_${raw}.wav`), data)
}

const entry = (raw: number, speaker: string, turns?: Array<[string, number, number]>): VoiceSidecarEntry => ({
  chunkIndex: raw,
  chunk: { speaker, text: 'invented', ...(turns ? { segments: turns.map(([s, startSec, endSec]) => ({ speaker: s, startSec, endSec })) } : {}) },
})

async function settled(runner: VoiceSuggestionRunner, session: string, revision: string): Promise<VoiceSuggestionsBody> {
  for (let i = 0; i < 2000; i++) {
    const now = runner.read(session, revision)
    if (now.state !== 'running') return now
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('job never settled')
}

function input(over: Partial<Parameters<VoiceSuggestionRunner['start']>[0]> & { entries: VoiceSidecarEntry[]; scopes?: string[][] }) {
  const { scopes, ...rest } = over
  return {
    sessionId: MAC,
    sourceRevision: 'rev-1',
    block: (): VoiceSuggestionBlock | null => null,
    pause: () => false,
    loadScopes: async () => scopes ?? [['Voice 1']],
    ...rest,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voice-suggest-'))
  rig = makeRig()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('which audio a voice gets', () => {
  it('whole chunk when every turn is that voice or there are no turns', () => {
    const entries = [entry(0, 'Voice 1'), entry(1, 'Voice 1', [['Voice 1', 0, 2], ['Voice 1', 2, 6]])]
    expect(voiceUnitCandidates(entries, 'Voice 1')).toEqual([{ raw: 0, slice: null }, { raw: 1, slice: null }])
  })

  it('in a mixed chunk, only that voice\'s turns of 3 s or more, inset .15 s', () => {
    const entries = [entry(4, 'Voice 1', [['Voice 1', 0, 3.5], ['Voice 2', 3.5, 4.5], ['Voice 1', 4.5, 6]])]
    expect(voiceUnitCandidates(entries, 'Voice 1')).toEqual([{ raw: 4, slice: { startSec: 0.15, endSec: 3.35 } }])
    expect(voiceUnitCandidates(entries, 'Voice 2')).toEqual([])
  })

  it('a 3.0 s turn counts; 2.99 s does not', () => {
    expect(voiceUnitCandidates([entry(1, 'Voice 2', [['Voice 1', 0, 3], ['Voice 2', 3, 6]])], 'Voice 1')).toHaveLength(1)
    expect(voiceUnitCandidates([entry(1, 'Voice 2', [['Voice 1', 0, 2.99], ['Voice 2', 2.99, 6]])], 'Voice 1')).toHaveLength(0)
  })

  it('a chunk labelled someone else still gives up this voice\'s long turn', () => {
    expect(voiceUnitCandidates([entry(9, 'Voice 2', [['Voice 2', 0, 2], ['Voice 1', 2, 6]])], 'Voice 1')).toEqual([{ raw: 9, slice: { startSec: 2.15, endSec: 5.85 } }])
  })

  it('a chunk that never mentions the voice gives nothing, even with no turns', () => {
    expect(voiceUnitCandidates([entry(0, 'Voice 2')], 'Voice 1')).toEqual([])
  })

  it('final turns win over live ones, as everywhere else', () => {
    const e: VoiceSidecarEntry = { chunkIndex: 3, chunk: { speaker: 'Voice 1', segments: [{ speaker: 'Voice 2', startSec: 0, endSec: 6 }], finalSegments: [{ speaker: 'Voice 1', startSec: 0, endSec: 6 }] } }
    expect(voiceUnitCandidates([e], 'Voice 1')).toEqual([{ raw: 3, slice: null }])
  })

  it('sorts by call order whatever the sidecar order', () => {
    expect(voiceUnitCandidates([entry(5, 'Voice 1'), entry(2, 'Voice 1')], 'Voice 1').map(u => u.raw)).toEqual([2, 5])
  })

  it('keeps only rows that can address audio', () => {
    const rows = [{ chunkIndex: 1, chunk: {} }, { chunkIndex: 'x', chunk: {} }, { chunkIndex: 2 }, null]
    expect(voiceSidecarEntries({ chunks: [], chunkEntries: rows })?.map(e => e.chunkIndex)).toEqual([1])
  })

  it('cannot line the two lists up, so it says so rather than guessing', () => {
    expect(voiceSidecarEntries({})).toBeNull()
    expect(voiceSidecarEntries({ chunks: [] })).toBeNull()
    expect(voiceSidecarEntries({ chunkEntries: [] })).toBeNull()
    expect(voiceSidecarEntries({ chunks: [{ speaker: 'Voice 1', text: 'a' }], chunkEntries: [] })).toBeNull()
  })

  it('skips a row whose current chunk was renamed, for every voice, and keeps silent rows', () => {
    const row = (chunkIndex: number, speaker: string, text = 'invented', extra: Record<string, unknown> = {}) => ({ chunkIndex, chunk: { speaker, text, ...extra } })
    const entries = voiceSidecarEntries({
      // What POST /relabel leaves behind: `chunks[]` says Theo Marsh at position 1, the entries still say Voice 3.
      chunks: [{ speaker: 'Voice 3', text: 'a' }, { speaker: 'Theo Marsh', text: 'b' }, { speaker: 'Voice 3', text: 'c' }],
      chunkEntries: [
        row(4, 'Voice 3'),
        row(5, 'Voice 3', '   '),
        row(6, 'Voice 3', 'b', { segments: [{ speaker: 'Voice 3', startSec: 0, endSec: 3 }, { speaker: 'Voice 8', startSec: 3, endSec: 6 }] }),
        row(9, 'Voice 3'),
      ],
    })
    expect(entries?.map(e => e.chunkIndex)).toEqual([4, 5, 9])
    expect(voiceUnitCandidates(entries!, 'Voice 8')).toEqual([])
  })

  it('slices the right samples, skips audio under 2 s, and a whole chunk under 2 s', async () => {
    chunkFiles(MAC, {
      0: wav([3.5, CODE.dana], [2.5, CODE.theo]),  // slice of Voice 1 is pure Dana
      1: wav([1.9, CODE.dana]),                     // whole but under 2 s: skipped
      2: wav([3.0, CODE.dana]),                     // turn claims 6 s but the file ends at 3: slice is 2.85 s
      3: wav([2.0, CODE.dana]),                     // whole at exactly 2 s: usable
      4: wav([2.1, CODE.dana]),                     // the turn runs off the end, leaving under 2 s: skipped
    })
    const entries = [
      entry(0, 'Voice 1', [['Voice 1', 0, 3.5], ['Voice 2', 3.5, 6]]),
      entry(1, 'Voice 1'),
      entry(2, 'Voice 1', [['Voice 1', 0, 6], ['Voice 2', 5, 6]]),
      entry(3, 'Voice 1'),
      entry(4, 'Voice 1', [['Voice 1', 0, 6], ['Voice 2', 5, 6]]),
    ]
    rig.runner.start(input({ entries }))
    const done = await settled(rig.runner, MAC, 'rev-1')
    expect(rig.extracts).toBe(3)
    expect(done.suggestions).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', score: 1, margin: 1, units: 3, kept: 3, requiresConfirmation: true, highConfidence: true }])
  })

  it('at most 40 units, spread across the voice, from usable audio only', async () => {
    const entries: VoiceSidecarEntry[] = []
    const chunks: Record<number, Buffer> = {}
    const used: number[] = []
    for (let raw = 0; raw < 100; raw++) { entries.push(entry(raw, 'Voice 1')); chunks[raw] = wav([raw % 2 ? 1 : 6, CODE.dana]) }
    chunkFiles(MAC, chunks)
    const r = makeRig({ extract: (audio, unit) => { used.push(unit.raw); return fakeExtract(audio) } })
    r.runner.start(input({ entries }))
    const done = await settled(r.runner, MAC, 'rev-1')
    expect(used).toHaveLength(40)
    expect(used.every(raw => raw % 2 === 0)).toBe(true)   // the short ones never took a slot
    expect(used[0]).toBe(0)
    expect(used[39]).toBeGreaterThan(90)                  // reaches the end of the call
    expect(done.progress).toEqual({ done: 40, total: 40 })
    expect(done.suggestions?.[0].units).toBe(40)
  })

  it('the cap covers each label, not the group: nothing is pooled', async () => {
    const entries: VoiceSidecarEntry[] = []
    const chunks: Record<number, Buffer> = {}
    for (let raw = 0; raw < 50; raw++) { entries.push(entry(raw, 'Voice 1'), entry(raw + 100, 'Voice 2')); chunks[raw] = wav([6, CODE.theo]); chunks[raw + 100] = wav([6, CODE.theo]) }
    chunkFiles(MAC, chunks)
    rig.runner.start(input({ entries, scopes: [['Voice 1', 'Voice 2']] }))
    const done = await settled(rig.runner, MAC, 'rev-1')
    expect(rig.extracts).toBe(80)
    expect(done.progress).toEqual({ done: 80, total: 80 })
    expect(done.suggestions).toEqual([{ labels: ['Voice 1', 'Voice 2'], name: 'Theo Marsh', score: 1, margin: 1, units: 80, kept: 80, requiresConfirmation: true, highConfidence: true }])
  })
})

describe('every label is scored on its own', () => {
  /** Runs one group through the real runner. Audio codes pick the axis, so `at` sets each unit's score against Dana. */
  async function group(voices: Record<string, { units: number; vector?: number[]; code?: number; sec?: number }>, scopes?: string[][]) {
    const entries: VoiceSidecarEntry[] = []
    const chunks: Record<number, Buffer> = {}
    const byRaw = new Map<number, number[] | null>()
    let raw = 0
    for (const [label, voice] of Object.entries(voices)) {
      for (let i = 0; i < voice.units; i++, raw++) {
        entries.push(entry(raw, label))
        chunks[raw] = wav([voice.sec ?? 6, voice.code ?? CODE.dana])
        byRaw.set(raw, voice.vector ?? null)
      }
    }
    chunkFiles(MAC, chunks)
    const r = makeRig({ extract: (audio, unit) => { const v = byRaw.get(unit.raw); return v ? Float32Array.from(v) : fakeExtract(audio) } })
    r.runner.start(input({ entries, scopes: scopes ?? [Object.keys(voices)] }))
    return settled(r.runner, MAC, 'rev-1')
  }

  it('the probe: 37 of one person and 3 of a stranger never name the stranger', async () => {
    const done = await group({ 'Voice 1': { units: 37, code: CODE.dana }, 'Voice 9': { units: 3, code: CODE.stranger } })
    expect(done.suggestions).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', score: 1, margin: 1, units: 37, kept: 37, requiresConfirmation: true, highConfidence: true }])
    expect(done.unmatched).toEqual([{ labels: ['Voice 9'], gate: 'below_rule' }])
  })

  it('agreement: labels that each pass for one person share a suggestion at the lowest score and margin', async () => {
    const done = await group({ 'Voice 1': { units: 3, vector: aimed(0.95, 0.1) }, 'Voice 2': { units: 3, vector: aimed(0.85, 0.2) } })
    expect(done.unmatched).toEqual([])
    expect(done.suggestions).toEqual([{ labels: ['Voice 1', 'Voice 2'], name: 'Dana Reyes', score: 0.85, margin: 0.65, units: 6, kept: 6, requiresConfirmation: true, highConfidence: true }])
  })

  it('agreement below the high-confidence bar: one member under it clears the flag for all', async () => {
    const done = await group({ 'Voice 1': { units: 3, vector: aimed(0.95) }, 'Voice 2': { units: 3, vector: aimed(0.75) } })
    expect(done.suggestions).toEqual([{ labels: ['Voice 1', 'Voice 2'], name: 'Dana Reyes', score: 0.75, margin: 0.75, units: 6, kept: 6, requiresConfirmation: true, highConfidence: false }])
  })

  it('disagreement: a member that passed for someone else gets its own suggestion', async () => {
    const done = await group({ 'Voice 1': { units: 3, code: CODE.dana }, 'Voice 2': { units: 3, code: CODE.theo }, 'Voice 3': { units: 3, code: CODE.dana } })
    expect(done.suggestions?.map(s => [s.labels, s.name])).toEqual([[['Voice 1', 'Voice 3'], 'Dana Reyes'], [['Voice 2'], 'Theo Marsh']])
    expect(done.unmatched).toEqual([])
  })

  it('a member with too little audio is unmatched with its own gate, and the rest still pass', async () => {
    const done = await group({ 'Voice 1': { units: 3, code: CODE.dana }, 'Voice 2': { units: 1, code: CODE.dana, sec: 3 } })
    expect(done.suggestions?.map(s => s.labels)).toEqual([['Voice 1']])
    expect(done.unmatched).toEqual([{ labels: ['Voice 2'], gate: 'too_little_audio' }])
  })

  it('a member with no audio at all is unmatched as such', async () => {
    const done = await group({ 'Voice 1': { units: 3, code: CODE.dana } }, [['Voice 1', 'Voice 2']])
    expect(done.unmatched).toEqual([{ labels: ['Voice 2'], gate: 'no_usable_audio' }])
  })

  it('a member closest to MU is unmatched, and cannot ride along with the group', async () => {
    const done = await group({ 'Voice 1': { units: 3, code: CODE.dana }, 'Voice 2': { units: 3, code: 5 } }, [['Voice 1', 'Voice 2']])
    expect(done.suggestions?.map(s => s.labels)).toEqual([['Voice 1']])
    expect(done.unmatched).toEqual([{ labels: ['Voice 2'], gate: 'below_rule' }])
  })

  it('never lists a label whose own decision did not pass, whatever the mix', () => {
    const pass = (label: string, name: string, score: number, margin: number): VoiceDecision => ({ labels: [label], units: 3, kept: 3, keptSec: 18, gate: null, top: { name, score }, margin })
    const fail = (label: string, gate: VoiceDecision['gate']): VoiceDecision => ({ labels: [label], units: 3, kept: 1, keptSec: 6, gate, top: { name: 'Dana Reyes', score: 0.99 }, margin: 0.9 })
    const decisions = new Map<string, VoiceDecision>([
      ['Voice 1', pass('Voice 1', 'Dana Reyes', 0.9, 0.3)],
      ['Voice 2', fail('Voice 2', 'mixed_voice')],
      ['Voice 3', pass('Voice 3', 'Dana Reyes', 0.72, 0.06)],
      ['Voice 4', pass('Voice 4', 'Theo Marsh', 0.81, 0.2)],
      ['Voice 5', fail('Voice 5', 'below_rule')],
    ])
    expect(combineVoiceDecisions([['Voice 1', 'Voice 2', 'Voice 3'], ['Voice 4'], ['Voice 5'], ['Voice 6']], decisions)).toEqual({
      suggestions: [
        { labels: ['Voice 1', 'Voice 3'], name: 'Dana Reyes', score: 0.72, margin: 0.06, units: 6, kept: 6, requiresConfirmation: true, highConfidence: false },
        { labels: ['Voice 4'], name: 'Theo Marsh', score: 0.81, margin: 0.2, units: 3, kept: 3, requiresConfirmation: true, highConfidence: true },
      ],
      unmatched: [{ labels: ['Voice 2'], gate: 'mixed_voice' }, { labels: ['Voice 5'], gate: 'below_rule' }, { labels: ['Voice 6'], gate: 'no_usable_audio' }],
    })
  })

  it('does not merge across scopes: two singles for one person stay two suggestions', () => {
    const pass = (label: string): VoiceDecision => ({ labels: [label], units: 3, kept: 3, keptSec: 18, gate: null, top: { name: 'Dana Reyes', score: 0.9 }, margin: 0.3 })
    const { suggestions } = combineVoiceDecisions([['Voice 1'], ['Voice 2']], new Map([['Voice 1', pass('Voice 1')], ['Voice 2', pass('Voice 2')]]))
    expect(suggestions.map(s => s.labels)).toEqual([['Voice 1'], ['Voice 2']])
  })
})

describe('a job from click to result', () => {
  const twoVoices = () => {
    chunkFiles(MAC, { 0: wav([6, CODE.dana]), 1: wav([6, CODE.dana]), 2: wav([6, CODE.stranger]), 3: wav([6, CODE.stranger]) })
    return [entry(0, 'Voice 1'), entry(1, 'Voice 1'), entry(2, 'Voice 2'), entry(3, 'Voice 2')]
  }

  it('idle until started; running then done; suggestion and unmatched each carry the labels', async () => {
    expect(rig.runner.read(MAC, 'rev-1')).toEqual({ state: 'idle', rule: { floor: 0.7, margin: 0.05 }, modelSpace: '192d', sourceRevision: 'rev-1' })
    expect(rig.extracts).toBe(0)
    const started = rig.runner.start(input({ entries: twoVoices(), scopes: [['Voice 1'], ['Voice 2'], ['Voice 3']] }))
    expect(started).toEqual({ state: 'running', progress: { done: 0, total: 0 }, rule: { floor: 0.7, margin: 0.05 }, modelSpace: '192d', sourceRevision: 'rev-1' })
    const done = await settled(rig.runner, MAC, 'rev-1')
    expect(done).toEqual({
      state: 'done',
      progress: { done: 4, total: 4 },
      rule: { floor: 0.7, margin: 0.05 },
      modelSpace: '192d',
      sourceRevision: 'rev-1',
      suggestions: [{ labels: ['Voice 1'], name: 'Dana Reyes', score: 1, margin: 1, units: 2, kept: 2, requiresConfirmation: true, highConfidence: true }],
      unmatched: [{ labels: ['Voice 2'], gate: 'below_rule' }, { labels: ['Voice 3'], gate: 'no_usable_audio' }],
    })
  })

  it('a second click while running or after done returns the same job and extracts nothing more', async () => {
    const entries = twoVoices()
    const first = rig.runner.start(input({ entries }))
    expect(rig.runner.start(input({ entries })).state).toBe('running')
    expect(first.state).toBe('running')
    await settled(rig.runner, MAC, 'rev-1')
    const count = rig.extracts
    expect(rig.runner.start(input({ entries })).state).toBe('done')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(rig.extracts).toBe(count)
  })

  it('a result counts only for its own revision', async () => {
    const entries = twoVoices()
    rig.runner.start(input({ entries }))
    await settled(rig.runner, MAC, 'rev-1')
    expect(rig.runner.read(MAC, 'rev-1').state).toBe('done')
    expect(rig.runner.read(MAC, 'rev-2')).toEqual({ state: 'idle', rule: { floor: 0.7, margin: 0.05 }, modelSpace: '192d', sourceRevision: 'rev-2' })
    const again = rig.runner.start(input({ entries, sourceRevision: 'rev-2' }))
    expect(again).toMatchObject({ state: 'running', sourceRevision: 'rev-2' })
    await settled(rig.runner, MAC, 'rev-2')
    expect(rig.runner.read(MAC, 'rev-1').state).toBe('idle')
  })

  it('a click on a changed meeting replaces its running job, and the old one stops extracting', async () => {
    const entries = twoVoices()
    const r = makeRig({ extract: audio => { r.extracts += 1; if (r.extracts === 1) r.runner.start(input({ entries, sourceRevision: 'rev-2' })); return fakeExtract(audio) } })
    r.runner.start(input({ entries, sourceRevision: 'rev-1' }))
    while (r.extracts === 0) await new Promise<void>(resolve => setImmediate(resolve))
    const done = await settled(r.runner, MAC, 'rev-2')
    expect(done.state).toBe('done')
    expect(done.progress).toEqual({ done: 2, total: 2 })
    // One extraction from the replaced job, then only the new job's two.
    expect(r.extracts).toBe(3)
    expect(r.runner.read(MAC, 'rev-1').state).toBe('idle')
    // The lane is free again.
    chunkFiles(MAC2, { 0: wav([6, CODE.dana]) })
    expect(r.runner.start(input({ sessionId: MAC2, entries: [entry(0, 'Voice 1')] })).state).toBe('running')
    await settled(r.runner, MAC2, 'rev-1')
  })

  it('yields to the server before every extraction', async () => {
    rig.runner.start(input({ entries: twoVoices(), scopes: [['Voice 1'], ['Voice 2']] }))
    await settled(rig.runner, MAC, 'rev-1')
    expect(rig.extracts).toBe(4)
    expect(rig.yields).toBeGreaterThan(4)
    let timers = 0
    const tick = setInterval(() => { timers += 1 }, 0)
    const entries: VoiceSidecarEntry[] = []
    const chunks: Record<number, Buffer> = {}
    for (let raw = 10; raw < 30; raw++) { entries.push(entry(raw, 'Voice 1')); chunks[raw] = wav([6, CODE.dana]) }
    chunkFiles(MAC2, chunks)
    const blocking = makeRig({ extract: audio => { const end = Date.now() + 3; while (Date.now() < end) { /* a native call */ } return fakeExtract(audio) } })
    blocking.runner.start(input({ sessionId: MAC2, entries }))
    await settled(blocking.runner, MAC2, 'rev-1')
    clearInterval(tick)
    expect(timers).toBeGreaterThanOrEqual(10)
  })
})

describe('refusals', () => {
  const entries = () => { chunkFiles(MAC, { 0: wav([6, CODE.dana]), 1: wav([6, CODE.dana]) }); return [entry(0, 'Voice 1'), entry(1, 'Voice 1')] }

  it('a recording blocks the start, and nothing is extracted', async () => {
    const out = rig.runner.start(input({ entries: entries(), block: () => 'recording_active' }))
    expect(out).toEqual({ state: 'refused', reason: 'recording_active', rule: { floor: 0.7, margin: 0.05 }, modelSpace: '192d', sourceRevision: 'rev-1' })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(rig.extracts).toBe(0)
  })

  it('a refusal is the POST\'s answer only: reading afterwards stays idle, or keeps the last real result', async () => {
    const list = entries()
    rig.runner.start(input({ entries: list, block: () => 'recording_active' }))
    expect(rig.runner.read(MAC, 'rev-1')).toEqual({ state: 'idle', rule: { floor: 0.7, margin: 0.05 }, modelSpace: '192d', sourceRevision: 'rev-1' })
    expect(rig.runner.running(MAC)).toBeNull()
    rig.runner.start(input({ entries: list }))
    await settled(rig.runner, MAC, 'rev-1')
    expect(rig.runner.start(input({ entries: list, sourceRevision: 'rev-2', block: () => 'recording_active' })).state).toBe('refused')
    expect(rig.runner.read(MAC, 'rev-1').state).toBe('done')
    expect(rig.runner.read(MAC, 'rev-2').state).toBe('idle')
  })

  it('a maintenance drain blocks the start', () => {
    expect(rig.runner.start(input({ entries: entries(), block: () => 'maintenance' }))).toMatchObject({ state: 'refused', reason: 'maintenance' })
  })

  it('a recording that starts mid-run ends the job as failed, with the reason and no partial result', async () => {
    let live = false
    const r = makeRig({ extract: audio => { r.extracts += 1; live = true; return fakeExtract(audio) } })
    r.runner.start(input({ entries: entries(), block: () => live ? 'recording_active' : null }))
    const out = await settled(r.runner, MAC, 'rev-1')
    expect(out.state).toBe('failed')
    expect(out.reason).toBe('recording_active')
    expect(out.suggestions).toBeUndefined()
    expect(r.extracts).toBe(1)
  })

  it('after a refusal the next click runs', async () => {
    const list = entries()
    rig.runner.start(input({ entries: list, block: () => 'recording_active' }))
    expect(rig.runner.start(input({ entries: list })).state).toBe('running')
    expect((await settled(rig.runner, MAC, 'rev-1')).state).toBe('done')
  })

  it('no retained audio', () => {
    expect(rig.runner.start(input({ entries: [entry(50, 'Voice 1')] }))).toMatchObject({ state: 'refused', reason: 'audio_not_retained' })
    expect(rig.runner.start(input({ entries: [] }))).toMatchObject({ state: 'refused', reason: 'audio_not_retained' })
  })

  it('no speaker runtime', () => {
    const r = makeRig({ available: () => false })
    expect(r.runner.start(input({ entries: entries() }))).toMatchObject({ state: 'refused', reason: 'speaker_model_unavailable' })
  })

  it('one job at a time machine-wide', async () => {
    const list = entries()
    chunkFiles(MAC2, { 0: wav([6, CODE.dana]) })
    rig.runner.start(input({ entries: list }))
    const other = rig.runner.start(input({ sessionId: MAC2, entries: [entry(0, 'Voice 1')] }))
    expect(other).toMatchObject({ state: 'refused', reason: 'job_running_elsewhere' })
    expect(rig.runner.running(MAC)?.state).toBe('running')
    await settled(rig.runner, MAC, 'rev-1')
    expect(rig.runner.start(input({ sessionId: MAC2, entries: [entry(0, 'Voice 1')] })).state).toBe('running')
    expect((await settled(rig.runner, MAC2, 'rev-1')).state).toBe('done')
  })

  it('a scope loader that throws is an explicit failure', async () => {
    rig.runner.start(input({ entries: entries(), loadScopes: async () => { throw new Error('review') } }))
    expect(await settled(rig.runner, MAC, 'rev-1')).toMatchObject({ state: 'failed', reason: 'internal_error' })
  })

  it('needs at least two profiles to prove a margin, and says so at the click', async () => {
    const r = makeRig({ readProfiles: () => ({ profiles: profiles().slice(0, 1) }) })
    expect(r.runner.start(input({ entries: entries() }))).toMatchObject({ state: 'refused', reason: 'not_enough_voice_profiles' })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(r.extracts).toBe(0)
  })

  it('an unreadable profile store is refused at the click', () => {
    const r = makeRig({ readProfiles: () => { throw new Error('corrupt') } })
    expect(r.runner.start(input({ entries: entries() }))).toMatchObject({ state: 'refused', reason: 'profile_store_unreadable' })
  })

  it('a refused click holds no lane', async () => {
    const list = entries()
    rig.runner.start(input({ entries: list, block: () => 'maintenance' }))
    chunkFiles(MAC2, { 0: wav([6, CODE.dana]) })
    expect(rig.runner.start(input({ sessionId: MAC2, entries: [entry(0, 'Voice 1')] })).state).toBe('running')
    await settled(rig.runner, MAC2, 'rev-1')
  })
})

describe('a result expires with the profile store', () => {
  const entries = () => { chunkFiles(MAC, { 0: wav([6, CODE.dana]), 1: wav([6, CODE.dana]) }); return [entry(0, 'Voice 1'), entry(1, 'Voice 1')] }
  afterEach(() => resetVoiceSuggestionRunnerForTests(null))

  it('a changed store reads as idle and null, and the next click re-runs against the new store', async () => {
    let store = 'store-a'
    let people = profiles()
    const r = makeRig({ storeFingerprint: () => store, readProfiles: () => ({ profiles: people }) })
    resetVoiceSuggestionRunnerForTests(r.runner)
    const list = entries()
    r.runner.start(input({ entries: list }))
    expect((await settled(r.runner, MAC, 'rev-1')).suggestions?.[0].name).toBe('Dana Reyes')
    expect(currentVoiceSuggestions(MAC)?.suggestions[0].name).toBe('Dana Reyes')
    const count = r.extracts

    // delete-person, as the store sees it.
    people = profiles().filter(p => p.name !== 'Dana Reyes')
    store = 'store-b'
    expect(r.runner.read(MAC, 'rev-1')).toEqual({ state: 'idle', rule: { floor: 0.7, margin: 0.05 }, modelSpace: '192d', sourceRevision: 'rev-1' })
    expect(currentVoiceSuggestions(MAC)).toBeNull()

    expect(r.runner.start(input({ entries: list })).state).toBe('running')
    const again = await settled(r.runner, MAC, 'rev-1')
    expect(r.extracts).toBe(count + 2)
    expect(again.suggestions).toEqual([])
    expect(again.unmatched).toEqual([{ labels: ['Voice 1'], gate: 'below_rule' }])
    expect(currentVoiceSuggestions(MAC)?.suggestions).toEqual([])
  })

  it('an unchanged store keeps the result and the click extracts nothing more', async () => {
    const r = makeRig({ storeFingerprint: () => 'same' })
    const list = entries()
    r.runner.start(input({ entries: list }))
    await settled(r.runner, MAC, 'rev-1')
    const count = r.extracts
    expect(r.runner.start(input({ entries: list })).state).toBe('done')
    expect(r.extracts).toBe(count)
  })

  it('a store that changes mid-run makes the result read idle when it finishes', async () => {
    let store = 'store-a'
    const r = makeRig({ storeFingerprint: () => store, extract: audio => { store = 'store-b'; return fakeExtract(audio) } })
    r.runner.start(input({ entries: entries() }))
    expect(r.runner.running(MAC)?.state).toBe('running')
    while (r.runner.running(MAC)) await new Promise<void>(resolve => setImmediate(resolve))
    expect(r.runner.read(MAC, 'rev-1').state).toBe('idle')
  })

  it('the real fingerprint follows the file', async () => {
    const { defaultVoiceSuggestionDeps } = await import('./mac-voice-suggestions.js')
    const { dataPath } = await import('./data-dir.js')
    const fingerprint = defaultVoiceSuggestionDeps().storeFingerprint
    const path = dataPath('voice-profiles.json')
    rmSync(path, { force: true })
    expect(fingerprint()).toBe('none')
    writeFileSync(path, JSON.stringify({ profiles: [] }))
    const first = fingerprint()
    expect(first).not.toBe('none')
    writeFileSync(path, JSON.stringify({ profiles: [{ name: 'x', embeddings: [] }] }))
    expect(fingerprint()).not.toBe(first)
    rmSync(path, { force: true })
  })
})

describe('failures and limits', () => {
  const entries = () => { chunkFiles(MAC, { 0: wav([6, CODE.dana]), 1: wav([6, CODE.dana]) }); return [entry(0, 'Voice 1'), entry(1, 'Voice 1')] }

  it('hits a deadline of 6 minutes as failed, with no partial result', async () => {
    let t = 1_000_000
    const r = makeRig({ now: () => t, extract: audio => { r.extracts += 1; t += VOICE_SUGGESTION_DEADLINE_MS; return fakeExtract(audio) } })
    r.runner.start(input({ entries: entries() }))
    const out = await settled(r.runner, MAC, 'rev-1')
    expect(out).toMatchObject({ state: 'failed', reason: 'deadline' })
    expect(out.suggestions).toBeUndefined()
    expect(r.extracts).toBe(1)
    chunkFiles(MAC2, { 0: wav([6, CODE.dana]) })
    expect(r.runner.start(input({ sessionId: MAC2, entries: [entry(0, 'Voice 1')] })).state).toBe('running')
  })

  it('just under the deadline still runs', async () => {
    let t = 1_000_000
    const r = makeRig({ now: () => t, extract: audio => { t += VOICE_SUGGESTION_DEADLINE_MS / 3; return fakeExtract(audio) } })
    r.runner.start(input({ entries: entries() }))
    expect((await settled(r.runner, MAC, 'rev-1')).state).toBe('done')
  })

  it('dictation pauses a job instead of ending it, and it finishes after', async () => {
    let dictating = 3
    const sleeps: number[] = []
    const r = makeRig({ sleep: async ms => { sleeps.push(ms); dictating -= 1 } })
    r.runner.start(input({ entries: entries(), pause: () => dictating > 0 }))
    expect((await settled(r.runner, MAC, 'rev-1')).state).toBe('done')
    expect(sleeps.length).toBe(3)
  })

  it('a pause cannot outlast the deadline, and a recording ends it', async () => {
    let t = 0
    const r = makeRig({ now: () => t, sleep: async () => { t += 60_000 } })
    r.runner.start(input({ entries: entries(), pause: () => true }))
    expect(await settled(r.runner, MAC, 'rev-1')).toMatchObject({ state: 'failed', reason: 'deadline' })

    let live = false
    const q = makeRig({ sleep: async () => { live = true } })
    q.runner.start(input({ entries: entries(), pause: () => true, block: () => live ? 'recording_active' : null }))
    expect(await settled(q.runner, MAC, 'rev-1')).toMatchObject({ state: 'failed', reason: 'recording_active' })
  })

  it('an exception mid-run is an explicit failure and frees the lane', async () => {
    const r = makeRig({ extract: () => { throw new Error('native') } })
    r.runner.start(input({ entries: entries() }))
    expect(await settled(r.runner, MAC, 'rev-1')).toMatchObject({ state: 'failed', reason: 'internal_error' })
    chunkFiles(MAC2, { 0: wav([6, CODE.dana]) })
    expect(r.runner.start(input({ sessionId: MAC2, entries: [entry(0, 'Voice 1')] })).state).toBe('running')
  })

  it('an extraction that yields nothing is simply not a unit', async () => {
    const r = makeRig({ extract: (audio, unit) => unit.raw === 0 ? null : fakeExtract(audio) })
    r.runner.start(input({ entries: entries() }))
    const out = await settled(r.runner, MAC, 'rev-1')
    expect(out.progress).toEqual({ done: 2, total: 2 })
    expect(out.unmatched).toEqual([])
    expect(out.suggestions).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', score: 1, margin: 1, units: 1, kept: 1, requiresConfirmation: true, highConfidence: true }])
  })

  it('audio evicted between the plan and the extraction drops that unit only', async () => {
    const list = entries()
    let looks = 0
    const r = makeRig({ audioPath: (s, raw) => { looks += 1; const p = join(dir, `${s}_${raw}.wav`); return raw === 1 && looks > 3 ? null : p } })
    r.runner.start(input({ entries: list }))
    const out = await settled(r.runner, MAC, 'rev-1')
    expect(out.progress).toEqual({ done: 2, total: 2 })
    expect(out.suggestions?.[0]).toMatchObject({ name: 'Dana Reyes', units: 1, kept: 1 })
  })

  it('a bank that only knows this capture is no bank: same-capture samples never name its voices', async () => {
    chunkFiles(MAC, { 0: wav([6, CODE.dana]), 1: wav([6, CODE.dana]) })
    const r = makeRig({ readProfiles: () => ({ profiles: [
      { name: 'Dana Reyes', embeddings: [axis(CODE.dana)], sources: [`mac-assign:${MAC}`] },
      { name: 'Theo Marsh', embeddings: [axis(CODE.theo)], sources: ['fireflies'] },
      { name: 'Ana Silva', embeddings: [axis(CODE.ana)], sources: ['fireflies'] },
    ] }) })
    r.runner.start(input({ entries: [entry(0, 'Voice 1'), entry(1, 'Voice 1')] }))
    expect(await settled(r.runner, MAC, 'rev-1')).toMatchObject({ state: 'done', suggestions: [], unmatched: [{ labels: ['Voice 1'], gate: 'below_rule' }] })
  })

  it('remembers a bounded number of results', async () => {
    const sessions = Array.from({ length: 18 }, (_, i) => `mac_1b2c3d4e-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`)
    for (const s of sessions) {
      chunkFiles(s, { 0: wav([6, CODE.dana]) })
      rig.runner.start(input({ sessionId: s, entries: [entry(0, 'Voice 1')] }))
      await settled(rig.runner, s, 'rev-1')
    }
    expect(rig.runner.read(sessions[0], 'rev-1').state).toBe('idle')
    expect(rig.runner.read(sessions[17], 'rev-1').state).toBe('done')
  })
})

describe('high confidence', () => {
  /** One voice, three units, all aimed at Dana (axis 0) with Theo (axis 1) as the runner-up. */
  async function suggestionAt(score: number, second = 0) {
    chunkFiles(MAC, { 0: wav([6, CODE.dana]), 1: wav([6, CODE.dana]), 2: wav([6, CODE.dana]) })
    const r = makeRig({ extract: () => Float32Array.from(aimed(score, second)) })
    r.runner.start(input({ entries: [entry(0, 'Voice 1'), entry(1, 'Voice 1'), entry(2, 'Voice 1')] }))
    return settled(r.runner, MAC, 'rev-1')
  }

  it('is .80 and .05', () => {
    expect(HIGH_CONFIDENCE_FLOOR).toBe(0.8)
    expect(HIGH_CONFIDENCE_MARGIN).toBe(0.05)
  })

  it('is inclusive at both edges and fails just under either', () => {
    expect(isHighConfidenceVoiceSuggestion(HIGH_CONFIDENCE_FLOOR, HIGH_CONFIDENCE_MARGIN)).toBe(true)
    expect(isHighConfidenceVoiceSuggestion(HIGH_CONFIDENCE_FLOOR - 1e-9, HIGH_CONFIDENCE_MARGIN)).toBe(false)
    expect(isHighConfidenceVoiceSuggestion(HIGH_CONFIDENCE_FLOOR, HIGH_CONFIDENCE_MARGIN - 1e-9)).toBe(false)
  })

  it('a score from .70 to .80 stays a plain suggestion', async () => {
    const low = await suggestionAt(0.71)
    expect(low.suggestions?.[0]).toMatchObject({ name: 'Dana Reyes', score: 0.71, highConfidence: false })
    const edge = await suggestionAt(0.79)
    expect(edge.suggestions?.[0]).toMatchObject({ name: 'Dana Reyes', score: 0.79, highConfidence: false })
  })

  it('a score of .80 or more with the margin is high confidence', async () => {
    expect((await suggestionAt(0.85)).suggestions?.[0]).toMatchObject({ name: 'Dana Reyes', score: 0.85, highConfidence: true })
  })

  it('judges the unrounded score: .7996 displays as .800 and is not high confidence', async () => {
    expect((await suggestionAt(0.7996)).suggestions?.[0]).toMatchObject({ score: 0.8, highConfidence: false })
  })

  it('judges the runner\'s margin: a high score with a thin margin is not even a suggestion', async () => {
    const out = await suggestionAt(0.85, 0.81)
    expect(out.suggestions).toEqual([])
    expect(out.unmatched).toEqual([{ labels: ['Voice 1'], gate: 'below_rule' }])
  })

  it('a high score behind a closed gate is not a suggestion at all', () => {
    const mixed = [...vectors(aimed(0.95), 3), ...[10, 20].map(i => ({ unit: axis(i), sec: 6 }))]
    expect(decideVoiceSuggestion(['Voice 1'], mixed, bankOf('Dana Reyes', 'Theo Marsh')).gate).toBe('mixed_voice')
    expect(decideVoiceSuggestion(['Voice 1'], vectors(aimed(0.95), 5), bankOf('MU', 'Dana Reyes')).gate).toBe('below_rule')
  })
})

describe('currentVoiceSuggestions', () => {
  afterEach(() => resetVoiceSuggestionRunnerForTests(null))

  const entries = () => { chunkFiles(MAC, { 0: wav([6, CODE.dana]), 1: wav([6, CODE.dana]) }); return [entry(0, 'Voice 1'), entry(1, 'Voice 1')] }

  it('is null with no runner, no job, a running job, or a refused one', async () => {
    resetVoiceSuggestionRunnerForTests(null)
    expect(currentVoiceSuggestions(MAC)).toBeNull()
    resetVoiceSuggestionRunnerForTests(rig.runner)
    expect(currentVoiceSuggestions(MAC)).toBeNull()
    const list = entries()
    rig.runner.start(input({ entries: list, block: () => 'recording_active' }))
    expect(currentVoiceSuggestions(MAC)).toBeNull()
    rig.runner.start(input({ entries: list }))
    expect(rig.runner.running(MAC)?.state).toBe('running')
    expect(currentVoiceSuggestions(MAC)).toBeNull()
    await settled(rig.runner, MAC, 'rev-1')
    expect(currentVoiceSuggestions(MAC2)).toBeNull()
  })

  it('reads a finished job, with its revision and the high-confidence flag', async () => {
    resetVoiceSuggestionRunnerForTests(rig.runner)
    rig.runner.start(input({ entries: entries() }))
    await settled(rig.runner, MAC, 'rev-1')
    expect(currentVoiceSuggestions(MAC)).toEqual({
      sourceRevision: 'rev-1',
      suggestions: [{ labels: ['Voice 1'], name: 'Dana Reyes', score: 1, margin: 1, units: 2, kept: 2, requiresConfirmation: true, highConfidence: true }],
    })
  })

  it('hands out a copy: a caller cannot change what the next reader or GET sees', async () => {
    resetVoiceSuggestionRunnerForTests(rig.runner)
    rig.runner.start(input({ entries: entries() }))
    await settled(rig.runner, MAC, 'rev-1')
    const first = currentVoiceSuggestions(MAC)!
    first.suggestions[0].name = 'Someone Else'
    first.suggestions[0].labels.push('Voice 9')
    first.suggestions.push({ ...first.suggestions[0] })
    const again = currentVoiceSuggestions(MAC)!
    expect(again.suggestions).toHaveLength(1)
    expect(again.suggestions[0]).toMatchObject({ name: 'Dana Reyes', labels: ['Voice 1'] })
    expect(rig.runner.read(MAC, 'rev-1').suggestions?.[0].name).toBe('Dana Reyes')
  })

  it('a new run on the same session withdraws the old result; a refused click does not', async () => {
    resetVoiceSuggestionRunnerForTests(rig.runner)
    const list = entries()
    rig.runner.start(input({ entries: list }))
    await settled(rig.runner, MAC, 'rev-1')
    expect(currentVoiceSuggestions(MAC)?.sourceRevision).toBe('rev-1')
    rig.runner.start(input({ entries: list, sourceRevision: 'rev-2', block: () => 'recording_active' }))
    expect(currentVoiceSuggestions(MAC)?.sourceRevision).toBe('rev-1')
    rig.runner.start(input({ entries: list, sourceRevision: 'rev-2' }))
    expect(currentVoiceSuggestions(MAC)).toBeNull()
    await settled(rig.runner, MAC, 'rev-2')
    expect(currentVoiceSuggestions(MAC)?.sourceRevision).toBe('rev-2')
  })
})

describe('the real runtime switch', () => {
  it('needs the speaker runtime, and honours the embedding master switch', async () => {
    const { __installSpeakerRuntimeForTests } = await import('./speaker-embeddings.js')
    const { fakeSpeakerRuntime } = await import('./__fixtures__/fake-speaker-runtime.js')
    const { defaultVoiceSuggestionDeps } = await import('./mac-voice-suggestions.js')
    const available = defaultVoiceSuggestionDeps().available
    __installSpeakerRuntimeForTests(null)
    expect(available()).toBe(false)
    __installSpeakerRuntimeForTests(fakeSpeakerRuntime())
    try {
      expect(available()).toBe(true)
      process.env.COS_CHUNK_EMBEDDINGS = '0'
      expect(available()).toBe(false)
    } finally {
      delete process.env.COS_CHUNK_EMBEDDINGS
      __installSpeakerRuntimeForTests(null)
    }
  })
})

describe('live-work leases', () => {
  it('splits every live lease into end-the-job or pause-the-job', () => {
    for (const kind of VOICE_SUGGESTION_PAUSE_LEASES) expect(SPEAKER_SHADOW_LIVE_LEASES as readonly string[]).toContain(kind)
    for (const kind of SPEAKER_SHADOW_LIVE_LEASES) {
      const held = () => ({ [kind]: 1 })
      expect(voiceSuggestionRecordingLease(held)).toBe(!VOICE_SUGGESTION_PAUSE_LEASES.includes(kind))
      expect(voiceSuggestionPauseLease(held)).toBe(VOICE_SUGGESTION_PAUSE_LEASES.includes(kind))
    }
    expect(voiceSuggestionRecordingLease(() => ({ recording_chunk: 1 }))).toBe(true)
    expect(voiceSuggestionRecordingLease(() => ({ prompt_draft_write: 1 }))).toBe(false)
    expect(voiceSuggestionPauseLease(() => ({}))).toBe(false)
    expect(voiceSuggestionRecordingLease(() => ({}))).toBe(false)
  })
})

describe('tripwires', () => {
  const code = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  const WRITE_CALL = /\b(writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rename|rmSync|rmdirSync|rmdir|unlinkSync|unlink|mkdirSync|mkdir|mkdtempSync|mkdtemp|symlinkSync|symlink|linkSync|copyFileSync|copyFile|cpSync|createWriteStream|durableAtomicWriteFileSync|atomicWriteFileSync|chmodSync|chmod|truncateSync|truncate|utimesSync|open|openSync)\(/g

  it.each(['mac-voice-display.ts', 'mac-voice-suggestions.ts'])('%s has no write-capable call', name => {
    expect(code(name).match(WRITE_CALL) ?? []).toEqual([])
  })

  it('reaches no enrolment, automatic-name or label code', () => {
    const source = code('mac-voice-suggestions.ts') + code('mac-voice-display.ts')
    for (const banned of ['enrollEmbeddingsBatch', 'enrolNamedVoice', 'commitMacVoiceAssignment', 'identifySpeaker', 'SEARCH_THRESHOLD', 'AUTO_ENROLL_THRESHOLD', 'meeting-speaker-policy', 'meeting-relabel']) {
      expect(source).not.toContain(banned)
    }
  })
})
