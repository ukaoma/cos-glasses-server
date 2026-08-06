// Speaker embedding extraction and verification using sherpa-onnx
// Wraps ECAPA-TDNN model for voiceprint-based speaker classification.
// Falls back gracefully if model is missing — amplitude classification continues.
//
// Phase 1: Auto-enrollment — high-confidence matches add G2-mic embeddings
// Phase 4: Calendar priming — scoped search to expected meeting attendees

import { resolve } from 'node:path'
import { errMsg } from './utils.js'
import { getOwnerSpeakerLabel } from './profile.js'
import { existsSync, appendFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import {
  appendEmbedding,
  deleteProfileFromStore,
  describeRepairs,
  dropOldestEmbedding,
  hasRepairs,
  loadVoiceProfileStore,
  modalDimension,
  removeEmbeddingsBySource,
  saveVoiceProfileStore,
  type ProfileStore,
  type VoiceProfile,
} from './voice-profile-store.js'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** A real voiceprint model is ~26 MB; anything this small is a bad download. */
const MIN_MODEL_BYTES = 1_000_000
const PROBE_TIMEOUT_MS = 30_000

// sherpa-onnx-node is CJS — use createRequire for ESM compat
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const __dirname = fileURLToPath(new URL('.', import.meta.url))

import { DATA_DIR } from './data-dir.js'

export const SPEAKER_MODEL_FILENAME = '3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx'

/** Where the voiceprint model may live, in priority order:
 *
 *  1. COS_SPEAKER_MODEL_PATH — explicit override (full path to the .onnx).
 *  2. ~/.cos-glasses/models/ — the bolt-on location. The model is ~26 MB and is
 *     deliberately NOT in the npm tarball, so a managed install has no bundled
 *     copy. The data home survives generation swaps; anything inside the
 *     installed package does not, and a model dropped there is destroyed by the
 *     next update.
 *  3. server/models/         — bundled, which only exists in a source checkout.
 *
 *  Anchored on homedir() rather than DATA_DIR/'..' on purpose: path.resolve is
 *  purely lexical, so deriving a sibling of a relocated COS_DATA_DIR could point
 *  the "durable" candidate at an unwritable root, or — if COS_DATA_DIR were ever
 *  set inside the package — collapse it back onto the very directory an update
 *  destroys, silently reintroducing the bug this ordering exists to fix.
 *
 *  Diarization is opt-in by design: with no model the system stays on amplitude
 *  fallback (wearer vs Ext) rather than failing. speakerModelState() exists so
 *  that choice is VISIBLE in /api/health instead of silently degrading.
 */
export function speakerModelCandidates(): string[] {
  const override = process.env.COS_SPEAKER_MODEL_PATH?.trim()
  return [
    ...(override ? [resolve(override)] : []),
    resolve(homedir(), '.cos-glasses', 'models', SPEAKER_MODEL_FILENAME),
    resolve(__dirname, '..', 'models', SPEAKER_MODEL_FILENAME),
  ]
}

function resolveSpeakerModelPath(): string | null {
  // isFile, not existsSync: a directory passes an existence check and would be
  // handed to the native loader as a model.
  return speakerModelCandidates().find(p => {
    try { return statSync(p).isFile() } catch { return false }
  }) ?? null
}

const PROFILES_PATH = resolve(DATA_DIR, 'voice-profiles.json')
const CALIBRATION_LOG = resolve(DATA_DIR, 'speaker-calibration.jsonl')

// Thresholds
const VERIFY_THRESHOLD = 0.65
const SEARCH_THRESHOLD = 0.55
const AUTO_ENROLL_THRESHOLD = 0.88    // High bar — must be very confident before auto-enrolling
const AUTO_ENROLL_CONSENSUS = 2       // Must match N times in same session before enrolling
const MAX_EMBEDDINGS_PER_SPEAKER = 20 // FIFO cap — oldest drops when full
const SAMPLE_RATE = 16000

// Module-level state — sherpa-onnx-node is CJS with no TS types (SDK v0.0.7 interop)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let manager: any = null
let initialized = false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sherpaOnnx: any = null

// In-memory profile store cache — avoids re-reading 7MB+ JSON on every audio chunk
let _cachedProfileStore: ProfileStore | null = null

// Auto-enrollment session tracking: sessionId → { speakerName → matchCount }
const autoEnrollSessions = new Map<string, Map<string, number>>()
// Track which speakers already auto-enrolled this session
const autoEnrolledThisSession = new Map<string, Set<string>>()

// Shape, durability, and integrity repair all live in voice-profile-store.ts.
// Re-exported because the review surfaces (/speakers, delete-person, coherence
// audit) need the types and were previously blocked on them being file-private.
export type { ProfileStore, VoiceProfile }

/** Cheap structural screen for a downloaded model.
 *
 *  Catches the common bad downloads — an HTML error/redirect page saved as
 *  .onnx, or a truncated transfer — before the file reaches the native runtime.
 *  ONNX is protobuf: field 1 (ir_version, varint) encodes as a leading 0x08.
 *  This is a screen, not validation; probeModelSafely() is the real gate. */
function looksLikeOnnxModel(path: string): boolean {
  try {
    if (statSync(path).size < MIN_MODEL_BYTES) return false
    const head = Buffer.alloc(1)
    const fd = openSync(path, 'r')
    try { readSync(fd, head, 0, 1, 0) } finally { closeSync(fd) }
    return head[0] === 0x08
  } catch { return false }
}

/** Load the model in a throwaway child process first.
 *
 *  onnxruntime does not throw on a malformed or mismatched model — it calls
 *  std::terminate, so the process dies with SIGABRT (or SIGSEGV for a valid-but-
 *  wrong model). No try/catch can intercept that. In a managed install the
 *  LaunchAgent has KeepAlive, so the death becomes a permanent restart loop that
 *  takes down queries, meetings, and transcription — the whole server, over an
 *  optional feature.
 *
 *  Absorbing that crash in a child keeps a bad file a diarization problem
 *  instead of an outage. Cost is one short-lived process, once, and only when a
 *  model is actually present. */
function probeModelSafely(modelPath: string): { ok: true } | { ok: false; reason: string } {
  const script =
    "const{SpeakerEmbeddingExtractor}=require('sherpa-onnx-node');" +
    "new SpeakerEmbeddingExtractor({model:process.argv[1],numThreads:1,provider:'cpu'});"
  const probe = spawnSync(process.execPath, ['-e', script, modelPath], {
    cwd: resolve(__dirname, '..', '..'), // package root, so sherpa-onnx-node resolves
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  if (probe.signal) return { ok: false, reason: `native runtime aborted (${probe.signal})` }
  if (probe.error) return { ok: false, reason: probe.error.message }
  if (probe.status !== 0) {
    const stderr = String(probe.stderr ?? '').trim().split('\n').pop() ?? ''
    return { ok: false, reason: stderr || `probe exited ${probe.status}` }
  }
  return { ok: true }
}

/** Initialize speaker embedding system. Returns false if model missing (graceful degradation). */
export function initSpeakerEmbeddings(): boolean {
  if (initialized) return extractor !== null

  initialized = true

  const override = process.env.COS_SPEAKER_MODEL_PATH?.trim()
  if (override) {
    const overridePath = resolve(override)
    let usable = false
    try { usable = statSync(overridePath).isFile() } catch { usable = false }
    if (!usable) {
      // Falling through silently would leave the operator believing an override
      // they mistyped (or pointed at a directory) is in effect.
      console.warn(
        `[speaker] COS_SPEAKER_MODEL_PATH=${overridePath} is not a readable file — ignoring it`,
        'and falling back to the remaining candidates.',
      )
    }
    if (override !== overridePath) {
      // Relative paths resolve against cwd, which under launchd is the installed
      // package — a location the next update deletes.
      console.warn(
        `[speaker] COS_SPEAKER_MODEL_PATH is relative; resolved against the working directory to ${overridePath}.`,
        'Use an absolute path so it cannot move with the process.',
      )
    }
  }

  const modelPath = resolveSpeakerModelPath()
  if (!modelPath) {
    const boltOn = resolve(homedir(), '.cos-glasses', 'models')
    console.log(
      '[speaker] Voiceprint model not found — embedding disabled, speaker labels come from the client.',
      `Searched: ${speakerModelCandidates().join(', ')}.`,
      // Name the durable directory outright. An ordinal ("the second path")
      // shifts with the override and pointed users at the package copy, which
      // the next update deletes.
      `To enable diarization put ${SPEAKER_MODEL_FILENAME} in ${boltOn}/ and restart.`,
    )
    return false
  }

  if (!looksLikeOnnxModel(modelPath)) {
    console.error(
      `[speaker] ${modelPath} does not look like an ONNX model (too small, or not protobuf) —`,
      'embedding disabled. A partial download or an HTML error page saved as .onnx does this.',
    )
    return false
  }

  const probe = probeModelSafely(modelPath)
  if (!probe.ok) {
    console.error(
      `[speaker] ${modelPath} failed to load — embedding disabled. Reason: ${probe.reason}.`,
      'The server is otherwise unaffected; replace the model file and restart.',
    )
    return false
  }

  try {
    sherpaOnnx = require('sherpa-onnx-node')

    extractor = new sherpaOnnx.SpeakerEmbeddingExtractor({
      model: modelPath,
      numThreads: 2,
      provider: 'cpu',
    })

    manager = new sherpaOnnx.SpeakerEmbeddingManager(extractor.dim)
    console.log(`[speaker] Initialized: ${extractor.dim}-dim embeddings`)

    // Ensure data directory exists
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true })
    }

    // Load persisted profiles
    loadProfiles()

    return true
  } catch (err: unknown) {
    console.error('[speaker] Init failed:', errMsg(err))
    extractor = null
    manager = null
    return false
  }
}

