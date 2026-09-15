#!/usr/bin/env tsx
/**
 * Reproduction gate for the meeting merge engine (6.47.0, WS3).
 *
 * The tier rules were measured in Python against Miles's own meetings before any of this
 * existed: 161 automatic merges, 21 suggestions and 16 refusals over the 198 G2 recordings
 * that already have a merge, and content spans within 27, 25, 42 and 42 s of his manual
 * split of the Aug 20 recording. This script runs the TypeScript engine over those same
 * inputs and reports whether it reproduces them. If it does not, the engine is wrong.
 *
 *   npx tsx server/scripts/engine-canary.ts [--inputs <dir>] [--samples <dir>]
 *
 * It imports ONLY `server/lib/meeting-engine/*`, reads its inputs from explicit paths, and
 * prints counts, seconds and booleans — never a title, name, email or line of transcript.
 * The rendered samples are for Miles to open himself; their paths are printed, never their
 * contents.
 *
 * Excluded from the npm package by `"!server/scripts/engine-canary.ts"` in package.json.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FirefliesMeetingInput, G2RecordingInput } from '../lib/meeting-engine/evidence.js'
import { type MergeTier, scoreRecording } from '../lib/meeting-engine/pairing.js'
import { contentSpanFor } from '../lib/meeting-engine/split.js'
import { renderMergedRecord } from '../lib/meeting-engine/render.js'

/** The gate: tier counts within this of the measured 161 / 21 / 16. */
const TIER_TOLERANCE = 2
const EXPECTED_TIERS: Record<MergeTier, number> = { auto_merge: 161, suggest: 21, none: 16 }
/** The gate: each Aug 20 content-span boundary within this of Miles's manual one. */
const BOUNDARY_TOLERANCE_S = 120
/** Auto merges rendered for review alongside the disputed pairs. */
const RANDOM_SAMPLE_COUNT = 3

interface ExportedSession {
  sessionId: string
  startMs: number
  durationMs: number
  sidecarPaths: string[]
  candidateFirefliesIds: string[]
  groundTruthFirefliesIds: string[]
  pythonReference: { tier: MergeTier; agreesWithExistingMerge: boolean | null; evidence: [number, string][]; cluster: string[]; secondK: number }
}

interface ExportedInputs {
  version: number
  sessions: ExportedSession[]
  pythonTierCounts: Record<string, number>
  aug20: {
    firefliesId: string
    startMs: number
    durationS: number
    groundTruthBoundariesMs: number[]
    overlappingG2: Array<{ sessionId: string; startMs: number; durationMs: number; sidecarPaths: string[] }>
  } | null
}

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** The sidecar with the most batch segments, matching how the measurement chose. */
function loadRecording(session: { sessionId: string; startMs: number; durationMs: number; sidecarPaths: string[] }): G2RecordingInput {
  let best: Record<string, unknown> | null = null
  for (const path of session.sidecarPaths) {
    let doc: Record<string, unknown>
    try {
      doc = readJson<Record<string, unknown>>(path)
    } catch {
      continue
    }
    const segments = Array.isArray(doc.batchSegments) ? doc.batchSegments.length : 0
    const bestSegments = best && Array.isArray(best.batchSegments) ? best.batchSegments.length : 0
    if (!best || segments > bestSegments) best = doc
  }
  return {
    sessionId: session.sessionId,
    startMs: session.startMs,
    durationMs: session.durationMs,
    chunks: (best?.chunks as G2RecordingInput['chunks']) ?? [],
    batchSegments: (best?.batchSegments as G2RecordingInput['batchSegments']) ?? [],
    correctionRevision: typeof best?.correctionRevision === 'number' ? best.correctionRevision : undefined,
    batchApplied: typeof best?.batchApplied === 'boolean' ? best.batchApplied : undefined,
    title: typeof best?.title === 'string' ? best.title : undefined,
  }
}

