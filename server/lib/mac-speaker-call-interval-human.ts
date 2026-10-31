/** Exact HQ-word human decisions over immutable BASE. No enrollment, source,
 * profile, Markdown, or shared corrections-ledger writes occur in this module. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { applyMacCallHumanAnnotation, isMacCallHumanName, macCallHumanPaths, readMacCallHumanFile, type MacCallHumanFiles } from './mac-speaker-call-human.js'
import { resolveMacSpeakerCallView, validateMacSpeakerCallPacket, type MacSpeakerCallPacket, type MacSpeakerCallView } from './mac-speaker-call-view.js'
import { createMacSpeakerCallIntervalProjector } from './mac-speaker-call-interval-projection.js'
import { isMacSpeakerHumanProtected } from './mac-speaker-protection.js'
import { isUnattributed } from './meeting-speaker-review.js'

const POLICY = 'mac-speaker-call-interval-human-v1'
const SHA = /^[a-f0-9]{64}$/
const MAX = 16 * 1024 * 1024
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const digest = (v: unknown) => hash(JSON.stringify(v))
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function fail(s: string): never { throw new Error(`Mac interval human: ${s}`) }
export interface MacIntervalHumanMember {
  id: string; text: string; elapsedMs: number; startElapsedMs: number; endElapsedMs: number; wordCount: 1
}
interface Word extends MacIntervalHumanMember {
  batchIndex: number; wordIndex: number; wordSHA256: string; rawChunkIndices: number[]
}
interface Source {
  baseSHA256: string; markdownSHA256: string; ledgerSHA256: string; legacyAnnotationSHA256: string | null
}
export interface MacIntervalHumanScope extends Source {
  kind: 'interval-words' | 'unresolved-words' | 'human-words'; identityId: string; displayLabel: string; scopeSHA256: string
  members: MacIntervalHumanMember[]; fieldCount: number; annotationSHA256: string | null
  /** Each run contains consecutive actual HQ indices from exactly one batch. */
  selectionRuns?: string[][]
  /** Null records that the manual review had no applied automatic packet. */
  projectionPacketSHA256?: string | null
  /** Existing source labels cannot become a new exact-word confirmation. */
  forbiddenNames: string[]
  packetSHA256: string; supportSHA256: string; generation: string; packetRevision: number
}
export interface MacIntervalHumanInput {
  baseJSON: string; markdown: string; ledgerJSONL: string; legacyAnnotationJSON: string | null
  annotationJSON: string | null; packet: MacSpeakerCallPacket | null; view: MacSpeakerCallView
}
interface NameEvent {
  kind: 'name'; id: string; at: string; identityId: string; displayLabel: string; to: string
  scopeSHA256: string; packetSHA256: string; supportSHA256: string; generation: string; packetRevision: number
  priorAnnotationSHA256: string | null; members: Word[]
  reviewKind?: MacIntervalHumanScope['kind']; supersedesActionId?: string
  projectionPacketSHA256?: string | null
}
interface UndoEvent { kind: 'undo'; id: string; at: string; actionId: string; priorAnnotationSHA256: string }
type Event = NameEvent | UndoEvent
interface Annotation extends Source {
  version: 1; policy: typeof POLICY; captureId: string; revision: number
  packets: MacSpeakerCallPacket[]; events: Event[]; annotationSHA256: string
}
export interface MacIntervalHumanMetadata {
  revision: number; annotationSHA256: string
  activeActions: Array<{ actionId: string; identityId: string; to: string; memberIds: string[] }>
  confirmedWords: Array<{ batchIndex: number; wordIndex: number; label: string; wordSHA256: string }>
}
function source(input: Pick<MacIntervalHumanInput, 'baseJSON' | 'markdown' | 'ledgerJSONL' | 'legacyAnnotationJSON'>): Source {
  if (Buffer.byteLength(input.baseJSON) > 32 * 1024 * 1024 || Buffer.byteLength(input.markdown) > MAX || Buffer.byteLength(input.ledgerJSONL) > 8 * 1024 * 1024 || Buffer.byteLength(input.legacyAnnotationJSON ?? '') > MAX) fail('source byte budget')
  return { baseSHA256: hash(input.baseJSON), markdownSHA256: hash(input.markdown), ledgerSHA256: hash(input.ledgerJSONL), legacyAnnotationSHA256: input.legacyAnnotationJSON === null ? null : hash(input.legacyAnnotationJSON) }
}
function seal(body: Omit<Annotation, 'annotationSHA256'>): Annotation { return { ...body, annotationSHA256: digest(body) } }
function packetWords(baseJSON: string, ledger: string, packet: MacSpeakerCallPacket): Map<string, Word & { identityId: string }> {
  validateMacSpeakerCallPacket(baseJSON, ledger, packet)
  if (packet.version !== 2 || packet.projectionPolicy !== 'source-bound-intervals' || packet.admission !== 'qualified' || !packet.intervalSupport) fail('qualified interval packet required')
  const base = JSON.parse(baseJSON)
  const projector = createMacSpeakerCallIntervalProjector({ rawBindings: packet.rawBindings, groups: packet.groups, displayLabels: packet.displayLabels, protectedRawChunkIndices: packet.aliasProtectedRawChunkIndices }, packet.intervalSupport)
  const words = projector.hqWords(base)
  if (words.length > 40000) fail('word budget')
  const out = new Map<string, Word & { identityId: string }>()
  for (const w of words) {
    const batch = base.batchSegments[w.batchIndex], row = batch.speakerWords[w.wordIndex], wordSHA256 = digest(row)
    // The reviewer presents the stored batch clock. A supported capture-piece
    // clock can differ after raw gaps/overlaps; naming must never display a
    // different interval from the one explicitly reviewed. Keep stored timing
    // untouched and admit only clocks agreeing within one 16kHz sample.
    const offset = typeof batch.startElapsed === 'number' && Number.isFinite(batch.startElapsed) ? batch.startElapsed : 0
    if (Math.abs(offset + row.start * 1000 - w.startElapsedMs) > 1 / 16 || Math.abs(offset + row.end * 1000 - w.endElapsedMs) > 1 / 16) continue
    const id = digest({ policy: POLICY, baseSHA256: packet.baseSHA256, batchIndex: w.batchIndex, wordIndex: w.wordIndex, wordSHA256 })
    const member: Word & { identityId: string } = { id, text: row.word.slice(0, 600), elapsedMs: w.startElapsedMs, startElapsedMs: w.startElapsedMs, endElapsedMs: w.endElapsedMs, wordCount: 1, batchIndex: w.batchIndex, wordIndex: w.wordIndex, wordSHA256, rawChunkIndices: w.rawChunkIndices, identityId: w.identityId }
    if (out.has(id) || !Number.isFinite(member.startElapsedMs) || !Number.isFinite(member.endElapsedMs) || member.endElapsedMs <= member.startElapsedMs) fail('word geometry')
    out.set(id, member)
  }
  return out
}
function publicMember(w: Word): MacIntervalHumanMember {
  return { id: w.id, text: w.text, elapsedMs: w.elapsedMs, startElapsedMs: w.startElapsedMs, endElapsedMs: w.endElapsedMs, wordCount: 1 }
}
function cleanWord(w: Word & { identityId?: string }): Word { const { identityId: _, ...word } = w; return word }
const actionIdentity = (id: string) => `action-${id.slice(POLICY.length + 1)}`
function assertContiguousWords(members: Word[]): void {
  if (!members.length || members.some((w, i) => w.batchIndex !== members[0].batchIndex || i > 0 && w.wordIndex !== members[i - 1].wordIndex + 1)) fail('manual selection must be one contiguous range in one batch')
}
function effectiveUnresolved(value: unknown): boolean {
  if (!value || typeof value !== 'object' || isMacSpeakerHumanProtected(value)) return false
  const speaker = (value as Record<string, unknown>).speaker ?? ''
  return typeof speaker === 'string' && (isUnattributed(speaker) || /^(?:ext|unknown|unidentified(?: \d+| voice)?|speaker(?: \d+)?|voice [1-9]\d?)$/i.test(speaker.trim()))
}
function manualWords(baseJSON: string, packet: MacSpeakerCallPacket): Map<string, Word> {
  const base = JSON.parse(baseJSON), out = new Map<string, Word>()
  if (!packet.intervalSupport) fail('qualified interval packet required')
  const projector = createMacSpeakerCallIntervalProjector({ rawBindings: packet.rawBindings, groups: packet.groups, displayLabels: packet.displayLabels, protectedRawChunkIndices: packet.aliasProtectedRawChunkIndices }, packet.intervalSupport)
  const sources = projector.hqWordSources(base)
  if (sources.length > 40000) fail('manual word budget')
  for (const w of sources) {
    const batch = base.batchSegments[w.batchIndex], row = batch.speakerWords[w.wordIndex]
    if (!effectiveUnresolved(row)) continue
    const offset = typeof batch.startElapsed === 'number' && Number.isFinite(batch.startElapsed) ? batch.startElapsed : 0
    const startElapsedMs = offset + row.start * 1000, endElapsedMs = offset + row.end * 1000, wordSHA256 = digest(row)
    if (!Number.isFinite(startElapsedMs) || !Number.isFinite(endElapsedMs) || startElapsedMs < 0 || endElapsedMs <= startElapsedMs) continue
    const id = digest({ policy: POLICY, baseSHA256: packet.baseSHA256, batchIndex: w.batchIndex, wordIndex: w.wordIndex, wordSHA256 })
    if (out.has(id)) fail('duplicate manual word')
    out.set(id, { id, text: row.word.slice(0, 600), elapsedMs: startElapsedMs, startElapsedMs, endElapsedMs, wordCount: 1, batchIndex: w.batchIndex, wordIndex: w.wordIndex, wordSHA256, rawChunkIndices: w.rawChunkIndices })
  }
  return out
}
function qualifiedPacket(input: Pick<MacIntervalHumanInput, 'baseJSON' | 'ledgerJSONL' | 'packet'>): MacSpeakerCallPacket | null {
  try {
    const p = input.packet
    if (!p || p.version !== 2 || p.admission !== 'qualified' || p.projectionPolicy !== 'source-bound-intervals' || !p.intervalSupport) return null
    validateMacSpeakerCallPacket(input.baseJSON, input.ledgerJSONL, p)
    return p
  } catch { return null } // Automatic withdrawal never invalidates an audited human action.
}
function legacySource(input: Pick<MacIntervalHumanInput, 'baseJSON' | 'ledgerJSONL' | 'legacyAnnotationJSON'>): MacSpeakerCallView {
  return applyMacCallHumanAnnotation(input.baseJSON, input.ledgerJSONL, input.legacyAnnotationJSON, resolveMacSpeakerCallView(input.baseJSON, input.ledgerJSONL, null))
}
/** Inspect all source speaker fields, including protected/nested HQ surfaces.
 * Interval annotations are deliberately excluded, so disjoint exact words may
 * share a name assigned by this mechanism without absorbing old source text. */
