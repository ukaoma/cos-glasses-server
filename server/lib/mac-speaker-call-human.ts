/** Explicit human annotations over an immutable automatic BASE. These are not
 * acoustic assertions or enrollment. The authenticated route owns authorization;
 * hashes bind the reviewed source and ledger, not the identity of a human. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath } from './data-dir.js'
import { checkSpeakerName } from './speaker-name.js'
import { hasMacSpeakerProtectedRows, isMacSpeakerHumanProtected } from './mac-speaker-protection.js'
import { boundWords, renderMarkdown } from './mac-speaker-repair-render.js'
import type { MacSpeakerCallPacket, MacSpeakerCallView } from './mac-speaker-call-view.js'

type Doc = Record<string, any>
type Path = Array<string | number>
const VOICE = /^Voice (?:[1-9]|[1-9]\d)$/
const SHA = /^[a-f0-9]{64}$/
const PREFIX = 'mac-speaker-call-human-v1'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const digest = (value: unknown) => hash(JSON.stringify(value))
const fail = (reason: string): never => { throw new Error(`Mac call human: ${reason}`) }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
interface Member { rawChunkIndex: number; position: number; before: string; text: string; elapsedMs: number; baseBefore?: string }
interface Field { path: Path; before: string; rawChunkIndices: number[] }
export interface MacCallHumanScope {
  kind: 'automatic' | 'human'
  reviewBasis: 'accepted-acoustic-group' | 'automatic-label-only' | 'human-authored'
  identityId: string; displayLabel: string; scopeSHA256: string
  members: Member[]; fields: Field[]
  baseSHA256: string; markdownSHA256: string; ledgerSHA256: string; annotationSHA256: string | null
  packetSHA256: string | null; generation: string; packetRevision: number
}
interface Action {
  id: string; at: string; identityId: string; to: string; scopeSHA256: string
  members: Member[]; fields: Field[]; fieldScopeSHA256: string; ledgerStart: number; ledgerEnd: number; ledgerBeforeSHA256: string; ledgerAfterSHA256: string
}
interface Annotation {
  version: 1; policy: typeof PREFIX; captureId: string; revision: number
  baseSHA256: string; ledgerSHA256: string; actions: Action[]; annotationSHA256: string
}
export interface MacCallHumanFiles { sidecarPath: string; meetingPath: string }
export function macCallHumanPaths(files: MacCallHumanFiles, captureId: string) {
  if (!files.sidecarPath.endsWith('.g2-chunks.json') || !/^mac_[A-Za-z0-9_-]{1,100}$/.test(captureId)) fail('capture paths')
  const stem = files.sidecarPath.replace(/\.g2-chunks\.json$/, '')
  return { annotation: `${stem}.speaker-call-human.json`, packet: `${stem}.speaker-call.json`, journal: `${stem}.speaker-call-human-transaction.json`,
    ledger: dataPath('meeting-corrections', `${captureId}.jsonl`), lock: `${dirname(files.sidecarPath)}/.${captureId}.speaker-call.lock` }
}
function at(doc: Doc, path: Path): any {
  if (!Array.isArray(path) || !path.length || path.length > 8 || path.some(p => typeof p !== 'number' && typeof p !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(String(p)))) fail('field path')
  let row = doc
  for (const part of path.slice(0, -1)) { if (!row || typeof row !== 'object' || !Object.hasOwn(row, part)) fail('field missing'); row = row[part] }
  if (!row || typeof row !== 'object' || !Object.hasOwn(row, path.at(-1)!)) fail('field missing')
  return row
}
function mapped(doc: Doc): Member[] {
  if (!Array.isArray(doc.chunks) || !Array.isArray(doc.chunkEntries) || doc.chunkEntries.length > 6000) fail('source bounds')
  const result: Member[] = []
  for (const [raw, e] of doc.chunkEntries.entries()) {
    if (e.chunkIndex !== raw || !e.chunk || typeof e.chunk.text !== 'string') fail('raw source')
    if (!e.chunk.text.trim()) continue
    const position = result.length, root = doc.chunks[position]
    if (!root || ['text', 'elapsed', 'audioSha256', 'audioDurationMs'].some(k => !equal(root[k], e.chunk[k]))) fail('source join')
    result.push({ rawChunkIndex: raw, position, before: root.speaker, text: root.text.slice(0, 600), elapsedMs: root.elapsed })
  }
  if (result.length !== doc.chunks.length) fail('source join')
  return result
}
function seal(body: Omit<Annotation, 'annotationSHA256'>): Annotation { return { ...body, annotationSHA256: digest(body) } }
function selectedFields(scope: MacCallHumanScope, selected: Set<number>): Field[] {
  if (scope.kind === 'human' && scope.fields.some(f => f.rawChunkIndices.some(raw => selected.has(raw)) && !f.rawChunkIndices.every(raw => selected.has(raw)))) fail('selection cuts a previously human-confirmed word')
  return scope.fields.filter(f => f.rawChunkIndices.every(raw => selected.has(raw)))
}
/** Preview the same exact label renderer used after publication. A transcript
 * mismatch refuses the action before any human intent or annotation is written. */
