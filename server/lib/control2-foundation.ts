import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'

export class FoundationError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}
export interface FoundationInput {
  meetingId: string; projectId: string; revision: string; transcript: string; ready: boolean
  sourceAliases?: string[]; criteria?: string[]
}
export interface FoundationWork {
  id: string; meetingId: string; projectId: string; revision: string
  status: 'needs_review' | 'superseded' | 'blocked'; title: string
  sourceExcerpt: string; criteria: string[]; createdAt: string; updatedAt: string; reason?: string
  sourceAliases?: string[]
  artifact?: { path: string; sha256: string; kind: 'preview'; checks: { name: string; passed: boolean }[] }
}
interface Receipt { key: string; digest: string; workId: string }
interface Journal { schemaVersion: 1; sequence: number; work: FoundationWork[]; receipts: Receipt[] }
const MAX_RECORDS = 200
const MAX_JOURNAL_BYTES = 2_000_000
const id = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(s)
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
function boundedRead(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new FoundationError('unsafe_journal', 409)
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null)
      if (!n) break
      length += n
    }
    if (length > limit) throw new FoundationError('unsafe_journal', 409)
    return bytes.subarray(0, length).toString('utf8')
  } finally { closeSync(fd) }
}

export function parseFoundationInput(raw: unknown): FoundationInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new FoundationError('invalid_input')
  const r = raw as Record<string, unknown>
  if (!id(r.meetingId) || !id(r.projectId) || !id(r.revision)) throw new FoundationError('invalid_identity')
  if (typeof r.ready !== 'boolean' || typeof r.transcript !== 'string' || !r.transcript.trim() || r.transcript.length > 32_000) throw new FoundationError('invalid_transcript')
  const aliases = r.sourceAliases ?? []
  const criteria = r.criteria ?? []
  if (!Array.isArray(aliases) || aliases.length > 8 || aliases.some(x => !id(x))) throw new FoundationError('invalid_aliases')
  if (!Array.isArray(criteria) || criteria.length > 12 || criteria.some(x => typeof x !== 'string' || !x.trim() || x.length > 500)) throw new FoundationError('invalid_criteria')
  return { meetingId: r.meetingId, projectId: r.projectId, revision: r.revision, transcript: r.transcript,
    ready: r.ready, sourceAliases: [...new Set(aliases)].sort(), criteria: [...criteria] }
}