/** Check if a speaker is enrolled */
export function isEnrolled(name: string): boolean {
  if (!manager) return false
  return manager.contains(name)
}

/** Get all enrolled speaker names */
export function getAllSpeakerNames(): string[] {
  if (!manager) return []
  return manager.getAllSpeakerNames()
}

/** Enroll a speaker from WAV audio buffer */
export function enrollSpeaker(name: string, wavBuffer: Buffer): { success: boolean; dim: number; error?: string } {
  if (!extractor || !manager) {
    return { success: false, dim: 0, error: 'Speaker embeddings not initialized' }
  }

  try {
    const embedding = extractEmbeddingFromWav(wavBuffer)
    if (!embedding) {
      return { success: false, dim: 0, error: 'Could not extract embedding — audio too short or silent' }
    }

    return enrollEmbedding(name, embedding, 'manual')
  } catch (err: unknown) {
    console.error('[speaker] Enrollment error:', errMsg(err))
    return { success: false, dim: 0, error: errMsg(err) }
  }
}

/** Enroll a raw embedding directly (used by trainer and auto-enroll).
 *  skipDedupCheck: when true, bypass the 0.95 similarity dedup gate.
 *  The trainer's greedy diversity selector already ensures embeddings are diverse,
 *  so the dedup gate is redundant and too restrictive for batch training
 *  (Fireflies audio conditions are uniform enough that even "most diverse"
 *  embeddings can exceed 0.95 similarity). */