export function previewMacCallHumanAnnotation(baseJSON: string, markdown: string, view: MacSpeakerCallView, scope: MacCallHumanScope, selectedRawChunkIndices: number[], to: string): { members: Member[]; fields: number } {
  if (to !== to.trim() || !checkSpeakerName(to).ok || !selectedRawChunkIndices.length || new Set(selectedRawChunkIndices).size !== selectedRawChunkIndices.length) fail('explicit name and source selection required')
  const selected = new Set(selectedRawChunkIndices), members = scope.members.filter(m => selected.has(m.rawChunkIndex)), doc = structuredClone(view.doc)
  if (members.length !== selected.size) fail('selection outside reviewed group')
  const fields = selectedFields(scope, selected)
  for (const field of fields) at(doc, field.path)[field.path.at(-1)!] = to
  renderMarkdown(markdown, boundWords(JSON.parse(baseJSON), doc))
  return { members, fields: fields.length }
}
function validateAnnotation(value: unknown, baseJSON: string, ledger: string): Annotation {
  const a = value as Annotation, base = JSON.parse(baseJSON), map = mapped(base), byRaw = new Map(map.map(m => [m.rawChunkIndex, m]))
  if (!a || a.version !== 1 || a.policy !== PREFIX || a.captureId !== base.sessionId || a.baseSHA256 !== hash(baseJSON) || a.ledgerSHA256 !== hash(ledger) || !Number.isSafeInteger(a.revision) || a.revision < 1 || !Array.isArray(a.actions) || a.actions.length !== a.revision || a.actions.length > 6000) fail('annotation source binding')
  const { annotationSHA256, ...body } = a
  if (!SHA.test(annotationSHA256) || annotationSHA256 !== digest(body)) fail('annotation integrity')
  let previousEnd = 0, fieldCount = 0
  const used = new Map<string, string>(), selected = new Map<number, string>()
  for (const action of a.actions) {
    if (!action || typeof action.id !== 'string' || !action.id || typeof action.to !== 'string' || action.to !== action.to.trim() || !checkSpeakerName(action.to).ok || !SHA.test(action.scopeSHA256) || !Array.isArray(action.members) || !action.members.length || action.members.length > 6000 || new Set(action.members.map(m => m.rawChunkIndex)).size !== action.members.length || !Array.isArray(action.fields) || !action.fields.length || (fieldCount += action.fields.length) > 40000 || !Number.isSafeInteger(action.ledgerStart) || !Number.isSafeInteger(action.ledgerEnd) || action.ledgerStart < previousEnd || action.ledgerEnd <= action.ledgerStart || action.ledgerEnd > ledger.length || action.ledgerBeforeSHA256 !== hash(ledger.slice(0, action.ledgerStart)) || action.ledgerAfterSHA256 !== hash(ledger.slice(0, action.ledgerEnd))) fail('annotation action')
    previousEnd = action.ledgerEnd
    const rows = ledger.slice(action.ledgerStart, action.ledgerEnd).trim().split('\n').map(line => JSON.parse(line))
    const groups = new Map<string, number[]>()
    for (const member of action.members) {
      const actual = byRaw.get(member.rawChunkIndex), c = base.chunkEntries[member.rawChunkIndex]?.chunk, root = base.chunks[member.position]
      const baseBefore = member.baseBefore ?? member.before
      const expected = { ...member }; delete expected.baseBefore; expected.before = baseBefore
      if (!actual || !equal(actual, expected) || !VOICE.test(baseBefore) || c.speaker !== baseBefore || hasMacSpeakerProtectedRows(c) || hasMacSpeakerProtectedRows(root)
        || (member.baseBefore === undefined ? selected.has(member.rawChunkIndex) : selected.get(member.rawChunkIndex) !== member.before)) fail('human member source')
      const positions = groups.get(member.before) ?? []; positions.push(member.position); groups.set(member.before, positions)
    }
    if (action.fieldScopeSHA256 !== digest({ identityId: action.identityId, members: action.members, fields: action.fields })) fail('human reviewed field scope')
    const expectedRows = [...groups].flatMap(([from, chunks], index) => ['intent', 'applied', 'confirmed-chunks'].map(phase => ({ id: `${action.id}:${index}`, batchId: action.id, phase, at: action.at, from, to: action.to, chunks, scope: 'meeting', source: PREFIX, fieldScopeSHA256: action.fieldScopeSHA256 })))
    if (!equal(rows, expectedRows)) fail('human ledger evidence')
    const actionRaw = new Set(action.members.map(m => m.rawChunkIndex))
    for (const field of action.fields) {
      const key = JSON.stringify(field.path), row = at(base, field.path), last = field.path.at(-1)!
      if (last !== 'speaker' || !VOICE.test(field.before) || row[last] !== field.before || !Array.isArray(field.rawChunkIndices) || !field.rawChunkIndices.length || field.rawChunkIndices.some(raw => !actionRaw.has(raw)) || isMacSpeakerHumanProtected(row)
        || used.has(key) && field.rawChunkIndices.some(raw => selected.get(raw) !== used.get(key))) fail('human field source')
      const raw = field.rawChunkIndices[0], member = byRaw.get(raw)!
      if (field.path[0] === 'chunks') { if (field.rawChunkIndices.length !== 1 || field.path[1] !== member.position || ![3, 5].includes(field.path.length) || field.path.length === 5 && !['segments', 'finalSegments', 'words'].includes(String(field.path[2]))) fail('human compacted field') }
      else if (field.path[0] === 'chunkEntries') { if (field.rawChunkIndices.length !== 1 || field.path[1] !== raw || field.path[2] !== 'chunk' || ![4, 6].includes(field.path.length) || field.path.length === 6 && !['segments', 'finalSegments', 'words'].includes(String(field.path[3]))) fail('human raw field') }
      else if (field.path[0] !== 'batchSegments' || field.path.length !== 5 || field.path[2] !== 'speakerWords') fail('human field scope')
      used.set(key, action.to)
    }
    // A scoped confirmation is never permitted to claim an unmodified root.
    for (const member of action.members) if (!action.fields.some(f => equal(f.path, ['chunks', member.position, 'speaker']))) fail('human root field missing')
    for (const member of action.members) selected.set(member.rawChunkIndex, action.to)
  }
  requireHumanLedgerCoverage(ledger, a)
  return a
}

