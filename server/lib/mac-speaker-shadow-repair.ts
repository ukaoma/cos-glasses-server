/** Pure PREPARATION only. Hashes bind supplied bytes; they do not authenticate native
 * execution, reconstructed PCM, model provenance, or a caller's complete export.
 * A future trusted caller must verify those before any durable transaction and
 * run this bounded but potentially expensive full-cohort computation off-thread
 * under a wall-time/memory budget. This is not an HTTP/main-thread entry point. */
import { createHash } from 'node:crypto'
import { decide, exactOverlap, nativeTurns, type ShadowEmbeddingRow } from './speaker-shadow-decide.js'
import { shadowEntries, shadowProductionSegments, type ShadowTimelineRow } from './speaker-shadow-timeline.js'
import { hasMacSpeakerProtectedRows, isMacSpeakerHumanProtected } from './mac-speaker-protection.js'
import { hashMacSpeakerDocument, projectMacSpeakerRepair, type MacSpeakerRepairPlan, type MacSpeakerWordBinding } from './mac-speaker-repair-projection.js'

type Doc = Record<string, any>
export interface MacShadowRepairSource {
  originalJSON: string
  currentJSON: string
  ledgerJSONL: string
  rawAudio: Array<{ rawChunkIndex: number; wavSHA256: string; pcmSHA256: string; sampleCount: number }>
  timeline: { rows: ShadowTimelineRow[]; total: number; pcmSHA256: string }
  cohort: { nativeJSON: string; embeddingsJSON: string; modelSHA256: string; cliSHA256: string }
}
export interface MacShadowRepairInput extends MacShadowRepairSource { sourceBindingSHA256: string }
export interface MacShadowRepairPreview {
  plan: MacSpeakerRepairPlan | null
  provenance: { productionQualified: false; nativeAuthenticated: false; sourceBindingSHA256: string; originalSHA256: string; currentSHA256: string; ledgerSHA256: string }
  protectedRawChunkIndices: number[]
  withheld: Array<{ rawChunkIndex: number; reason: string }>
  counts: { raw: number; spoken: number; embeddings: number; acousticAcceptedMerges: number; candidateChunks: number; assignedChunks: number; protectedChunks: number; withheldChunks: number; beforeLabels: number; afterLabels: number; beforeRootLabels: number; afterRootLabels: number }
}
const HASH = /^[a-f0-9]{64}$/
const VOICE = /^Voice (?:[1-9]|[1-9]\d)$/
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const fail = (message: string): never => { throw new Error(`Mac shadow repair: ${message}`) }
/** Integrity helper, NOT a native execution/qualification certificate. */
export function bindMacSpeakerShadowRepair(source: MacShadowRepairSource): string { return sha(JSON.stringify(source)) }
function boundedJSON(text: string, max: number): any {
  if (typeof text !== 'string' || Buffer.byteLength(text) > max) fail('JSON byte bound')
  return JSON.parse(text)
}
function closed(doc: Doc) {
  if (!doc || !Array.isArray(doc.chunks) || !Array.isArray(doc.chunkEntries) || doc.finalizationState !== 'complete' || doc.sourceType !== 'mac_system_audio' || !/^mac_/.test(doc.sessionId) || doc.active || doc.isActive || doc.claimPending || doc.status === 'recording' || doc.mergedFrom || doc.sourceSessionIds || doc.isMerged) fail('closed original Mac capture required')
  // Even a valid prior reader proof binds the complete speech document. A new
  // label patch would invalidate it. This adapter cannot compose those receipts.
  if (['speakerRepair', 'speakerProfilePass'].some(key => Object.hasOwn(doc, key))) fail('prior repair/profile receipt requires proof composition')
}
const ANNOTATION_KEYS = new Set(['speaker', 'originalSpeaker', 'speakerCorrectionBatchId', 'speakerCorrectionId', 'manualSpeaker', 'speakerManuallyAssigned', 'confirmedByHuman', 'manuallyAssigned', 'manuallyCorrected', 'speakerOrigin', 'speakerSource', 'speakerPolicy', 'speakerProvenance', 'source'])
/** Compare the complete source row recursively, allowing only speaker annotation
 * changes. Annotation differences are handled by protection, never by copying
 * labels back from ORIGINAL. Array presence, text, clocks and diagnostics remain
 * exact on every support/competitor row, not just eventual assignments. */
