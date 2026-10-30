/** Read-only call-wide anonymous view. Packet hashes prove integrity, NOT native
 * authentication. Only the trusted offline producer may grant qualified admission
 * after independent QA. Full export replay belongs in that producer, never HTTP. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { dataPath } from './data-dir.js'
import { validateMacSpeaker256State, type MacSpeaker256SnapshotInput, type MacSpeaker256State, type MacSpeaker256Group } from './mac-speaker-live-memory.js'
import { inspectMacSpeakerShadowCallSource } from './mac-speaker-shadow-repair.js'
import { readMacSpeakerMachineEvidence } from './mac-speaker-machine-evidence.js'
import { hasMacSpeakerProtectedRows, isMacSpeakerHumanProtected } from './mac-speaker-protection.js'
import { boundWords, renderMarkdown } from './mac-speaker-repair-render.js'
import { applyMacCallHumanAnnotation, macCallHumanPaths, readMacCallHumanFile } from './mac-speaker-call-human.js'

type Doc = Record<string, any>
const HASH = /^[a-f0-9]{64}$/
const VOICE = /^Voice (?:[1-9]|[1-9]\d)$/
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const digest = (v: unknown) => sha(JSON.stringify(v))
function refuse(s: string): never { throw new Error(`Mac call view: ${s}`) }
const MAX_PACKET = 16 * 1024 * 1024
// Exact-byte identities only; a changed packet/base/ledger never inherits trust.
const checkedPackets = new Set<string>()
const checkedBaseProofs = new Map<string, ReturnType<typeof readMacSpeakerMachineEvidence>['status']>()
function remember<K, V>(cache: Map<K, V>, key: K, value: V): void { if (cache.size >= 8) cache.delete(cache.keys().next().value!); cache.set(key, value) }
export interface MacSpeakerCallPacket {
  version: 1; policy: 'fluid256-call-view-v1'; admission: 'off' | 'qualified'
  projectionPolicy: 'strict' | 'anonymous-estimate'
  captureId: string; generation: string; revision: number
  baseSHA256: string; ledgerSHA256: string; sourceBindingSHA256: string
  stateSHA256: string; modelSHA256: string; cliSHA256: string
  rawBindings: MacSpeaker256State['rawBindings']; groups: MacSpeaker256Group[]
  protectedRawChunkIndices: number[]
  aliasProtectedRawChunkIndices: number[]
  displayLabels: Record<string, string>
  provenance: { nativeAuthenticated: false; timingBasis: 'native-exclusive-intersect-machine-production'; speakerPurityVerified: false; excludedProductionSegments?: ReturnType<typeof inspectMacSpeakerShadowCallSource>['excludedProductionSegments'] }
  packetSHA256: string
}
export interface MacSpeakerCallView {
  doc: Doc
  markdown?: string
  metadata: { status: 'base' | 'applied'; reason: string; mode: 'strict' | 'anonymous-estimate' | 'alias-evaluation'; revision?: number; generation?: string; packetSHA256?: string; changedChunks: number; changedWords: number; groups: Array<{ identityId: string; label: string; memberVoices: string[]; intervals: MacSpeaker256Group['intervals'] }>; localization: 'estimated-ASR-with-native-support' | 'inherited-machine-estimate'; speakerPurityVerified: false; humanAnnotation?: { revision: number; annotationSHA256: string; members: number }; humanAnnotationInvalid?: true }
}

/** Expensive pure preparation: call only off-thread/offline with full verified inputs. */
export function prepareMacSpeakerCallPacket(input: MacSpeaker256SnapshotInput, state: MacSpeaker256State, options: { admission?: 'off' | 'qualified'; projectionPolicy?: 'strict' | 'anonymous-estimate' } = {}): MacSpeakerCallPacket {
  validateMacSpeaker256State(state, input)
  const { generation: _g, expectedStateSHA256: _e, ...source } = input
  const inspected = inspectMacSpeakerShadowCallSource(source)
  const displayLabels: Record<string, string> = {}
  // A display hint is a retained, already estimated Voice label, not a new
  // anonymous namespace. Identity claims live ONLY in the separate interval
  // metadata, never on unsupported occurrences of this same display hint.
  for (const g of state.groups) {
    const identity = state.identities.find(i => i.identityId === g.identityId && !i.retired)
    const hint = identity?.birthIntervals[0]?.originalVoice
    if (!hint || !VOICE.test(hint) || !g.memberVoices.includes(hint)) refuse('retained anonymous display hint')
    displayLabels[g.identityId] = hint
  }
  const body = {
    version: 1 as const, policy: 'fluid256-call-view-v1' as const, admission: options.admission ?? 'off', projectionPolicy: options.projectionPolicy ?? 'strict',
    captureId: state.captureId, generation: state.generation, revision: state.revision,
    baseSHA256: sha(input.currentJSON), ledgerSHA256: sha(input.ledgerJSONL), sourceBindingSHA256: state.sourceBindingSHA256,
    stateSHA256: state.stateSHA256, modelSHA256: state.modelSHA256, cliSHA256: state.cliSHA256,
    rawBindings: structuredClone(state.rawBindings), groups: structuredClone(state.groups),
    protectedRawChunkIndices: [...inspected.protection].sort((a, b) => a - b), aliasProtectedRawChunkIndices: [...inspected.humanProtection].sort((a, b) => a - b), displayLabels,
    provenance: { nativeAuthenticated: false as const, timingBasis: 'native-exclusive-intersect-machine-production' as const, speakerPurityVerified: false as const, excludedProductionSegments: structuredClone(inspected.excludedProductionSegments) },
  }
  const packet = { ...body, packetSHA256: digest(body) }
  if (Buffer.byteLength(JSON.stringify(packet)) > MAX_PACKET) refuse('packet byte bound')
  return packet
}

