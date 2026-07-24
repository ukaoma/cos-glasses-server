// Voice enrollment, status, and multi-speaker training endpoints

import { Router } from 'express'
import { errMsg } from '../lib/utils.js'
import { readdirSync, readFileSync, unlinkSync, existsSync, rmdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enrollSpeaker, isEnrolled, getAllSpeakerNames, identifySpeaker, extractEmbedding, enrollEmbedding, rawCosineSimilarity, getEmbeddingCount } from '../lib/speaker-embeddings.js'
import { statSync } from 'node:fs'
import { trainFromFireflies, getTrainingStatus } from '../lib/speaker-trainer.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const AUDIO_SAVE_DIR = resolve(__dirname, '..', 'data', 'training-audio')
const EXT_AUDIO_DIR = resolve(__dirname, '..', 'data', 'ext-audio')

export const voiceRouter = Router()

// POST /api/voice/enroll — accept WAV audio, extract embedding, store as profile
voiceRouter.post('/voice/enroll', async (req, res) => {
  try {
    const name = (req.query.name as string) || 'MU'

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

// GET /api/voice/status — is MU enrolled?
voiceRouter.get('/voice/status', (_req, res) => {
  res.json({
    enrolled: isEnrolled('MU'),
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
// These accumulate during meetings for speakers who need more embeddings
voiceRouter.post('/voice/train-g2', async (req, res) => {
  try {
    const targetSpeaker = req.body?.speaker as string | undefined
    if (!existsSync(AUDIO_SAVE_DIR)) {
      return res.json({ trained: 0, speakers: [], message: 'No saved G2 audio yet' })
    }

    const speakerDirs = readdirSync(AUDIO_SAVE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .filter(d => !targetSpeaker || d.name === targetSpeaker.replace(/\s+/g, '_'))

    const results: Array<{ speaker: string; chunks: number; enrolled: number }> = []

    for (const dir of speakerDirs) {
      const speakerName = dir.name.replace(/_/g, ' ')
      const speakerPath = resolve(AUDIO_SAVE_DIR, dir.name)
      const wavFiles = readdirSync(speakerPath).filter(f => f.endsWith('.wav')).sort()

      if (wavFiles.length === 0) continue

      // Extract all embeddings, select most diverse
      const embeddings: Float32Array[] = []
      for (const wav of wavFiles) {
        const buffer = readFileSync(resolve(speakerPath, wav))
        const emb = extractEmbedding(buffer)
        if (emb) embeddings.push(emb)
      }

      if (embeddings.length === 0) {
        results.push({ speaker: speakerName, chunks: wavFiles.length, enrolled: 0 })
        continue
      }

      // Enroll diverse embeddings (enrollEmbedding handles diversity gate + FIFO cap)
      let enrolled = 0
      for (const emb of embeddings) {
        const result = enrollEmbedding(speakerName, emb, 'g2-training')
        if (result.success) enrolled++
      }

      results.push({ speaker: speakerName, chunks: wavFiles.length, enrolled })

      // Clean up processed audio
      for (const wav of wavFiles) {
        try { unlinkSync(resolve(speakerPath, wav)) } catch {}
      }
      try { rmdirSync(speakerPath) } catch {}
    }

    const totalEnrolled = results.reduce((sum, r) => sum + r.enrolled, 0)
    res.json({ trained: totalEnrolled, speakers: results })
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
      const dirPath = resolve(EXT_AUDIO_DIR, sessionId)
      if (existsSync(dirPath)) targetDirs.push(dirPath)
      else return res.status(404).json({ error: `Session ${sessionId} not found in ext-audio` })
    } else {
      const sessionDirs = readdirSync(EXT_AUDIO_DIR, { withFileTypes: true }).filter(d => d.isDirectory())
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
