#!/usr/bin/env tsx
import { boundWords, renderMarkdown, renderBoundSpeakerLabels } from '../lib/mac-speaker-repair-render.js'
export { renderBoundSpeakerLabels, renderSparseBoundSpeakerLabels, renderTruncatedBoundSpeakerLabels } from '../lib/mac-speaker-repair-render.js'
/** Offline-only, labels-only repair transaction. No server/data-home discovery.
 * Default preview writes nothing. --prepare saves private durable before/after
 * images; --apply/--undo can modify only explicit marker-certified offline copies.
 * Live installation requires the deploying session's own sync/capture coordination.
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { durableAtomicWriteFileSync } from '../lib/atomic-fs.js'
import { hashMacSpeakerMachineBinding, projectMacSpeakerRepair, type MacSpeakerMachineEvidence, type MacSpeakerRepairPlan, type MacSpeakerRepairReceipt } from '../lib/mac-speaker-repair-projection.js'

type Doc = Record<string, any>
export interface RepairFileSnapshot { path: string; sha256: string | null }
export interface MacRepairManifest {
  version: 1
  id: string
  at: string
  evidenceHash: string
  offlineRoot: string
  /** Read-only immutable evidence, including frozen profile/model versions. */
  preconditions: RepairFileSnapshot[]
  audioFiles: Array<{ rawChunkIndex: number; path: string; sha256: string }>
  copies: Array<{
    copy: 'local' | 'operations'
    sidecar: RepairFileSnapshot
    markdown: RepairFileSnapshot
    ledger: RepairFileSnapshot
    plan: MacSpeakerRepairPlan
  }>
}
interface PreparedFile {
  path: string
  beforeHash: string
  afterHash: string
  beforeImage: string
  afterImage: string
  role: 'sidecar' | 'markdown'
  copy: 'local' | 'operations'
}
interface TransactionPayload {
  version: 1
  id: string
  at: string
  evidenceHash: string
  offlineRoot: string
  preconditions: RepairFileSnapshot[]
  files: PreparedFile[]
  receipts: MacSpeakerRepairReceipt[]
}
export interface MacRepairTransaction extends TransactionPayload {
  payloadHash: string
  state: 'prepared' | 'applying' | 'applied' | 'undoing' | 'reverted' | 'partial'
  completed: string[]
  error?: string
}
export interface MacRepairPreview {
  transaction: MacRepairTransaction
  images: Array<{ name: string; bytes: string }>
  summary: { copies: number; chunks: number; labelPatches: number; offlineOnly: true }
}
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const digest = (value: unknown) => sha(JSON.stringify(value))
const HASH = /^[a-f0-9]{64}$/
const MARKER = '.mac-speaker-repair-offline.json'
function refuse(message: string): never { throw new Error(`Mac offline repair: ${message}`) }
function absolute(path: string) { if (typeof path !== 'string' || !isAbsolute(path)) refuse('all paths must be explicit and absolute'); return resolve(path) }
function safeRead(path: string): Buffer {
  absolute(path)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== resolve(path)) refuse('symlink, hardlink or nonregular source refused')
  return readFileSync(path)
}
function snapshot(path: string): string | null { return existsSync(path) ? sha(safeRead(path)) : null }
function checkSnapshot(file: RepairFileSnapshot) {
  absolute(file.path)
  if (file.sha256 !== null && !HASH.test(file.sha256)) refuse('invalid source hash')
  if (snapshot(file.path) !== file.sha256) refuse('source/profile/ledger drift')
}
function inside(root: string, path: string) {
  const rel = relative(root, absolute(path))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) refuse('write target must be strictly inside offline root')
}
function offlineRoot(path: string): string {
  const root = absolute(path)
  if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) refuse('offline root must not contain symlinks')
  // An explicit marker is an offline-copy assertion, never a server maintenance
  // authorization. Also reject recognizable production data locations.
  if (root.split('/').includes('.cos-glasses') || /\/MU-Chief-Staff\/operations(?:\/|$)/.test(root)) refuse('production data path is not an offline root')
  const marker = JSON.parse(safeRead(join(root, MARKER)).toString('utf8'))
  if (marker.kind !== 'cos-mac-speaker-repair-offline' || marker.version !== 1) refuse('offline-copy marker required')
  return root
}
/** Only WAV metadata + hash verification; never playback/ASR/native extraction. */
function pcmSamples(bytes: Buffer): { count: number; pcm: Buffer } {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) refuse('invalid WAV container')
  let format = false, samples: number | null = null, pcm: Buffer | null = null
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8
    if (start + size > bytes.length) refuse('truncated WAV')
    if (tag === 'fmt ') {
      if (size < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt32LE(start + 4) !== 16000 || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) refuse('expected mono 16kHz PCM16 WAV')
      format = true
    }
    if (tag === 'data') { if (samples !== null || size % 2) refuse('ambiguous PCM data'); samples = size / 2; pcm = bytes.subarray(start, start + size) }
    offset = start + size + (size % 2)
  }
  if (!format || !samples) refuse('missing WAV PCM')
  return { count: samples, pcm: pcm! }
}