export function enrollEmbedding(name: string, embedding: Float32Array, source: string = 'manual', skipDedupCheck: boolean = false): { success: boolean; dim: number; error?: string } {
  if (!extractor || !manager) {
    return { success: false, dim: 0, error: 'Speaker embeddings not initialized' }
  }

  // Check diversity: skip if too similar to an existing embedding for this speaker
  const store = loadProfileStore()
  const profile = store.profiles.find(p => p.name === name)
  if (profile) {
    // Dedup check: skip if too similar to existing (unless bypassed by trainer)
    if (!skipDedupCheck) {
      for (const existing of profile.embeddings) {
        const sim = rawCosineSimilarity(embedding, new Float32Array(existing))
        if (sim > 0.95) {
          return { success: false, dim: extractor.dim, error: 'Too similar to existing embedding (>0.95)' }
        }
      }
    }

    // FIFO cap: if at max, drop oldest before adding (always enforced).
    // dropOldestEmbedding keeps sources[] in lockstep — the old inline
    // `sources?.shift()` no-opped whenever sources was undefined or short,
    // permanently offsetting provenance from the samples it described.
    if (profile.embeddings.length >= MAX_EMBEDDINGS_PER_SPEAKER) {
      console.log(`[speaker] Profile cap reached for "${name}" (${profile.embeddings.length}/${MAX_EMBEDDINGS_PER_SPEAKER}) — dropping oldest`)
      dropOldestEmbedding(profile)
      rebuildSpeakerInManager(name, profile.embeddings)
    }
  }

  // Add to manager — if manager rejects (internal dedup), force via remove+readd
  let added = manager.add({ name, v: embedding })
  if (!added) {
    // Manager's internal dedup rejected it — force-add by rebuilding
    // Persist first so we have the complete embedding list
    persistProfile(name, embedding, source)
    const updatedStore = loadProfileStore()
    const updatedProfile = updatedStore.profiles.find(p => p.name === name)
    if (updatedProfile) {
      rebuildSpeakerInManager(name, updatedProfile.embeddings)
      console.log(`[speaker] Force-enrolled "${name}" via rebuild (${updatedProfile.embeddings.length} total, source: ${source})`)
      return { success: true, dim: extractor.dim }
    }
    return { success: false, dim: extractor.dim, error: 'Manager rejected and rebuild failed' }
  }

  // Persist to disk with provenance
  persistProfile(name, embedding, source)

  console.log(`[speaker] Enrolled "${name}" (${extractor.dim}-dim, source: ${source})`)
  return { success: true, dim: extractor.dim }
}