function forbiddenSourceNames(base: unknown, legacy: unknown): string[] {
  const labels = new Set<string>(), pending: unknown[] = [base, legacy]
  let count = 0
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    if (++count > 500000) fail('source field budget')
    if (Array.isArray(value)) { for (const child of value) if (child && typeof child === 'object') pending.push(child); continue }
    const row = value as Record<string, unknown>
    if (typeof row.speaker === 'string' && isMacCallHumanName(row.speaker)) labels.add(row.speaker)
    for (const v of Object.values(row)) if (v && typeof v === 'object') pending.push(v)
  }
  if (labels.size > 40000) fail('source label budget')
  return [...labels].sort()
}
function assertFreshTarget(to: string, forbiddenNames: readonly string[]): void {
  const key = (s: string) => s.normalize('NFKC').toLowerCase()
  if (forbiddenNames.some(name => key(name) === key(to))) fail('target name already exists in source')
}
function validate(input: Omit<MacIntervalHumanInput, 'packet' | 'view'>): { annotation: Annotation | null; active: NameEvent[]; undone: Set<string> } {
  const binding = source(input)
  if (input.annotationJSON === null) return { annotation: null, active: [], undone: new Set() }
  if (Buffer.byteLength(input.annotationJSON) > MAX) fail('annotation byte budget')
  const a = JSON.parse(input.annotationJSON) as Annotation, base = JSON.parse(input.baseJSON)
  const { annotationSHA256, ...body } = a ?? {}
  if (!a || a.version !== 1 || a.policy !== POLICY || a.captureId !== base.sessionId || !equal(binding, { baseSHA256: a.baseSHA256, markdownSHA256: a.markdownSHA256, ledgerSHA256: a.ledgerSHA256, legacyAnnotationSHA256: a.legacyAnnotationSHA256 }) || !SHA.test(annotationSHA256) || annotationSHA256 !== digest(body) || !Number.isSafeInteger(a.revision) || a.revision < 1 || !Array.isArray(a.events) || a.events.length !== a.revision || a.events.length > 6000 || !Array.isArray(a.packets) || !a.packets.length || a.packets.length > 32) fail('annotation source or integrity changed')
  const referenced = new Set(a.events.filter(e => e?.kind === 'name').map(e => (e as NameEvent).packetSHA256))
  if (a.packets.some(p => !p || !referenced.has(p.packetSHA256))) fail('unreferenced audited packet')
  const packets = new Map<string, MacSpeakerCallPacket>(), words = new Map<string, ReturnType<typeof packetWords>>()
  let projectedWordCount = 0
  for (const p of a.packets) {
    if (packets.has(p.packetSHA256)) fail('duplicate packet')
    const projected = packetWords(input.baseJSON, input.ledgerJSONL, p)
    if ((projectedWordCount += projected.size) > 40000) fail('aggregate audited word budget')
    packets.set(p.packetSHA256, p); words.set(p.packetSHA256, projected)
  }
  // Validate v1 first, including its shared-ledger coverage and protected sources.
  const legacy = legacySource(input), forbiddenNames = forbiddenSourceNames(base, legacy.doc)
  const seen = new Set<string>(), names = new Map<string, NameEvent>(), active = new Map<string, NameEvent>(), occupied = new Set<string>(), usedPackets = new Set<string>(), undone = new Set<string>()
  const manual = new Map<string, Map<string, Word>>()
  const prefixPackets: MacSpeakerCallPacket[] = []
  let memberCount = 0, auditVerificationBytes = 0
  for (const [index, event] of a.events.entries()) {
    if (!event || typeof event.id !== 'string' || !event.id.startsWith(`${POLICY}:`) || seen.has(event.id) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) fail('audit event')
    seen.add(event.id)
    if (event.priorAnnotationSHA256 !== null && !SHA.test(event.priorAnnotationSHA256) || index === 0 && event.priorAnnotationSHA256 !== null || index > 0 && event.priorAnnotationSHA256 === null) fail('audit chain')
    if (index > 0) {
      // Replay the exact preceding envelope, adding a retained packet only on
      // its first name event. This authenticates the append-only prefix rather
      // than accepting any syntactically valid predecessor hash. Bound total
      // hashing work as well as retained bytes for adversarial local inputs.
      const prefix = JSON.stringify({ version: 1, policy: POLICY, captureId: a.captureId, ...binding, revision: index, packets: prefixPackets, events: a.events.slice(0, index) })
      if ((auditVerificationBytes += Buffer.byteLength(prefix)) > 256 * 1024 * 1024) fail('audit verification budget')
      if (event.priorAnnotationSHA256 !== hash(prefix)) fail('audit chain predecessor changed')
    }
    if (event.kind === 'undo') {
      const target = names.get(event.actionId)
      if (!target || !active.has(event.actionId)) fail('undo action')
      const ids = new Set(target.members.map(m => m.id))
      if ([...active.values()].some(e => e !== target && a.events.indexOf(e) > a.events.indexOf(target) && e.members.some(m => ids.has(m.id)))) fail('undo overlaps later active edit')
      active.delete(event.actionId)
      target.members.forEach(m => occupied.delete(m.id))
      undone.add(event.actionId)
      if (target.supersedesActionId) {
        const predecessor = names.get(target.supersedesActionId)
        if (!predecessor || undone.has(predecessor.id) || predecessor.members.some(m => occupied.has(m.id))) fail('rename predecessor conflict')
        active.set(predecessor.id, predecessor); predecessor.members.forEach(m => occupied.add(m.id))
      }
      continue
    }
    if (event.kind !== 'name' || !isMacCallHumanName(event.to) || !SHA.test(event.scopeSHA256) || !Array.isArray(event.members) || !event.members.length || (memberCount += event.members.length) > 40000 || new Set(event.members.map(m => m.id)).size !== event.members.length) fail('name event')
    assertFreshTarget(event.to, forbiddenNames)
    const packet = packets.get(event.packetSHA256)
    if (!packet || packet.generation !== event.generation || packet.revision !== event.packetRevision || packet.intervalSupport!.supportSHA256 !== event.supportSHA256) fail('audited packet binding')
    const reviewKind = event.reviewKind ?? 'interval-words'
    let expectedWords: Map<string, Word | (Word & { identityId: string })> = words.get(packet.packetSHA256)!
    if (reviewKind === 'human-words') {
      const predecessor = event.supersedesActionId ? active.get(event.supersedesActionId) : undefined
      if (!predecessor || event.identityId !== actionIdentity(predecessor.id) || event.displayLabel !== predecessor.to || event.packetSHA256 !== predecessor.packetSHA256 || !equal(event.members, predecessor.members)) fail('rename must supersede one whole active action')
      active.delete(predecessor.id); predecessor.members.forEach(m => occupied.delete(m.id))
      expectedWords = new Map(predecessor.members.map(m => [m.id, m]))
    } else if (reviewKind === 'unresolved-words') {
      if (event.supersedesActionId !== undefined || event.identityId !== 'unresolved' || event.displayLabel !== 'Unresolved speech' || event.projectionPacketSHA256 !== null && event.projectionPacketSHA256 !== event.packetSHA256) fail('manual review identity')
      assertContiguousWords(event.members)
      if (!manual.has(packet.packetSHA256)) {
        const candidates = manualWords(input.baseJSON, packet)
        if ((projectedWordCount += candidates.size) > 40000) fail('aggregate audited word budget')
        manual.set(packet.packetSHA256, candidates)
      }
      expectedWords = manual.get(packet.packetSHA256)!
      const projection = event.projectionPacketSHA256 ? resolveMacSpeakerCallView(input.baseJSON, input.ledgerJSONL, packet).doc : base
      for (const m of event.members) if (!effectiveUnresolved(projection.batchSegments?.[m.batchIndex]?.speakerWords?.[m.wordIndex])) fail('manual word was not unresolved')
    } else if (reviewKind !== 'interval-words' || event.supersedesActionId !== undefined || packet.displayLabels[event.identityId] !== event.displayLabel) fail('audited group binding')
    if (!usedPackets.has(packet.packetSHA256)) prefixPackets.push(packet)
    usedPackets.add(packet.packetSHA256)
    for (const member of event.members) {
      const actual = expectedWords.get(member.id)
      const row = legacy.doc.batchSegments?.[member.batchIndex]?.speakerWords?.[member.wordIndex]
      if (!actual || reviewKind === 'interval-words' && (!('identityId' in actual) || actual.identityId !== event.identityId) || !equal(cleanWord(actual), member) || !row || digest(row) !== member.wordSHA256 || isMacSpeakerHumanProtected(row)) fail('audited word source changed')
      // Names are allowed only over anonymous projected words. Earlier active
      // human decisions cannot be overwritten by manufacturing another event.
      if (occupied.has(member.id)) fail('overlapping active human decision')
    }
    event.members.forEach(m => occupied.add(m.id))
    names.set(event.id, event); active.set(event.id, event)
  }
  if (usedPackets.size !== packets.size) fail('unreferenced audited packet')
  if (!equal(a.packets.map(p => p.packetSHA256), prefixPackets.map(p => p.packetSHA256))) fail('audited packet order changed')
  return { annotation: a, active: [...active.values()], undone }
}
function canonical(input: Omit<MacIntervalHumanInput, 'view'>): MacSpeakerCallView {
  const automatic = resolveMacSpeakerCallView(input.baseJSON, input.ledgerJSONL, input.packet)
  const legacy = applyMacCallHumanAnnotation(input.baseJSON, input.ledgerJSONL, input.legacyAnnotationJSON, automatic)
  return applyMacIntervalHumanAnnotation({ ...input, view: legacy })
}
export function applyMacIntervalHumanAnnotation(input: MacIntervalHumanInput): MacSpeakerCallView {
  const { annotation, active } = validate(input)
  if (!annotation) return input.view
  const doc = structuredClone(input.view.doc), base = JSON.parse(input.baseJSON), confirmedWords: MacIntervalHumanMetadata['confirmedWords'] = []
  for (const event of active) for (const m of event.members) {
    const row = doc.batchSegments?.[m.batchIndex]?.speakerWords?.[m.wordIndex], original = base.batchSegments[m.batchIndex].speakerWords[m.wordIndex]
    // The source-bound decision survives packet withdrawal, but never replaces
    // a new protected claim, changed word, or differently named legacy field.
    if (!row || isMacSpeakerHumanProtected(row) || !equal({ ...row, speaker: original.speaker }, original) || isMacCallHumanName(row.speaker) && row.speaker !== event.to && row.speaker !== original.speaker) fail('current word conflicts with human decision')
    row.speaker = event.to
    confirmedWords.push({ batchIndex: m.batchIndex, wordIndex: m.wordIndex, label: event.to, wordSHA256: m.wordSHA256 })
  }
  const metadata: MacIntervalHumanMetadata = { revision: annotation.revision, annotationSHA256: annotation.annotationSHA256, activeActions: active.map(e => ({ actionId: e.id, identityId: actionIdentity(e.id), to: e.to, memberIds: e.members.map(m => m.id) })), confirmedWords }
  return { ...input.view, doc, metadata: { ...input.view.metadata, intervalHumanAnnotation: metadata } } as MacSpeakerCallView
}
export function buildMacIntervalHumanScopes(input: MacIntervalHumanInput): MacIntervalHumanScope[] {
  const binding = source(input), checked = canonical(input), { annotation, active } = validate(input)
  if (!equal(input.view.doc, checked.doc) || input.view.metadata.status !== checked.metadata.status || input.view.metadata.packetSHA256 !== checked.metadata.packetSHA256) fail('unvalidated reviewed view')
  const current = qualifiedPacket(input), packet = current ?? annotation?.packets.at(-1) ?? null
  const forbiddenNames = forbiddenSourceNames(JSON.parse(input.baseJSON), legacySource(input).doc)
  Object.freeze(forbiddenNames)
  const result: MacIntervalHumanScope[] = []
  const add = (kind: MacIntervalHumanScope['kind'], identityId: string, displayLabel: string, members: MacIntervalHumanMember[], basis: MacSpeakerCallPacket, extra: Pick<MacIntervalHumanScope, 'selectionRuns' | 'projectionPacketSHA256'> = {}) => {
    const body = { kind, identityId, displayLabel, members, fieldCount: members.length, forbiddenNames, ...extra, ...binding, annotationSHA256: input.annotationJSON === null ? null : hash(input.annotationJSON), packetSHA256: basis.packetSHA256, supportSHA256: basis.intervalSupport!.supportSHA256, generation: basis.generation, packetRevision: basis.revision }
    const scope = { ...body, scopeSHA256: digest(body) }
    members.forEach(Object.freeze); Object.freeze(members)
    if (extra.selectionRuns) { extra.selectionRuns.forEach(Object.freeze); Object.freeze(extra.selectionRuns) }
    result.push(Object.freeze(scope))
  }
  const applied = current && checked.metadata.status === 'applied' && checked.metadata.packetSHA256 === current.packetSHA256
  if (applied) {
    const words = packetWords(input.baseJSON, input.ledgerJSONL, current), groups = new Map<string, MacIntervalHumanMember[]>()
    for (const w of words.values()) {
      const row = checked.doc.batchSegments?.[w.batchIndex]?.speakerWords?.[w.wordIndex], label = current.displayLabels[w.identityId]
      if (!row || row.speaker !== label || isMacSpeakerHumanProtected(row) || !checked.metadata.groups.some(g => g.identityId === w.identityId && g.label === label)) continue
      const list = groups.get(w.identityId) ?? []; list.push(publicMember(w)); groups.set(w.identityId, list)
    }
    for (const [id, members] of groups) add('interval-words', id, current.displayLabels[id], members, current)
  }
  if (packet) {
    const legacy = legacySource(input), members: MacIntervalHumanMember[] = [], runs: string[][] = []
    let previous: Word | undefined
    for (const word of manualWords(input.baseJSON, packet).values()) {
      const row = checked.doc.batchSegments?.[word.batchIndex]?.speakerWords?.[word.wordIndex], old = legacy.doc.batchSegments?.[word.batchIndex]?.speakerWords?.[word.wordIndex]
      if (!effectiveUnresolved(row) || !old || digest(old) !== word.wordSHA256 || isMacSpeakerHumanProtected(old)) continue
      if (!previous || previous.batchIndex !== word.batchIndex || previous.wordIndex + 1 !== word.wordIndex) runs.push([])
      runs.at(-1)!.push(word.id); members.push(publicMember(word)); previous = word
    }
    if (members.length) add('unresolved-words', 'unresolved', 'Unresolved speech', members, packet, { selectionRuns: runs, projectionPacketSHA256: applied ? current.packetSHA256 : null })
  }
  for (const action of active) {
    const basis = annotation!.packets.find(p => p.packetSHA256 === action.packetSHA256)
    if (!basis) fail('active action packet missing')
    add('human-words', actionIdentity(action.id), action.to, action.members.map(publicMember), basis)
  }
  return result
}
export function previewMacIntervalHumanAnnotation(scope: MacIntervalHumanScope, memberIds: string[], to: string): { members: MacIntervalHumanMember[]; fields: number } {
  if (!isMacCallHumanName(to) || !Array.isArray(memberIds) || !memberIds.length || memberIds.length > 40000 || memberIds.some(id => typeof id !== 'string' || !SHA.test(id)) || new Set(memberIds).size !== memberIds.length) fail('explicit name and word IDs required')
  const { scopeSHA256, ...body } = scope
  if (!['interval-words', 'unresolved-words', 'human-words'].includes(scope.kind) || scopeSHA256 !== digest(body)) fail('reviewed scope integrity')
  if (!Array.isArray(scope.forbiddenNames) || scope.forbiddenNames.length > 40000 || scope.forbiddenNames.some(name => typeof name !== 'string')) fail('reviewed source labels')
  assertFreshTarget(to, scope.forbiddenNames)
  const byId = new Map(scope.members.map(m => [m.id, m]))
  let members = memberIds.map(id => byId.get(id) ?? fail('word outside reviewed group'))
  if (scope.kind === 'unresolved-words') {
    const selected = new Set(memberIds), runs = scope.selectionRuns
    members = scope.members.filter(m => selected.has(m.id))
    if (scope.identityId !== 'unresolved' || scope.displayLabel !== 'Unresolved speech' || !Array.isArray(runs) || runs.length > 40000 || runs.some(r => !Array.isArray(r) || !r.length) || !equal(runs.flat(), scope.members.map(m => m.id))
      || !runs.some(run => { const start = run.indexOf(members[0].id); return start >= 0 && equal(run.slice(start, start + members.length), members.map(m => m.id)) })) fail('manual selection must be one contiguous range in one batch')
  } else if (scope.kind === 'human-words') {
    if (!/^action-[a-f0-9-]{36}$/.test(scope.identityId) || members.length !== scope.members.length) fail('rename requires the whole active action')
    members = scope.members.slice()
  }
  return { members, fields: members.length }
}