function protectedRaw(doc: Doc, ledger: RepairFileSnapshot): number[] {
  checkSnapshot(ledger)
  if (ledger.sha256 === null) return []
  const rows = safeRead(ledger.path).toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
  const byId = new Map<string, Doc[]>()
  for (const row of rows) {
    if (!row.id || !['intent', 'applied', 'failed', 'confirmed', 'confirmed-chunks', 'reverted'].includes(row.phase)) refuse('unreadable correction ledger')
    byId.set(row.id, [...(byId.get(row.id) ?? []), row])
  }
  const raw = doc.chunkEntries.filter((e: Doc) => e.chunk?.text).map((e: Doc) => e.chunkIndex)
  const protectedIndexes = new Set<number>()
  for (const history of byId.values()) {
    const last = history.at(-1)!
    if (last.phase === 'intent') refuse('incomplete prior correction intent')
    if (last.phase === 'reverted' || last.phase === 'failed') continue
    for (const row of history.filter(r => r.phase !== 'intent')) {
      if (!Array.isArray(row.chunks) || row.chunks.some((position: number) => !Number.isInteger(position) || raw[position] === undefined)) refuse('ambiguous correction ledger positions')
      if (!row.chunks.length) for (const index of raw) protectedIndexes.add(index)
      else for (const position of row.chunks) protectedIndexes.add(raw[position])
    }
  }
  return [...protectedIndexes]
}
function revision(value: any): number { if (value === undefined) return 0; if (!Number.isSafeInteger(value) || value < 0) refuse('invalid lifecycle/correction revision'); return value }
export function previewMacSpeakerRepair(manifest: MacRepairManifest): MacRepairPreview {
  if (manifest.version !== 1 || !/^[A-Za-z0-9_-]{3,100}$/.test(manifest.id) || !HASH.test(manifest.evidenceHash) || !Number.isFinite(Date.parse(manifest.at))) refuse('invalid manifest identity')
  const root = offlineRoot(manifest.offlineRoot)
  if (!Array.isArray(manifest.copies) || manifest.copies.length !== 2 || new Set(manifest.copies.map(copy => copy.copy)).size !== 2) refuse('explicit local and operations copies required')
  if (!Array.isArray(manifest.preconditions) || !manifest.preconditions.length || !Array.isArray(manifest.audioFiles) || !manifest.audioFiles.length) refuse('frozen evidence and raw audio required')
  if (!manifest.preconditions.some(file=>file.sha256===manifest.evidenceHash)) refuse('qualified evidence bytes must be a frozen precondition')
  manifest.preconditions.forEach(checkSnapshot)
  const pcm = new Map<number, Buffer>()
  const samples: Record<string, number> = {}, audioPreconditions: RepairFileSnapshot[] = []
  for (const audio of manifest.audioFiles) {
    if (!Number.isInteger(audio.rawChunkIndex) || audio.rawChunkIndex < 0 || samples[String(audio.rawChunkIndex)] !== undefined || !HASH.test(audio.sha256)) refuse('invalid audio evidence binding')
    const bytes = safeRead(audio.path)
    if (sha(bytes) !== audio.sha256) refuse('raw audio drift')
    const metadata = pcmSamples(bytes)
    samples[String(audio.rawChunkIndex)] = metadata.count
    pcm.set(audio.rawChunkIndex, metadata.pcm)
    audioPreconditions.push({ path: audio.path, sha256: audio.sha256 })
  }
  const files: PreparedFile[] = [], images: MacRepairPreview['images'] = [], receipts: MacSpeakerRepairReceipt[] = []
  const seen = new Set<string>(); let session: string | undefined, agreement: string | undefined
  for (const [ci, copy] of manifest.copies.entries()) {
    for (const file of [copy.sidecar, copy.markdown]) {
      inside(root, file.path); if (seen.has(resolve(file.path))) refuse('duplicate target file'); seen.add(resolve(file.path)); checkSnapshot(file)
    }
    if (copy.sidecar.sha256 === null || copy.markdown.sha256 === null) refuse('source copies must exist')
    const beforeSidecar = safeRead(copy.sidecar.path).toString('utf8'), beforeMarkdown = safeRead(copy.markdown.path).toString('utf8'), before = JSON.parse(beforeSidecar)
    if (session && session !== before.sessionId) refuse('copy capture IDs disagree'); session = before.sessionId
    const copyAgreement = digest({ assignments: copy.plan.assignments, samples: copy.plan.rawAudioSampleCounts, chunks: before.chunks.map((chunk: Doc) => [chunk.text, chunk.speaker, chunk.elapsed]), raw: before.chunkEntries.map((entry: Doc) => entry.chunkIndex) })
    if (agreement && agreement !== copyAgreement) refuse('local and operations projection mappings disagree'); agreement = copyAgreement
    if (copy.plan.id !== manifest.id || copy.plan.evidenceHash !== manifest.evidenceHash) refuse('copy plan identity disagrees')
    for (const [raw, count] of Object.entries(copy.plan.rawAudioSampleCounts)) {
      if (samples[raw] !== count) refuse('raw sample count not supported by WAV evidence')
      const sourceChunk = before.chunkEntries.find((entry: Doc) => entry.chunkIndex === Number(raw))?.chunk
      const verified = manifest.audioFiles.find(file => file.rawChunkIndex === Number(raw))
      if (sourceChunk?.audioSha256 && sourceChunk.audioSha256 !== verified?.sha256) refuse('sidecar raw audio hash disagrees with verified WAV')
    }
    for (const assignment of copy.plan.assignments) {
      const proof = assignment.targetEvidence
      if (!proof) continue
      const profileFile = manifest.preconditions.find(file => file.sha256 === proof.profileSha256)
      if (!profileFile || !manifest.preconditions.some(file => file.sha256 === proof.modelSha256)) refuse('profile/model proof files are not frozen preconditions')
      const profile = JSON.parse(safeRead(profileFile.path).toString('utf8'))
      if (!Array.isArray(profile.profiles) || profile.profiles.filter((row: Doc) => row.name === proof.profileName).length !== 1) refuse('profile evidence name is missing or ambiguous')
      for (const window of proof.windows) {
        if (window.rawChunks.some(raw => !pcm.has(raw.rawChunkIndex)) || sha(Buffer.concat(window.rawChunks.map(raw => pcm.get(raw.rawChunkIndex)!))) !== window.pcmSha256) refuse('concatenated profile PCM proof disagrees')
        for (const raw of window.rawChunks) {
        if (!manifest.audioFiles.some(file => file.rawChunkIndex === raw.rawChunkIndex && file.sha256 === raw.audioSha256) || samples[String(raw.rawChunkIndex)] !== raw.sampleCount) refuse('profile evidence raw audio is not verified')
        }
      }
    }
    const plan = { ...copy.plan, protectedRawChunkIndices: [...new Set([...copy.plan.protectedRawChunkIndices, ...protectedRaw(before, copy.ledger)])] }
    const projected = projectMacSpeakerRepair(before, plan), after = projected.doc, sequence = boundWords(before, after)
    after.batchTranscript = renderBoundSpeakerLabels(before.batchTranscript, sequence)
    const afterMarkdown = renderMarkdown(beforeMarkdown, sequence)
    after.correctionRevision = revision(before.correctionRevision) + 1
    after.lifecycleRevision = revision(before.lifecycleRevision) + 1
    after.lifecycleUpdatedAt = manifest.at
    after.labelsNewerThanGraph = true
    after.proseStale = true
    const rawChunkMap = Object.fromEntries(plan.assignments.map(assignment => [assignment.rawChunkIndex, assignment.to]))
    after.speakerRepair = { version: 1, id: manifest.id, evidenceHash: manifest.evidenceHash, at: manifest.at, requiresSyncRefresh: true, rawChunkMap }
    after.diarization = { engine: 'mac-speaker-repair-v1', status: 'applied', mode: 'labels-only', labels: plan.assignments.every(assignment => /^Voice (?:[1-9]|[1-9]\d)$/.test(assignment.to)) ? 'unnamed' : 'profile-matched', appliedAt: manifest.at, outputSha256: sha(after.batchTranscript), rawChunkMap }
    const machineEvidence: MacSpeakerMachineEvidence = {
      version: 1, correctionRevision: after.correctionRevision,
      documentBinding: hashMacSpeakerMachineBinding(after),
      receipt: projected.receipt, rawAudioSampleCounts: structuredClone(plan.rawAudioSampleCounts),
    }
    after.speakerRepair.machineEvidence = machineEvidence
    // The receipt records aggregate model/profile confidence. It neither changes
    // capture similarities nor fabricates ledger confirmations or enrollment.
    // Original diarization/output maps remain byte-exact in the before-image.
    const afterSidecar = JSON.stringify(after, null, 2) + '\n'
    receipts.push(projected.receipt)
    for (const [role, path, beforeBytes, afterBytes] of [['sidecar', copy.sidecar.path, beforeSidecar, afterSidecar], ['markdown', copy.markdown.path, beforeMarkdown, afterMarkdown]] as const) {
      const stem = `${ci}-${role}`, beforeImage = `${stem}.before`, afterImage = `${stem}.after`
      images.push({ name: beforeImage, bytes: beforeBytes }, { name: afterImage, bytes: afterBytes })
      files.push({ path, beforeHash: sha(beforeBytes), afterHash: sha(afterBytes), beforeImage, afterImage, role, copy: copy.copy })
    }
  }
  const payload: TransactionPayload = { version: 1, id: manifest.id, at: manifest.at, evidenceHash: manifest.evidenceHash, offlineRoot: root, preconditions: [...manifest.preconditions, ...audioPreconditions, ...manifest.copies.map(copy => copy.ledger)], files, receipts }
  return { transaction: { ...payload, payloadHash: digest(payload), state: 'prepared', completed: [] }, images, summary: { copies: 2, chunks: receipts[0].rawChunkIndices.length, labelPatches: receipts.reduce((n, receipt) => n + receipt.patches.length, 0), offlineOnly: true } }
}
function writePrivate(path: string, bytes: string) { durableAtomicWriteFileSync(path, bytes, { mode: 0o600 }) }
function saveTransaction(path: string, tx: MacRepairTransaction) { writePrivate(path, JSON.stringify(tx, null, 2) + '\n') }
function lockRoot(root: string, resume = false): () => void {
  const path = join(root, '.mac-speaker-repair.lock')
  if (resume && existsSync(path)) {
    const prior = JSON.parse(safeRead(path).toString('utf8'))
    if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0) refuse('invalid lock owner; manual review required')
    try { process.kill(prior.pid, 0); refuse('offline repair lock owner is still alive') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    unlinkSync(path)
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd) } finally { closeSync(fd) }
  return () => { unlinkSync(path) }
}
export function prepareMacSpeakerRepair(manifest: MacRepairManifest, transactionDir: string): MacRepairPreview {
  const root = offlineRoot(manifest.offlineRoot); inside(root, transactionDir)
  if (existsSync(transactionDir)) refuse('transaction directory already exists')
  const parent = dirname(absolute(transactionDir)); if (realpathSync(parent) !== parent) refuse('transaction parent symlink refused')
  const release = lockRoot(root)
  try {
    const preview = previewMacSpeakerRepair(manifest)
    mkdirSync(transactionDir, { mode: 0o700 })
    const parentFd = openSync(root, constants.O_RDONLY); try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
    for (const image of preview.images) writePrivate(join(transactionDir, image.name), image.bytes)
    saveTransaction(join(transactionDir, 'transaction.json'), preview.transaction)
    return preview
  } finally { release() }
}
function payloadOf(tx: MacRepairTransaction): TransactionPayload {
  const { payloadHash: _, state: __, completed: ___, error: ____, ...payload } = tx
  return payload
}
export function executeMacSpeakerRepair(transactionDir: string, direction: 'apply' | 'undo', options: { resume?: boolean; beforeWrite?: (index: number) => void } = {}): MacRepairTransaction {
  const transactionPath = join(absolute(transactionDir), 'transaction.json')
  const tx = JSON.parse(safeRead(transactionPath).toString('utf8')) as MacRepairTransaction
  if (tx.version !== 1 || digest(payloadOf(tx)) !== tx.payloadHash) refuse('transaction integrity mismatch')
  const root = offlineRoot(tx.offlineRoot); inside(root, transactionDir)
  if (realpathSync(transactionDir) !== resolve(transactionDir)) refuse('transaction directory symlink refused')
  const release = lockRoot(root, options.resume)
  try {
    tx.preconditions.forEach(checkSnapshot)
    const forward = direction === 'apply', wanted = forward ? 'applied' : 'reverted'
    if ((tx.state === 'partial' || tx.state === 'applying' || tx.state === 'undoing') && !options.resume && forward) refuse('incomplete prior intent; explicit --resume or --undo required')
    const writes: Array<{ file: PreparedFile; bytes: string; changed: boolean }> = []
    for (const file of tx.files) {
      inside(root, file.path)
      for (const image of [file.beforeImage, file.afterImage]) if (image !== image.split('/').at(-1) || image.includes('..')) refuse('unsafe image path')
      const before = safeRead(join(transactionDir, file.beforeImage)), after = safeRead(join(transactionDir, file.afterImage))
      if (sha(before) !== file.beforeHash || sha(after) !== file.afterHash) refuse('before/after-image drift')
      const current = snapshot(file.path), desired = forward ? file.afterHash : file.beforeHash, prior = forward ? file.beforeHash : file.afterHash
      if (current !== desired && current !== prior) refuse('copy drift; restore would overwrite a later edit')
      if (!options.resume && tx.state === 'prepared' && forward && current !== prior) refuse('copy changed before first apply')
      const currentDoc = file.role === 'sidecar' ? JSON.parse(safeRead(file.path).toString('utf8')) : null
      if (currentDoc && (currentDoc.finalizationState !== 'complete' || currentDoc.claimPending === true || currentDoc.active === true || currentDoc.isActive === true)) refuse('capture is active or no longer finalized')
      writes.push({ file, bytes: (forward ? after : before).toString('utf8'), changed: current !== desired })
    }
    if (tx.state === wanted && writes.every(write => !write.changed)) return tx
    tx.state = forward ? 'applying' : 'undoing'; tx.completed = []; delete tx.error
    saveTransaction(transactionPath, tx) // durable intent before any copy mutation
    try {
      for (const [index, write] of writes.entries()) {
        options.beforeWrite?.(index)
        tx.preconditions.forEach(checkSnapshot)
        // Recheck all remaining copies immediately before each publish. The
        // offline lock excludes this tool; hash CAS also detects external edits.
        for (const completed of writes.slice(0, index)) if (snapshot(completed.file.path) !== (forward ? completed.file.afterHash : completed.file.beforeHash)) refuse('completed copy drift after publish')
        for (const pending of writes.slice(index)) {
          const actual = snapshot(pending.file.path)
          const expected = pending.changed ? (forward ? pending.file.beforeHash : pending.file.afterHash) : (forward ? pending.file.afterHash : pending.file.beforeHash)
          if (actual !== expected) refuse('copy changed immediately before write')
        }
        if (write.changed) writePrivate(write.file.path, write.bytes)
        if (snapshot(write.file.path) !== (forward ? write.file.afterHash : write.file.beforeHash)) refuse('post-write verification failed')
        tx.completed.push(write.file.path); saveTransaction(transactionPath, tx)
      }
      for (const write of writes) if (snapshot(write.file.path) !== (forward ? write.file.afterHash : write.file.beforeHash)) refuse('final copy postimage drift')
      tx.state = wanted; saveTransaction(transactionPath, tx)
    } catch (error) {
      tx.state = 'partial'; tx.error = error instanceof Error ? error.message : String(error); saveTransaction(transactionPath, tx); throw error
    }
    return tx
  } finally { release() }
}
export function macSpeakerRepairMain(args = process.argv.slice(2)): void {
  const known = new Set(['--manifest', '--transaction', '--prepare', '--apply', '--undo', '--resume'])
  for (let i = 0; i < args.length; i++) { if (!known.has(args[i])) refuse('unknown command option'); if (args[i] === '--manifest' || args[i] === '--transaction') { if (!args[++i]) refuse('missing option value') } }
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
  const transactionDir = value('--transaction'), apply = args.includes('--apply'), undo = args.includes('--undo'), prepare = args.includes('--prepare')
  if (Number(apply) + Number(undo) + Number(prepare) > 1) refuse('choose one of --prepare, --apply or --undo')
  if (apply || undo) {
    if (!transactionDir) refuse('--transaction required')
    const tx = executeMacSpeakerRepair(transactionDir, undo ? 'undo' : 'apply', { resume: args.includes('--resume') })
    console.log(JSON.stringify({ id: tx.id, state: tx.state, offlineOnly: true })); return
  }
  const manifestPath = value('--manifest'); if (!manifestPath) refuse('--manifest required for preview or prepare')
  const manifest = JSON.parse(safeRead(manifestPath).toString('utf8')) as MacRepairManifest
  if (prepare && !transactionDir) refuse('--transaction required for prepare')
  const preview = prepare ? prepareMacSpeakerRepair(manifest, transactionDir!) : previewMacSpeakerRepair(manifest)
  console.log(JSON.stringify({ id: manifest.id, mode: prepare ? 'prepared' : 'dry-run', ...preview.summary }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { macSpeakerRepairMain() } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
