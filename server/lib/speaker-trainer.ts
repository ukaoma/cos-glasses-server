// Multi-speaker voiceprint training from Fireflies meeting transcripts.
// Downloads meeting audio, extracts per-speaker segments via ffmpeg,
// and builds diverse embedding profiles through greedy diversity selection.
//
// Deep training: extracts ALL candidate embeddings, then selects the N most
// acoustically diverse ones (maximizing pairwise cosine distance).

import { resolve } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'
import {
  enrollEmbedding, extractEmbedding, isEmbeddingAvailable, getAllSpeakerNames,
  rawCosineSimilarity, saveProfileStore, rebuildAllProfiles, clearSpeakerEmbeddings,
} from './speaker-embeddings.js'
import { COS_SCRIPTS_DIR } from './python-bridge.js'

const CACHE_DIR = '/tmp/cos-speaker-training'
const PROGRESS_PATH = resolve(CACHE_DIR, 'training-progress.json')

// Fireflies GraphQL API
const FIREFLIES_API = 'https://api.fireflies.ai/graphql'

// Load Fireflies API key from COS .env (not the glasses app .env — that gets published)
function loadCosEnvKey(key: string): string | undefined {
  if (process.env[key]) return process.env[key]
  if (!COS_SCRIPTS_DIR) return undefined
  const envPaths = [
    resolve(COS_SCRIPTS_DIR, '.env'),
    resolve(COS_SCRIPTS_DIR, '../../.env'),
  ]
  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue
    try {
      const content = readFileSync(envPath, 'utf-8')
      for (const line of content.split('\n')) {
        const match = line.match(new RegExp(`^${key}=(.+)$`))
        if (match) return match[1].trim()
      }
    } catch { /* skip */ }
  }
  return undefined
}

interface FirefliesSentence {
  speaker_name: string
  start_time: number
  end_time: number
  text: string
}

interface FirefliesTranscript {
  id: string
  title: string
  audio_url: string | null
  sentences: FirefliesSentence[]
  date: number
}

interface TrainingProgress {
  processedMeetings: string[]
  speakerSegmentCounts: Record<string, number>
  lastRunAt: string
}

export interface TrainingReport {
  speakersProcessed: number
  segmentsExtracted: number
  enrollmentsAdded: number
  skippedDuplicate: number
  errors: string[]
  speakers: Array<{ name: string; segments: number; enrolled: boolean; embeddings: number }>
}

export interface TrainingStatus {
  speakers: Array<{ name: string; segments: number; meetings: number; enrolled: boolean }>
  lastTrainedAt: string | null
}

function getApiKey(): string {
  const key = loadCosEnvKey('FIREFLIES_API_KEY')
  if (!key) throw new Error('FIREFLIES_API_KEY not found — set it in MU-Chief-Staff/.env')
  return key
}

function ensureFfmpeg(): void {
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' })
  } catch {
    throw new Error('ffmpeg not found — install with: brew install ffmpeg')
  }
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true })
  }
}

function loadProgress(): TrainingProgress {
  if (existsSync(PROGRESS_PATH)) {
    return JSON.parse(readFileSync(PROGRESS_PATH, 'utf-8'))
  }
  return { processedMeetings: [], speakerSegmentCounts: {}, lastRunAt: '' }
}

function saveProgress(progress: TrainingProgress): void {
  writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2))
}

