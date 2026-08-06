// Voice enrollment, status, and multi-speaker training endpoints

import { Router } from 'express'
import { errMsg } from '../lib/utils.js'
import { readdirSync, readFileSync, unlinkSync, existsSync, rmdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { enrollSpeaker, isEnrolled, getAllSpeakerNames, identifySpeaker, extractEmbedding, enrollEmbedding, rawCosineSimilarity, getEmbeddingCount, removeSpeakerProfile, readVoiceProfiles, mergeSpeakerProfiles } from '../lib/speaker-embeddings.js'
import { statSync } from 'node:fs'
import { trainFromFireflies, getTrainingStatus } from '../lib/speaker-trainer.js'
import { getOwnerSpeakerLabel } from '../lib/profile.js'
import { dataPath } from '../lib/data-dir.js'
import { purgeSpeakerCalibrationRows, relabelSpeakerCalibrationRows } from '../lib/speaker-calibration-log.js'
import { trainingSourceFor } from '../lib/training-audio-provenance.js'

// These MUST match the writer in transcribe-stream.ts, which saves under
// dataPath(). They previously resolved relative to __dirname — i.e. inside the
// installed package generation, a directory the writer never touches and that
// every managed update replaces. Every reader below therefore reported zero
// speakers and zero sessions while real audio accumulated in the data home.
const AUDIO_SAVE_DIR = dataPath('training-audio')
const EXT_AUDIO_DIR = dataPath('ext-audio')
// Must match speaker-embeddings.ts, which appends every identification decision.
const CALIBRATION_LOG = dataPath('speaker-calibration.jsonl')

/** A speaker directory name is derived from a label by replacing spaces with
 *  underscores. Resolve back through basename so a crafted `speaker` value
 *  cannot escape the audio root. */
function speakerDirPath(root: string, speakerName: string): string | null {
  const dirName = speakerName.trim().replace(/\s+/g, '_')
  if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.includes('..')) return null
  const path = resolve(root, dirName)
  if (!path.startsWith(resolve(root) + '/')) return null
  return path
}

export const voiceRouter = Router()

// POST /api/voice/enroll — accept WAV audio, extract embedding, store as profile
voiceRouter.post('/voice/enroll', async (req, res) => {
  try {
    // Default to the configured wearer label ('Me' unless owner_speaker_label
    // is set). Hardcoding one user's initials here enrolled every other install
    // under a stranger's name.
    const name = (req.query.name as string) || getOwnerSpeakerLabel()

    // Collect raw audio body
    const buffers: Buffer[] = []
    for await (const chunk of req) {
      buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const audioBuffer = Buffer.concat(buffers)

    if (audioBuffer.length < 1000) {
      return res.status(400).json({ success: false, error: 'Audio too short — need at least 5 seconds' })
    }

    const result = enrollSpeaker(name, audioBuffer)
    res.json(result)
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: errMsg(err) })
  }
})

// GET /api/voice/status — is the wearer enrolled?
voiceRouter.get('/voice/status', (_req, res) => {
  const owner = getOwnerSpeakerLabel()
  res.json({
    owner,
    enrolled: isEnrolled(owner),
    speakers: getAllSpeakerNames(),
  })
})

