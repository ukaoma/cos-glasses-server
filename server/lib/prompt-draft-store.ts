import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { atomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

export type PromptDraftStatus = 'recording' | 'finalized' | 'error' | 'cancelled' | 'expired'

export interface PromptDraftTranscriptRecord {
  text: string
  hash: string
  requestedMode: 'hq' | 'fast'
  actualQuality: 'hq' | 'fast' | 'cloud'
  backend: string
  degraded: boolean
  acceptedDegraded?: boolean
}

export interface PromptDraftMeta {
  v: 2
  draftId: string
  createdAt: string
  updatedAt: string
  expiresAt: string
  status: PromptDraftStatus
  receivedChunkIndexes: number[]
  chunkBytes: Record<string, number>
  chunkHashes: Record<string, string>
  warmTranscripts: Record<string, PromptDraftTranscriptRecord>
  finalTranscripts: Record<string, PromptDraftTranscriptRecord>
  /** Compatibility mirror for pre-v2 clients and draft fixtures. */
  chunkTranscripts?: Record<string, string>
  finalizedText?: string
  lastError?: string
}

// Public installs run from an ephemeral npx cache. Persist draft audio under
// ~/.cos-glasses/data so package upgrades cannot erase a recoverable recording.
const DATA_DIR = process.env.COS_PROMPT_DRAFT_DIR
  ? path.resolve(process.env.COS_PROMPT_DRAFT_DIR)
  : dataPath('prompt-drafts')
const META_NAME = 'meta.json'
const TTL_MS = 72 * 60 * 60 * 1000
const locks = new Map<string, Promise<unknown>>()

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function nowIso(): string {
  return new Date().toISOString()
}

function expiresFromNowIso(): string {
  return new Date(Date.now() + TTL_MS).toISOString()
}

function normalizeDraftId(draftId: string): string {
  const clean = String(draftId || '').replace(/[^a-zA-Z0-9_-]/g, '')
  if (!clean) throw new Error('invalid draft id')
  return clean
}

function draftDir(draftId: string): string {
  return path.join(DATA_DIR, normalizeDraftId(draftId))
}

function metaPath(draftId: string): string {
  return path.join(draftDir(draftId), META_NAME)
}

function chunkPath(draftId: string, chunkIndex: number): string {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) throw new Error('invalid chunk index')
  return path.join(draftDir(draftId), `chunk-${String(chunkIndex).padStart(5, '0')}.wav`)
}

function writeMeta(meta: PromptDraftMeta): PromptDraftMeta {
  ensureDir(draftDir(meta.draftId))
  atomicWriteFileSync(metaPath(meta.draftId), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 })
  return meta
}

export function createPromptDraft(requestedId?: string): PromptDraftMeta {
  ensureDir(DATA_DIR)
  const candidate = requestedId ? normalizeDraftId(requestedId) : ''
  const draftId = candidate && !existsSync(metaPath(candidate)) ? candidate : randomBytes(8).toString('hex')
  const now = nowIso()
  return writeMeta({
    v: 2,
    draftId,
    createdAt: now,
    updatedAt: now,
    expiresAt: expiresFromNowIso(),
    status: 'recording',
    receivedChunkIndexes: [],
    chunkBytes: {},
    chunkHashes: {},
    warmTranscripts: {},
    finalTranscripts: {},
    chunkTranscripts: {},
  })
}

export function loadPromptDraftMeta(draftId: string): PromptDraftMeta | null {
  const loaded = loadJsonOrQuarantine<PromptDraftMeta & { v?: number }>(metaPath(draftId))
  if (loaded.status === 'missing') return null
  if (loaded.status === 'corrupt') {
    console.warn(`[prompt-draft] corrupt metadata quarantined: ${loaded.quarantinedAs}`)
    return null
  }
  const data = loaded.data
  if (data.v !== 2) {
    const legacy = data.chunkTranscripts ?? {}
    data.v = 2
    data.chunkHashes = data.chunkHashes ?? {}
    data.warmTranscripts = data.warmTranscripts ?? {}
    data.finalTranscripts = data.finalTranscripts ?? {}
    for (const [index, text] of Object.entries(legacy)) {
      data.warmTranscripts[index] ??= {
        text,
        hash: data.chunkHashes[index] ?? '',
        requestedMode: 'hq',
        actualQuality: 'fast',
        backend: 'legacy-unknown',
        degraded: true,
      }
    }
    writeMeta(data)
  }
  data.chunkHashes ??= {}
  data.warmTranscripts ??= {}
  data.finalTranscripts ??= {}
  data.chunkTranscripts ??= {}
  return data
}

function touchMeta(meta: PromptDraftMeta): PromptDraftMeta {
  meta.updatedAt = nowIso()
  meta.expiresAt = expiresFromNowIso()
  return meta
}

async function withDraftLock<T>(draftId: string, fn: () => Promise<T> | T): Promise<T> {
  const key = normalizeDraftId(draftId)
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const chained = previous.then(() => current)
  locks.set(key, chained)
  await previous.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === chained) locks.delete(key)
  }
}