/** Identify speaker from WAV audio buffer.
 *  Phase 4: optionally scope search to expected attendees for fewer false positives. */
export function identifySpeaker(
  wavBuffer: Buffer,
  expectedSpeakers?: string[],
): { speaker: string; similarity: number } | null {
  if (!extractor || !manager) return null

  try {
    const embedding = extractEmbeddingFromWav(wavBuffer)
    if (!embedding) return null

    // If the wearer is enrolled, verify against them first (they're wearing the glasses)
    const owner = getOwnerSpeakerLabel()
    if (manager.contains(owner)) {
      const isOwner = manager.verify({ name: owner, v: embedding, threshold: VERIFY_THRESHOLD })
      if (isOwner) {
        const similarity = computeCosineSimilarity(embedding, owner)
        logCalibration(owner, similarity, true)
        return { speaker: owner, similarity }
      }
    }

    // Phase 4: scoped search — try expected attendees first
    if (expectedSpeakers && expectedSpeakers.length > 0) {
      for (const name of expectedSpeakers) {
        if (name === owner) continue // wearer already checked
        if (!manager.contains(name)) continue
        const matches = manager.verify({ name, v: embedding, threshold: SEARCH_THRESHOLD })
        if (matches) {
          const similarity = computeCosineSimilarity(embedding, name)
          logCalibration(name, similarity, true)
          return { speaker: name, similarity }
        }
      }
    }

    // Full search across all speakers (fallback or no expected speakers)
    const found = manager.search({ v: embedding, threshold: SEARCH_THRESHOLD })
    if (found && found.length > 0) {
      const similarity = computeCosineSimilarity(embedding, found)
      logCalibration(found, similarity, true)
      return { speaker: found, similarity }
    }

    // No match — external speaker
    logCalibration('Ext', 0, false)
    return { speaker: 'Ext', similarity: 0 }
  } catch (err: unknown) {
    console.error('[speaker] Identification error:', errMsg(err))
    return null
  }
}

/** Auto-enroll from a high-confidence match during live meetings.
 *  Requires consensus: N matches above threshold in the same session before enrolling.
 *  Rate limited: max 1 auto-enrollment per speaker per session. */
