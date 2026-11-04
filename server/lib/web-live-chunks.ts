import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dataPath } from './data-dir.js'
import { normalizeTitleSteer } from './meeting-title-steer.js'

const SESSION_ID_RE = /^[A-Za-z0-9:_-]{3,96}$/
const MAX_FILE_BYTES = 32 * 1024 * 1024
const SETTLE_WINDOW = 3
const LEVEL_LIMIT = 120

export interface LiveSessionSummary {
  sessionId: string
  mtimeMs: number
  stamp: string
  sourceType?: string
  speakerPolicy?: string
}

export interface LiveTranscriptTurn {
  i: number
  elapsedMs: number
  speaker: string
  text: string
  originalSpeaker?: string
}

export interface LiveChunkLevel {
  i: number
  level: number
  speechSec: number | null
}

export interface LiveTranscriptReadResult {
  sessionId: string
  ended: boolean
  unchanged: boolean
  stamp?: string
  startTime?: number | null
  lastActivityAt?: number | null
  maxIndex?: number
  settledThrough?: number
  turns?: LiveTranscriptTurn[]
  speakerRevision?: number
  fullSnapshot?: boolean
  sourceType?: string
  speakerPolicy?: string
  levels?: LiveChunkLevel[]
  /** 6.99.5: the name typed for this recording while it runs (the session file's `titleSteer`); absent when none. */
  titleSteer?: string
}

export function isValidLiveSessionId(id: string): boolean {
  return typeof id === 'string' && SESSION_ID_RE.test(id)
}

function fileStamp(stat: { mtimeMs: number; size: number }): string {
  return `${Math.floor(stat.mtimeMs)}.${stat.size}`
}

function validIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value) {
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0 && item < 10_000_000) {
      out.push(item)
    }
  }
  return out
}

function parseLevels(value: unknown): LiveChunkLevel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const byIndex = new Map<number, LiveChunkLevel>()
  for (const row of value) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const idx = validIndexes([r.i])[0]
    const level = typeof r.level === 'number' && Number.isFinite(r.level) ? r.level : -1
    if (idx === undefined || level < 0 || level > 1) continue
    let speechSec: number | null = null
    if (r.speechSec === null || r.speechSec === undefined) {
      speechSec = null
    } else if (typeof r.speechSec === 'number' && Number.isFinite(r.speechSec) && r.speechSec >= 0) {
      speechSec = r.speechSec
    } else {
      continue
    }
    byIndex.set(idx, { i: idx, level, speechSec })
  }
  const sorted = [...byIndex.keys()].sort((a, b) => a - b)
  return sorted.slice(-LEVEL_LIMIT).map(k => byIndex.get(k)!)
}

export function listLiveTranscriptSessions(baseDataDir = dataPath()): LiveSessionSummary[] {
  const activeDir = resolve(baseDataDir, 'active-sessions')
  let names: string[] = []
  try {
    const dirStat = lstatSync(activeDir)
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return []
    names = readdirSync(activeDir)
  } catch {
    return []
  }

  const rows: LiveSessionSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const id = name.slice(0, -5)
    if (!isValidLiveSessionId(id)) continue
    const full = resolve(activeDir, name)
    if (resolve(full, '..') !== activeDir) continue
    try {
      const st = lstatSync(full)
      if (!st.isFile() || st.isSymbolicLink()) continue
      rows.push({
        sessionId: id,
        mtimeMs: Math.floor(st.mtimeMs),
        stamp: fileStamp(st),
        ...(id.startsWith('phone_') ? { sourceType: 'iphone_microphone', speakerPolicy: 'anonymous' } : {}),
      })
    } catch {
      continue
    }
  }

  rows.sort((a, b) => (b.mtimeMs !== a.mtimeMs ? b.mtimeMs - a.mtimeMs : a.sessionId.localeCompare(b.sessionId)))
  return rows
}