/** Fetch transcripts from Fireflies GraphQL API with pagination */
async function fetchFirefliesTranscripts(limit: number): Promise<FirefliesTranscript[]> {
  const apiKey = getApiKey()
  const results: FirefliesTranscript[] = []
  let skip = 0
  const batchSize = 50

  while (results.length < limit) {
    const query = `
      query {
        transcripts(limit: ${batchSize}, skip: ${skip}) {
          id
          title
          audio_url
          date
          sentences {
            speaker_name
            start_time
            end_time
            text
          }
        }
      }
    `

    const res = await fetch(FIREFLIES_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query }),
    })

    if (!res.ok) {
      if (res.status === 429) {
        console.log('[speaker-trainer] Rate limited, waiting 10s...')
        await new Promise(r => setTimeout(r, 10_000))
        continue
      }
      throw new Error(`Fireflies API error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json() as any
    const transcripts = data?.data?.transcripts ?? []
    if (transcripts.length === 0) break

    for (const t of transcripts) {
      if (results.length >= limit) break
      results.push(t)
    }

    skip += batchSize
    if (results.length < limit) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  return results
}

/** Download MP3 audio from Fireflies (URL expires in 24hr) */
async function downloadAudio(audioUrl: string, meetingId: string): Promise<string> {
  const outPath = resolve(CACHE_DIR, `${meetingId}.mp3`)
  if (existsSync(outPath)) return outPath

  console.log(`[speaker-trainer] Downloading audio for ${meetingId}...`)
  const res = await fetch(audioUrl)
  if (!res.ok) throw new Error(`Audio download failed: ${res.status}`)

  const arrayBuffer = await res.arrayBuffer()
  writeFileSync(outPath, Buffer.from(arrayBuffer))
  return outPath
}

/** Extract a WAV segment from an MP3 file using ffmpeg */
function extractSegment(mp3Path: string, startSec: number, endSec: number, outPath: string): boolean {
  try {
    execSync(
      `ffmpeg -y -i "${mp3Path}" -ss ${startSec} -to ${endSec} -ar 16000 -ac 1 -f wav "${outPath}"`,
      { stdio: 'pipe', timeout: 30_000 }
    )
    return true
  } catch {
    return false
  }
}

/** Find monologue segments (speaker talking for >= minDuration seconds continuously) */
function findMonologues(
  sentences: FirefliesSentence[],
  speakerName: string,
  minDuration: number
): Array<{ start: number; end: number; meetingId?: string }> {
  const segments: Array<{ start: number; end: number }> = []
  let currentStart = -1
  let currentEnd = -1

  for (const s of sentences) {
    if (s.speaker_name !== speakerName) {
      if (currentStart >= 0 && (currentEnd - currentStart) >= minDuration) {
        segments.push({ start: currentStart, end: currentEnd })
      }
      currentStart = -1
      currentEnd = -1
      continue
    }
    if (currentStart < 0) {
      currentStart = s.start_time
      currentEnd = s.end_time
    } else if (s.start_time - currentEnd < 1.5) {
      currentEnd = s.end_time
    } else {
      if ((currentEnd - currentStart) >= minDuration) {
        segments.push({ start: currentStart, end: currentEnd })
      }
      currentStart = s.start_time
      currentEnd = s.end_time
    }
  }
  if (currentStart >= 0 && (currentEnd - currentStart) >= minDuration) {
    segments.push({ start: currentStart, end: currentEnd })
  }
  return segments
}

/** Normalize speaker names */
function normalizeSpeakerName(name: string): string | null {
  if (!name || name.trim().length === 0) return null
  if (/^speaker\s*\d*$/i.test(name.trim())) return null
  if (/^unknown$/i.test(name.trim())) return null
  if (/^unidentified$/i.test(name.trim())) return null
  return name.trim()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/** Greedy diversity selection: pick N most diverse embeddings from a pool.
 *  Starts with the pair having maximum distance, then greedily adds the
 *  embedding with the highest minimum distance to the selected set. */
function selectDiverseEmbeddings(
  embeddings: Float32Array[],
  maxCount: number,
): Float32Array[] {
  if (embeddings.length <= maxCount) return embeddings

  // Compute pairwise similarities
  const n = embeddings.length
  const sims: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = rawCosineSimilarity(embeddings[i], embeddings[j])
      sims[i][j] = s
      sims[j][i] = s
    }
  }

  // Start with the pair having minimum similarity (maximum diversity)
  let bestPairSim = 1.0
  let bestI = 0, bestJ = 1
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sims[i][j] < bestPairSim) {
        bestPairSim = sims[i][j]
        bestI = i
        bestJ = j
      }
    }
  }

  const selected = new Set<number>([bestI, bestJ])

  // Greedily add embeddings that maximize minimum distance to selected set
  while (selected.size < maxCount && selected.size < n) {
    let bestIdx = -1
    let bestMinDist = -1

    for (let i = 0; i < n; i++) {
      if (selected.has(i)) continue
      // Find minimum similarity (maximum distance) to any selected embedding
      let minDist = 1.0
      for (const s of selected) {
        minDist = Math.min(minDist, 1 - sims[i][s]) // distance = 1 - similarity
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist
        bestIdx = i
      }
    }

    if (bestIdx >= 0) {
      selected.add(bestIdx)
    } else {
      break
    }
  }

  return Array.from(selected).sort().map(i => embeddings[i])
}

/** Deep training pipeline: extract ALL candidate embeddings, select most diverse 10 */
export async function trainFromFireflies(options: {
  speakerNames?: string[]
  minSegments?: number
  minSegmentDuration?: number
  limit?: number
  maxEmbeddingsPerSpeaker?: number
  fresh?: boolean  // ignore processedMeetings, rebuild from scratch
} = {}): Promise<TrainingReport> {
  const {
    speakerNames,
    minSegments = 3,
    minSegmentDuration = 5,
    limit = 200,
    maxEmbeddingsPerSpeaker = 10,
    fresh = false,
  } = options

  if (!isEmbeddingAvailable()) {
    throw new Error('Speaker embedding system not initialized — check sherpa-onnx model')
  }

  ensureFfmpeg()
  ensureCacheDir()

  const progress = fresh ? { processedMeetings: [], speakerSegmentCounts: {}, lastRunAt: '' } : loadProgress()
  const report: TrainingReport = {
    speakersProcessed: 0,
    segmentsExtracted: 0,
    enrollmentsAdded: 0,
    skippedDuplicate: 0,
    errors: [],
    speakers: [],
  }

  // Fresh mode: clear existing embeddings for target speakers so dedup gate doesn't reject new diverse set
  if (fresh && speakerNames && speakerNames.length > 0) {
    for (const name of speakerNames) {
      const cleared = clearSpeakerEmbeddings(name)
      if (cleared) console.log(`[speaker-trainer] Fresh mode: cleared embeddings for "${name}"`)
    }
  }

  console.log(`[speaker-trainer] Fetching up to ${limit} meetings from Fireflies (fresh: ${fresh})...`)
  const transcripts = await fetchFirefliesTranscripts(limit)
  console.log(`[speaker-trainer] Got ${transcripts.length} transcripts`)

  // Collect all speakers and their meeting segments
  const speakerMeetings: Map<string, Array<{
    meetingId: string
    audioUrl: string | null
    segments: Array<{ start: number; end: number }>
  }>> = new Map()

  for (const transcript of transcripts) {
    if (!fresh && progress.processedMeetings.includes(transcript.id)) continue
    if (!transcript.audio_url) continue
    if (!transcript.sentences?.length) continue

    const speakers = new Set<string>()
    for (const s of transcript.sentences) {
      const normalized = normalizeSpeakerName(s.speaker_name)
      if (normalized) speakers.add(normalized)
    }

    for (const speaker of speakers) {
      if (speakerNames && !speakerNames.some(n =>
        speaker.toLowerCase().includes(n.toLowerCase()) ||
        n.toLowerCase().includes(speaker.toLowerCase())
      )) continue

      const monologues = findMonologues(transcript.sentences, speaker, minSegmentDuration)
      if (monologues.length === 0) continue

      if (!speakerMeetings.has(speaker)) {
        speakerMeetings.set(speaker, [])
      }
      speakerMeetings.get(speaker)!.push({
        meetingId: transcript.id,
        audioUrl: transcript.audio_url,
        segments: monologues,
      })
    }
  }

  console.log(`[speaker-trainer] Found ${speakerMeetings.size} speakers with monologue segments`)

  // For deep training: collect ALL embeddings per speaker, then select diverse set
  for (const [speaker, meetings] of speakerMeetings) {
    const totalSegments = meetings.reduce((sum, m) => sum + m.segments.length, 0)
    const uniqueMeetings = new Set(meetings.map(m => m.meetingId)).size

    if (totalSegments < minSegments) {
      console.log(`[speaker-trainer] Skipping ${speaker}: ${totalSegments} segments (need ${minSegments}+)`)
      continue
    }

    console.log(`[speaker-trainer] Processing ${speaker}: ${totalSegments} segments in ${uniqueMeetings} meetings`)
    report.speakersProcessed++

    // Phase 1: Extract ALL candidate embeddings from diverse meetings
    const candidateEmbeddings: Float32Array[] = []
    const meetingIds = new Set<string>()

    // Spread across meetings for acoustic diversity — take 3 segments per meeting max
    for (const meeting of meetings.slice(0, 20)) {
      if (!meeting.audioUrl) continue

      let mp3Path: string
      try {
        mp3Path = await downloadAudio(meeting.audioUrl, meeting.meetingId)
      } catch (err: any) {
        report.errors.push(`Download failed for ${meeting.meetingId}: ${err.message}`)
        continue
      }

      // Take up to 3 segments per meeting (spread across the recording)
      const segs = meeting.segments
      const selectedSegs = segs.length <= 3 ? segs : [
        segs[0],
        segs[Math.floor(segs.length / 2)],
        segs[segs.length - 1],
      ]

      for (const seg of selectedSegs) {
        const wavPath = resolve(CACHE_DIR, `${meeting.meetingId}_${speaker.replace(/\s+/g, '_')}_${Math.round(seg.start)}.wav`)

        if (!extractSegment(mp3Path, seg.start, seg.end, wavPath)) {
          continue
        }

        const wavBuffer = readFileSync(wavPath)
        if (wavBuffer.length < 1000) {
          try { unlinkSync(wavPath) } catch {}
          continue
        }

        // Extract raw embedding (don't enroll yet)
        const embedding = extractEmbedding(wavBuffer)
        if (embedding) {
          candidateEmbeddings.push(embedding)
          meetingIds.add(meeting.meetingId)
          report.segmentsExtracted++
        }

        try { unlinkSync(wavPath) } catch {}
      }

      // Clean up MP3
      try { unlinkSync(mp3Path) } catch {}

      if (!progress.processedMeetings.includes(meeting.meetingId)) {
        progress.processedMeetings.push(meeting.meetingId)
      }
    }

    console.log(`[speaker-trainer] ${speaker}: ${candidateEmbeddings.length} candidate embeddings from ${meetingIds.size} meetings`)

    if (candidateEmbeddings.length === 0) {
      report.speakers.push({ name: speaker, segments: 0, enrolled: false, embeddings: 0 })
      continue
    }

    // Phase 2: Select most diverse embeddings via greedy algorithm
    const diverse = selectDiverseEmbeddings(candidateEmbeddings, maxEmbeddingsPerSpeaker)
    console.log(`[speaker-trainer] ${speaker}: selected ${diverse.length} most diverse embeddings`)

    // Phase 3: Enroll the diverse set (skip dedup — diversity selector already handled it)
    let enrolled = 0
    for (const embedding of diverse) {
      const result = enrollEmbedding(speaker, embedding, 'fireflies', true)
      if (result.success) {
        enrolled++
        report.enrollmentsAdded++
      } else if (result.error?.includes('Too similar')) {
        report.skippedDuplicate++
      } else {
        report.errors.push(`${speaker}: ${result.error}`)
      }
    }

    report.speakers.push({ name: speaker, segments: candidateEmbeddings.length, enrolled: enrolled > 0, embeddings: enrolled })
    progress.speakerSegmentCounts[speaker] = enrolled

    console.log(`[speaker-trainer] ${speaker}: enrolled ${enrolled}/${diverse.length} diverse embeddings`)
  }

  progress.lastRunAt = new Date().toISOString()
  saveProgress(progress)

  console.log(`[speaker-trainer] Done: ${report.enrollmentsAdded} enrollments, ${report.skippedDuplicate} duplicates, ${report.errors.length} errors`)

  return report
}

/** Get current training status */
export async function getTrainingStatus(): Promise<TrainingStatus> {
  const progress = loadProgress()
  const enrolledNames = getAllSpeakerNames()

  const speakers: TrainingStatus['speakers'] = []

  for (const [name, count] of Object.entries(progress.speakerSegmentCounts)) {
    speakers.push({
      name,
      segments: count,
      meetings: 0,
      enrolled: enrolledNames.includes(name),
    })
  }

  for (const name of enrolledNames) {
    if (!speakers.some(s => s.name === name)) {
      speakers.push({ name, segments: 0, meetings: 0, enrolled: true })
    }
  }

  return {
    speakers,
    lastTrainedAt: progress.lastRunAt || null,
  }
}