export function autoEnroll(
  name: string,
  wavBuffer: Buffer,
  similarity: number,
  sessionId: string,
): { enrolled: boolean; reason: string } {
  if (!extractor || !manager) return { enrolled: false, reason: 'not initialized' }
  if (name === getOwnerSpeakerLabel() || name === 'Ext') return { enrolled: false, reason: 'skip owner/Ext' }
  if (similarity < AUTO_ENROLL_THRESHOLD) return { enrolled: false, reason: `similarity ${similarity.toFixed(3)} < ${AUTO_ENROLL_THRESHOLD}` }

  // Check if already auto-enrolled this session
  if (!autoEnrolledThisSession.has(sessionId)) {
    autoEnrolledThisSession.set(sessionId, new Set())
  }
  if (autoEnrolledThisSession.get(sessionId)!.has(name)) {
    return { enrolled: false, reason: 'already enrolled this session' }
  }

  // Consensus gate: track match count per speaker per session
  if (!autoEnrollSessions.has(sessionId)) {
    autoEnrollSessions.set(sessionId, new Map())
  }
  const sessionCounts = autoEnrollSessions.get(sessionId)!
  const count = (sessionCounts.get(name) ?? 0) + 1
  sessionCounts.set(name, count)

  if (count < AUTO_ENROLL_CONSENSUS) {
    return { enrolled: false, reason: `consensus ${count}/${AUTO_ENROLL_CONSENSUS}` }
  }

  // Extract embedding and enroll
  const embedding = extractEmbeddingFromWav(wavBuffer)
  if (!embedding) return { enrolled: false, reason: 'extraction failed' }

  const result = enrollEmbedding(name, embedding, `auto:${sessionId}`)
  if (result.success) {
    autoEnrolledThisSession.get(sessionId)!.add(name)
    logCalibration(name, similarity, true, 'auto-enrolled')
    console.log(`[speaker] Auto-enrolled "${name}" (sim: ${similarity.toFixed(3)}, session: ${sessionId})`)
    return { enrolled: true, reason: 'success' }
  }

  return { enrolled: false, reason: result.error ?? 'enrollment failed' }
}

/** Clear auto-enrollment session state (call when meeting ends) */
export function clearAutoEnrollSession(sessionId: string): void {
  autoEnrollSessions.delete(sessionId)
  autoEnrolledThisSession.delete(sessionId)
}

/** Clear all embeddings for a speaker (used by fresh training mode) */
export function clearSpeakerEmbeddings(name: string): boolean {
  const store = loadProfileStore()
  const profile = store.profiles.find(p => p.name === name)
  if (!profile || profile.embeddings.length === 0) return false

  console.log(`[speaker] Clearing ${profile.embeddings.length} embeddings for "${name}"`)
  profile.embeddings = []
  profile.sources = []

  // Remove from manager
  if (manager && manager.contains(name)) {
    try { manager.remove(name) } catch { /* ignore */ }
  }

  // Persist. A "fresh training" clear legitimately empties one profile but must
  // never be able to empty the whole store, so allowEmpty stays off here.
  return writeProfileStore(store)
}

/** Remove a person entirely: profile, embeddings, and manager registration.
 *  Returns counts so a caller can report what was actually removed. */
export function removeSpeakerProfile(name: string): { removedProfiles: number; removedEmbeddings: number } {
  const store = loadProfileStore()
  const result = deleteProfileFromStore(store, name)
  if (result.removedProfiles === 0) return result

  if (manager && manager.contains(name)) {
    try { manager.remove(name) } catch { /* the on-disk removal is the durable half */ }
  }
  // allowEmpty: deleting the only enrolled person is a legitimate reset, and the
  // caller has already confirmed it explicitly.
  writeProfileStore(store, { allowEmpty: true })
  return result
}

/** Retract samples by provenance — e.g. every `auto:<sessionId>` embedding a
 *  bad session wrote into the wrong profile. `clearSpeakerEmbeddings` is
 *  all-or-nothing and would discard the legitimate training alongside it. */
export function retractEmbeddingsBySource(
  name: string,
  matches: (source: string) => boolean,
): { removed: number; remaining: number } {
  const store = loadProfileStore()
  const profile = store.profiles.find(p => p.name === name)
  if (!profile) return { removed: 0, remaining: 0 }

  const removed = removeEmbeddingsBySource(profile, matches)
  if (removed === 0) return { removed: 0, remaining: profile.embeddings.length }

  rebuildSpeakerInManager(name, profile.embeddings)
  writeProfileStore(store, { allowEmpty: true })
  return { removed, remaining: profile.embeddings.length }
}