export function readLiveTranscriptSession(options: {
  baseDataDir?: string
  sessionId: string
  since?: number
  knownStamp?: string | null
  knownSpeakerRevision?: number | null
}): LiveTranscriptReadResult {
  const { sessionId } = options
  if (!isValidLiveSessionId(sessionId)) {
    throw new Error('invalid_session_id')
  }
  const since = typeof options.since === 'number' && Number.isInteger(options.since) ? options.since : -1
  if (since < -1 || since >= 10_000_000) {
    throw new Error('invalid_since')
  }

  const activeDir = resolve(options.baseDataDir ?? dataPath(), 'active-sessions')
  const filePath = join(activeDir, `${sessionId}.json`)
  if (resolve(filePath, '..') !== activeDir) {
    throw new Error('invalid_session_id')
  }

  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(filePath)
  } catch (err: any) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return { sessionId, ended: true, unchanged: false }
    }
    throw new Error('unreadable')
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new Error('unsafe_file')
  }
  if (st.size > MAX_FILE_BYTES) {
    throw new Error('too_large')
  }

  const stamp = fileStamp(st)
  if (options.knownStamp && options.knownStamp === stamp) {
    return {
      sessionId,
      ended: false,
      unchanged: true,
      stamp,
      ...(sessionId.startsWith('phone_') ? { sourceType: 'iphone_microphone', speakerPolicy: 'anonymous' } : {}),
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    throw new Error('parse_failed')
  }
  if (typeof parsed.sessionId === 'string' && parsed.sessionId !== sessionId) {
    throw new Error('session_mismatch')
  }

  const chunks = new Map<number, LiveTranscriptTurn>()
  const rawChunks = Array.isArray(parsed.chunksIndexed) ? parsed.chunksIndexed : []
  for (const entry of rawChunks) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const idx = validIndexes([row.i])[0]
    const c = row.c && typeof row.c === 'object' ? (row.c as Record<string, unknown>) : null
    if (idx === undefined || !c || typeof c.text !== 'string' || !c.text.trim()) continue
    const elapsedMs = typeof c.elapsed === 'number' && Number.isFinite(c.elapsed) ? Math.max(0, Math.round(c.elapsed)) : 0
    const speaker = typeof c.speaker === 'string' ? c.speaker.trim() : ''
    chunks.set(idx, { i: idx, elapsedMs, speaker, text: c.text })
  }

  let speakerRevision: number | undefined
  if (typeof parsed.speakerRevision === 'number' && Number.isInteger(parsed.speakerRevision) && parsed.speakerRevision >= 0) {
    speakerRevision = parsed.speakerRevision
    if (Array.isArray(parsed.speakerProjectedChunksIndexed)) {
      for (const proj of parsed.speakerProjectedChunksIndexed) {
        if (!proj || typeof proj !== 'object') continue
        const pRow = proj as Record<string, unknown>
        const idx = validIndexes([pRow.i])[0]
        const pc = pRow.c && typeof pRow.c === 'object' ? (pRow.c as Record<string, unknown>) : null
        const orig = idx !== undefined ? chunks.get(idx) : undefined
        if (orig && pc && typeof pc.speaker === 'string' && pc.speaker.trim()) {
          orig.originalSpeaker = orig.speaker
          orig.speaker = pc.speaker.trim()
        }
      }
    }
  }

  const fullSnapshot = speakerRevision !== undefined && speakerRevision !== (options.knownSpeakerRevision ?? undefined)
  const settled = new Set<number>(chunks.keys())
  for (const idx of validIndexes(parsed.asrCompletedIndices)) settled.add(idx)
  if (parsed.emptyCompletions && typeof parsed.emptyCompletions === 'object') {
    for (const k of Object.keys(parsed.emptyCompletions as Record<string, unknown>)) {
      const n = Number.parseInt(k, 10)
      if (Number.isInteger(n) && n >= 0) settled.add(n)
    }
  }

  const received = validIndexes(parsed.receivedIndices)
  const declared = validIndexes([parsed.maxChunkIndex])[0] ?? -1
  const maxSettled = settled.size > 0 ? Math.max(...settled) : -1
  const maxReceived = received.length > 0 ? Math.max(...received) : -1
  const newest = Math.max(declared, maxReceived, maxSettled)

  let settledThrough = -1
  if (newest >= 0) {
    for (let i = 0; i <= newest; i++) {
      if (settled.has(i) || i < newest - SETTLE_WINDOW) {
        settledThrough = i
      } else {
        break
      }
    }
  }

  const sortedIndices = [...chunks.keys()].sort((a, b) => a - b)
  const turns = sortedIndices
    .filter(idx => fullSnapshot || idx > since)
    .map(idx => chunks.get(idx)!)

  const levels = parseLevels(parsed.chunkLevels)
  // The live name, read the way the steer store reads its own ledger: normalized, and dropped (never trimmed to fit)
  // when it is not a string or is over the cap. The web pane names the recording with it, as COS Control does.
  let titleSteer = ''
  try { titleSteer = normalizeTitleSteer(typeof parsed.titleSteer === 'string' ? parsed.titleSteer : null) } catch { titleSteer = '' }

  return {
    sessionId,
    ended: false,
    unchanged: false,
    stamp,
    startTime: typeof parsed.startTime === 'number' ? parsed.startTime : null,
    lastActivityAt: typeof parsed.lastActivityAt === 'number' ? parsed.lastActivityAt : null,
    maxIndex: sortedIndices.length > 0 ? sortedIndices[sortedIndices.length - 1] : -1,
    settledThrough,
    turns,
    ...(speakerRevision !== undefined ? { speakerRevision, fullSnapshot } : {}),
    ...(sessionId.startsWith('phone_') ? { sourceType: 'iphone_microphone', speakerPolicy: 'anonymous' } : {}),
    ...(levels ? { levels } : {}),
    ...(titleSteer ? { titleSteer } : {}),
  }
}
