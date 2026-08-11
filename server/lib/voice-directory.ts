/**
 * Cross-meeting voice directory.
 *
 * Profiles answer WHO is enrolled. Meeting sidecars answer WHERE a profile was
 * observed and how strong those occurrence-level matches were. Keeping those
 * jobs separate matters: an embedding count is training coverage, never a
 * confidence score, and Ext/Unidentified clusters are meeting-local—not people.
 *
 * The scan is asynchronous, bounded, single-flight, and cached. It never runs a
 * client-side N+1 fan-out and it never exposes filesystem paths.
 */

import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { dataPath } from './data-dir.js'
import { confirmedLabels } from './meeting-corrections.js'
import { resolveCosOperationsDir, resolveMeetingLibrary } from './cos-operations-meetings.js'
import {
  isUnattributed,
  reviewMeetingSpeakers,
  type Reliability,
  type ReviewChunk,
  type SpeakerWordSegment,
} from './meeting-speaker-review.js'
import { getOwnerSpeakerLabel } from './profile.js'
import { readVoiceProfiles, type VoiceProfile } from './speaker-embeddings.js'

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const SIDECAR = /\.g2-chunks\.json$/
const SESSION = /^[A-Za-z0-9:_-]{3,96}$/
const MAX_EVIDENCE_FILES = 1_200
const MAX_SIDECAR_BYTES = 12 * 1024 * 1024
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_APPEARANCES_PER_VOICE = 24
const CACHE_MS = 5 * 60_000

type EvidenceSource = 'cos_operations' | 'direct_library' | 'standalone_recordings'

interface EvidenceCandidate {
  sidecarPath: string
  markdownPath: string
  source: EvidenceSource
  mutable: boolean
  date: string
}

export interface VoiceAppearance {
  sessionId: string
  title: string
  date: string
  source: EvidenceSource
  mutable: boolean
  segments: number
  speakingMs: number
  speakingTimeSource: 'words' | 'chunks'
  observedMatch: number | null
  reliability: Reliability
  confirmedByHuman: boolean
  needsReview: boolean
}

export interface VoiceDirectoryProfile {
  name: string
  isOwner: boolean
  embeddings: number
  sources: Record<string, number>
  sourcesAligned: boolean
  assertedSegments: number
  candidateSegments: number
  assertedSpeakingMs: number
  candidateSpeakingMs: number
  speakingTimeSources: Record<'words' | 'chunks', number>
  meetingCount: number
  reviewMeetingCount: number
  observedMatch: number | null
  observedMatchSegments: number
  reliabilityCounts: Record<Reliability, number>
  firstSeen: string | null
  lastSeen: string | null
  appearances: VoiceAppearance[]
}

export interface VoiceDirectorySnapshot {
  schemaVersion: 1
  generatedAt: string
  owner: string
  profileCount: number
  totalEmbeddings: number
  meetingsScanned: number
  sidecarsSkipped: number
  truncated: boolean
  unresolvedMeetings: number
  unresolvedSegments: number
  profiles: VoiceDirectoryProfile[]
}

interface AppearanceAccumulator {
  assertedSegments: number
  candidateSegments: number
  assertedSpeakingMs: number
  candidateSpeakingMs: number
  speakingTimeSources: Record<'words' | 'chunks', number>
  observedWeighted: number
  observedSegments: number
  reliabilityCounts: Record<Reliability, number>
  assertedMeetings: Set<string>
  reviewMeetings: Set<string>
  firstSeen: string | null
  lastSeen: string | null
  appearances: VoiceAppearance[]
}

let cached: { at: number; snapshot: VoiceDirectorySnapshot } | null = null
let building: Promise<VoiceDirectorySnapshot> | null = null

function sourceCounts(profile: VoiceProfile): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const source of profile.sources ?? []) {
    const key = source.startsWith('auto:') ? 'auto' : source
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function cleanTitle(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (heading) return heading.slice(0, 180)
  return fallback
    .replace(/\.g2-chunks\.json$/, '')
    .replace(/^\d{4}-\d{2}-\d{2}_/, '')
    .replace(/_/g, ' ')
    .slice(0, 180) || 'Untitled meeting'
}

async function safeDirectory(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    return await realpath(path)
  } catch { return null }
}

async function childDirectory(parentReal: string, name: string): Promise<string | null> {
  const child = await safeDirectory(join(parentReal, name))
  return child && dirname(child) === parentReal ? child : null
}

async function collectMonths(
  base: string,
  source: EvidenceSource,
  mutable: boolean,
): Promise<EvidenceCandidate[]> {
  const root = await safeDirectory(base)
  if (!root) return []
  const candidates: EvidenceCandidate[] = []
  const months = (await readdir(root)).filter(name => MONTH.test(name)).sort().reverse()
  for (const month of months) {
    const monthDir = await childDirectory(root, month)
    if (!monthDir) continue
    const files = (await readdir(monthDir)).filter(name => SIDECAR.test(name)).sort().reverse()
    for (const file of files) {
      candidates.push({
        sidecarPath: join(monthDir, file),
        markdownPath: join(monthDir, file.replace(SIDECAR, '.md')),
        source,
        mutable,
        date: file.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? month,
      })
      if (candidates.length >= MAX_EVIDENCE_FILES) return candidates
    }
  }
  return candidates
}