// POST /api/voice/identify — one-shot identification (testing)
voiceRouter.post('/voice/identify', async (req, res) => {
  try {
    const buffers: Buffer[] = []
    for await (const chunk of req) {
      buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const audioBuffer = Buffer.concat(buffers)

    const result = identifySpeaker(audioBuffer)
    res.json(result ?? { speaker: 'Unknown', similarity: 0 })
  } catch (err: unknown) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/voice/train — train voiceprints from Fireflies meeting audio
voiceRouter.post('/voice/train', async (req, res) => {
  try {
    const { speakerNames, minSegments, minSegmentDuration, limit, maxEmbeddingsPerSpeaker, fresh } = req.body ?? {}
    const report = await trainFromFireflies({
      speakerNames,
      minSegments,
      minSegmentDuration,
      limit,
      maxEmbeddingsPerSpeaker,
      fresh,
    })
    res.json(report)
  } catch (err: unknown) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// GET /api/voice/training-status — show trained speakers and enrollment state
voiceRouter.get('/voice/training-status', async (_req, res) => {
  try {
    const status = await getTrainingStatus()
    res.json(status)
  } catch (err: unknown) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/voice/train-g2 — train from saved G2-mic audio chunks
// These accumulate during meetings for speakers who need more embeddings.
//
// Body: { speaker?, confirmAllSpeakers?, dryRun?, maxPerSpeaker? }
//
// This endpoint permanently rewrites voice profiles AND deletes the source WAVs,
// so the unscoped form now requires an explicit confirmation. Two reasons, both
// load-bearing:
//
//  1. Until the reader path above was fixed it saw an empty directory, so a
//     no-argument call was harmless. It is not harmless any more — it now reaches
//     every accumulated speaker directory at once.
//  2. Enrolling N samples into a profile capped at 20 evicts the oldest sample N
//     times. A 30-WAV directory would therefore discard EVERY pre-existing
//     embedding for that speaker, replacing months of curated training with one
//     meeting's audio. Diversity selection bounds the enrollment instead.
const DEFAULT_MAX_TRAIN_PER_SPEAKER = 10

voiceRouter.post('/voice/train-g2', async (req, res) => {
  try {
    const targetSpeaker = req.body?.speaker as string | undefined
    const confirmAll = req.body?.confirmAllSpeakers === true
    const dryRun = req.body?.dryRun === true
    const maxPerSpeaker = Number.isFinite(req.body?.maxPerSpeaker)
      ? Math.max(1, Math.min(20, Number(req.body.maxPerSpeaker)))
      : DEFAULT_MAX_TRAIN_PER_SPEAKER

    if (!existsSync(AUDIO_SAVE_DIR)) {
      return res.json({ trained: 0, speakers: [], message: 'No saved G2 audio yet' })
    }

    let speakerDirs = readdirSync(AUDIO_SAVE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())

    if (targetSpeaker) {
      const wanted = speakerDirPath(AUDIO_SAVE_DIR, targetSpeaker)
      if (!wanted) return res.status(400).json({ error: 'invalid speaker name' })
      speakerDirs = speakerDirs.filter(d => resolve(AUDIO_SAVE_DIR, d.name) === wanted)
      if (speakerDirs.length === 0) {
        return res.status(404).json({ error: `No saved G2 audio for "${targetSpeaker}"` })
      }
    } else if (!confirmAll && !dryRun) {
      // Fail closed with the inventory, so the caller can see exactly what a
      // confirmation would rewrite before granting it.
      const pending = speakerDirs.map(d => {
        const name = d.name.replace(/_/g, ' ')
        let chunks = 0
        try { chunks = readdirSync(resolve(AUDIO_SAVE_DIR, d.name)).filter(f => f.endsWith('.wav')).length } catch {}
        return { speaker: name, chunks, currentEmbeddings: getEmbeddingCount(name) }
      }).filter(s => s.chunks > 0)
      return res.status(400).json({
        error: 'confirmation required',
        message: 'Training every speaker at once rewrites their profiles and deletes the source audio. '
          + 'Pass { speaker } to scope it, { dryRun: true } to preview, or { confirmAllSpeakers: true } to proceed.',
        wouldTrain: pending,
        totalSpeakers: pending.length,
        totalChunks: pending.reduce((sum, s) => sum + s.chunks, 0),
      })
    }

    const results: Array<{
      speaker: string
      chunks: number
      embeddingsExtracted: number
      selected: number
      enrolled: number
      audioRetained?: boolean
    }> = []

    for (const dir of speakerDirs) {
      const speakerName = dir.name.replace(/_/g, ' ')
      const speakerPath = resolve(AUDIO_SAVE_DIR, dir.name)
      const wavFiles = readdirSync(speakerPath).filter(f => f.endsWith('.wav')).sort()

      if (wavFiles.length === 0) continue

      // Extract all embeddings, select most diverse
      const embeddings: Float32Array[] = []
      // Parallel to `embeddings`: the WAV each one came from, so the enrollment
      // below can stamp WHICH MEETING produced the sample. Without it a later
      // de-attribution cannot retract this meeting's contribution to the profile.
      const embeddingFiles: string[] = []
      for (const wav of wavFiles) {
        const buffer = readFileSync(resolve(speakerPath, wav))
        const emb = extractEmbedding(buffer)
        if (emb) { embeddings.push(emb); embeddingFiles.push(wav) }
      }

      if (embeddings.length === 0) {
        results.push({ speaker: speakerName, chunks: wavFiles.length, embeddingsExtracted: 0, selected: 0, enrolled: 0, audioRetained: true })
        continue
      }

      const selected = greedyDiversitySelect(embeddings, maxPerSpeaker)

      if (dryRun) {
        results.push({
          speaker: speakerName,
          chunks: wavFiles.length,
          embeddingsExtracted: embeddings.length,
          selected: selected.length,
          enrolled: 0,
          audioRetained: true,
        })
        continue
      }

      // Enroll the diverse subset (enrollEmbedding handles dedup gate + FIFO cap)
      let enrolled = 0
      for (const emb of selected) {
        // Reference identity, NOT a re-selection: greedyDiversitySelect returns
        // the very same Float32Array objects, so indexOf recovers the filename
        // without changing which samples were chosen. Swapping the selector for
        // an index-returning one would silently alter that choice.
        const at = embeddings.indexOf(emb)
        const source = at >= 0 ? trainingSourceFor(embeddingFiles[at]) : 'g2-training'
        const result = enrollEmbedding(speakerName, emb, source)
        if (result.success) enrolled++
      }

      results.push({
        speaker: speakerName,
        chunks: wavFiles.length,
        embeddingsExtracted: embeddings.length,
        selected: selected.length,
        enrolled,
      })

      // Clean up processed audio. Only when something was actually enrolled —
      // deleting the source after enrolling nothing is pure data loss.
      if (enrolled > 0) {
        for (const wav of wavFiles) {
          try { unlinkSync(resolve(speakerPath, wav)) } catch {}
        }
        try { rmdirSync(speakerPath) } catch {}
      } else {
        results[results.length - 1].audioRetained = true
      }
    }

    const totalEnrolled = results.reduce((sum, r) => sum + r.enrolled, 0)
    res.json({ trained: totalEnrolled, dryRun, maxPerSpeaker, speakers: results })
  } catch (err: unknown) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// GET /api/voice/saved-audio — show accumulated G2 training audio
voiceRouter.get('/voice/saved-audio', (_req, res) => {
  try {
    if (!existsSync(AUDIO_SAVE_DIR)) {
      return res.json({ speakers: [] })
    }

    const speakerDirs = readdirSync(AUDIO_SAVE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())

    const speakers = speakerDirs.map(d => {
      const speakerPath = resolve(AUDIO_SAVE_DIR, d.name)
      const wavFiles = readdirSync(speakerPath).filter(f => f.endsWith('.wav'))
      return {
        name: d.name.replace(/_/g, ' '),
        chunks: wavFiles.length,
        currentEmbeddings: getEmbeddingCount(d.name.replace(/_/g, ' ')),
      }
    }).filter(s => s.chunks > 0)

    res.json({ speakers })
  } catch (err: unknown) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// GET /api/voice/ext-audio — list saved unrecognized speaker audio (72hr retention)
voiceRouter.get('/voice/ext-audio', (_req, res) => {
  try {
    if (!existsSync(EXT_AUDIO_DIR)) {
      return res.json({ sessions: [], totalChunks: 0 })
    }

    const sessionDirs = readdirSync(EXT_AUDIO_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())

    const sessions = sessionDirs.map(d => {
      const dirPath = resolve(EXT_AUDIO_DIR, d.name)
      const wavFiles = readdirSync(dirPath).filter(f => f.endsWith('.wav')).sort()
      let oldestMs = Date.now(), newestMs = 0
      for (const f of wavFiles) {
        try {
          const { mtimeMs } = statSync(resolve(dirPath, f))
          if (mtimeMs < oldestMs) oldestMs = mtimeMs
          if (mtimeMs > newestMs) newestMs = mtimeMs
        } catch {}
      }
      const ageHours = ((Date.now() - oldestMs) / (60 * 60 * 1000)).toFixed(1)
      return {
        sessionId: d.name,
        chunks: wavFiles.length,
        ageHours: parseFloat(ageHours),
        expiresIn: `${Math.max(0, 72 - parseFloat(ageHours)).toFixed(1)}h`,
      }
    }).filter(s => s.chunks > 0)

    res.json({
      sessions,
      totalChunks: sessions.reduce((sum, s) => sum + s.chunks, 0),
    })
  } catch (err: unknown) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/voice/enroll-ext — enroll saved Ext audio under a speaker name
// Body: { name: "Chuks", sessionId?: "abc123" }
// If sessionId provided, only enroll from that session. Otherwise, enroll from all ext sessions.
voiceRouter.post('/voice/enroll-ext', async (req, res) => {
  try {
    const { name, sessionId } = req.body ?? {}
    if (!name || typeof name !== 'string' || name.length < 2) {
      return res.status(400).json({ error: 'name is required (min 2 chars)' })
    }

    if (!existsSync(EXT_AUDIO_DIR)) {
      return res.json({ enrolled: 0, message: 'No ext-audio available' })
    }

    // Collect target directories
    const targetDirs: string[] = []
    if (sessionId) {
      const dirPath = speakerDirPath(EXT_AUDIO_DIR, String(sessionId))
      if (dirPath && existsSync(dirPath)) targetDirs.push(dirPath)
      else return res.status(404).json({ error: `Session ${sessionId} not found in ext-audio` })
    } else {
      const sessionDirs = readdirSync(EXT_AUDIO_DIR, { withFileTypes: true }).filter(d => d.isDirectory())
      // Same reasoning as train-g2: with the reader path fixed, the unscoped
      // form now attributes EVERY unrecognized session in the retention window
      // to one person and then recursively deletes them all. Different sessions
      // are usually different people, so that is a profile-poisoning default.
      if (req.body?.confirmAllSessions !== true) {
        const inventory = sessionDirs.map(d => {
          let chunks = 0
          try { chunks = readdirSync(resolve(EXT_AUDIO_DIR, d.name)).filter(f => f.endsWith('.wav')).length } catch {}
          return { sessionId: d.name, chunks }
        }).filter(s => s.chunks > 0)
        return res.status(400).json({
          error: 'confirmation required',
          message: `Enrolling every ext-audio session as "${name}" assumes one speaker across all of them, `
            + 'and deletes the audio afterwards. Pass { sessionId } to scope it, '
            + 'or { confirmAllSessions: true } to proceed.',
          wouldEnrollFrom: inventory,
          totalSessions: inventory.length,
          totalChunks: inventory.reduce((sum, s) => sum + s.chunks, 0),
        })
      }
      for (const d of sessionDirs) targetDirs.push(resolve(EXT_AUDIO_DIR, d.name))
    }

    // Extract all embeddings from WAV chunks
    const allEmbeddings: Float32Array[] = []
    let totalChunks = 0
    for (const dirPath of targetDirs) {
      const wavFiles = readdirSync(dirPath).filter(f => f.endsWith('.wav')).sort()
      for (const wav of wavFiles) {
        totalChunks++
        const buffer = readFileSync(resolve(dirPath, wav))
        const emb = extractEmbedding(buffer)
        if (emb) allEmbeddings.push(emb)
      }
    }

    if (allEmbeddings.length === 0) {
      return res.json({ enrolled: 0, totalChunks, message: 'No valid embeddings extracted from ext audio' })
    }

    // Greedy diversity selection: pick most diverse embeddings (max 20)
    const maxToEnroll = 20
    const selected = greedyDiversitySelect(allEmbeddings, maxToEnroll)

    // Enroll selected embeddings
    let enrolled = 0
    for (const emb of selected) {
      const result = enrollEmbedding(name, emb, 'ext-retroactive', true)
      if (result.success) enrolled++
    }

    // Clean up enrolled ext-audio
    for (const dirPath of targetDirs) {
      try { rmSync(dirPath, { recursive: true, force: true }) } catch {}
    }

    res.json({
      speaker: name,
      enrolled,
      totalChunks,
      embeddingsExtracted: allEmbeddings.length,
      selectedDiverse: selected.length,
      message: `Enrolled ${enrolled} diverse embeddings for ${name} from ${totalChunks} ext audio chunks`,
    })
  } catch (err: unknown) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// ── Voice sample playback (6.21.18) ───────────────────────────────────────
//
// Miles: hearing three seconds of a voice settles an identity question that a
// similarity score cannot. These two paths need NO retention change — the audio
// already exists:
//
//   training-audio  what the system thinks a NAMED person sounds like
//   ext-audio       an UNIDENTIFIED voice, 72-hour window
//
// The first is the higher-value one for the review panel: "is this really Navaz?"
// is answered by playing Navaz's own profile sample, not by playing the segment
// under review.

/** Newest WAV in a directory — the most representative recent sample. */
function newestWav(dirPath: string): string | null {
  try {
    const wavs = readdirSync(dirPath).filter(f => f.endsWith('.wav'))
    if (wavs.length === 0) return null
    let best = wavs[0], bestAt = 0
    for (const w of wavs) {
      try {
        const at = statSync(resolve(dirPath, w)).mtimeMs
        if (at >= bestAt) { bestAt = at; best = w }
      } catch { /* skip unreadable */ }
    }
    return resolve(dirPath, best)
  } catch {
    return null
  }
}

// GET /api/voice/profiles/:name/sample — hear what a stored profile sounds like.
voiceRouter.get('/voice/profiles/:name/sample', (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const name = String(req.params.name ?? '')
  const dirPath = speakerDirPath(AUDIO_SAVE_DIR, name)
  if (!dirPath) {
    res.status(400).json({ error: 'Invalid speaker name', reason: 'invalid_speaker' })
    return
  }
  const wav = existsSync(dirPath) ? newestWav(dirPath) : null
  if (!wav) {
    // A profile can exist with no retained audio: it may have been built from
    // Fireflies seeds, or its training audio may have aged out. Say which rather
    // than implying the person is unknown.
    res.status(404).json({
      error: `No retained audio for "${name}"`,
      reason: 'no_sample_audio',
      enrolled: isEnrolled(name),
      embeddings: getEmbeddingCount(name),
    })
    return
  }
  res.type('audio/wav')
  res.sendFile(wav)
})

// GET /api/voice/ext-audio/:sessionId/sample — hear an unidentified voice.
voiceRouter.get('/voice/ext-audio/:sessionId/sample', (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const sessionId = String(req.params.sessionId ?? '')
  const dirPath = speakerDirPath(EXT_AUDIO_DIR, sessionId)
  if (!dirPath) {
    res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
    return
  }
  const wav = existsSync(dirPath) ? newestWav(dirPath) : null
  if (!wav) {
    res.status(404).json({
      error: 'No ext-audio retained for this session',
      reason: 'no_ext_audio',
    })
    return
  }
  res.type('audio/wav')
  res.sendFile(wav)
})

// GET /api/voice/profiles — enrolled people with sample counts and provenance.
// The review surfaces need to see the store; until now the only window into it
// was a per-name count, so a misattributed profile was invisible.
voiceRouter.get('/voice/profiles', (_req, res) => {
  try {
    const { profiles } = readVoiceProfiles()
    const owner = getOwnerSpeakerLabel()
    res.json({
      owner,
      count: profiles.length,
      totalEmbeddings: profiles.reduce((sum, p) => sum + p.embeddings.length, 0),
      profiles: profiles
        .map(p => {
          const bySource: Record<string, number> = {}
          for (const source of p.sources ?? []) {
            // Collapse auto:<sessionId> so one poisoned session is visible
            // without leaking a session id per row.
            const key = source.startsWith('auto:') ? 'auto' : source
            bySource[key] = (bySource[key] ?? 0) + 1
          }
          return {
            name: p.name,
            embeddings: p.embeddings.length,
            isOwner: p.name === owner,
            sources: bySource,
            // Provenance alignment is now an invariant; surfacing it makes a
            // future regression visible instead of silent.
            sourcesAligned: (p.sources?.length ?? 0) === p.embeddings.length,
          }
        })
        .sort((a, b) => b.embeddings - a.embeddings),
    })
  } catch (err: unknown) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/voice/merge-profiles — fold two names for one person together.
// Body: { into, from: string[]|string, confirm: true, dryRun?, force? }
//
// Two profiles for one voice is worse than it looks: the sherpa manager holds
// one centroid per NAME, so both compete on every search and each is capped at
// 20 samples independently — 40 samples of one person, split, each half a
// weaker representation of them than the union would be.
//
// Fails closed below the search-accept threshold. A wrong merge destroys BOTH
// identities at once and cannot be undone from the store alone, so the only
// acceptable evidence is acoustic. `force` exists for the case where Miles
// knows something the audio does not, and it is logged.
voiceRouter.post('/voice/merge-profiles', (req, res) => {
  try {
    const into = typeof req.body?.into === 'string' ? req.body.into.trim() : ''
    const rawFrom = req.body?.from
    const from = (Array.isArray(rawFrom) ? rawFrom : [rawFrom])
      .filter((n: unknown): n is string => typeof n === 'string' && n.trim().length > 0)
      .map((n: string) => n.trim())

    if (!into || from.length === 0) {
      return res.status(400).json({ error: 'into (string) and from (string or string[]) are required' })
    }
    if (from.includes(into)) {
      return res.status(400).json({ error: 'into and from must differ' })
    }

    const owner = getOwnerSpeakerLabel()
    if (from.includes(owner)) {
      // Absorbing the owner label would delete the profile the live
      // identification path checks FIRST, on every chunk.
      return res.status(400).json({
        error: `refusing to absorb the owner label "${owner}" — merge INTO it instead`,
      })
    }

    const dryRun = req.body?.dryRun === true
    const force = req.body?.force === true

    if (req.body?.confirm !== true && !dryRun) {
      const preview = mergeSpeakerProfiles(into, from, { force, dryRun: true })
      return res.status(400).json({
        error: 'confirmation required',
        message: `Merging is not reversible from the store alone. Review the similarity scores, then pass { confirm: true }.`,
        preview,
      })
    }

    const report = mergeSpeakerProfiles(into, from, { force, dryRun })

    if (report.missing.length > 0 && report.merged.length === 0) {
      return res.status(404).json({ error: 'no such profile(s)', missing: report.missing, report })
    }
    if (report.refused && report.merged.length === 0) {
      return res.status(409).json({
        error: 'similarity below the merge floor',
        message: 'These centroids are further apart than the threshold at which identification would '
          + 'accept a match between them, so they are probably different people. Pass { force: true } '
          + 'only if you know they are the same person.',
        report,
      })
    }

    // Relabel rather than drop the absorbed name's calibration history: after a
    // merge it is one person's history, and it is the only evidence for whether
    // the merge improved identification.
    const calibration: Record<string, number> = {}
    if (!dryRun) {
      for (const name of report.merged) {
        calibration[name] = relabelSpeakerCalibrationRows(CALIBRATION_LOG, name, into).relabeled
      }
    }

    res.json({ ...report, dryRun, forced: force, calibrationRowsRelabeled: calibration })
  } catch (err: unknown) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/voice/delete-person — remove one person from every store that
// carries their name. Body: { name, confirm: true, dryRun? }
//
// Built before more data accumulates, and returns a per-store count so the sweep
// is auditable rather than a bare success. Two stores are deliberately NOT swept:
// ext-audio and session-audio are keyed by session, not by person, so there is no
// name to match on — they age out on their own retention instead.
voiceRouter.post('/voice/delete-person', (req, res) => {
  try {
    const name = req.body?.name
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'name is required (min 2 chars)' })
    }
    const target = name.trim()
    const dryRun = req.body?.dryRun === true

    if (req.body?.confirm !== true && !dryRun) {
      const existing = readVoiceProfiles().profiles.find(p => p.name === target)
      const audioDir = speakerDirPath(AUDIO_SAVE_DIR, target)
      let wavs = 0
      if (audioDir && existsSync(audioDir)) {
        try { wavs = readdirSync(audioDir).filter(f => f.endsWith('.wav')).length } catch {}
      }
      const calibration = purgeSpeakerCalibrationRows(CALIBRATION_LOG, target, { dryRun: true })
      return res.status(400).json({
        error: 'confirmation required',
        message: `Deleting "${target}" is not reversible. Pass { confirm: true } to proceed.`,
        wouldRemove: {
          profile: existing ? 1 : 0,
          embeddings: existing?.embeddings.length ?? 0,
          trainingAudioFiles: wavs,
          calibrationRows: calibration.removed,
        },
      })
    }

    if (dryRun) {
      const existing = readVoiceProfiles().profiles.find(p => p.name === target)
      const audioDir = speakerDirPath(AUDIO_SAVE_DIR, target)
      let wavs = 0
      if (audioDir && existsSync(audioDir)) {
        try { wavs = readdirSync(audioDir).filter(f => f.endsWith('.wav')).length } catch {}
      }
      const calibration = purgeSpeakerCalibrationRows(CALIBRATION_LOG, target, { dryRun: true })
      return res.json({
        name: target,
        dryRun: true,
        removed: {
          profiles: existing ? 1 : 0,
          embeddings: existing?.embeddings.length ?? 0,
          trainingAudioFiles: wavs,
          calibrationRows: calibration.removed,
        },
      })
    }

    // 1. Voice profile + sherpa manager registration.
    const profileResult = removeSpeakerProfile(target)

    // 2. Saved G2 training audio for this person.
    let trainingAudioFiles = 0
    const audioDir = speakerDirPath(AUDIO_SAVE_DIR, target)
    if (audioDir && existsSync(audioDir)) {
      try {
        const wavs = readdirSync(audioDir).filter(f => f.endsWith('.wav'))
        trainingAudioFiles = wavs.length
        rmSync(audioDir, { recursive: true, force: true })
      } catch { /* reported as 0 rather than claimed */ }
    }

    // 3. Calibration rows (the name appears in every row).
    const calibration = purgeSpeakerCalibrationRows(CALIBRATION_LOG, target)

    res.json({
      name: target,
      removed: {
        profiles: profileResult.removedProfiles,
        embeddings: profileResult.removedEmbeddings,
        trainingAudioFiles,
        calibrationRows: calibration.removed,
      },
      notAttributable: {
        extAudio: 'keyed by session, not by person — ages out on its own retention',
        sessionAudio: 'keyed by session, not by person — ages out on its own retention',
      },
      calibrationRetained: calibration.retained,
    })
  } catch (err: unknown) {
    res.status(500).json({ error: errMsg(err) })
  }
})

/** Greedy diversity selection — pick N most acoustically diverse embeddings */
function greedyDiversitySelect(embeddings: Float32Array[], maxN: number): Float32Array[] {
  if (embeddings.length <= maxN) return embeddings

  // Find the most dissimilar pair as seeds
  let maxDist = -1, seedA = 0, seedB = 1
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const dist = 1 - rawCosineSimilarity(embeddings[i], embeddings[j])
      if (dist > maxDist) { maxDist = dist; seedA = i; seedB = j }
    }
  }

  const selected = new Set([seedA, seedB])
  while (selected.size < maxN) {
    let bestIdx = -1, bestMinDist = -1
    for (let i = 0; i < embeddings.length; i++) {
      if (selected.has(i)) continue
      let minDist = Infinity
      for (const s of selected) {
        const dist = 1 - rawCosineSimilarity(embeddings[i], embeddings[s])
        if (dist < minDist) minDist = dist
      }
      if (minDist > bestMinDist) { bestMinDist = minDist; bestIdx = i }
    }
    if (bestIdx === -1) break
    selected.add(bestIdx)
  }

  return [...selected].map(i => embeddings[i])
}