/** Get embedding count for a speaker */
export function getEmbeddingCount(name: string): number {
  const store = loadProfileStore()
  const profile = store.profiles.find(p => p.name === name)
  return profile?.embeddings.length ?? 0
}

/** Extract raw embedding from WAV buffer */
export function extractEmbedding(wavBuffer: Buffer): Float32Array | null {
  return extractEmbeddingFromWav(wavBuffer)
}

/** Check if the embedding system is available */
export function isEmbeddingAvailable(): boolean {
  return extractor !== null && manager !== null
}

/** Reported on /api/health so an amplitude fallback is never mistaken for real
 *  diarization.
 *
 *  `state` is the RUNTIME truth (isEmbeddingAvailable), not "is a model file on
 *  disk". Those diverge in both directions: a model deleted after a successful
 *  load leaves diarization working from memory, and a model present alongside a
 *  broken/ABI-mismatched sherpa-onnx never loads at all. `error` distinguishes
 *  that second case — a model is installed but the runtime rejected it — from a
 *  simply unconfigured install, which otherwise look identical to an operator.
 *
 *  Declared after the module state it reads: hoisting it above `extractor`
 *  would make any import-time caller throw a ReferenceError on an
 *  unauthenticated endpoint. */
export function speakerModelState(): {
  state: 'active' | 'unavailable' | 'error'
  path: string | null
  searched: string[]
} {
  const path = resolveSpeakerModelPath()
  const running = isEmbeddingAvailable()
  const state = running ? 'active' : (path && initialized ? 'error' : 'unavailable')
  return { state, path, searched: speakerModelCandidates() }
}

/** Compute actual cosine similarity between two raw embedding vectors */
export function rawCosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom > 0 ? dot / denom : 0
}

// ── Internal helpers ───────────────────────────────────────────

function extractEmbeddingFromWav(wavBuffer: Buffer): Float32Array | null {
  if (!extractor) return null

  try {
    // Parse WAV header to get to PCM data
    const samples = wavBufferToFloat32(wavBuffer)
    if (!samples || samples.length < SAMPLE_RATE * 0.5) {
      // Need at least 0.5s of audio
      return null
    }

    const stream = extractor.createStream()
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
    stream.inputFinished()

    if (!extractor.isReady(stream)) {
      return null
    }

    return extractor.compute(stream)
  } catch (err: unknown) {
    console.error('[speaker] Embedding extraction error:', errMsg(err))
    return null
  }
}

/** Convert WAV buffer (16-bit PCM) to Float32Array normalized to [-1, 1] */
function wavBufferToFloat32(wavBuffer: Buffer): Float32Array | null {
  // WAV header is 44 bytes for standard PCM
  if (wavBuffer.length < 44) return null

  // Verify RIFF header
  const riff = wavBuffer.toString('ascii', 0, 4)
  if (riff !== 'RIFF') return null

  // Find data chunk offset — standard WAV has data at offset 44,
  // but some encoders add extra chunks. Search for 'data' marker.
  let dataOffset = 12
  while (dataOffset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString('ascii', dataOffset, dataOffset + 4)
    const chunkSize = wavBuffer.readUInt32LE(dataOffset + 4)
    if (chunkId === 'data') {
      dataOffset += 8
      break
    }
    dataOffset += 8 + chunkSize
  }

  if (dataOffset >= wavBuffer.length) return null

  const pcmData = wavBuffer.subarray(dataOffset)
  const numSamples = Math.floor(pcmData.length / 2)
  const float32 = new Float32Array(numSamples)

  for (let i = 0; i < numSamples; i++) {
    const sample = pcmData.readInt16LE(i * 2)
    float32[i] = sample / 32768.0
  }

  return float32
}