async function boundedMarkdownTitle(path: string, fallback: string): Promise<string> {
  try {
    const link = await lstat(path)
    if (!link.isFile() || link.isSymbolicLink() || link.size > 10 * 1024 * 1024) return fallback
    const real = await realpath(path)
    if (dirname(real) !== dirname(path)) return fallback
    return cleanTitle((await readFile(real, 'utf8')).slice(0, 8_192), fallback)
  } catch {
    return fallback
  }
}

async function collectCandidates(): Promise<{ rows: EvidenceCandidate[]; truncated: boolean }> {
  const groups: EvidenceCandidate[][] = []
  const canonicalRoots = new Set<string>()
  const operations = resolveCosOperationsDir()
  if (operations) {
    const operationsReal = await safeDirectory(operations)
    if (operationsReal) {
      canonicalRoots.add(operationsReal)
      const domains = (await readdir(operationsReal)).sort()
      const rows: EvidenceCandidate[] = []
      for (const domain of domains) {
        const domainDir = await childDirectory(operationsReal, domain)
        if (!domainDir) continue
        rows.push(...await collectMonths(join(domainDir, 'meetings'), 'cos_operations', true))
        if (rows.length >= MAX_EVIDENCE_FILES) break
      }
      groups.push(rows)
    }
  }

  const library = resolveMeetingLibrary()
  if (library.layout === 'direct' && library.root) {
    const directReal = await safeDirectory(library.root)
    if (directReal && !canonicalRoots.has(directReal)) {
      canonicalRoots.add(directReal)
      groups.push(await collectMonths(directReal, 'direct_library', false))
    }
  }

  const standalone = await safeDirectory(dataPath('recordings'))
  if (standalone && !canonicalRoots.has(standalone)) {
    groups.push(await collectMonths(standalone, 'standalone_recordings', true))
  }

  const total = groups.reduce((sum, rows) => sum + rows.length, 0)
  // Source order is precedence order. Duplicates are removed after parsing by
  // session id, so the titled operations copy wins over direct/raw copies.
  return { rows: groups.flat().slice(0, MAX_EVIDENCE_FILES), truncated: total > MAX_EVIDENCE_FILES }
}

function emptyAccumulator(): AppearanceAccumulator {
  return {
    assertedSegments: 0,
    candidateSegments: 0,
    assertedSpeakingMs: 0,
    candidateSpeakingMs: 0,
    speakingTimeSources: { words: 0, chunks: 0 },
    observedWeighted: 0,
    observedSegments: 0,
    reliabilityCounts: { confident: 0, weak: 0, unreliable: 0, unattributed: 0 },
    assertedMeetings: new Set(),
    reviewMeetings: new Set(),
    firstSeen: null,
    lastSeen: null,
    appearances: [],
  }
}