function main(): number {
  const inputsDir = argValue('--inputs', join(homedir(), '.cos-glasses', 'data', 'imports', '.engine-canary'))
  const samplesDir = argValue('--samples', '')
  const inputs = readJson<ExportedInputs>(join(inputsDir, 'inputs.json'))
  const list = readJson<Array<{ id: string; date: number; duration: number | null }>>(join(inputsDir, 'ff_list.json'))
  const sentenceCache = readJson<Record<string, { sentences: Array<{ text?: string; speaker_name?: string; start_time?: number; end_time?: number }> }>>(join(inputsDir, 'ff_sentences.json'))

  const meetings: FirefliesMeetingInput[] = list.map(row => ({
    id: row.id,
    startMs: Number(row.date),
    durationS: typeof row.duration === 'number' && row.duration > 0 ? row.duration * 60 : 0,
    sentences: sentenceCache[row.id]?.sentences ?? [],
  }))
  const meetingsById = new Map(meetings.map(meeting => [meeting.id, meeting]))

  const counts: Record<MergeTier, number> = { auto_merge: 0, suggest: 0, none: 0 }
  const agreement: Record<string, number> = {}
  let tierMismatches = 0
  let primaryMismatches = 0
  let candidateMismatches = 0
  let offsetRejections = 0
  const disputed: Array<{ session: ExportedSession; primary: string }> = []
  const agreed: Array<{ session: ExportedSession; primary: string }> = []

  const started = Date.now()
  for (const session of inputs.sessions) {
    const recording = loadRecording(session)
    const result = scoreRecording(recording, meetings)
    counts[result.tier] += 1
    offsetRejections += result.rejections.filter(r => r.reason === 'offset_outside_interval').length
    if (result.tier !== session.pythonReference.tier) tierMismatches += 1
    const pythonTop = session.pythonReference.evidence[0]?.[1] ?? null
    if (result.tier !== 'none' && pythonTop && !session.pythonReference.cluster.includes(result.primaryFirefliesId ?? '')) primaryMismatches += 1
    if (result.candidates.length !== session.candidateFirefliesIds.length) candidateMismatches += 1
    if (result.tier !== 'none' && result.primaryFirefliesId) {
      const truth = new Set(session.groundTruthFirefliesIds)
      const cluster = [result.primaryFirefliesId, ...result.duplicateFirefliesIds]
      const agrees = cluster.some(id => truth.has(id))
      agreement[`${result.tier}:${agrees ? 'agree' : 'differ'}`] = (agreement[`${result.tier}:${agrees ? 'agree' : 'differ'}`] ?? 0) + 1
      if (result.tier === 'auto_merge') (agrees ? agreed : disputed).push({ session, primary: result.primaryFirefliesId })
    }
  }

  const within = (Object.keys(EXPECTED_TIERS) as MergeTier[]).every(tier => Math.abs(counts[tier] - EXPECTED_TIERS[tier]) <= TIER_TOLERANCE)
  console.log(`sessions scored ${inputs.sessions.length} in ${Math.round((Date.now() - started) / 1000)} s`)
  console.log(`tiers: auto ${counts.auto_merge} (expected ${EXPECTED_TIERS.auto_merge}) · suggest ${counts.suggest} (${EXPECTED_TIERS.suggest}) · none ${counts.none} (${EXPECTED_TIERS.none}) · within ±${TIER_TOLERANCE}: ${within}`)
  console.log(`agreement with existing merges: ${JSON.stringify(agreement)}`)
  console.log(`parity with the Python reference: tier mismatches ${tierMismatches} · primary outside the Python cluster ${primaryMismatches} · candidate-count mismatches ${candidateMismatches} · candidates rejected for offset ${offsetRejections}`)

  let boundariesOk = false
  if (inputs.aug20) {
    const meeting = meetingsById.get(inputs.aug20.firefliesId)
    if (!meeting) {
      console.log('aug 20: recording not in the cached list · NOT RUN')
    } else {
      const boundaries: number[] = []
      let spans = 0
      for (const session of inputs.aug20.overlappingG2) {
        const span = contentSpanFor(loadRecording(session), meeting)
        if (!span) continue
        spans += 1
        boundaries.push(meeting.startMs + span.startS * 1000, meeting.startMs + span.endS * 1000)
      }
      const lastSpeech = meeting.sentences.reduce((max, s) => Math.max(max, Number(s.end_time ?? 0) || 0), 0)
      boundaries.push(meeting.startMs + lastSpeech * 1000)
      const distances = inputs.aug20.groundTruthBoundariesMs.map(truth =>
        Math.round(Math.min(...boundaries.map(b => Math.abs(b - truth))) / 1000))
      boundariesOk = distances.every(d => d <= BOUNDARY_TOLERANCE_S)
      console.log(`aug 20: captures with a content span ${spans} of ${inputs.aug20.overlappingG2.length} · boundary distances (s) ${JSON.stringify(distances)} · all within ${BOUNDARY_TOLERANCE_S} s: ${boundariesOk}`)
    }
  }

  if (samplesDir) {
    mkdirSync(samplesDir, { recursive: true, mode: 0o700 })
    const picks = [
      ...disputed.map(entry => ({ ...entry, label: 'disputed' })),
      ...agreed
        .slice()
        .sort((a, b) => (a.session.sessionId < b.session.sessionId ? -1 : 1))
        .filter((_, index) => index % Math.max(1, Math.floor(agreed.length / RANDOM_SAMPLE_COUNT)) === 0)
        .slice(0, RANDOM_SAMPLE_COUNT)
        .map(entry => ({ ...entry, label: 'auto' })),
    ]
    let written = 0
    for (const [index, pick] of picks.entries()) {
      const meeting = meetingsById.get(pick.primary)
      if (!meeting) continue
      const rendered = renderMergedRecord({
        actionId: `sample_${index + 1}`,
        tier: 'auto',
        primary: meeting,
        captures: [loadRecording(pick.session)],
        evidence: { k1: 0, k2: 0 },
      })
      if (!rendered.ok) continue
      // Numbered, not named after the session: G2 session ids share a long prefix, so a
      // truncated id gave every sample the same filename and nine renders left four files.
      const base = join(samplesDir, `${pick.label}_${String(index + 1).padStart(2, '0')}`)
      writeFileSync(`${base}.md`, rendered.record.markdown, { mode: 0o600 })
      writeFileSync(`${base}.derived.json`, JSON.stringify(rendered.record.sidecar, null, 2), { mode: 0o600 })
      written += 1
    }
    console.log(`samples written ${written} (${disputed.length} disputed, ${picks.length - disputed.length} automatic) into ${samplesDir}`)
  }

  const passed = within && (!inputs.aug20 || boundariesOk)
  console.log(`REPRODUCTION GATE: ${passed ? 'PASS' : 'FAIL'}`)
  return passed ? 0 : 1
}

process.exit(main())