export type MacIntervalHumanFiles = MacCallHumanFiles
export function macIntervalHumanPaths(files: MacIntervalHumanFiles, captureId: string) {
  const old = macCallHumanPaths(files, captureId), stem = files.sidecarPath.replace(/\.g2-chunks\.json$/, '')
  return { annotation: `${stem}.speaker-call-interval-human.json`, journal: `${stem}.speaker-call-interval-human-transaction.json`, packet: old.packet, legacyAnnotation: old.annotation, ledger: old.ledger, lock: old.lock }
}
function directory(path: string) { const dir = dirname(path); if (realpathSync(dir) !== dir || !lstatSync(dir).isDirectory()) fail('canonical parent required'); return dir }
function syncDirectory(path: string) { const fd = openSync(directory(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK); try { fsyncSync(fd) } finally { closeSync(fd) } }
function atomic(path: string, text: string, before: () => void) {
  directory(path); const tmp = `${path}.${randomUUID()}.tmp`, fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  try { before(); renameSync(tmp, path); syncDirectory(path) } finally { if (existsSync(tmp)) unlinkSync(tmp) }
}
function acquire(path: string, journal: string, recover: boolean, expectedLockSHA256?: string) {
  const old = readMacCallHumanFile(path, 4096, true)
  if (expectedLockSHA256 !== undefined && old?.hash !== expectedLockSHA256) fail('lock drift')
  if (old) {
    if (!recover) fail('capture locked')
    const owner = JSON.parse(old.text)
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.kind !== POLICY || owner.journal !== journal) fail('foreign lock')
    try { process.kill(owner.pid, 0); fail('capture lock owner alive') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e }
    if (readMacCallHumanFile(path, 4096)!.hash !== old.hash) fail('lock drift')
    unlinkSync(path); syncDirectory(path)
  }
  directory(path)
  const text = JSON.stringify({ kind: POLICY, journal, pid: process.pid, token: randomUUID() }), fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  syncDirectory(path)
  const assertOwned = () => { if (readMacCallHumanFile(path, 4096, true)?.text !== text) fail('lock drift') }
  return { assertOwned, release: () => { assertOwned(); unlinkSync(path); syncDirectory(path) } }
}
interface Pin { path: string; hash: string | null; maximum: number }
interface Journal { version: 1; policy: typeof POLICY; captureId: string; phase: 'prepared' | 'complete'; pins: Pin[]; before: string | null; after: string; journalSHA256: string }
function journalSeal(body: Omit<Journal, 'journalSHA256'>): Journal { return { ...body, journalSHA256: digest(body) } }
function readSources(files: MacIntervalHumanFiles, captureId: string) {
  const paths = macIntervalHumanPaths(files, captureId)
  const base = readMacCallHumanFile(files.sidecarPath, 32 * 1024 * 1024)!, md = readMacCallHumanFile(files.meetingPath, MAX)!, ledger = readMacCallHumanFile(paths.ledger, 8 * 1024 * 1024, true), legacy = readMacCallHumanFile(paths.legacyAnnotation, MAX, true), packet = readMacCallHumanFile(paths.packet, MAX, true), prior = readMacCallHumanFile(paths.annotation, MAX, true)
  // An unreadable automatic JSON payload is unavailable projection, not a
  // reason to strand a source-bound human undo. Keep its exact bytes pinned.
  // Human/legacy annotations remain strict JSON in their own validators.
  let parsedPacket: MacSpeakerCallPacket | null = null
  if (packet) { try { parsedPacket = JSON.parse(packet.text) as MacSpeakerCallPacket } catch { /* unavailable current automatic packet */ } }
  const input = { baseJSON: base.text, markdown: md.text, ledgerJSONL: ledger?.text ?? '', legacyAnnotationJSON: legacy?.text ?? null, annotationJSON: prior?.text ?? null, packet: parsedPacket }
  const pins: Pin[] = [{ path: files.sidecarPath, hash: base.hash, maximum: 32 * 1024 * 1024 }, { path: files.meetingPath, hash: md.hash, maximum: MAX }, { path: paths.ledger, hash: ledger?.hash ?? null, maximum: 8 * 1024 * 1024 }, { path: paths.legacyAnnotation, hash: legacy?.hash ?? null, maximum: MAX }, { path: paths.packet, hash: packet?.hash ?? null, maximum: MAX }]
  return { paths, input, pins }
}
function checkPins(pins: Pin[]) { for (const p of pins) if ((readMacCallHumanFile(p.path, p.maximum, p.hash === null)?.hash ?? null) !== p.hash) fail('source changed') }
function checkedJournal(files: MacIntervalHumanFiles, captureId: string, value: unknown): Journal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('journal scope or bounds')
  const journal = value as Journal, paths = macIntervalHumanPaths(files, captureId), { journalSHA256, ...body } = journal
  if (journal.version !== 1 || journal.policy !== POLICY || journal.captureId !== captureId || !SHA.test(journalSHA256) || digest(body) !== journalSHA256 || !['prepared', 'complete'].includes(journal.phase) || !Array.isArray(journal.pins) || !equal(journal.pins.map(p => p.path), [files.sidecarPath, files.meetingPath, paths.ledger, paths.legacyAnnotation, paths.packet]) || !equal(journal.pins.map(p => p.maximum), [32 * 1024 * 1024, MAX, 8 * 1024 * 1024, MAX, MAX]) || journal.pins.some(p => p.hash !== null && !SHA.test(p.hash)) || journal.before !== null && typeof journal.before !== 'string' || typeof journal.after !== 'string' || Buffer.byteLength(journal.before ?? '') > MAX || Buffer.byteLength(journal.after) > MAX) fail('journal scope or bounds')
  return journal
}
/** Read-only receipt verification shared by readers, publication, and recovery.
 * Completed receipts preserve the exact human postimage and immutable sources;
 * a newer/missing/malformed current automatic packet is allowed after completion.
 * A prepared transaction must still match every original source pin. */