/** Compute cosine similarity between an embedding and a stored speaker (approximate via binary search) */
function computeCosineSimilarity(_embedding: Float32Array, _name: string): number {
  // The sherpa-onnx manager doesn't expose raw stored embeddings,
  // so we use verify with decreasing thresholds to estimate similarity
  if (!manager) return 0

  // Binary search for similarity threshold
  let lo = 0, hi = 1
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2
    const matches = manager.verify({ name: _name, v: _embedding, threshold: mid })
    if (matches) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return (lo + hi) / 2
}

/** Log calibration data for threshold tuning */
function logCalibration(speaker: string, similarity: number, matched: boolean, event?: string): void {
  try {
    const entry: Record<string, string | number | boolean> = {
      ts: new Date().toISOString(),
      speaker,
      similarity: Math.round(similarity * 1000) / 1000,
      matched,
    }
    if (event) entry.event = event
    appendFileSync(CALIBRATION_LOG, JSON.stringify(entry) + '\n')
  } catch { /* non-critical */ }
}

/** Load profile store from disk (cached in memory, invalidated on write).
 *
 *  Previously a bare `JSON.parse(readFileSync(...))`: a truncated file threw out
 *  of every caller, including the live enrollment path, and there was no backup
 *  to fall back to. Corruption and integrity repairs are now both reported —
 *  silently returning `{profiles: []}` is the one outcome that must never pass
 *  unremarked, because the next save would commit it over the real store. */
function loadProfileStore(): ProfileStore {
  if (_cachedProfileStore) return _cachedProfileStore

  const load = loadVoiceProfileStore(PROFILES_PATH)

  if (load.status === 'corrupt') {
    if (load.recoveredFromBackup) {
      console.error(
        `[speaker] voice-profiles.json was corrupt (quarantined as ${load.quarantinedAs}) —`,
        `recovered ${load.store.profiles.length} profile(s) from ${load.recoveredFromBackup}.`,
      )
      // Republish the recovered content so the next boot reads a clean file
      // rather than repeating the recovery. The corrupt original is retained at
      // the quarantine path for inspection.
      try {
        saveVoiceProfileStore(PROFILES_PATH, load.store)
      } catch (err: unknown) {
        console.error('[speaker] Failed to republish recovered profiles:', errMsg(err))
      }
    } else {
      console.error(
        `[speaker] voice-profiles.json was corrupt and NO usable backup exists.`,
        `The unreadable file is retained at ${load.quarantinedAs}.`,
        'Diarization is starting with zero profiles; writes will not overwrite a populated store.',
      )
    }
  }

  if (hasRepairs(load.repairs)) {
    console.warn(`[speaker] Repaired voice-profiles.json on load: ${describeRepairs(load.repairs)}`)
  }

  _cachedProfileStore = load.store
  return _cachedProfileStore
}

/** Read-only view of the persisted profiles, for review/audit surfaces.
 *  Returns a structural copy so a caller cannot mutate the shared cache. */
export function readVoiceProfiles(): ProfileStore {
  const store = loadProfileStore()
  return { profiles: store.profiles.map(p => ({ ...p, embeddings: p.embeddings, sources: [...(p.sources ?? [])] })) }
}

/** Persist the shared store, reporting a refusal rather than swallowing it. */
function writeProfileStore(store: ProfileStore, options: { allowEmpty?: boolean } = {}): boolean {
  const result = saveVoiceProfileStore(PROFILES_PATH, store, options)
  if (!result.written) {
    console.error(`[speaker] Profile store write refused: ${result.refusedReason}`)
    return false
  }
  if (result.backup) console.log(`[speaker] Profile store backed up to ${result.backup}`)
  invalidateProfileCache()
  return true
}

/** Invalidate the in-memory profile store cache (call after any write to PROFILES_PATH) */
function invalidateProfileCache(): void {
  _cachedProfileStore = null
}

/** Persist a speaker profile to disk with provenance tracking */
function persistProfile(name: string, embedding: Float32Array, source: string = 'manual'): void {
  try {
    const store = loadProfileStore()

    let profile = store.profiles.find(p => p.name === name)
    if (!profile) {
      profile = { name, embeddings: [], sources: [] }
      store.profiles.push(profile)
    }
    appendEmbedding(profile, Array.from(embedding), source)

    writeProfileStore(store)
  } catch (err: unknown) {
    console.error('[speaker] Profile persist error:', errMsg(err))
  }
}