/** A capture ledger is shared by its copies, but an annotation is bound to one
 * immutable BASE. Never append from a copy that is missing earlier decisions.
 * Only validated action ranges cover these rows; duplicated ids outside their
 * original range cannot confer coverage. Replication is a separate operation. */
function requireHumanLedgerCoverage(ledger: string, annotation: Annotation | null): void {
  let offset = 0, index = 0
  const actions = annotation?.actions ?? [], lines = ledger.split('\n')
  if (lines.length > 20001) fail('human ledger row budget')
  for (const line of lines) {
    while (index < actions.length && actions[index].ledgerEnd <= offset) index++
    if (line.trim()) {
      const row = JSON.parse(line)
      if (row?.source === PREFIX) {
        const action = actions[index]
        if (!action || offset < action.ledgerStart || offset + line.length > action.ledgerEnd) fail('copy is missing prior human decisions')
      }
    }
    offset += line.length + 1
  }
}

/** Select exact current automatic members. No display-label expansion and no
 * independent nested identity: the b18 source/root agreement remains mandatory. */
export function macCallHumanScopes(input: { baseJSON: string; markdown: string; ledgerJSONL: string; annotationJSON: string | null; packet: MacSpeakerCallPacket | null; view: MacSpeakerCallView }): MacCallHumanScope[] {
  const { packet, view } = input, base = JSON.parse(input.baseJSON), map = mapped(base)
  const result: MacCallHumanScope[] = []
  const source = { baseSHA256: hash(input.baseJSON), markdownSHA256: hash(input.markdown), ledgerSHA256: hash(input.ledgerJSONL), annotationSHA256: input.annotationJSON === null ? null : hash(input.annotationJSON) }
  const annotation = input.annotationJSON ? validateAnnotation(JSON.parse(input.annotationJSON), input.baseJSON, input.ledgerJSONL) : null
  if (!annotation) requireHumanLedgerCoverage(input.ledgerJSONL, null)
  const protectedRaw = new Set<number>()
  if (annotation) {
    const latestMembers = new Map<number, { member: Member; to: string }>(), latestFields = new Map<string, { field: Field; to: string }>()
    for (const action of annotation.actions) {
      for (const member of action.members) { latestMembers.set(member.rawChunkIndex, { member, to: action.to }); protectedRaw.add(member.rawChunkIndex) }
      for (const field of action.fields) latestFields.set(JSON.stringify(field.path), { field, to: action.to })
    }
    for (const name of new Set([...latestMembers.values()].map(m => m.to))) {
      const members = [...latestMembers.values()].filter(m => m.to === name).map(({ member }) => ({ ...member, before: name, baseBefore: member.baseBefore ?? member.before }))
      const raw = new Set(members.map(m => m.rawChunkIndex)), fields = [...latestFields.values()].filter(f => f.to === name && f.field.rawChunkIndices.every(r => raw.has(r))).map(f => f.field)
      const body = { kind: 'human' as const, reviewBasis: 'human-authored' as const, identityId: `human_${digest({ base: source.baseSHA256, name }).slice(0, 40)}`, displayLabel: name, members, fields, ...source, packetSHA256: null, generation: annotation.annotationSHA256, packetRevision: annotation.revision }
      result.push({ ...body, scopeSHA256: digest(body) })
    }
  }
  if (!packet) return result
  const { packetSHA256, ...packetBody } = packet
  if (packetSHA256 !== digest(packetBody)) return result
  if (view.metadata.status !== 'applied' || view.metadata.packetSHA256 !== packet.packetSHA256 || packet.admission !== 'qualified' || packet.projectionPolicy !== 'anonymous-estimate' || packet.baseSHA256 !== source.baseSHA256 || packet.ledgerSHA256 !== source.ledgerSHA256) return result
  for (const raw of packet.aliasProtectedRawChunkIndices) protectedRaw.add(raw)
  const acousticVoices = new Set(packet.groups.flatMap(g => g.memberVoices))
  // A human may also review an unresolved automatic label. This is NOT an
  // acoustic group/alias: it only presents explicit eligible rows for selection.
  const singletonVoices = [...new Set(map.filter(m => VOICE.test(m.before) && !acousticVoices.has(m.before)).map(m => m.before))]
  const groups = [
    ...packet.groups.map(group => ({ group, displayLabel: packet.displayLabels[group.identityId], reviewBasis: 'accepted-acoustic-group' as const })),
    ...singletonVoices.map(voice => ({ group: { identityId: `review_${digest({ base: source.baseSHA256, voice }).slice(0, 40)}`, memberVoices: [voice] }, displayLabel: voice, reviewBasis: 'automatic-label-only' as const })),
  ]
  for (const { group, displayLabel, reviewBasis } of groups) {
    const voices = new Set(group.memberVoices), fields: Field[] = [], members = map.filter(m => !protectedRaw.has(m.rawChunkIndex) && voices.has(m.before) && voices.has(base.chunkEntries[m.rawChunkIndex].chunk.speaker) && base.chunks[m.position].speaker === base.chunkEntries[m.rawChunkIndex].chunk.speaker && !hasMacSpeakerProtectedRows(base.chunks[m.position]) && !hasMacSpeakerProtectedRows(base.chunkEntries[m.rawChunkIndex].chunk))
    const memberRaw = new Set(members.map(m => m.rawChunkIndex))
    for (const member of members) for (const [path, row] of [[['chunks', member.position], base.chunks[member.position]], [['chunkEntries', member.rawChunkIndex, 'chunk'], base.chunkEntries[member.rawChunkIndex].chunk]] as Array<[Path, Doc]>) {
      fields.push({ path: [...path, 'speaker'], before: row.speaker, rawChunkIndices: [member.rawChunkIndex] })
      for (const key of ['segments', 'finalSegments', 'words']) for (const [i, nested] of (row[key] ?? []).entries()) if (voices.has(nested.speaker) && !isMacSpeakerHumanProtected(nested)) fields.push({ path: [...path, key, i, 'speaker'], before: nested.speaker, rawChunkIndices: [member.rawChunkIndex] })
    }
    for (const [si, segment] of (base.batchSegments ?? []).entries()) {
      const clock: Array<{ raw: number; lo: number; hi: number }> = []; let offset = 0
      for (let raw = segment.startChunkIdx; raw <= segment.endChunkIdx; raw++) { const r = packet.rawBindings[raw]; if (!r) fail('batch binding'); const n = r.endSample - r.startSample; clock.push({ raw, lo: offset, hi: offset + n }); offset += n }
      for (const [wi, word] of (segment.speakerWords ?? []).entries()) {
        if (!voices.has(word.speaker) || isMacSpeakerHumanProtected(word)) continue
        const lo = Math.round(word.start * 16000), hi = Math.round(word.end * 16000), raw = clock.filter(c => lo < c.hi && hi > c.lo).map(c => c.raw)
        if (Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && lo >= 0 && hi > lo && hi <= offset && raw.length && raw.every(r => memberRaw.has(r))) fields.push({ path: ['batchSegments', si, 'speakerWords', wi, 'speaker'], before: word.speaker, rawChunkIndices: raw })
      }
    }
    if (!members.length) continue
    const body = { kind: 'automatic' as const, reviewBasis, identityId: group.identityId, displayLabel, members, fields, baseSHA256: hash(input.baseJSON), markdownSHA256: hash(input.markdown), ledgerSHA256: hash(input.ledgerJSONL), annotationSHA256: input.annotationJSON === null ? null : hash(input.annotationJSON), packetSHA256: packet.packetSHA256, generation: packet.generation, packetRevision: packet.revision }
    if (fields.length > 40000) fail('field budget')
    result.push({ ...body, scopeSHA256: digest(body) })
  }
  return result
}