function verifyJournalSnapshot(files: MacIntervalHumanFiles, captureId: string, value: unknown, expectedText: string): Journal {
  const journal = checkedJournal(files, captureId, value), state = readSources(files, captureId)
  const pins = journal.phase === 'complete' ? journal.pins.slice(0, 4) : journal.pins
  checkPins(pins)
  const current = state.input.annotationJSON
  if (journal.phase === 'complete' ? current !== journal.after : current !== journal.before && current !== journal.after) fail('journal annotation postimage changed')
  validate({ ...state.input, annotationJSON: journal.after })
  if (current !== null && current !== journal.after) validate(state.input)
  // Catch a concurrent replacement during the potentially expensive pure replay.
  checkPins(pins)
  if (readMacCallHumanFile(state.paths.journal, 40 * 1024 * 1024)!.text !== expectedText || (readMacCallHumanFile(state.paths.annotation, MAX, true)?.text ?? null) !== current) fail('journal snapshot changed')
  return journal
}
export interface MacIntervalHumanJournalStatus {
  status: 'absent' | 'complete' | 'prepared' | 'recovery-invalid'
  reason?: string
}
/** Bounded inspection only: no locks, recovery, file creation, or mutation. */
export function inspectMacIntervalHumanJournal(files: MacIntervalHumanFiles, captureId: string): MacIntervalHumanJournalStatus {
  try {
    const paths = macIntervalHumanPaths(files, captureId), stored = readMacCallHumanFile(paths.journal, 40 * 1024 * 1024, true)
    if (!stored) {
      const lock = readMacCallHumanFile(paths.lock, 4096, true)
      if (lock) {
        let owner: any
        try { owner = JSON.parse(lock.text) } catch { /* Foreign lock handling belongs to its owner. */ }
        if (owner?.kind === POLICY && owner.journal === paths.journal) return { status: 'recovery-invalid', reason: 'Interval-human lock without a durable intent; explicit dead-owner recovery required' }
      }
      return { status: 'absent' }
    }
    const journal = verifyJournalSnapshot(files, captureId, JSON.parse(stored.text), stored.text)
    return { status: journal.phase }
  } catch (error) { return { status: 'recovery-invalid', reason: error instanceof Error ? error.message : 'Invalid interval annotation journal' } }
}
function runJournal(files: MacIntervalHumanFiles, captureId: string, value: Journal, expectedText: string, assertOwned: () => void, afterWrite?: (index: number) => void) {
  const journal = checkedJournal(files, captureId, value), paths = macIntervalHumanPaths(files, captureId), { journalSHA256: _, ...body } = journal
  const fence = () => { assertOwned(); if (readMacCallHumanFile(paths.journal, 40 * 1024 * 1024)!.text !== expectedText) fail('journal changed'); const text = readMacCallHumanFile(paths.annotation, MAX, true)?.text ?? null; if (text !== journal.before && text !== journal.after) fail('later human edit'); return text }
  if (journal.phase === 'complete') { if (fence() !== journal.after) fail('completed annotation changed'); verifyJournalSnapshot(files, captureId, journal, expectedText); assertOwned(); return }
  checkPins(journal.pins)
  const current = readSources(files, captureId)
  validate({ ...current.input, annotationJSON: journal.after })
  if (fence() !== journal.after) atomic(paths.annotation, journal.after, () => { fence(); checkPins(journal.pins) })
  afterWrite?.(0)
  if (fence() !== journal.after) fail('publication changed')
  checkPins(journal.pins)
  const complete = `${JSON.stringify(journalSeal({ ...body, phase: 'complete' }))}\n`
  atomic(paths.journal, complete, () => { if (fence() !== journal.after) fail('publication changed'); checkPins(journal.pins) })
  if (readMacCallHumanFile(paths.journal, 40 * 1024 * 1024)!.text !== complete) fail('journal readback changed')
}
function publish(files: MacIntervalHumanFiles, captureId: string, state: ReturnType<typeof readSources>, annotation: Annotation, assertOwned: () => void, afterWrite?: (index: number) => void) {
  const after = `${JSON.stringify(annotation)}\n`
  if (Buffer.byteLength(after) > MAX) fail('annotation byte budget')
  validate({ ...state.input, annotationJSON: after })
  const priorJournal = readMacCallHumanFile(state.paths.journal, 40 * 1024 * 1024, true)
  if (priorJournal) {
    const parsed = JSON.parse(priorJournal.text) as Journal
    if (parsed.phase !== 'complete') fail('annotation recovery required')
    runJournal(files, captureId, parsed, priorJournal.text, assertOwned)
  }
  const journal = journalSeal({ version: 1, policy: POLICY, captureId, phase: 'prepared', pins: state.pins, before: state.input.annotationJSON, after }), text = `${JSON.stringify(journal)}\n`
  atomic(state.paths.journal, text, () => { assertOwned(); checkPins(state.pins); if ((readMacCallHumanFile(state.paths.annotation, MAX, true)?.text ?? null) !== state.input.annotationJSON || (readMacCallHumanFile(state.paths.journal, 40 * 1024 * 1024, true)?.text ?? null) !== (priorJournal?.text ?? null)) fail('publication precondition changed') })
  runJournal(files, captureId, journal, text, assertOwned, afterWrite)
}
export function commitMacIntervalHumanAnnotation(input: { files: MacIntervalHumanFiles; captureId: string; scope: MacIntervalHumanScope; memberIds: string[]; to: string; afterWrite?: (index: number) => void }): { correctionId: string; revision: number; members: number; fields: number } {
  previewMacIntervalHumanAnnotation(input.scope, input.memberIds, input.to)
  const paths = macIntervalHumanPaths(input.files, input.captureId), guard = acquire(paths.lock, paths.journal, false)
  try {
    const state = readSources(input.files, input.captureId), view = canonical(state.input), scopes = buildMacIntervalHumanScopes({ ...state.input, view }), scope = scopes.find(s => s.scopeSHA256 === input.scope.scopeSHA256)
    if (!scope || !equal(scope, input.scope)) fail('reviewed source changed')
    const selected = previewMacIntervalHumanAnnotation(scope, input.memberIds, input.to), { annotation: existing, active } = validate(state.input)
    const packet = [qualifiedPacket(state.input), ...(existing?.packets ?? [])].find(p => p?.packetSHA256 === scope.packetSHA256)
    if (!packet) fail('reviewed packet unavailable')
    const predecessor = scope.kind === 'human-words' ? active.find(a => actionIdentity(a.id) === scope.identityId) : undefined
    if (scope.kind === 'human-words' && !predecessor) fail('reviewed active action changed')
    const words = predecessor ? new Map(predecessor.members.map(m => [m.id, m])) : scope.kind === 'unresolved-words' ? manualWords(state.input.baseJSON, packet) : packetWords(state.input.baseJSON, state.input.ledgerJSONL, packet)
    const members = selected.members.map(m => { const word = words.get(m.id); if (!word) fail('reviewed word unavailable'); return cleanWord(word) })
    const id = `${POLICY}:${randomUUID()}`, event: NameEvent = { kind: 'name', id, at: new Date().toISOString(), identityId: scope.identityId, displayLabel: scope.displayLabel, to: input.to, scopeSHA256: scope.scopeSHA256, packetSHA256: packet.packetSHA256, supportSHA256: scope.supportSHA256, generation: scope.generation, packetRevision: scope.packetRevision, priorAnnotationSHA256: existing?.annotationSHA256 ?? null, members, reviewKind: scope.kind, ...(predecessor ? { supersedesActionId: predecessor.id } : {}), ...(scope.kind === 'unresolved-words' ? { projectionPacketSHA256: scope.projectionPacketSHA256 } : {}) }
    const annotation = seal({ version: 1, policy: POLICY, captureId: input.captureId, ...source(state.input), revision: (existing?.revision ?? 0) + 1, packets: existing?.packets.some(p => p.packetSHA256 === packet.packetSHA256) ? existing.packets : [...(existing?.packets ?? []), packet], events: [...(existing?.events ?? []), event] })
    publish(input.files, input.captureId, state, annotation, guard.assertOwned, input.afterWrite)
    return { correctionId: id, revision: annotation.revision, members: selected.members.length, fields: selected.fields }
  } finally { guard.release() }
}
export function undoMacIntervalHumanAnnotation(input: { files: MacIntervalHumanFiles; captureId: string; actionId: string; revision: number; annotationSHA256: string; afterWrite?: (index: number) => void }): { correctionId: string; revision: number; undone: boolean } {
  const paths = macIntervalHumanPaths(input.files, input.captureId), guard = acquire(paths.lock, paths.journal, false)
  try {
    const journal = inspectMacIntervalHumanJournal(input.files, input.captureId)
    if (journal.status === 'prepared' || journal.status === 'recovery-invalid') fail('annotation recovery required')
    const state = readSources(input.files, input.captureId), { annotation: existing, active, undone } = validate(state.input)
    if (!existing || !existing.events.some(e => e.kind === 'name' && e.id === input.actionId)) fail('unknown undo action')
    if (!active.some(e => e.id === input.actionId)) {
      if (!undone.has(input.actionId)) fail('action has an active superseding edit; undo latest rename first')
      return { correctionId: input.actionId, revision: existing.revision, undone: false }
    }
    if (existing.revision !== input.revision || existing.annotationSHA256 !== input.annotationSHA256) fail('reviewed annotation changed')
    const event: UndoEvent = { kind: 'undo', id: `${POLICY}:${randomUUID()}`, at: new Date().toISOString(), actionId: input.actionId, priorAnnotationSHA256: existing.annotationSHA256 }
    const { annotationSHA256: _, ...body } = existing, annotation = seal({ ...body, revision: existing.revision + 1, events: [...existing.events, event] })
    publish(input.files, input.captureId, state, annotation, guard.assertOwned, input.afterWrite)
    return { correctionId: input.actionId, revision: annotation.revision, undone: true }
  } finally { guard.release() }
}
export function recoverMacIntervalHumanAnnotation(files: MacIntervalHumanFiles, captureId: string, afterWrite?: (index: number) => void): void {
  const paths = macIntervalHumanPaths(files, captureId), journal = readMacCallHumanFile(paths.journal, 40 * 1024 * 1024, true)
  if (!journal) {
    const lock = readMacCallHumanFile(paths.lock, 4096, true)
    if (!lock) return
    let owner: any
    try { owner = JSON.parse(lock.text) } catch { fail('foreign lock') }
    if (owner?.kind !== POLICY || owner.journal !== paths.journal) fail('foreign lock')
    // A crash before the first durable intent moved no annotation. Reclaim
    // only this operation's unchanged lock after a signal-0 ESRCH; a live or
    // unknown owner is never inferred dead, signalled, or automatically resumed.
    const orphanGuard = acquire(paths.lock, paths.journal, true, lock.hash)
    try { if (readMacCallHumanFile(paths.journal, 40 * 1024 * 1024, true)) fail('journal appeared during orphan recovery') } finally { orphanGuard.release() }
    return
  }
  const guard = acquire(paths.lock, paths.journal, true)
  try { runJournal(files, captureId, JSON.parse(journal.text), journal.text, guard.assertOwned, afterWrite) } finally { guard.release() }
}