/** Compute centroid (average) of multiple embeddings.
 *  The centroid captures the speaker's average voice across different acoustic
 *  conditions (meetings, mics, energy levels). More robust than any single embedding. */
export function computeCentroid(embeddings: number[][]): Float32Array {
  // Dimension-safe: one wrong-length row used to read `undefined` past its end
  // and turn EVERY component of the averaged vector into NaN, which sherpa then
  // registers as the speaker's only representative vector. Skip mismatches
  // instead, and take the modal dimension so a corrupt row 0 cannot define it.
  const dim = modalDimension(embeddings)
  const centroid = new Float32Array(dim)
  if (dim === 0) return centroid
  const usable = embeddings.filter(emb => emb.length === dim)
  if (usable.length === 0) return centroid
  for (const emb of usable) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += emb[i]
    }
  }
  // Average
  for (let i = 0; i < dim; i++) {
    centroid[i] /= usable.length
  }
  // L2 normalize (important for cosine similarity)
  let norm = 0
  for (let i = 0; i < dim; i++) norm += centroid[i] * centroid[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < dim; i++) centroid[i] /= norm
  }
  return centroid
}

/** Rebuild a speaker in the manager using the centroid of all stored embeddings.
 *  The sherpa-onnx manager only supports 1 embedding per speaker name —
 *  add() returns false for duplicates. So we compute a centroid from all
 *  diverse embeddings and register that single representative vector. */
function rebuildSpeakerInManager(name: string, embeddings: number[][]): void {
  if (!manager) return
  try {
    // Remove existing entry
    if (manager.contains(name)) {
      manager.remove(name)
    }
    if (embeddings.length === 0) return

    // Register centroid of all embeddings
    const centroid = computeCentroid(embeddings)
    const added = manager.add({ name, v: centroid })
    if (added) {
      console.log(`[speaker] Registered centroid for "${name}" (${embeddings.length} source embeddings)`)
    } else {
      console.error(`[speaker] Failed to register centroid for "${name}"`)
    }
  } catch (err: unknown) {
    console.error(`[speaker] Rebuild failed for "${name}":`, errMsg(err))
  }
}

/** Save full profile store to disk (used by trainer for bulk updates) */
export function saveProfileStore(store: ProfileStore): void {
  writeProfileStore(store)
}

/** Rebuild all profiles in manager from a store (used after bulk training) */
export function rebuildAllProfiles(store: ProfileStore): void {
  if (!manager) return
  // Clear manager completely
  for (const name of getAllSpeakerNames()) {
    try { manager.remove(name) } catch { /* ignore */ }
  }
  // Re-add using centroids
  let loaded = 0
  for (const profile of store.profiles) {
    if (profile.embeddings.length === 0) continue
    rebuildSpeakerInManager(profile.name, profile.embeddings)
    loaded++
  }
  console.log(`[speaker] Rebuilt manager: ${loaded} speakers (centroid mode)`)
}

/** Load persisted profiles into manager.
 *
 *  Goes through loadProfileStore() rather than re-reading the file: a second
 *  independent `JSON.parse` here meant boot and the enrollment path could
 *  disagree about the store's contents, and it bypassed both the corrupt-file
 *  recovery and the integrity repairs. */
function loadProfiles(): void {
  if (!manager) return

  try {
    const store = loadProfileStore()
    let loaded = 0

    for (const profile of store.profiles) {
      if (profile.embeddings.length === 0) continue
      // Register centroid — manager only supports 1 embedding per speaker
      rebuildSpeakerInManager(profile.name, profile.embeddings)
      loaded++
    }

    if (loaded > 0) {
      const names = manager.getAllSpeakerNames()
      console.log(`[speaker] Loaded ${loaded} speakers (centroid mode): ${names.join(', ')}`)
    }
  } catch (err: unknown) {
    console.error('[speaker] Profile load error:', errMsg(err))
  }
}
