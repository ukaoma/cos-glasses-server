/** Explicit return to immutable BASE plus verified older human corrections.
 * Only derived interval artifacts move. A durable archive precedes the prepared
 * marker, which precedes every removal; recovery never invents a new intent. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { applyMacCallHumanAnnotation, macCallHumanPaths, readMacCallHumanFile, type MacCallHumanFiles } from './mac-speaker-call-human.js'
import { applyMacIntervalHumanAnnotation, inspectMacIntervalHumanJournal, macIntervalHumanPaths } from './mac-speaker-call-interval-human.js'
import type { MacSpeakerCallPacket, MacSpeakerCallView } from './mac-speaker-call-view.js'

const POLICY = 'mac-speaker-call-original-view-v1'
const SHA = /^[a-f0-9]{64}$/
const MB = 1024 * 1024
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const digest = (v: unknown) => hash(JSON.stringify(v))
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function fail(reason: string): never { throw Error(`Mac original view: ${reason}`) }

type SourceKey = 'base' | 'markdown' | 'ledger' | 'legacyAnnotation' | 'legacyJournal'
type ArtifactKey = 'packet' | 'intervalAnnotation' | 'intervalJournal' | 'state'
interface Pin<K extends string> { key: K; hash: string | null }
interface Intent {
  version: 1; policy: typeof POLICY; captureId: string; scopeSHA256: string; archiveId: string
  sourcePins: Pin<SourceKey>[]; artifacts: Pin<ArtifactKey>[]; previousTransactionSHA256: string | null
}
interface Journal extends Intent { phase: 'prepared' | 'complete'; journalSHA256: string }
export interface OriginalViewPreview {
  scopeSHA256: string; archiveId: string; artifacts: ArtifactKey[]; activeActions: 0
}
export interface OriginalViewTransactionStatus {
  status: 'absent' | 'prepared' | 'complete' | 'recovery-invalid'; archiveId?: string; reason?: string
}
export function originalViewPaths(files: MacCallHumanFiles, captureId: string) {
  const interval = macIntervalHumanPaths(files, captureId), stem = files.sidecarPath.replace(/\.g2-chunks\.json$/, '')
  return { journal: `${stem}.speaker-call-original-view-transaction.json`, archiveRoot: `${stem}.speaker-call-original-view-archive`, lock: interval.lock }
}
function specifications(files: MacCallHumanFiles, captureId: string) {
  const interval = macIntervalHumanPaths(files, captureId), legacy = macCallHumanPaths(files, captureId)
  return {
    sources: [
      { key: 'base' as const, path: files.sidecarPath, maximum: 32 * MB, optional: false },
      { key: 'markdown' as const, path: files.meetingPath, maximum: 16 * MB, optional: true },
      { key: 'ledger' as const, path: legacy.ledger, maximum: 8 * MB, optional: true },
      { key: 'legacyAnnotation' as const, path: legacy.annotation, maximum: 16 * MB, optional: true },
      { key: 'legacyJournal' as const, path: legacy.journal, maximum: 64 * MB, optional: true },
    ],
    artifacts: [
      { key: 'packet' as const, path: interval.packet, maximum: 16 * MB, archiveName: 'packet.json' },
      { key: 'intervalAnnotation' as const, path: interval.annotation, maximum: 16 * MB, archiveName: 'interval-human.json' },
      { key: 'intervalJournal' as const, path: interval.journal, maximum: 40 * MB, archiveName: 'interval-human-transaction.json' },
      { key: 'state' as const, path: files.sidecarPath.replace(/\.g2-chunks\.json$/, '.speaker-call-state.json'), maximum: 16 * MB, archiveName: 'state.json' },
    ],
  }
}
function canonicalParent(path: string): string {
  if (resolve(path) !== path) fail('absolute canonical path required')
  const parent = dirname(path)
  if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory()) fail('canonical parent required')
  return parent
}
function syncParent(path: string) {
  const fd = openSync(canonicalParent(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function safeRead(path: string, maximum: number, optional = false) {
  const result = readMacCallHumanFile(path, maximum, optional)
  if (result) canonicalParent(path)
  return result
}
function privateDirectory(path: string, create: boolean) {
  canonicalParent(path)
  if (create) { try { mkdirSync(path, { mode: 0o700 }); syncParent(path) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e } }
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o077) !== 0) fail('private canonical archive directory required')
}
function exclusiveCopy(path: string, text: string) {
  canonicalParent(path)
  const existing = safeRead(path, 80 * MB, true)
  if (existing) { if (existing.text !== text) fail('archive collision'); return }
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  try { linkSync(temporary, path); syncParent(path) } finally { unlinkSync(temporary); syncParent(path) }
  if (safeRead(path, 80 * MB)!.text !== text) fail('archive copy changed')
}
function atomic(path: string, text: string, before: () => void) {
  canonicalParent(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  try { before(); renameSync(temporary, path); syncParent(path) } finally { try { unlinkSync(temporary) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e } }
}
function acquire(files: MacCallHumanFiles, captureId: string, recover: boolean) {
  const paths = originalViewPaths(files, captureId), old = safeRead(paths.lock, 4096, true)
  if (old) {
    if (!recover) fail('capture locked')
    const owner = JSON.parse(old.text)
    if (owner.kind !== POLICY || owner.journal !== paths.journal || !Number.isSafeInteger(owner.pid) || owner.pid < 1) fail('foreign capture lock')
    try { process.kill(owner.pid, 0); fail('capture lock owner alive') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e }
    if (safeRead(paths.lock, 4096)!.text !== old.text) fail('capture lock drift')
    unlinkSync(paths.lock); syncParent(paths.lock)
  }
  canonicalParent(paths.lock)
  const text = JSON.stringify({ kind: POLICY, journal: paths.journal, pid: process.pid, token: randomUUID() })
  const fd = openSync(paths.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  syncParent(paths.lock)
  const assertOwned = () => { if (safeRead(paths.lock, 4096, true)?.text !== text) fail('capture lock drift') }
  return { assertOwned, release: () => { assertOwned(); unlinkSync(paths.lock); syncParent(paths.lock) } }
}
function sealed(body: Omit<Journal, 'journalSHA256'>): Journal { return { ...body, journalSHA256: digest(body) } }
function checkedJournal(files: MacCallHumanFiles, captureId: string, value: unknown): Journal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('transaction integrity')
  const journal = value as Journal, { journalSHA256, phase, ...intent } = journal
  const { scopeSHA256, archiveId, ...scope } = intent
  const specs = specifications(files, captureId)
  if (journal.version !== 1 || journal.policy !== POLICY || journal.captureId !== captureId || !SHA.test(journalSHA256)
    || digest({ ...intent, phase }) !== journalSHA256 || !['prepared', 'complete'].includes(phase)
    || !SHA.test(scopeSHA256) || archiveId !== scopeSHA256 || digest(scope) !== scopeSHA256
    || !Array.isArray(journal.sourcePins) || !Array.isArray(journal.artifacts)
    || !equal(journal.sourcePins.map(p => p?.key), specs.sources.map(s => s.key))
    || !equal(journal.artifacts.map(p => p?.key), specs.artifacts.map(s => s.key))
    || [...journal.sourcePins, ...journal.artifacts].some(p => p.hash !== null && !SHA.test(p.hash))
    || journal.sourcePins[0].hash === null
    || journal.previousTransactionSHA256 !== null && !SHA.test(journal.previousTransactionSHA256)) fail('transaction integrity')
  return journal
}
function archiveDirectory(files: MacCallHumanFiles, captureId: string, archiveId: string, create: boolean) {
  if (!SHA.test(archiveId)) fail('archive identity')
  const paths = originalViewPaths(files, captureId), directory = join(paths.archiveRoot, archiveId)
  privateDirectory(paths.archiveRoot, create); privateDirectory(directory, create)
  return directory
}
function checkSources(files: MacCallHumanFiles, captureId: string, pins: Pin<SourceKey>[]) {
  for (const [index, spec] of specifications(files, captureId).sources.entries()) {
    if ((safeRead(spec.path, spec.maximum, spec.optional)?.hash ?? null) !== pins[index].hash) fail('source changed')
  }
}
/** Complete older journals are archival: their packet pin is intentionally not
 * current. Their integrity and human/ledger postimages must still agree. */