export async function buildVoiceDirectorySnapshot(): Promise<VoiceDirectorySnapshot> {
  const owner = getOwnerSpeakerLabel()
  const { profiles } = readVoiceProfiles()
  const byName = new Map(profiles.map(profile => [profile.name, emptyAccumulator()]))
  const known = new Set(profiles.map(profile => profile.name))
  const candidates = await collectCandidates()
  const seenSessions = new Set<string>()
  let totalBytes = 0
  let meetingsScanned = 0
  let sidecarsSkipped = 0
  let truncated = candidates.truncated
  let unresolvedSegments = 0
  const unresolvedMeetings = new Set<string>()

  for (let i = 0; i < candidates.rows.length; i++) {
    if (i > 0 && i % 8 === 0) await yieldToEventLoop()
    const candidate = candidates.rows[i]
    try {
      const link = await lstat(candidate.sidecarPath)
      if (!link.isFile() || link.isSymbolicLink() || link.size <= 0 || link.size > MAX_SIDECAR_BYTES) {
        sidecarsSkipped++
        continue
      }
      if (totalBytes + link.size > MAX_TOTAL_BYTES) {
        truncated = true
        break
      }
      const real = await realpath(candidate.sidecarPath)
      if (dirname(real) !== dirname(candidate.sidecarPath)) {
        sidecarsSkipped++
        continue
      }
      totalBytes += link.size
      const raw = JSON.parse(await readFile(real, 'utf8')) as Record<string, unknown> | ReviewChunk[]
      const chunks = Array.isArray(raw) ? raw : raw.chunks
      const sessionId = Array.isArray(raw) ? '' : String(raw.sessionId ?? '')
      if (!Array.isArray(chunks) || !SESSION.test(sessionId) || seenSessions.has(sessionId)) {
        sidecarsSkipped++
        continue
      }
      seenSessions.add(sessionId)

      const record = Array.isArray(raw) ? {} : raw
      const storedTitle = typeof record.title === 'string' && record.title.trim()
        ? record.title.trim().slice(0, 180)
        : cleanTitle('', basename(candidate.sidecarPath))
      const title = await boundedMarkdownTitle(
        candidate.markdownPath,
        storedTitle,
      )

      const review = reviewMeetingSpeakers(chunks as ReviewChunk[], {
        owner,
        phrasesPerVoice: 1,
        confirmed: confirmedLabels(sessionId),
        durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined,
        batchSegments: Array.isArray(record.batchSegments)
          ? record.batchSegments as SpeakerWordSegment[]
          : undefined,
      })
      meetingsScanned++

      for (const voice of review.voices) {
        if (isUnattributed(voice.label)) {
          unresolvedSegments += voice.segments
          unresolvedMeetings.add(sessionId)
          continue
        }
        if (!known.has(voice.label)) continue
        const acc = byName.get(voice.label)!
        const needsReview = !voice.nameAsserted
        if (needsReview) {
          acc.candidateSegments += voice.segments
          acc.candidateSpeakingMs += voice.speakingMs
          acc.reviewMeetings.add(sessionId)
        } else {
          acc.assertedSegments += voice.segments
          acc.assertedSpeakingMs += voice.speakingMs
          acc.assertedMeetings.add(sessionId)
        }
        acc.speakingTimeSources[review.speakingTimeSource] += voice.speakingMs
        acc.reliabilityCounts[voice.reliability] += voice.segments
        if (!acc.firstSeen || candidate.date < acc.firstSeen) acc.firstSeen = candidate.date
        if (!acc.lastSeen || candidate.date > acc.lastSeen) acc.lastSeen = candidate.date
        if (voice.meanSimilarity != null) {
          acc.observedWeighted += voice.meanSimilarity * voice.segments
          acc.observedSegments += voice.segments
        }
        acc.appearances.push({
          sessionId,
          title,
          date: candidate.date,
          source: candidate.source,
          mutable: candidate.mutable,
          segments: voice.segments,
          speakingMs: voice.speakingMs,
          speakingTimeSource: review.speakingTimeSource,
          observedMatch: voice.meanSimilarity,
          reliability: voice.reliability,
          confirmedByHuman: voice.confirmedByHuman,
          needsReview,
        })
      }
    } catch {
      sidecarsSkipped++
    }
  }

  const directory = profiles.map(profile => {
    const acc = byName.get(profile.name) ?? emptyAccumulator()
    const appearances = acc.appearances
      .sort((a, b) => b.date.localeCompare(a.date) || b.segments - a.segments)
      .slice(0, MAX_APPEARANCES_PER_VOICE)
    return {
      name: profile.name,
      isOwner: profile.name === owner,
      embeddings: profile.embeddings.length,
      sources: sourceCounts(profile),
      sourcesAligned: (profile.sources?.length ?? 0) === profile.embeddings.length,
      assertedSegments: acc.assertedSegments,
      candidateSegments: acc.candidateSegments,
      assertedSpeakingMs: acc.assertedSpeakingMs,
      candidateSpeakingMs: acc.candidateSpeakingMs,
      speakingTimeSources: acc.speakingTimeSources,
      meetingCount: acc.assertedMeetings.size,
      reviewMeetingCount: acc.reviewMeetings.size,
      observedMatch: acc.observedSegments > 0
        ? Math.round((acc.observedWeighted / acc.observedSegments) * 1_000) / 1_000
        : null,
      observedMatchSegments: acc.observedSegments,
      reliabilityCounts: acc.reliabilityCounts,
      firstSeen: acc.firstSeen,
      lastSeen: acc.lastSeen,
      appearances,
    }
  }).sort((a, b) => {
    const attentionA = a.reviewMeetingCount > 0 || !a.sourcesAligned ? 1 : 0
    const attentionB = b.reviewMeetingCount > 0 || !b.sourcesAligned ? 1 : 0
    return attentionB - attentionA || b.meetingCount - a.meetingCount || a.name.localeCompare(b.name)
  })

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    owner,
    profileCount: profiles.length,
    totalEmbeddings: profiles.reduce((sum, profile) => sum + profile.embeddings.length, 0),
    meetingsScanned,
    sidecarsSkipped,
    truncated,
    unresolvedMeetings: unresolvedMeetings.size,
    unresolvedSegments,
    profiles: directory,
  }
}

export async function getVoiceDirectorySnapshot(force = false): Promise<VoiceDirectorySnapshot> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.snapshot
  if (!building) {
    building = buildVoiceDirectorySnapshot()
      .then(snapshot => {
        cached = { at: Date.now(), snapshot }
        return snapshot
      })
      .finally(() => { building = null })
  }
  return building
}

/** Test and post-mutation hook. */
export function invalidateVoiceDirectory(): void {
  cached = null
}