function sourceGeometry(value: any): any {
  if (Array.isArray(value)) return value.map(sourceGeometry)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).filter(key => !ANNOTATION_KEYS.has(key)).sort().map(key => [key, sourceGeometry(value[key])]))
}
function rows(chunk: Doc): Doc[] {
  const out = [chunk]
  for (const key of ['segments', 'finalSegments', 'words']) {
    if (chunk[key] !== undefined && !Array.isArray(chunk[key])) fail('malformed label surface')
    for (const row of chunk[key] ?? []) {
      if (!row || typeof row !== 'object') fail('malformed label row')
      if (key !== 'words' || 'speaker' in row) out.push(row)
    }
  }
  return out
}
function mapping(doc: Doc): Array<{ raw: number; chunk: Doc; entry: Doc }> {
  const entries = shadowEntries(doc)
  if (entries.length > 6000 || entries.some((e, i) => e.chunkIndex !== i)) fail('complete ordered raw map required')
  const spoken = entries.filter(e => e.chunk.text)
  if (spoken.length !== doc.chunks.length) fail('compacted map count')
  return spoken.map((e, i) => {
    const chunk = doc.chunks[i]
    if (!chunk || ['text', 'elapsed', 'audioSha256', 'audioDurationMs'].some(k => !equal(chunk[k], e.chunk[k]))) fail('ambiguous compacted raw join')
    if (typeof chunk.text !== 'string' || !HASH.test(chunk.audioSha256)) fail('unbound spoken source')
    return { raw: e.chunkIndex, chunk, entry: e.chunk }
  })
}
function ledgerProtection(text: string, map: ReturnType<typeof mapping>, original: ReturnType<typeof mapping>): Set<number> {
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) fail('ledger byte bound')
  const history = new Map<string, Doc[]>()
  const replay = original.map(m => m.chunk.speaker)
  const lines = text.split('\n').filter(x => x.trim())
  if (lines.length > 20000) fail('ledger row bound')
  for (const line of lines) {
    const row = JSON.parse(line)
    if (!row || typeof row.id !== 'string' || !row.id || !['intent', 'applied', 'failed', 'confirmed', 'confirmed-chunks', 'reverted'].includes(row.phase) || !Array.isArray(row.chunks) || row.chunks.some((i: number) => !Number.isInteger(i) || !map[i]) || new Set(row.chunks).size !== row.chunks.length) fail('ambiguous correction ledger')
    const prior = history.get(row.id) ?? []
    if (prior.at(-1)?.phase === 'intent' && !['applied', 'failed'].includes(row.phase)) fail('incomplete correction intent')
    const intended = prior.at(-1)
    const resolvedIntent = intended?.chunks.length ? intended.chunks : replay.flatMap((label, i) => label === intended?.from ? [i] : [])
    // CorrectionRow documents an explicit empty intent as all rows carrying from;
    // applied rows normally carry the resolved list. Missing chunks is not that
    // explicit contract and was rejected above.
    if (row.phase === 'intent' && prior.length || row.phase === 'applied' && (intended?.phase !== 'intent' || row.chunks.length && !equal(resolvedIntent, row.chunks) || intended?.from !== row.from || intended?.to !== row.to) || row.phase === 'failed' && intended?.phase !== 'intent' || row.phase === 'reverted' && !prior.some(r => r.phase === 'applied')) fail('ambiguous correction history')
    if (row.phase === 'applied' && row.chunks.length) {
      if (typeof row.from !== 'string' || typeof row.to !== 'string' || !row.to || row.chunks.some((i: number) => replay[i] !== row.from)) fail('correction history source label mismatch')
      for (const i of row.chunks) replay[i] = row.to
    }
    if (row.phase === 'reverted') {
      const applied = prior.find(e => e.phase === 'applied')!
      if (!applied.chunks.length || applied.chunks.some((i: number) => replay[i] !== applied.to)) fail('ambiguous correction revert')
      for (const i of applied.chunks) replay[i] = applied.from
    }
    history.set(row.id, [...prior, row])
  }
  const protectedRaw = new Set<number>()
  for (const events of history.values()) {
    if (events.at(-1)?.phase === 'intent') fail('incomplete correction intent')
    // Retain protection even for a historical reverted decision. No machine write
    // should silently reinterpret human history. Empty confirmations keep the
    // existing offline CLI's conservative protect-all behavior.
    for (const e of events.filter(e => ['applied', 'confirmed', 'confirmed-chunks'].includes(e.phase))) {
      if (!e.chunks.length) for (const m of map) protectedRaw.add(m.raw)
      else for (const i of e.chunks) protectedRaw.add(map[i].raw)
    }
  }
  return protectedRaw
}
/** No remap/proposal input: recompute unchanged floor15/.8/1.5 decision from the
 * entire bound export and production segments reconstructed from ORIGINAL rows. */