/** Foundation-only journal. It never dispatches a task or grants publication authority. */
export class FoundationStore {
  readonly root: string
  constructor(root: string) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    if (lstatSync(this.root).isSymbolicLink()) throw new FoundationError('unsafe_store', 409)
  }
  private read(): Journal {
    const path = join(this.root, 'journal.json')
    if (!existsSync(path)) return { schemaVersion: 1, sequence: 0, work: [], receipts: [] }
    if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > MAX_JOURNAL_BYTES) throw new FoundationError('unsafe_journal', 409)
    try {
      const j = JSON.parse(boundedRead(path, MAX_JOURNAL_BYTES)) as Journal
      if (j.schemaVersion !== 1 || !Number.isSafeInteger(j.sequence) || j.sequence < 0 || !Array.isArray(j.work) || !Array.isArray(j.receipts)
        || j.work.length > MAX_RECORDS || j.receipts.length > MAX_RECORDS
        || j.work.some(w => !id(w.id) || !id(w.meetingId) || !id(w.projectId) || !id(w.revision)
          || !['needs_review', 'superseded', 'blocked'].includes(w.status) || typeof w.sourceExcerpt !== 'string'
          || typeof w.title !== 'string' || !Array.isArray(w.criteria) || w.criteria.some(c => typeof c !== 'string')
          || (w.sourceAliases !== undefined && (!Array.isArray(w.sourceAliases) || w.sourceAliases.some(a => !id(a))))
          || (w.artifact !== undefined && (!w.artifact || w.artifact.kind !== 'preview'
            || !/^[a-f0-9]{64}$/.test(w.artifact.sha256)
            || w.artifact.path !== join(this.root, 'artifacts', `${w.artifact.sha256}.html`)
            || !Array.isArray(w.artifact.checks) || !w.artifact.checks.length
            || w.artifact.checks.some(c => !c || typeof c.name !== 'string' || c.passed !== true)))
          || typeof w.createdAt !== 'string' || typeof w.updatedAt !== 'string')
        || new Set(j.work.map(w => w.id)).size !== j.work.length
        || j.receipts.some(r => typeof r.key !== 'string' || !/^[a-f0-9]{64}$/.test(r.digest) || !j.work.some(w => w.id === r.workId))) throw new Error('invalid')
      for (const w of j.work) {
        if (w.artifact && hash(boundedRead(w.artifact.path, 100_000)) !== w.artifact.sha256) throw new Error('artifact_changed')
      }
      return j
    } catch { throw new FoundationError('journal_recovery_required', 409) }
  }
  snapshot() {
    const journal = this.read()
    return { schemaVersion: 1 as const, enabled: true, mode: 'foundation', sequence: journal.sequence,
      capabilities: { publication: false, automaticExecution: false, legacyTaskMutation: false },
      work: journal.work,
      gates: [
        { id: 'meeting-replay', status: 'available', detail: 'Disposable source replay and durable receipt; no automatic agent execution.' },
        { id: 'task-migration', status: 'blocked', detail: 'Legacy task IDs remain unchanged; migration and shared ownership must pass before automatic execution.' },
        { id: 'publication', status: 'blocked', detail: 'Publication is unavailable in this foundation build.' },
      ] }
  }
  recordDraft(workId: string, revision: string, html: string, sha256: string) {
    if (!id(workId) || !id(revision) || Buffer.byteLength(html) > 100_000 || hash(html) !== sha256) throw new FoundationError('invalid_draft')
    const lock = join(this.root, 'journal.lock')
    let fd: number
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600) } catch { throw new FoundationError('journal_busy_or_recovery_required', 409) }
    try {
      const journal = this.read()
      const row = journal.work.find(w => w.id === workId)
      if (!row || row.revision !== revision || row.status !== 'needs_review') throw new FoundationError('draft_source_superseded', 409)
      const artifactDir = join(this.root, 'artifacts')
      mkdirSync(artifactDir, { recursive: true, mode: 0o700 })
      if (lstatSync(artifactDir).isSymbolicLink()) throw new FoundationError('unsafe_artifact_directory', 409)
      const path = join(artifactDir, `${sha256}.html`)
      if (existsSync(path)) {
        if (lstatSync(path).isSymbolicLink() || hash(boundedRead(path, 100_000)) !== sha256) throw new FoundationError('artifact_conflict', 409)
      } else durableAtomicWriteFileSync(path, html, { mode: 0o600 })
      row.artifact = { path, sha256, kind: 'preview', checks: [{ name: 'Escaped text preview read back under OS sandbox', passed: true }] }
      row.updatedAt = new Date().toISOString(); row.reason = 'Text-only preview prepared. This is not a website code change or publication approval.'
      journal.sequence++
      const serialized = JSON.stringify(journal)
      if (Buffer.byteLength(serialized) > MAX_JOURNAL_BYTES) throw new FoundationError('foundation_capacity_reached', 409)
      durableAtomicWriteFileSync(join(this.root, 'journal.json'), serialized, { mode: 0o600 })
      return this.snapshot()
    } finally { closeSync(fd); unlinkSync(lock) }
  }
  replay(raw: unknown) {
    const input = parseFoundationInput(raw)
    const lock = join(this.root, 'journal.lock')
    let fd: number
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600) } catch { throw new FoundationError('journal_busy_or_recovery_required', 409) }
    try {
      const journal = this.read()
      const key = `${input.projectId}/${input.meetingId}/${input.revision}`
      const digest = hash(JSON.stringify(input))
      const prior = journal.receipts.find(r => r.key === key)
      if (prior) {
        if (prior.digest !== digest) throw new FoundationError('revision_conflict', 409)
        return { ...this.snapshot(), replayed: true, workId: prior.workId }
      }
      // Aliases are evidence, not permission to silently union or split identities.
      const identities = new Set([input.meetingId, ...(input.sourceAliases ?? [])])
      if (journal.work.some(w => w.projectId === input.projectId && w.meetingId !== input.meetingId
        && [w.meetingId, ...(w.sourceAliases ?? [])].some(alias => identities.has(alias)))) throw new FoundationError('alias_reconciliation_required', 409)
      if (journal.receipts.length >= MAX_RECORDS) throw new FoundationError('foundation_capacity_reached', 409)
      const now = new Date().toISOString()
      for (const row of journal.work) {
        if (row.projectId === input.projectId && row.meetingId === input.meetingId && row.status !== 'superseded') {
          row.status = 'superseded'; row.updatedAt = now; row.reason = 'Source revision replaced; no authority carries forward.'
        }
      }
      const row: FoundationWork = { id: randomUUID(), meetingId: input.meetingId, projectId: input.projectId,
        revision: input.revision, status: input.ready ? 'needs_review' : 'blocked',
        title: `Meeting follow-through: ${input.meetingId}`, sourceExcerpt: input.transcript.slice(0, 600), criteria: input.criteria ?? [],
        sourceAliases: input.sourceAliases,
        createdAt: now, updatedAt: now,
        reason: input.ready ? 'Source captured for review. Automatic execution is disabled.' : 'Waiting for canonical meeting readiness.' }
      journal.work.unshift(row); journal.receipts.push({ key, digest, workId: row.id }); journal.sequence++
      const serialized = JSON.stringify(journal)
      if (Buffer.byteLength(serialized) > MAX_JOURNAL_BYTES) throw new FoundationError('foundation_capacity_reached', 409)
      durableAtomicWriteFileSync(join(this.root, 'journal.json'), serialized, { mode: 0o600 })
      return { ...this.snapshot(), replayed: false, workId: row.id }
    } finally { closeSync(fd); unlinkSync(lock) }
  }
}