export async function savePromptDraftChunk(draftId: string, chunkIndex: number, audioBuffer: Buffer): Promise<PromptDraftMeta> {
  return withDraftLock(draftId, () => {
    const meta = loadPromptDraftMeta(draftId)
    if (!meta) throw new Error('draft not found')
    ensureDir(draftDir(draftId))
    const hash = createHash('sha256').update(audioBuffer).digest('hex')
    const key = String(chunkIndex)
    if (meta.chunkHashes[key] === hash && existsSync(chunkPath(draftId, chunkIndex))) {
      return writeMeta(touchMeta(meta))
    }
    atomicWriteFileSync(chunkPath(draftId, chunkIndex), audioBuffer, { mode: 0o600 })
    if (!meta.receivedChunkIndexes.includes(chunkIndex)) {
      meta.receivedChunkIndexes.push(chunkIndex)
      meta.receivedChunkIndexes.sort((a, b) => a - b)
    }
    meta.chunkBytes[key] = audioBuffer.length
    meta.chunkHashes[key] = hash
    if (!meta.chunkTranscripts) meta.chunkTranscripts = {}
    delete meta.chunkTranscripts[key]
    delete meta.warmTranscripts[key]
    delete meta.finalTranscripts[key]
    if (meta.status === 'error') meta.status = 'recording'
    return writeMeta(touchMeta(meta))
  })
}

export function readPromptDraftChunks(draftId: string): Array<{ chunkIndex: number; audioBuffer: Buffer }> {
  const meta = loadPromptDraftMeta(draftId)
  if (!meta) throw new Error('draft not found')
  return meta.receivedChunkIndexes
    .slice()
    .sort((a, b) => a - b)
    .map((chunkIndex) => ({ chunkIndex, audioBuffer: readFileSync(chunkPath(draftId, chunkIndex)) }))
}

export async function markPromptDraftFinalized(draftId: string, text: string): Promise<PromptDraftMeta> {
  return withDraftLock(draftId, () => {
    const meta = loadPromptDraftMeta(draftId)
    if (!meta) throw new Error('draft not found')
    meta.status = 'finalized'
    meta.finalizedText = text
    meta.lastError = undefined
    return writeMeta(touchMeta(meta))
  })
}

export async function markPromptDraftChunkTranscript(
  draftId: string,
  chunkIndex: number,
  record: PromptDraftTranscriptRecord | string,
  purpose: 'warm' | 'final' = 'warm',
): Promise<PromptDraftMeta> {
  return withDraftLock(draftId, () => {
    const meta = loadPromptDraftMeta(draftId)
    if (!meta) throw new Error('draft not found')
    const key = String(chunkIndex)
    const normalized: PromptDraftTranscriptRecord = typeof record === 'string'
      ? { text: record, hash: meta.chunkHashes[key] ?? '', requestedMode: 'hq', actualQuality: 'fast', backend: 'legacy', degraded: true }
      : record
    if (meta.chunkHashes[key] && normalized.hash && meta.chunkHashes[key] !== normalized.hash) return meta
    if (purpose === 'final') meta.finalTranscripts[key] = normalized
    else meta.warmTranscripts[key] = normalized
    if (!meta.chunkTranscripts) meta.chunkTranscripts = {}
    meta.chunkTranscripts[key] = normalized.text
    return writeMeta(touchMeta(meta))
  })
}

export async function markPromptDraftError(draftId: string, error: string): Promise<PromptDraftMeta | null> {
  return withDraftLock(draftId, () => {
    const meta = loadPromptDraftMeta(draftId)
    if (!meta) return null
    meta.status = 'error'
    meta.lastError = error
    return writeMeta(touchMeta(meta))
  })
}

export function getMissingChunkIndexes(meta: PromptDraftMeta): number[] {
  if (meta.receivedChunkIndexes.length === 0) return []
  const max = Math.max(...meta.receivedChunkIndexes)
  const received = new Set(meta.receivedChunkIndexes)
  const missing: number[] = []
  for (let i = 0; i <= max; i++) {
    if (!received.has(i)) missing.push(i)
  }
  return missing
}

export function prunePromptDrafts(): number {
  ensureDir(DATA_DIR)
  let pruned = 0
  for (const entry of readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(DATA_DIR, entry.name)
    const meta = loadPromptDraftMeta(entry.name)
    const expiredByMeta = meta ? new Date(meta.expiresAt).getTime() <= Date.now() : false
    let expiredByMtime = false
    try {
      expiredByMtime = Date.now() - statSync(dir).mtimeMs > TTL_MS
    } catch {
      expiredByMtime = true
    }
    if (expiredByMeta || expiredByMtime) {
      try {
        rmSync(dir, { recursive: true, force: true })
        pruned++
      } catch (err: any) {
        console.warn(`[prompt-draft] prune failed for ${entry.name}: ${err.message}`)
      }
    }
  }
  return pruned
}