export function buildMacSpeakerShadowRepair(input: MacShadowRepairInput): MacShadowRepairPreview {
  if (Object.keys(input).some(k => !['originalJSON', 'currentJSON', 'ledgerJSONL', 'rawAudio', 'timeline', 'cohort', 'sourceBindingSHA256'].includes(k))) fail('unsupported proposal/remap input')
  for (const [value, maximum] of [[input.originalJSON, 32], [input.currentJSON, 32], [input.ledgerJSONL, 8], [input.cohort?.nativeJSON, 64], [input.cohort?.embeddingsJSON, 96]] as const) if (typeof value !== 'string' || Buffer.byteLength(value) > maximum * 1024 * 1024) fail('input byte bound')
  if (!Array.isArray(input.rawAudio) || input.rawAudio.length > 6000 || !Array.isArray(input.timeline?.rows) || input.timeline.rows.length > 6000) fail('raw/timeline schema bound')
  const { sourceBindingSHA256, ...source } = input
  if (!HASH.test(sourceBindingSHA256) || bindMacSpeakerShadowRepair(source) !== sourceBindingSHA256) fail('full source binding drift')
  const original = boundedJSON(input.originalJSON, 32 * 1024 * 1024), current = boundedJSON(input.currentJSON, 32 * 1024 * 1024)
  closed(original); closed(current)
  if (original.sessionId !== current.sessionId) fail('capture mismatch')
  const oldMap = mapping(original), map = mapping(current)
  if (oldMap.some(m => !equal(sourceGeometry(m.chunk), sourceGeometry(m.entry)))) fail('original root/raw source geometry disagreement')
  if (['startTime', 'durationMs'].some(key => !equal(original[key], current[key]))) fail('current capture clock drift')
  if (oldMap.length !== map.length || oldMap.some((m, i) => m.raw !== map[i].raw || ['text', 'elapsed', 'audioSha256', 'audioDurationMs'].some(k => !equal(m.chunk[k], map[i].chunk[k])))) fail('current speech source drift')
  if (oldMap.some((m, i) => !equal(sourceGeometry(m.chunk), sourceGeometry(map[i].chunk)))) fail('current compacted source geometry drift')
  const entries = shadowEntries(original), currentEntries = shadowEntries(current)
  if (entries.length !== currentEntries.length || entries.some((e, i) => ['text', 'elapsed', 'audioSha256', 'audioDurationMs'].some(k => !equal(e.chunk[k], currentEntries[i].chunk[k])))) fail('current raw source drift')
  for (const entry of [...entries, ...currentEntries]) rows(entry.chunk)
  if (entries.some((e, i) => !equal(sourceGeometry(e.chunk), sourceGeometry(currentEntries[i].chunk)))) fail('current raw source geometry drift')
  if (!Array.isArray(input.rawAudio) || input.rawAudio.length !== entries.length || !input.rawAudio.length) fail('all raw WAV bindings required')
  const samples: Record<string, number> = {}
  const placed = input.rawAudio.map((raw, i) => {
    const chunk = entries[i].chunk
    if (raw.rawChunkIndex !== i || !HASH.test(raw.wavSHA256) || !HASH.test(raw.pcmSHA256) || chunk.audioSha256 && raw.wavSHA256 !== chunk.audioSha256 || !Number.isSafeInteger(raw.sampleCount) || raw.sampleCount <= 0 || raw.sampleCount > 480000 || !Number.isFinite(chunk.elapsed) || (chunk.elapsed as number) < 0) fail('raw WAV source binding')
    samples[String(i)] = raw.sampleCount
    return { rawChunkIndex: i, startSample: Math.floor((chunk.elapsed as number) * 16 + .5), sampleCount: raw.sampleCount, usedSampleCount: 0 }
  }).sort((a, b) => a.startSample - b.startSample || a.rawChunkIndex - b.rawChunkIndex)
  for (let i = 0; i < placed.length; i++) {
    const row = placed[i]
    row.usedSampleCount = i + 1 < placed.length ? Math.min(row.sampleCount, placed[i + 1].startSample - row.startSample) : row.sampleCount
    if (row.usedSampleCount <= 0) fail('shadowed timeline row')
  }
  const total = Math.max(...placed.map(r => r.startSample + r.sampleCount))
  if (total > 4 * 3600 * 16000 || !equal(placed, input.timeline.rows) || total !== input.timeline.total || !HASH.test(input.timeline.pcmSHA256)) fail('timeline geometry drift')
  if (!HASH.test(input.cohort.modelSHA256) || !HASH.test(input.cohort.cliSHA256)) fail('model/CLI binding required')
  // Validate every export row, including short confusers that decide will reject.
  const native = boundedJSON(input.cohort.nativeJSON, 64 * 1024 * 1024), embeddings = boundedJSON(input.cohort.embeddingsJSON, 96 * 1024 * 1024)
  if (!native || !Array.isArray(native.segments) || native.segments.length > 20000 || !Array.isArray(embeddings) || embeddings.length > 10000) fail('cohort schema bound')
  const vector = (v: unknown) => Array.isArray(v) && v.length === 256 && v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e10) && v.some(x => x !== 0)
  for (const s of native.segments) {
    if (!s || typeof s.speakerId !== 'string' || !s.speakerId || s.speakerId.length > 100 || !Number.isFinite(s.startTimeSeconds) || !Number.isFinite(s.endTimeSeconds) || s.startTimeSeconds < 0 || s.endTimeSeconds <= s.startTimeSeconds || s.endTimeSeconds > total / 16000 + 1) fail('native turn bound')
    if (s.embedding !== undefined && !vector(s.embedding)) fail('native vector must be finite nonzero256d')
  }
  for (const e of embeddings) if (!e || !vector(e.embedding256) || !Number.isInteger(e.cluster) || e.cluster < 0 || e.cluster > 9999 || !Number.isFinite(e.startTime) || !Number.isFinite(e.endTime) || e.startTime < 0 || e.endTime <= e.startTime || e.endTime > total / 16000 + 1e-6) fail('embedding must be bounded finite nonzero256d')
  const { turns, dropped } = nativeTurns(native.segments, total / 16000)
  if (dropped) fail('malformed/dropped native turn')
  const production = shadowProductionSegments(entries, placed, total)
  if (production.segs.length > 40000) fail('production segment bound')
  // The port accepts historical permissive numeric inputs. This write adapter
  // requires exact bounded segment coordinates before invoking that unchanged port.
  for (const e of entries) for (const s of (e.chunk.segments as Doc[] | undefined) ?? []) if (!s || typeof s.speaker !== 'string' || !Number.isFinite(s.startSec) || !Number.isFinite(s.endSec) || s.startSec < 0 || s.endSec <= s.startSec || s.endSec * 16000 > samples[String(e.chunkIndex)] + 1e-6) fail('production segment coordinates')
  const decision = decide(production.segs, total, turns, embeddings as ShadowEmbeddingRow[])
  const protection = ledgerProtection(input.ledgerJSONL, map, oldMap)
  for (const m of map) if ([m.chunk, m.entry].some(c => hasMacSpeakerProtectedRows(c) || rows(c).some(r => !VOICE.test(r.speaker)))) protection.add(m.raw)
  const withheld = new Map<number, string>(), chosen = new Map<number, { from: string; to: string }>()
  let candidateChunks = 0
  for (let i = 0; i < oldMap.length; i++) {
    const before = oldMap[i], now = map[i], to = decision.remap.get(before.chunk.speaker)
    if (!to) { withheld.set(now.raw, VOICE.test(before.chunk.speaker) ? 'no-qualified-merge' : 'non-Voice'); continue }
    candidateChunks++
    if (!VOICE.test(to) || !VOICE.test(before.chunk.speaker)) { withheld.set(now.raw, 'non-Voice'); continue }
    if (protection.has(now.raw)) { withheld.set(now.raw, 'human-or-named-protected'); continue }
    if (!equal(rows(before.chunk), rows(now.chunk)) || !equal(rows(now.chunk), rows(now.entry)) || rows(now.chunk).some(r => r.speaker !== before.chunk.speaker)) { withheld.set(now.raw, 'mixed-or-current-surfaces-differ'); continue }
    const row = placed.find(r => r.rawChunkIndex === now.raw)!, segs = production.segs.filter((_, j) => production.sources[j].chunkIndex === now.raw)
    const cluster = decision.rows.get(before.chunk.speaker)?.topCluster
    if (row.usedSampleCount !== row.sampleCount || !segs.length || !cluster || segs.some(([lo, hi, label]) => label !== before.chunk.speaker || [...exactOverlap(lo, hi, decision.index)].some(([key]) => key !== cluster))) { withheld.set(now.raw, 'outside-fully-qualified-chunk'); continue }
    chosen.set(now.raw, { from: now.chunk.speaker, to })
  }
  const wordSpans: Array<{ binding: MacSpeakerWordBinding; raw: number[]; protected: boolean }> = []
  if (current.batchSegments !== undefined && !Array.isArray(current.batchSegments)) fail('batch schema')
  if (!equal((original.batchSegments ?? []).map((b: Doc) => [b.startChunkIdx, b.endChunkIdx, b.speakerWords?.length]), (current.batchSegments ?? []).map((b: Doc) => [b.startChunkIdx, b.endChunkIdx, b.speakerWords?.length]))) fail('current batch topology drift')
  for (const [si, batch] of (current.batchSegments ?? []).entries()) {
    if (!Number.isInteger(batch.startChunkIdx) || !Number.isInteger(batch.endChunkIdx) || batch.startChunkIdx < 0 || batch.endChunkIdx < batch.startChunkIdx || batch.endChunkIdx >= entries.length || !Array.isArray(batch.speakerWords)) fail('batch raw clock range')
    let offset = 0
    const intervals = []
    for (let raw = batch.startChunkIdx; raw <= batch.endChunkIdx; raw++) { const end = offset + samples[String(raw)] / 16000; intervals.push({ raw, start: offset, end }); offset = end }
    for (const [wi, word] of batch.speakerWords.entries()) {
      if (!word || typeof word.word !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start || word.end > offset) fail('batch word clock')
      const raw = intervals.filter(r => word.end === word.start ? word.start >= r.start && word.start < r.end : word.start < r.end && word.end > r.start).map(r => r.raw)
      const oldWord = original.batchSegments[si].speakerWords[wi], changedWord = !equal(oldWord, word)
      // Preserve even an anonymous, unmarked edit. An altered word clock protects
      // both its original and current source intersections; never normalize it.
      if (changedWord) for (const r of intervals) if (oldWord?.end === oldWord?.start ? oldWord.start >= r.start && oldWord.start < r.end : oldWord?.start < r.end && oldWord?.end > r.start) protection.add(r.raw)
      wordSpans.push({ binding: { segmentIndex: si, wordIndex: wi, word: word.word, start: word.start, end: word.end, from: word.speaker }, raw, protected: changedWord || isMacSpeakerHumanProtected(word) || !/^(?:Voice [1-9]\d?|Ext|Unknown|Unidentified(?: \d+)?|Speaker \d+)$/.test(word.speaker) })
    }
  }
  for (const word of wordSpans) if (word.protected) for (const raw of word.raw) protection.add(raw)
  for (const raw of chosen.keys()) if (protection.has(raw)) { chosen.delete(raw); withheld.set(raw, 'batch-protected-or-crosses-unqualified-boundary') }
  // Remove entire chunks to a fixed point; never write a partly unqualified word.
  let changed = true
  while (changed) {
    changed = false
    for (const word of wordSpans) {
      const touched = word.raw.filter(r => chosen.has(r))
      if (touched.length && (word.protected || word.raw.some(r => !chosen.has(r)) || new Set(touched.map(r => chosen.get(r)!.to)).size !== 1)) for (const raw of touched) { chosen.delete(raw); withheld.set(raw, 'batch-protected-or-crosses-unqualified-boundary'); changed = true }
    }
  }
  const protectedRawChunkIndices = [...protection].sort((a, b) => a - b)
  const assignments = [...chosen].map(([rawChunkIndex, pair]) => ({ rawChunkIndex, ...pair, evidenceId: `shadow256_${sourceBindingSHA256}`, batchWords: wordSpans.filter(w => w.raw[0] === rawChunkIndex).map(w => w.binding) }))
  let plan: MacSpeakerRepairPlan | null = assignments.length ? { id: `shadow256_${sourceBindingSHA256.slice(0, 24)}`, evidenceHash: sourceBindingSHA256, expectedDocumentHash: hashMacSpeakerDocument(current), protectedRawChunkIndices, rawAudioSampleCounts: samples, assignments } : null
  let after = current
  if (plan) {
    try { after = projectMacSpeakerRepair(current, plan).doc }
    catch { for (const a of assignments) withheld.set(a.rawChunkIndex, 'strict-projector-refused'); plan = null }
  }
  const rootLabels = (d: Doc) => new Set(d.chunks.map((c: Doc) => c.speaker)).size
  const labels = (d: Doc) => new Set([
    ...d.chunks.flatMap((c: Doc) => rows(c).map(r => r.speaker)),
    ...d.chunkEntries.flatMap((e: Doc) => rows(e.chunk).map(r => r.speaker)),
    ...(d.batchSegments ?? []).flatMap((b: Doc) => b.speakerWords.map((w: Doc) => w.speaker)),
  ].filter(v => typeof v === 'string' && v)).size
  // An acoustic proposal alone is not the requested fragmentation repair. The
  // CURRENT root display must improve without increasing any stored label set.
  if (plan && (rootLabels(after) >= rootLabels(current) || labels(after) > labels(current))) {
    for (const assignment of plan.assignments) withheld.set(assignment.rawChunkIndex, 'non-reducing-plan')
    plan = null; after = current
  }
  return { plan, provenance: { productionQualified: false, nativeAuthenticated: false, sourceBindingSHA256, originalSHA256: sha(input.originalJSON), currentSHA256: sha(input.currentJSON), ledgerSHA256: sha(input.ledgerJSONL) }, protectedRawChunkIndices, withheld: [...withheld].map(([rawChunkIndex, reason]) => ({ rawChunkIndex, reason })), counts: { raw: entries.length, spoken: map.length, embeddings: embeddings.length, acousticAcceptedMerges: decision.accepted, candidateChunks, assignedChunks: plan?.assignments.length ?? 0, protectedChunks: protection.size, withheldChunks: withheld.size, beforeLabels: labels(current), afterLabels: labels(after), beforeRootLabels: rootLabels(current), afterRootLabels: rootLabels(after) } }
}