function checkPacket(p: MacSpeakerCallPacket, baseJSON: string, ledger: string, doc: Doc): void {
  if (!p || p.version !== 1 || p.policy !== 'fluid256-call-view-v1' || !['strict', 'anonymous-estimate'].includes(p.projectionPolicy) || !['off', 'qualified'].includes(p.admission) || p.captureId !== doc.sessionId || typeof p.generation !== 'string' || !p.generation || p.generation.length > 128 || !Number.isSafeInteger(p.revision) || p.revision < 1) refuse('packet identity')
  const { packetSHA256, ...body } = p
  if ([packetSHA256, p.baseSHA256, p.ledgerSHA256, p.sourceBindingSHA256, p.stateSHA256, p.modelSHA256, p.cliSHA256].some(h => !HASH.test(h)) || packetSHA256 !== digest(body) || p.baseSHA256 !== sha(baseJSON) || p.ledgerSHA256 !== sha(ledger)) refuse('packet/source/ledger drift')
  const cacheKey = `${packetSHA256}:${p.baseSHA256}:${p.ledgerSHA256}`
  if (checkedPackets.has(cacheKey)) return
  if (p.provenance?.nativeAuthenticated !== false || p.provenance?.speakerPurityVerified !== false || p.provenance?.timingBasis !== 'native-exclusive-intersect-machine-production') refuse('provenance')
  if (!Array.isArray(doc.chunkEntries) || !Array.isArray(doc.chunks) || !Array.isArray(p.rawBindings) || p.rawBindings.length !== doc.chunkEntries.length || p.rawBindings.length > 6000 || !Array.isArray(p.groups) || p.groups.length > 99 || !Array.isArray(p.protectedRawChunkIndices) || p.protectedRawChunkIndices.length > 6000) refuse('packet bounds')
  for (const indices of [p.protectedRawChunkIndices, p.aliasProtectedRawChunkIndices]) {
    if (!Array.isArray(indices) || indices.length > 6000) refuse('protected indices')
    const protectedSet = new Set(indices)
    if (protectedSet.size !== indices.length || [...protectedSet].some(i => !Number.isInteger(i) || i < 0 || i >= p.rawBindings.length)) refuse('protected indices')
  }
  for (const [i, r] of p.rawBindings.entries()) {
    const e = doc.chunkEntries[i]
    if (r.rawChunkIndex !== i || e.chunkIndex !== i || !HASH.test(r.audioSHA256) || !HASH.test(r.pcmSHA256) || !HASH.test(r.originalRowSHA256) || !Number.isSafeInteger(r.startSample) || !Number.isSafeInteger(r.endSample) || r.startSample < 0 || r.endSample <= r.startSample || r.endSample - r.startSample > 480000 || r.startSample !== Math.round(e.chunk.elapsed * 16) || e.chunk.audioSha256 && e.chunk.audioSha256 !== r.audioSHA256) refuse('raw binding')
  }
  const quarantined = p.provenance.excludedProductionSegments ?? []
  if (!Array.isArray(quarantined) || quarantined.length > 40000) refuse('quarantine bound')
  for (const q of quarantined) {
    const raw = p.rawBindings[q.rawChunkIndex], row = doc.chunkEntries[q.rawChunkIndex]?.chunk?.segments?.[q.segmentIndex]
    if (!raw || !row || !Number.isInteger(q.segmentIndex) || q.segmentIndex < 0 || q.reason !== 'generic-segment-crosses-source-end' || !HASH.test(q.rowSHA256) || q.rowSHA256 !== digest(row) || row.speaker !== 'Ext' || doc.chunkEntries[q.rawChunkIndex].chunk.speaker !== 'Ext' || q.startSec !== row.startSec || q.endSec !== row.endSec || q.sourceSamples !== raw.endSample - raw.startSample || q.overrunSamples <= 0 || q.overrunSamples > 16000 || Math.abs(q.overrunSamples - (q.endSec * 16000 - q.sourceSamples)) > 1e-6 || !p.protectedRawChunkIndices.includes(q.rawChunkIndex) || !p.aliasProtectedRawChunkIndices.includes(q.rawChunkIndex)) refuse('quarantine binding')
  }
  const ids = new Set<string>(), labels = new Set<string>(), voices = new Set<string>()
  let intervals = 0
  for (const g of p.groups) {
    if (typeof g.identityId !== 'string' || g.identityId.length > 128 || ids.has(g.identityId) || !HASH.test(g.groupSHA256) || !Array.isArray(g.memberVoices) || g.memberVoices.length < 2 || g.memberVoices.length > 99 || !g.memberVoices.every(v => VOICE.test(v) && !voices.has(v)) || new Set(g.memberVoices).size !== g.memberVoices.length || !g.memberVoices.includes(g.keepVoiceHint)) refuse('group identity')
    ids.add(g.identityId); g.memberVoices.forEach(v => voices.add(v))
    const label = p.displayLabels?.[g.identityId]
    if (!VOICE.test(label) || !g.memberVoices.includes(label) || labels.has(label)) refuse('anonymous display label')
    labels.add(label)
    if (!Array.isArray(g.witnesses) || g.witnesses.length !== 2 || !Array.isArray(g.intervals) || (intervals += g.intervals.length) > 40000) refuse('group bounds')
    const [a, b] = g.witnesses
    for (const w of [a, b]) if (!HASH.test(w.evidenceId) || !Number.isSafeInteger(w.startSample) || !Number.isSafeInteger(w.endSample) || w.endSample <= w.startSample || !Array.isArray(w.rawChunkIndices) || !w.rawChunkIndices.length || w.rawChunkIndices.length > 6000 || !Array.isArray(w.pcmSHA256s) || w.pcmSHA256s.length !== w.rawChunkIndices.length || w.pcmSHA256s.some(h => !HASH.test(h))) refuse('witness')
    if (a.startSample < b.endSample && b.startSample < a.endSample || a.rawChunkIndices.some(i => b.rawChunkIndices.includes(i)) || a.pcmSHA256s.some(h => b.pcmSHA256s.includes(h))) refuse('dependent witnesses')
    for (const s of g.intervals) {
      const r = p.rawBindings[s.rawChunkIndex]
      if (!r || s.identityId !== g.identityId || s.timingBasis !== p.provenance.timingBasis || !g.memberVoices.includes(s.originalVoice) || s.audioSHA256 !== r.audioSHA256 || s.pcmSHA256 !== r.pcmSHA256 || !Number.isSafeInteger(s.startSample) || !Number.isSafeInteger(s.endSample) || s.startSample < r.startSample || s.endSample > r.endSample || s.endSample <= s.startSample || !Array.isArray(s.evidenceIds) || s.evidenceIds.length !== 2 || s.evidenceIds.some(h => !g.witnesses.some(w => w.evidenceId === h))) refuse('interval binding')
    }
  }
  if (checkedPackets.size >= 8) checkedPackets.delete(checkedPackets.values().next().value!)
  checkedPackets.add(cacheKey)
}

