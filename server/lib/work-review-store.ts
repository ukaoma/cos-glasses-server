import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { acquireServerInstanceLock, type ServerInstanceLock } from './server-instance-lock.js'

export class WorkReviewError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code) }
}
export interface MeetingDescriptor { domain: string; month: string; filename: string; recordId?: string }
export interface ReviewModel { id: string; provider: string; title: string; available: boolean; reason?: string }
export interface ReviewTaskLink { domain: string; taskId: string; title: string; evidence: string; confidence: 'source_reference' | 'possible'; decision: 'proposed' }
export interface ReviewSource {
  descriptor: MeetingDescriptor; title: string; domain: string; revision: string; sourceTruncated: boolean
  aliases: string[]; projectId: string | null; inputTruncated: boolean
}
export interface WorkReview {
  id: string; canonicalMeetingId: string; source: ReviewSource; model: string; provider: string; policyVersion: 1
  status: 'queued' | 'running' | 'ready' | 'failed' | 'superseded' | 'source_unavailable'
  clientJobId: string; generation: 1; jobId?: string; cosSessionId?: string; providerNativeSessionId?: string
  providerOwnershipConfirmedAt?: string; markdown?: string; taskLinks: ReviewTaskLink[]; contextWarnings: string[]
  createdAt: string; updatedAt: string; supersededBy?: string; error?: { code: string; message: string }
}
/** Private immutable admission payload, never exposed as a client execution authority. */
export interface StoredWorkReview extends WorkReview {
  prompt: string; messageEra: string; admissionAttempted: boolean
  suspendedTerminal?: { status: 'ready' | 'failed'; error?: { code: string; message: string } }
}
export function reviewHash(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function publicReview(row: StoredWorkReview): WorkReview {
  const { prompt: _prompt, messageEra: _era, admissionAttempted: _attempted, suspendedTerminal: _terminal, ...record } = structuredClone(row)
  return record
}
export function parseMeetingDescriptor(raw: unknown): MeetingDescriptor {
  const r = raw as Partial<MeetingDescriptor> | undefined
  if (!r || typeof r.domain !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(r.domain)
    || typeof r.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(r.month)
    || typeof r.filename !== 'string' || r.filename.length > 255 || !/^[^/\\\x00-\x1f]+\.md$/.test(r.filename)
    || (r.recordId !== undefined && (typeof r.recordId !== 'string' || !r.recordId || r.recordId.length > 512))) {
    throw new WorkReviewError('invalid_meeting_descriptor', 400)
  }
  return { domain: r.domain, month: r.month, filename: r.filename, ...(r.recordId ? { recordId: r.recordId } : {}) }
}
/** One process owns a review journal. A second runtime never silently overwrites it. */
export class WorkReviewStore {
  private rows: StoredWorkReview[] = []
  private readonly path: string
  private readonly lock: ServerInstanceLock
  private closed = false
  constructor(root: string) {
    const dir = resolve(root)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new WorkReviewError('review_store_unsafe', 503)
    this.path = join(dir, 'reviews.json')
    try { this.lock = acquireServerInstanceLock({ lockDir: join(dir, 'writer.lock') }) }
    catch { throw new WorkReviewError('review_store_locked', 503) }
    try {
      if (existsSync(this.path)) {
        const file = lstatSync(this.path)
        if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077) || file.size > 32_000_000) throw new Error('unsafe')
        const journal = JSON.parse(readFileSync(this.path, 'utf8'))
        if (journal.version !== 1 || !Array.isArray(journal.reviews) || journal.reviews.length > 1000) throw new Error('version')
        for (const r of journal.reviews) {
          if (!/^wr_[a-f0-9]{32}$/.test(r.id) || typeof r.prompt !== 'string' || r.prompt.length > 48_000
            || !/^[a-f0-9]{64}$/.test(r.source?.revision) || typeof r.clientJobId !== 'string'
            || !['queued','running','ready','failed','superseded','source_unavailable'].includes(r.status)
            || typeof r.canonicalMeetingId !== 'string' || !r.canonicalMeetingId
            || r.policyVersion !== 1 || r.generation !== 1 || typeof r.admissionAttempted !== 'boolean'
            || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(r.clientJobId)
            || !['claude','ollama'].includes(r.provider) || typeof r.model !== 'string' || !r.model || r.model.length > 100
            || typeof r.messageEra !== 'string' || !r.messageEra || r.messageEra.length > 256
            || typeof r.source.inputTruncated !== 'boolean' || r.source.sourceTruncated !== false
            || !Array.isArray(r.taskLinks) || !Array.isArray(r.contextWarnings) || r.contextWarnings.some((v: unknown) => typeof v !== 'string')
            || (r.suspendedTerminal !== undefined && (!['ready','failed'].includes(r.suspendedTerminal?.status)
              || (r.suspendedTerminal.error !== undefined && (typeof r.suspendedTerminal.error?.code !== 'string' || typeof r.suspendedTerminal.error?.message !== 'string'))))
            || r.id !== `wr_${reviewHash(`${r.canonicalMeetingId}|${r.source.revision}|1`).slice(0,32)}`) throw new Error('record')
          const descriptor = parseMeetingDescriptor(r.source.descriptor)
          if (descriptor.recordId !== r.canonicalMeetingId) throw new Error('record-identity')
        }
        if (new Set(journal.reviews.map((r: StoredWorkReview) => r.id)).size !== journal.reviews.length) throw new Error('duplicate')
        this.rows = journal.reviews
      }
    } catch { this.close(); throw new WorkReviewError('review_store_recovery_required', 503) }
  }
  list(): StoredWorkReview[] { return structuredClone(this.rows) }
  get(id: string): StoredWorkReview | undefined { return this.list().find(r => r.id === id) }
  put(row: StoredWorkReview): void {
    if (this.closed) throw new WorkReviewError('review_store_closed', 503)
    const next = this.list(); const index = next.findIndex(r => r.id === row.id)
    if (index < 0) next.unshift(structuredClone(row)); else next[index] = structuredClone(row)
    const bytes = JSON.stringify({ version: 1, reviews: next }) + '\n'
    if (next.length > 1000 || Buffer.byteLength(bytes) > 32_000_000) throw new WorkReviewError('review_store_full', 503)
    durableAtomicWriteFileSync(this.path, bytes)
    this.rows = next
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.lock.release()
  }
}