export function applyMacCallHumanAnnotation(baseJSON: string, ledger: string, annotationJSON: string | null, view: MacSpeakerCallView): MacSpeakerCallView {
  if (annotationJSON === null) return view
  const annotation = validateAnnotation(JSON.parse(annotationJSON), baseJSON, ledger), doc = structuredClone(view.doc)
  const changedRaw = new Set<number>(), changedWords = new Set<string>(), activeNames = new Map<string, string>()
  for (const action of annotation.actions) {
    action.members.forEach(m => changedRaw.add(m.rawChunkIndex))
    for (const field of action.fields) { const row = at(doc, field.path); row[field.path.at(-1)!] = action.to; activeNames.set(JSON.stringify(field.path), action.to); if (field.path[0] === 'batchSegments') changedWords.add(JSON.stringify(field.path)) }
  }
  doc.speakers = [...new Set([...(doc.speakers ?? []), ...activeNames.values()])]
  return { ...view, doc, metadata: { ...view.metadata, status: 'applied', reason: 'source-bound-human-annotation', changedChunks: view.metadata.changedChunks + changedRaw.size, changedWords: view.metadata.changedWords + changedWords.size, humanAnnotation: { revision: annotation.revision, annotationSHA256: annotation.annotationSHA256, members: changedRaw.size } } }
}