/** Evaluation aliases intentionally test an aggregate hypothesis over residuals.
 * They can NEVER be selected by the HTTP loader below. They assert no real name. */
export function resolveMacSpeakerCallView(baseJSON: string, ledgerJSONL: string, packet: MacSpeakerCallPacket | null, options: { mode?: 'strict' | 'anonymous-estimate' | 'alias-evaluation'; allowEvaluation?: boolean } = {}): MacSpeakerCallView {
  const base = JSON.parse(baseJSON) as Doc
  const mode = options.mode ?? packet?.projectionPolicy ?? 'strict'
  const localization = mode === 'strict' ? 'estimated-ASR-with-native-support' as const : 'inherited-machine-estimate' as const
  const fallback = (reason: string): MacSpeakerCallView => ({ doc: base, metadata: { status: 'base', reason, mode, changedChunks: 0, changedWords: 0, groups: [], localization, speakerPurityVerified: false } })
  try {
    if (!packet) return fallback('packet-absent')
    if (!['strict', 'anonymous-estimate', 'alias-evaluation'].includes(mode)) refuse('view mode')
    if (Buffer.byteLength(baseJSON) > 32 * 1024 * 1024 || Buffer.byteLength(ledgerJSONL) > 8 * 1024 * 1024 || Buffer.byteLength(JSON.stringify(packet)) > MAX_PACKET) refuse('byte bound')
    checkPacket(packet, baseJSON, ledgerJSONL, base)
    if (mode === 'alias-evaluation' ? options.allowEvaluation !== true : packet.admission !== 'qualified') return fallback(mode === 'alias-evaluation' ? 'evaluation-not-authorized' : 'packet-off')
    if (mode === 'anonymous-estimate' && packet.projectionPolicy !== 'anonymous-estimate') refuse('packet policy mismatch')
    // Old qualified names are always validated against immutable BASE bytes.
    let proofStatus = checkedBaseProofs.get(packet.baseSHA256)
    if (!proofStatus) { proofStatus = readMacSpeakerMachineEvidence(base).status; remember(checkedBaseProofs, packet.baseSHA256, proofStatus) }
    if (proofStatus === 'invalid') return fallback('base-machine-proof-invalid')
    const doc = structuredClone(base), protectedRaw = new Set(mode === 'anonymous-estimate' ? packet.aliasProtectedRawChunkIndices : packet.protectedRawChunkIndices)
    const existingVoiceHints = new Set(base.chunks.map((c: Doc) => c.speaker).filter((label: unknown) => typeof label === 'string' && VOICE.test(label)))
    const byRaw = new Map<number, Array<{ g: MacSpeaker256Group; lo: number; hi: number; voice: string }>>()
    const aliases = new Map(packet.groups.flatMap(g => g.memberVoices.map(v => [v, g] as const)))
    // Nested/HQ estimates must agree with their immutable source turn. A
    // different accepted Voice in a mixed turn is not authorized by the root's
    // aggregate recurrence decision, even if that other Voice has its own group.
    const sourceGroups = new Map<number, string>()
    let basePosition = 0
    for (const e of base.chunkEntries) {
      if (typeof e.chunk.text !== 'string' || !e.chunk.text.trim()) continue
      const root = base.chunks[basePosition++]
      const rawGroup = aliases.get(e.chunk.speaker)?.identityId
      if (rawGroup && aliases.get(root?.speaker)?.identityId === rawGroup) sourceGroups.set(e.chunkIndex, rawGroup)
    }
    const agreesWithSource = (raw: number, voice: unknown): boolean => typeof voice === 'string' && sourceGroups.has(raw) && aliases.get(voice)?.identityId === sourceGroups.get(raw)
    for (const g of packet.groups) for (const s of g.intervals) { const list = byRaw.get(s.rawChunkIndex) ?? []; list.push({ g, lo: s.startSample, hi: s.endSample, voice: s.originalVoice }); byRaw.set(s.rawChunkIndex, list) }
    for (const list of byRaw.values()) list.sort((a, b) => a.lo - b.lo || a.hi - b.hi)
    const labelFor = (raw: number, lo: number, hi: number, voice: unknown): string | null => {
      if (protectedRaw.has(raw) || typeof voice !== 'string' || !VOICE.test(voice) || hi <= lo) return null
      if (mode !== 'strict') { const hint = mode === 'anonymous-estimate' ? packet.displayLabels[aliases.get(voice)?.identityId ?? ''] : aliases.get(voice)?.keepVoiceHint; return hint && existingVoiceHints.has(hint) ? hint : null }
      let end = lo, group: MacSpeaker256Group | null = null
      for (const s of byRaw.get(raw) ?? []) {
        if (s.voice !== voice || s.hi <= lo || s.lo >= hi) continue
        if (group && group.identityId !== s.g.identityId || s.lo > end) return null
        group = s.g; end = Math.max(end, s.hi)
      }
      return end >= hi && group && existingVoiceHints.has(packet.displayLabels[group.identityId]) ? packet.displayLabels[group.identityId] : null
    }
    let changedChunks = 0, changedWords = 0, position = 0
    for (const e of doc.chunkEntries) {
      const raw = e.chunkIndex, c = e.chunk, r = packet.rawBindings[raw]
      if (typeof c.text !== 'string' || !c.text.trim()) continue
      const root = doc.chunks[position++]
      if (mode === 'anonymous-estimate') {
        if (!root || protectedRaw.has(raw) || hasMacSpeakerProtectedRows(c) || hasMacSpeakerProtectedRows(root)) continue
        let changed = false
        // This policy consolidates an ALREADY automatic Voice estimate. A
        // structural Ext/Unknown field stays unchanged. Nested fields may use
        // only the source turn's accepted group, never an independent group.
        for (const row of [root, c]) {
          for (const nested of [...(row.segments ?? []), ...(row.finalSegments ?? []), ...(row.words ?? [])]) {
            if (!agreesWithSource(raw, nested.speaker)) continue
            const to = labelFor(raw, r.startSample, r.endSample, nested.speaker)
            if (to && to !== nested.speaker) { nested.speaker = to; changed = true }
          }
          const to = labelFor(raw, r.startSample, r.endSample, row.speaker)
          if (to && to !== row.speaker) { row.speaker = to; changed = true }
        }
        if (changed) changedChunks++
        continue
      }
      if (!root || protectedRaw.has(raw) || hasMacSpeakerProtectedRows(c) || hasMacSpeakerProtectedRows(root) || !VOICE.test(root.speaker) || root.speaker !== c.speaker) continue
      const segs = Array.isArray(c.segments) && c.segments.length ? c.segments : [{ speaker: c.speaker, startSec: 0, endSec: (r.endSample - r.startSample) / 16000 }]
      const labels = segs.map((s: Doc) => labelFor(raw, r.startSample + Math.round(s.startSec * 16000), r.startSample + Math.round(s.endSec * 16000), s.speaker))
      const to = labels[0]
      if (!to || labels.some((v: unknown) => v !== to)) continue
      // A root claim cannot silently extend beyond another stored localization
      // surface. Final segments and ASR words have their own clocks; every
      // declared row must be covered, even when its speaker field is absent.
      if (mode === 'strict' && [root, c].some(row => ['segments', 'finalSegments', 'words'].some(key => row[key] !== undefined && (!Array.isArray(row[key]) || row[key].some((nested: Doc) => {
        const start = key === 'words' ? nested.start : nested.startSec, end = key === 'words' ? nested.end : nested.endSec
        return !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || (nested.speaker !== undefined && nested.speaker !== root.speaker) || labelFor(raw, r.startSample + Math.round(start * 16000), r.startSample + Math.round(end * 16000), root.speaker) !== to
      }))))) continue
      const from = root.speaker
      for (const row of [root, c]) { row.speaker = to; for (const key of ['segments', 'finalSegments', 'words']) for (const nested of row[key] ?? []) if (nested.speaker === from) nested.speaker = to }
      if (to !== base.chunks[position - 1].speaker) changedChunks++
    }
    // HQ word seconds index concatenated RAW files, including silent files.
    for (const segment of doc.batchSegments ?? []) {
      if (!Number.isInteger(segment.startChunkIdx) || !Number.isInteger(segment.endChunkIdx) || segment.startChunkIdx < 0 || segment.endChunkIdx < segment.startChunkIdx || segment.endChunkIdx >= packet.rawBindings.length || !Array.isArray(segment.speakerWords)) refuse('batch geometry')
      const clock: Array<{ raw: number; lo: number; hi: number }> = []; let offset = 0
      for (let raw = segment.startChunkIdx; raw <= segment.endChunkIdx; raw++) { const r = packet.rawBindings[raw], n = r.endSample - r.startSample; clock.push({ raw, lo: offset, hi: offset + n }); offset += n }
      for (const w of segment.speakerWords) {
        if (isMacSpeakerHumanProtected(w) || !VOICE.test(w.speaker)) continue
        const lo = Math.round(w.start * 16000), hi = Math.round(w.end * 16000)
        if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 0 || hi <= lo || hi > offset) continue
        // Raw PCM intervals are contiguous and ordered even when ASR words are
        // not. Avoid scanning every raw file for every word on the HTTP path.
        let left = 0, right = clock.length
        while (left < right) { const mid = (left + right) >>> 1; if (clock[mid].hi <= lo) left = mid + 1; else right = mid }
        const parts: typeof clock = []
        for (let i = left; i < clock.length && clock[i].lo < hi; i++) parts.push(clock[i])
        const targets = parts.map(c => { const r = packet.rawBindings[c.raw]; return mode === 'anonymous-estimate' && !agreesWithSource(c.raw, w.speaker) ? null : labelFor(c.raw, r.startSample + Math.max(0, lo - c.lo), r.startSample + Math.min(c.hi - c.lo, hi - c.lo), w.speaker) })
        if (targets.length && targets[0] && targets.every(t => t === targets[0])) { if (w.speaker !== targets[0]) changedWords++; w.speaker = targets[0] }
      }
    }
    return { doc, metadata: { status: 'applied', reason: 'source-bound-anonymous-view', mode, revision: packet.revision, generation: packet.generation, packetSHA256: packet.packetSHA256, changedChunks, changedWords, groups: packet.groups.map(g => ({ identityId: g.identityId, label: mode === 'alias-evaluation' ? g.keepVoiceHint : packet.displayLabels[g.identityId], memberVoices: g.memberVoices, intervals: g.intervals })), localization, speakerPurityVerified: false } }
  } catch (e) { return fallback(e instanceof Error ? e.message : 'invalid-packet') }
}
/** Legacy naming actions cannot represent projected multi-source/word scopes. */
export function isEffectiveMacSpeakerCallView(view: MacSpeakerCallView): boolean {
  return view.metadata.status === 'applied' && (view.metadata.changedChunks > 0 || view.metadata.changedWords > 0)
}