function checkLegacyJournal(files: MacCallHumanFiles, captureId: string, text: string | null, ledger: string | null, annotation: string | null) {
  if (text === null) return
  const value = JSON.parse(text), { journalSHA256, ...body } = value ?? {}, legacy = macCallHumanPaths(files, captureId)
  if (value?.version !== 1 || value.policy !== 'mac-speaker-call-human-v1' || value.captureId !== captureId || value.phase !== 'complete'
    || !SHA.test(journalSHA256) || journalSHA256 !== digest(body) || !Array.isArray(value.images) || !Array.isArray(value.pins)
    || !equal(value.pins.map((p: any) => p?.path), [files.sidecarPath, files.meetingPath, legacy.packet])
    || !equal(value.pins.map((p: any) => p?.maximum), [32 * MB, 16 * MB, 16 * MB])
    || value.pins.some((p: any) => p.hash !== null && !SHA.test(p.hash))
    || !equal(value.images.map((i: any) => i?.path), [legacy.ledger, legacy.annotation])
    || value.images.some((i: any) => i.before !== null && typeof i.before !== 'string' || typeof i.after !== 'string' || Buffer.byteLength(i.before ?? '') > 16 * MB || Buffer.byteLength(i.after) > 16 * MB)
    || value.images[0].after !== ledger || value.images[1].after !== annotation) fail('legacy human recovery required')
}
function validateInactive(files: MacCallHumanFiles, captureId: string, sources: Array<string | null>, artifacts: Array<string | null>) {
  const [baseJSON, markdownSource, ledger, legacyAnnotation, legacyJournal] = sources
  if (baseJSON === null) fail('missing immutable source')
  const markdown = markdownSource ?? ''
  const base = JSON.parse(baseJSON)
  if (base?.sessionId !== captureId) fail('capture source mismatch')
  checkLegacyJournal(files, captureId, legacyJournal, ledger, legacyAnnotation)
  const baseline: MacSpeakerCallView = { doc: base, metadata: { status: 'base', reason: 'original-view', mode: 'strict', changedChunks: 0, changedWords: 0, groups: [], localization: 'estimated-ASR-with-native-support', speakerPurityVerified: false } }
  const legacy = applyMacCallHumanAnnotation(baseJSON, ledger ?? '', legacyAnnotation, baseline)
  let packet: MacSpeakerCallPacket | null = null
  if (artifacts[0] !== null) { try { packet = JSON.parse(artifacts[0]) } catch { /* Preserve unusable automatic bytes in the archive too. */ } }
  const view = applyMacIntervalHumanAnnotation({ baseJSON, markdown, ledgerJSONL: ledger ?? '', legacyAnnotationJSON: legacyAnnotation, annotationJSON: artifacts[1], packet, view: legacy })
  if (view.metadata.intervalHumanAnnotation?.activeActions.length) fail('active interval human actions must be undone first')
  if (artifacts[2] !== null) {
    const value = JSON.parse(artifacts[2]), { journalSHA256, ...body } = value ?? {}, interval = macIntervalHumanPaths(files, captureId)
    if (value?.version !== 1 || value.policy !== 'mac-speaker-call-interval-human-v1' || value.captureId !== captureId || value.phase !== 'complete'
      || !SHA.test(journalSHA256) || journalSHA256 !== digest(body) || value.after !== artifacts[1]
      || value.before !== null && typeof value.before !== 'string' || typeof value.after !== 'string'
      || Buffer.byteLength(value.before ?? '') > 16 * MB || Buffer.byteLength(value.after) > 16 * MB
      || !equal(value.pins?.map((p: any) => p.path), [files.sidecarPath, files.meetingPath, interval.ledger, interval.legacyAnnotation, interval.packet])
      || !equal(value.pins.map((p: any) => p.maximum), [32 * MB, 16 * MB, 8 * MB, 16 * MB, 16 * MB])
      || value.pins.some((p: any) => p.hash !== null && !SHA.test(p.hash))
      || !equal(value.pins.slice(0, 4).map((p: any) => p.hash), [hash(baseJSON), markdownSource === null ? null : hash(markdown), ledger === null ? null : hash(ledger), legacyAnnotation === null ? null : hash(legacyAnnotation)])) fail('interval human recovery required')
  }
}
function snapshot(files: MacCallHumanFiles, captureId: string, ownedPreparation = false) {
  const specs = specifications(files, captureId), paths = originalViewPaths(files, captureId)
  canonicalParent(paths.journal)
  const prior = safeRead(paths.journal, MB, true)
  let status: OriginalViewTransactionStatus
  if (ownedPreparation && prior === null) status = { status: 'absent' }
  else if (ownedPreparation) {
    const previous = checkedJournal(files, captureId, JSON.parse(prior!.text))
    if (previous.phase === 'complete') { verifyArchive(files, captureId, previous); status = { status: 'complete' } }
    else status = inspectOriginalViewTransaction(files, captureId)
  } else status = inspectOriginalViewTransaction(files, captureId)
  if (status.status === 'prepared' || status.status === 'recovery-invalid') fail('original view recovery required')
  const sources = specs.sources.map(s => safeRead(s.path, s.maximum, s.optional))
  const artifacts = specs.artifacts.map(s => safeRead(s.path, s.maximum, true))
  const intervalJournal = inspectMacIntervalHumanJournal(files, captureId)
  if (intervalJournal.status === 'prepared' || intervalJournal.status === 'recovery-invalid') fail('interval human recovery required')
  validateInactive(files, captureId, sources.map(s => s?.text ?? null), artifacts.map(a => a?.text ?? null))
  const body: Omit<Intent, 'scopeSHA256' | 'archiveId'> = { version: 1, policy: POLICY, captureId,
    sourcePins: specs.sources.map((s, i) => ({ key: s.key, hash: sources[i]?.hash ?? null })),
    artifacts: specs.artifacts.map((s, i) => ({ key: s.key, hash: artifacts[i]?.hash ?? null })), previousTransactionSHA256: prior?.hash ?? null }
  const scopeSHA256 = digest(body), intent: Intent = { ...body, scopeSHA256, archiveId: scopeSHA256 }
  checkSources(files, captureId, intent.sourcePins)
  for (const [index, spec] of specs.artifacts.entries()) if ((safeRead(spec.path, spec.maximum, true)?.hash ?? null) !== intent.artifacts[index].hash) fail('artifact changed')
  if ((safeRead(paths.journal, MB, true)?.hash ?? null) !== intent.previousTransactionSHA256) fail('transaction changed')
  return { intent, sources, artifacts, prior }
}
export function previewOriginalViewTransaction(files: MacCallHumanFiles, captureId: string): OriginalViewPreview {
  const { intent } = snapshot(files, captureId)
  return { scopeSHA256: intent.scopeSHA256, archiveId: intent.archiveId, artifacts: intent.artifacts.filter(a => a.hash !== null).map(a => a.key), activeActions: 0 }
}
function verifyArchive(files: MacCallHumanFiles, captureId: string, journal: Journal) {
  const archive = archiveDirectory(files, captureId, journal.archiveId, false), specs = specifications(files, captureId)
  // Remove the old seal before resealing a phase; it is never part of the body.
  const { journalSHA256: _, ...preparedBody } = journal
  const intentText = `${JSON.stringify(sealed({ ...preparedBody, phase: 'prepared' }))}\n`
  if (safeRead(join(archive, 'intent.json'), MB)!.text !== intentText) fail('archived intent changed')
  const completion = safeRead(join(archive, 'complete.json'), MB, journal.phase !== 'complete')
  if (completion && completion.text !== `${JSON.stringify(sealed({ ...preparedBody, phase: 'complete' }))}\n`) fail('archived completion changed')
  const artifacts = specs.artifacts.map((s, i) => {
    const read = safeRead(join(archive, s.archiveName), s.maximum, journal.artifacts[i].hash === null)
    if ((read?.hash ?? null) !== journal.artifacts[i].hash) fail('archived artifact changed')
    return read?.text ?? null
  })
  if ((safeRead(join(archive, 'previous-transaction.json'), MB, journal.previousTransactionSHA256 === null)?.hash ?? null) !== journal.previousTransactionSHA256) fail('archived prior transaction changed')
  return artifacts
}
function verifyPrepared(files: MacCallHumanFiles, captureId: string, journal: Journal, expectedText: string) {
  const paths = originalViewPaths(files, captureId), specs = specifications(files, captureId), artifacts = verifyArchive(files, captureId, journal)
  checkSources(files, captureId, journal.sourcePins)
  for (const [index, spec] of specs.artifacts.entries()) {
    const current = safeRead(spec.path, spec.maximum, true)
    if (current && current.hash !== journal.artifacts[index].hash) fail('later interval artifact changed')
  }
  const sources = specs.sources.map(s => safeRead(s.path, s.maximum, s.optional)?.text ?? null)
  validateInactive(files, captureId, sources, artifacts)
  checkSources(files, captureId, journal.sourcePins)
  if (safeRead(paths.journal, MB)!.text !== expectedText) fail('transaction changed')
}
export function inspectOriginalViewTransaction(files: MacCallHumanFiles, captureId: string): OriginalViewTransactionStatus {
  try {
    const paths = originalViewPaths(files, captureId), stored = safeRead(paths.journal, MB, true)
    if (!stored) {
      const lock = safeRead(paths.lock, 4096, true)
      if (lock) {
        let owner: any
        try { owner = JSON.parse(lock.text) } catch { /* Foreign lock handling belongs to its owner. */ }
        if (owner?.kind === POLICY && owner.journal === paths.journal) return { status: 'recovery-invalid', reason: 'Original-view lock without a durable intent; explicit dead-owner recovery required' }
      }
      return { status: 'absent' }
    }
    const journal = checkedJournal(files, captureId, JSON.parse(stored.text))
    if (journal.phase === 'prepared') verifyPrepared(files, captureId, journal, stored.text)
    else {
      verifyArchive(files, captureId, journal)
      if (safeRead(paths.journal, MB)!.text !== stored.text) fail('transaction changed')
      const lock = safeRead(paths.lock, 4096, true)
      if (lock) {
        let owner: any
        try { owner = JSON.parse(lock.text) } catch { /* A different operation owns malformed/foreign locks. */ }
        if (owner?.kind === POLICY && owner.journal === paths.journal) return { status: 'recovery-invalid', archiveId: journal.archiveId, reason: 'Original-view capture lock requires explicit owner recovery' }
      }
    }
    // Completed receipts are historical. They deliberately do not pin current
    // BASE, Markdown, ledger, legacy decisions, or newly generated packets.
    return { status: journal.phase, archiveId: journal.archiveId }
  } catch (error) { return { status: 'recovery-invalid', reason: error instanceof Error ? error.message : 'Invalid original-view transaction' } }
}
function run(files: MacCallHumanFiles, captureId: string, journal: Journal, expectedText: string, assertOwned: () => void, afterWrite?: (index: number) => void) {
  const paths = originalViewPaths(files, captureId), specs = specifications(files, captureId)
  const fence = () => { assertOwned(); verifyPrepared(files, captureId, journal, expectedText) }
  if (journal.phase === 'complete') { assertOwned(); verifyArchive(files, captureId, journal); return }
  fence()
  for (const [index, spec] of specs.artifacts.entries()) {
    fence()
    if (safeRead(spec.path, spec.maximum, true)) { unlinkSync(spec.path); syncParent(spec.path) }
    afterWrite?.(index)
    fence()
    for (const earlier of specs.artifacts.slice(0, index + 1)) if (safeRead(earlier.path, earlier.maximum, true)) fail('removed artifact reappeared')
  }
  const { journalSHA256: _, ...body } = journal, complete = `${JSON.stringify(sealed({ ...body, phase: 'complete' }))}\n`
  fence()
  for (const spec of specs.artifacts) if (safeRead(spec.path, spec.maximum, true)) fail('removed artifact reappeared')
  exclusiveCopy(join(archiveDirectory(files, captureId, journal.archiveId, false), 'complete.json'), complete)
  afterWrite?.(specs.artifacts.length)
  atomic(paths.journal, complete, () => { fence(); for (const spec of specs.artifacts) if (safeRead(spec.path, spec.maximum, true)) fail('removed artifact reappeared') })
  if (safeRead(paths.journal, MB)!.text !== complete) fail('completed transaction changed')
}
export function commitOriginalViewTransaction(input: { files: MacCallHumanFiles; captureId: string; expectedScopeSHA256: string; afterWrite?: (index: number) => void }): { archiveId: string; scopeSHA256: string } {
  if (!SHA.test(input.expectedScopeSHA256)) fail('explicit reviewed scope required')
  const guard = acquire(input.files, input.captureId, false)
  try {
    const state = snapshot(input.files, input.captureId, true)
    if (state.intent.scopeSHA256 !== input.expectedScopeSHA256) fail('reviewed source changed')
    const paths = originalViewPaths(input.files, input.captureId), archive = archiveDirectory(input.files, input.captureId, state.intent.archiveId, true)
    const specs = specifications(input.files, input.captureId), journal = sealed({ ...state.intent, phase: 'prepared' }), text = `${JSON.stringify(journal)}\n`
    state.artifacts.forEach((a, i) => { if (a) exclusiveCopy(join(archive, specs.artifacts[i].archiveName), a.text) })
    if (state.prior) exclusiveCopy(join(archive, 'previous-transaction.json'), state.prior.text)
    exclusiveCopy(join(archive, 'intent.json'), text)
    verifyArchive(input.files, input.captureId, journal)
    atomic(paths.journal, text, () => {
      guard.assertOwned(); checkSources(input.files, input.captureId, state.intent.sourcePins)
      for (const [i, spec] of specs.artifacts.entries()) if ((safeRead(spec.path, spec.maximum, true)?.hash ?? null) !== state.intent.artifacts[i].hash) fail('artifact changed')
      if ((safeRead(paths.journal, MB, true)?.hash ?? null) !== state.intent.previousTransactionSHA256) fail('transaction changed')
    })
    input.afterWrite?.(-1) // The durable intent exists; no active artifact has moved.
    run(input.files, input.captureId, journal, text, guard.assertOwned, input.afterWrite)
    return { archiveId: state.intent.archiveId, scopeSHA256: state.intent.scopeSHA256 }
  } finally { guard.release() }
}
export function recoverOriginalViewTransaction(files: MacCallHumanFiles, captureId: string, afterWrite?: (index: number) => void): void {
  const paths = originalViewPaths(files, captureId), stored = safeRead(paths.journal, MB, true)
  if (!stored) {
    const lock = safeRead(paths.lock, 4096, true)
    if (!lock) return
    let owner: any
    try { owner = JSON.parse(lock.text) } catch { return }
    if (owner?.kind !== POLICY || owner.journal !== paths.journal) return
    // A crash before the durable intent moved nothing. Only a proven dead lock
    // owned by this operation may be cleared; no new intent is submitted.
    const orphanGuard = acquire(files, captureId, true)
    try { if (safeRead(paths.journal, MB, true)) fail('transaction appeared during orphan recovery') } finally { orphanGuard.release() }
    return
  }
  const guard = acquire(files, captureId, true)
  try {
    if (safeRead(paths.journal, MB)!.text !== stored.text) fail('transaction changed')
    const journal = checkedJournal(files, captureId, JSON.parse(stored.text))
    if (journal.phase === 'complete') { verifyArchive(files, captureId, journal); return }
    run(files, captureId, journal, stored.text, guard.assertOwned, afterWrite)
  } finally { guard.release() }
}