interface Read { text: string; hash: string; stamp: string }
const stamp = (s: Stats) => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(':')
export function readMacCallHumanFile(path: string, max: number, missing = false): Read | null {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (e) { if (missing && (e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  try {
    const before = fstatSync(fd); if (!before.isFile() || before.size > max) fail('unsafe file')
    const bytes = Buffer.alloc(before.size + 1); let n = 0
    while (n < bytes.length) { const got = readSync(fd, bytes, n, bytes.length - n, null); if (!got) break; n += got }
    const after = fstatSync(fd), current = lstatSync(path)
    if (n !== before.size || stamp(before) !== stamp(after) || stamp(after) !== stamp(current) || current.isSymbolicLink()) fail('file read drift')
    const contents = bytes.subarray(0, n), text = contents.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(contents)) fail('non-UTF8 source')
    return { text, hash: hash(text), stamp: stamp(after) }
  } finally { closeSync(fd) }
}
function directory(path: string) { const dir = dirname(path); if (realpathSync(dir) !== dir || !lstatSync(dir).isDirectory()) fail('canonical parent required'); return dir }
function syncDir(path: string) { const fd = openSync(directory(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) } }
function atomic(path: string, text: string, before: () => void) {
  directory(path); const temp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  try { before(); renameSync(temp, path); syncDir(path) } finally { if (existsSync(temp)) unlinkSync(temp) }
}
function acquire(path: string, journal: string, recover: boolean) {
  const old = readMacCallHumanFile(path, 4096, true)
  if (old) {
    if (!recover) fail('capture locked')
    const owner = JSON.parse(old.text)
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.kind !== PREFIX || owner.directory !== journal) fail('foreign lock')
    try { process.kill(owner.pid, 0); fail('capture lock owner alive') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e }
    if (readMacCallHumanFile(path, 4096)!.hash !== old.hash) fail('lock drift')
    unlinkSync(path); syncDir(path)
  }
  directory(path); const text = JSON.stringify({ pid: process.pid, token: randomUUID(), kind: PREFIX, directory: journal }), fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  syncDir(path)
  const assertOwned = () => { if (readMacCallHumanFile(path, 4096, true)?.hash !== hash(text)) fail('lock drift') }
  return { assertOwned, release: () => { assertOwned(); unlinkSync(path); syncDir(path) } }
}
interface Pin { path: string; hash: string | null; maximum: number }
interface Journal { version: 1; policy: typeof PREFIX; captureId: string; phase: 'prepared' | 'complete'; pins: Pin[]; images: Array<{ path: string; before: string | null; after: string }>; journalSHA256: string }
function sealJournal(body: Omit<Journal, 'journalSHA256'>): Journal { return { ...body, journalSHA256: digest(body) } }
function runJournal(files: MacCallHumanFiles, captureId: string, journal: Journal, expectedJournal: string, afterWrite?: (index: number) => void, assertOwned: () => void = () => {}) {
  const paths = macCallHumanPaths(files, captureId), { journalSHA256, ...body } = journal
  if (journal.version !== 1 || journal.policy !== PREFIX || journal.captureId !== captureId || journalSHA256 !== digest(body) || journal.images.length !== 2 || journal.images[0].path !== paths.ledger || journal.images[1].path !== paths.annotation || !['prepared', 'complete'].includes(journal.phase) || !equal(journal.pins.map(p => p.path), [files.sidecarPath, files.meetingPath, paths.packet])) fail('journal scope')
  if (!equal(journal.pins.map(p => p.maximum), [32 * 1024 * 1024, 16 * 1024 * 1024, 16 * 1024 * 1024]) || journal.pins.some(p => p.hash !== null && !SHA.test(p.hash)) || journal.images.some(image => (image.before !== null && typeof image.before !== 'string') || typeof image.after !== 'string' || Buffer.byteLength(image.before ?? '') > 16 * 1024 * 1024 || Buffer.byteLength(image.after) > 16 * 1024 * 1024)) fail('journal bounds')
  const fence = () => {
    assertOwned()
    if (readMacCallHumanFile(paths.journal, 64 * 1024 * 1024)!.text !== expectedJournal) fail('journal changed')
    for (const pin of journal.pins) if ((readMacCallHumanFile(pin.path, pin.maximum, pin.hash === null)?.hash ?? null) !== pin.hash) fail('source changed')
    return journal.images.map(image => { const actual = readMacCallHumanFile(image.path, 16 * 1024 * 1024, true)?.text ?? null; if (actual !== image.before && actual !== image.after) fail('later human edit'); return actual })
  }
  if (journal.phase === 'complete') {
    assertOwned()
    if (readMacCallHumanFile(paths.journal, 64 * 1024 * 1024)!.text !== expectedJournal || journal.images.some(image => readMacCallHumanFile(image.path, 16 * 1024 * 1024, true)?.text !== image.after)) fail('completed annotation changed')
    return // Archival human decision: refreshed automatic packets are allowed.
  }
  let current = fence()
  for (const [index, image] of journal.images.entries()) {
    fence()
    if (current[index] !== image.after) atomic(image.path, image.after, () => { const checked = fence(); for (let i = 0; i < index; i++) if (checked[i] !== journal.images[i].after) fail('earlier publication changed') })
    afterWrite?.(index)
    current = fence()
    for (let i = 0; i <= index; i++) if (current[i] !== journal.images[i].after) fail('publication changed')
  }
  const completed = `${JSON.stringify(sealJournal({ ...body, phase: 'complete' }))}\n`
  atomic(paths.journal, completed, () => { const checked = fence(); if (checked.some((v, i) => v !== journal.images[i].after)) fail('postimage changed') })
  if (readMacCallHumanFile(paths.journal, 64 * 1024 * 1024)!.text !== completed) fail('journal readback changed')
}
export function recoverMacCallHumanAnnotation(files: MacCallHumanFiles, captureId: string, afterWrite?: (index: number) => void): void {
  const paths = macCallHumanPaths(files, captureId), journal = readMacCallHumanFile(paths.journal, 64 * 1024 * 1024, true)
  if (!journal) return
  const guard = acquire(paths.lock, paths.journal, true)
  try { runJournal(files, captureId, JSON.parse(journal.text), journal.text, afterWrite, guard.assertOwned) } finally { guard.release() }
}
export function commitMacCallHumanAnnotation(input: { files: MacCallHumanFiles; captureId: string; scope: MacCallHumanScope; selectedRawChunkIndices: number[]; to: string; afterWrite?: (index: number) => void }): { correctionId: string; members: number; fields: number } {
  if (input.to !== input.to.trim() || !checkSpeakerName(input.to).ok || !Array.isArray(input.selectedRawChunkIndices) || !input.selectedRawChunkIndices.length || input.selectedRawChunkIndices.length > 6000 || new Set(input.selectedRawChunkIndices).size !== input.selectedRawChunkIndices.length) fail('explicit name and source selection required')
  const paths = macCallHumanPaths(input.files, input.captureId)
  mkdirSync(dirname(paths.ledger), { recursive: true, mode: 0o700 }); directory(paths.ledger)
  const guard = acquire(paths.lock, paths.journal, false)
  try {
    const base = readMacCallHumanFile(input.files.sidecarPath, 32 * 1024 * 1024)!, md = readMacCallHumanFile(input.files.meetingPath, 16 * 1024 * 1024)!, ledger = readMacCallHumanFile(paths.ledger, 8 * 1024 * 1024, true), packet = readMacCallHumanFile(paths.packet, 16 * 1024 * 1024, true), prior = readMacCallHumanFile(paths.annotation, 16 * 1024 * 1024, true)
    const scope = input.scope, { scopeSHA256, ...scopeBody } = scope
    const parsedPacket = scope.kind === 'automatic' && packet ? JSON.parse(packet.text) as MacSpeakerCallPacket : null
    const { packetSHA256, ...packetBody } = parsedPacket ?? { packetSHA256: null }
    if (scopeSHA256 !== digest(scopeBody) || base.hash !== scope.baseSHA256 || md.hash !== scope.markdownSHA256 || hash(ledger?.text ?? '') !== scope.ledgerSHA256 || prior?.hash !== (scope.annotationSHA256 ?? undefined) || !['automatic', 'human'].includes(scope.kind) || scope.kind === 'automatic' && (packetSHA256 !== scope.packetSHA256 || packetSHA256 !== digest(packetBody) || parsedPacket?.generation !== scope.generation || parsedPacket?.revision !== scope.packetRevision)) fail('reviewed source changed')
    const existing = prior ? validateAnnotation(JSON.parse(prior.text), base.text, ledger?.text ?? '') : null
    if (!existing) requireHumanLedgerCoverage(ledger?.text ?? '', null)
    if (scope.kind === 'human' && (!existing || existing.annotationSHA256 !== scope.generation || existing.revision !== scope.packetRevision)) fail('reviewed human annotation changed')
    const selected = new Set(input.selectedRawChunkIndices), members = scope.members.filter(m => selected.has(m.rawChunkIndex))
    if (members.length !== selected.size) fail('selection outside reviewed group')
    const fields = selectedFields(scope, selected)
    const fieldScopeSHA256 = digest({ identityId: scope.identityId, members, fields })
    const id = `${PREFIX}:${randomUUID()}`, atTime = new Date().toISOString(), groups = new Map<string, number[]>()
    for (const m of members) { const positions = groups.get(m.before) ?? []; positions.push(m.position); groups.set(m.before, positions) }
    const rows = [...groups].flatMap(([from, chunks], index) => ['intent', 'applied', 'confirmed-chunks'].map(phase => ({ id: `${id}:${index}`, batchId: id, phase, at: atTime, from, to: input.to, chunks, scope: 'meeting', source: PREFIX, fieldScopeSHA256 })))
    const beforeLedger = ledger?.text ?? '', afterLedger = beforeLedger + (beforeLedger && !beforeLedger.endsWith('\n') ? '\n' : '') + rows.map(r => JSON.stringify(r)).join('\n') + '\n'
    const action: Action = { id, at: atTime, identityId: scope.identityId, to: input.to, scopeSHA256, members, fields, fieldScopeSHA256, ledgerStart: beforeLedger.length, ledgerEnd: afterLedger.length, ledgerBeforeSHA256: hash(beforeLedger), ledgerAfterSHA256: hash(afterLedger) }
    const annotation = seal({ version: 1, policy: PREFIX, captureId: input.captureId, revision: (existing?.revision ?? 0) + 1, baseSHA256: base.hash, ledgerSHA256: hash(afterLedger), actions: [...(existing?.actions ?? []), action] }), afterAnnotation = `${JSON.stringify(annotation)}\n`
    validateAnnotation(annotation, base.text, afterLedger)
    const humanDoc = structuredClone(JSON.parse(base.text))
    for (const a of annotation.actions) for (const field of a.fields) at(humanDoc, field.path)[field.path.at(-1)!] = a.to
    renderMarkdown(md.text, boundWords(JSON.parse(base.text), humanDoc))
    if (Buffer.byteLength(afterLedger) > 8 * 1024 * 1024 || Buffer.byteLength(afterAnnotation) > 16 * 1024 * 1024) fail('annotation byte budget')
    const oldJournal = readMacCallHumanFile(paths.journal, 64 * 1024 * 1024, true)
    if (oldJournal && JSON.parse(oldJournal.text).phase !== 'complete') fail('annotation recovery required')
    const pins = [{ path: input.files.sidecarPath, hash: base.hash, maximum: 32 * 1024 * 1024 }, { path: input.files.meetingPath, hash: md.hash, maximum: 16 * 1024 * 1024 }, { path: paths.packet, hash: packet?.hash ?? null, maximum: 16 * 1024 * 1024 }]
    const journal = sealJournal({ version: 1, policy: PREFIX, captureId: input.captureId, phase: 'prepared', pins, images: [{ path: paths.ledger, before: ledger?.text ?? null, after: afterLedger }, { path: paths.annotation, before: prior?.text ?? null, after: afterAnnotation }] }), journalText = `${JSON.stringify(journal)}\n`
    atomic(paths.journal, journalText, () => {
      guard.assertOwned()
      for (const pin of pins) if ((readMacCallHumanFile(pin.path, pin.maximum, pin.hash === null)?.hash ?? null) !== pin.hash) fail('source changed')
      if ((readMacCallHumanFile(paths.ledger, 8 * 1024 * 1024, true)?.text ?? null) !== (ledger?.text ?? null) || (readMacCallHumanFile(paths.annotation, 16 * 1024 * 1024, true)?.text ?? null) !== (prior?.text ?? null) || (readMacCallHumanFile(paths.journal, 64 * 1024 * 1024, true)?.text ?? null) !== (oldJournal?.text ?? null)) fail('publication precondition changed')
    })
    if (readMacCallHumanFile(paths.journal, 64 * 1024 * 1024)!.text !== journalText) fail('journal readback changed')
    runJournal(input.files, input.captureId, journal, journalText, input.afterWrite, guard.assertOwned)
    return { correctionId: id, members: members.length, fields: fields.length }
  } finally { guard.release() }
}