/** Exact prefix-only label edits; refuses transcript drift instead of guessing. */
export function renderMacSpeakerCallMarkdown(markdown: string, base: Doc, view: MacSpeakerCallView): string {
  if (view.metadata.status !== 'applied' || !view.metadata.changedWords) return markdown
  return renderMarkdown(markdown, boundWords(base, view.doc))
}
function boundedFile(path: string, maximum: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = fstatSync(fd); if (!st.isFile() || st.size > maximum) refuse('file bound')
    const buffer = Buffer.allocUnsafe(st.size + 1); let length = 0
    while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n }
    const after = fstatSync(fd)
    if (length !== st.size || st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs) refuse('file changed during read')
    return buffer.subarray(0, length).toString('utf8')
  } finally { closeSync(fd) }
}
export function readMacSpeakerCallView(sidecarPath: string, baseJSON: string, markdownPath?: string): MacSpeakerCallView {
  let humanPresent = false
  try {
    const doc = JSON.parse(baseJSON)
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(doc.sessionId) || !sidecarPath.endsWith('.g2-chunks.json')) return resolveMacSpeakerCallView(baseJSON, '', null)
    let packet: MacSpeakerCallPacket | null = null
    try { packet = JSON.parse(boundedFile(sidecarPath.replace(/\.g2-chunks\.json$/, '.speaker-call.json'), MAX_PACKET)) as MacSpeakerCallPacket } catch { /* Independent human annotations remain readable after automatic withdrawal. */ }
    const mdPath = markdownPath ?? sidecarPath.replace(/\.g2-chunks\.json$/, '.md')
    const paths = macCallHumanPaths({ sidecarPath, meetingPath: mdPath }, doc.sessionId)
    humanPresent = true // Unreadable annotation files must refuse competing writes.
    const annotation = readMacCallHumanFile(paths.annotation, 16 * 1024 * 1024, true)
    humanPresent = annotation !== null
    let ledger = ''
    try { ledger = boundedFile(dataPath('meeting-corrections', `${doc.sessionId.replace(/:/g, '_')}.jsonl`), 8 * 1024 * 1024) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    const view = applyMacCallHumanAnnotation(baseJSON, ledger, annotation?.text ?? null, resolveMacSpeakerCallView(baseJSON, ledger, packet))
    let markdown: string
    try { markdown = boundedFile(mdPath, 16 * 1024 * 1024) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return view; throw e }
    view.markdown = renderMacSpeakerCallMarkdown(markdown, doc, view)
    return view
  } catch { const view = resolveMacSpeakerCallView(baseJSON, '', null); if (humanPresent) { view.metadata.humanAnnotationInvalid = true; view.metadata.reason = 'human-annotation-invalid' }; return view }
}
