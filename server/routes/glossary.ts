// Transcription glossary — runtime-editable positive vocabulary, exact
// corrections, and negative cleanup rules. Persists into .cos-profile.json and
// busts the profile + decoder caches so edits take effect WITHOUT a server
// restart. Auto token-protected by the /api middleware (server/index.ts:124).
//
//   GET /api/transcription-glossary → { vocabulary, corrections, negative_rules }
//   PUT /api/transcription-glossary → same shape; PARTIAL (any omitted field is
//     left unchanged). whisper_corrections is stored as a JSON STRING in the
//     profile (legacy decoder contract), so the route encodes/decodes it here.
//   POST /api/transcription-glossary/correction {heard, written, source} → learn
//     ONE correction and its spelling (6.73.11, Fix a word), logged for undo.
//   GET  /api/transcription-glossary/recent → { entries } newest first.
//   POST /api/transcription-glossary/correction/undo {id} → revert that entry.

import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { errMsg } from '../lib/utils.js'
import { atomicWriteFileSync } from '../lib/atomic-fs.js'
import { dataPath } from '../lib/data-dir.js'
import {
  getVocabulary,
  getNegativeRules,
  getWhisperCorrections,
  loadProfileObject,
  updateProfileFields,
} from '../lib/profile.js'
import {
  MAX_TERMS,
  MAX_TERM_LEN,
  appendLog,
  learnCorrection,
  looksLikeUrlEmailPath,
  parseLog,
  undoCorrection,
  type CorrectionLogEntry,
  type GlossaryWords,
} from '../lib/glossary-learn.js'
import { resetDecoderCaches } from '../lib/whisper-local.js'
import { resetVocabEchoCache } from '../lib/hallucination-filter.js'
import { validateNegativeRule } from '../lib/hallucination-filter.js'

export const glossaryRouter = Router()

const MAX_RULES = 500

function readCorrections(): Record<string, string> {
  return getWhisperCorrections()
}

function currentGlossary() {
  return {
    vocabulary: getVocabulary(),
    corrections: readCorrections(),
    negative_rules: getNegativeRules(),
  }
}

// Serialize PUTs so two writers can't clobber the read-modify-write. (The RMW in
// updateProfileFields is synchronous today, but this guards against future async
// drift and satisfies the write-lock contract.)
let putChain: Promise<unknown> = Promise.resolve()

glossaryRouter.get('/transcription-glossary', (_req, res) => {
  try {
    res.json(currentGlossary())
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

glossaryRouter.put('/transcription-glossary', async (req, res) => {
  const body = req.body ?? {}
  const patch: Record<string, unknown> = {}

  // ── vocabulary (positive spellings → decoder prompt + fuzzy targets) ──
  if (body.vocabulary !== undefined) {
    if (!Array.isArray(body.vocabulary)) {
      return res.status(400).json({ error: 'vocabulary must be an array of strings' })
    }
    if (body.vocabulary.length > MAX_TERMS) {
      return res.status(400).json({ error: `too many vocabulary terms (max ${MAX_TERMS})` })
    }
    const vocab: string[] = []
    for (const raw of body.vocabulary) {
      if (typeof raw !== 'string') return res.status(400).json({ error: 'vocabulary entries must be strings' })
      const term = raw.trim()
      if (!term) continue
      if (term.length > MAX_TERM_LEN) return res.status(400).json({ error: `vocabulary term too long: "${term.slice(0, 40)}…"` })
      if (looksLikeUrlEmailPath(term)) {
        return res.status(400).json({ error: `vocabulary cannot contain URLs/emails/paths: "${term}" — they induce hallucinations in the decoder prompt` })
      }
      vocab.push(term)
    }
    patch.vocabulary = vocab
  }

  // ── corrections (bad → good) — persisted as a JSON STRING ──
  if (body.corrections !== undefined) {
    if (typeof body.corrections !== 'object' || body.corrections === null || Array.isArray(body.corrections)) {
      return res.status(400).json({ error: 'corrections must be an object { "bad": "good" }' })
    }
    const entries = Object.entries(body.corrections as Record<string, unknown>)
    if (entries.length > MAX_TERMS) return res.status(400).json({ error: `too many corrections (max ${MAX_TERMS})` })
    const map: Record<string, string> = {}
    for (const [bad, good] of entries) {
      const b = bad.trim()
      if (!b) continue
      if (typeof good !== 'string') return res.status(400).json({ error: `correction "${bad}" must map to a string` })
      if (b.length > MAX_TERM_LEN || good.length > MAX_TERM_LEN) {
        return res.status(400).json({ error: `correction too long near "${b.slice(0, 40)}"` })
      }
      map[b] = good.trim()
    }
    patch.whisper_corrections = JSON.stringify(map)
  }

  // ── negative rules (whole/strip/replace/flag) ──
  if (body.negative_rules !== undefined) {
    if (!Array.isArray(body.negative_rules)) {
      return res.status(400).json({ error: 'negative_rules must be an array of strings' })
    }
    if (body.negative_rules.length > MAX_RULES) {
      return res.status(400).json({ error: `too many negative rules (max ${MAX_RULES})` })
    }
    const rules: string[] = []
    for (const raw of body.negative_rules) {
      if (typeof raw !== 'string') return res.status(400).json({ error: 'negative_rules entries must be strings' })
      const v = validateNegativeRule(raw)
      if (!v.ok) return res.status(400).json({ error: `invalid rule "${raw.slice(0, 60)}": ${v.error}` })
      rules.push(raw)
    }
    patch.negative_rules = rules
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'nothing to update (send vocabulary, corrections, and/or negative_rules)' })
  }

  try {
    // Cache-bust chain: updateProfileFields() writes atomically + clears the ROOT
    // profileCache; resetDecoderCaches() clears the two derived decoder snapshots.
    // Both are required for an edit to reach the decoder without a restart.
    await (putChain = putChain.catch(() => {}).then(() => {
      updateProfileFields(patch)
      resetDecoderCaches()
      resetVocabEchoCache()  // vocab matcher in hallucination-filter is profile-derived too
    }))
    return res.json(currentGlossary())
  } catch (err) {
    return res.status(500).json({ error: errMsg(err) })
  }
})

// ── One-word learning (6.73.11) ──────────────────────────────────────────────
// The recent-corrections log lives in the data dir (private, atomic, bounded);
// the dictionary itself stays in .cos-profile.json. Both writes run inside the
// same putChain as PUT, so a learn can never interleave with a whole-map edit.

function correctionsLogPath(): string {
  return dataPath('transcription-corrections.json')
}

function readCorrectionsLog(): CorrectionLogEntry[] {
  try {
    return parseLog(JSON.parse(readFileSync(correctionsLogPath(), 'utf-8')))
  } catch {
    return []
  }
}

function writeCorrectionsLog(entries: CorrectionLogEntry[]): void {
  atomicWriteFileSync(correctionsLogPath(), JSON.stringify({ version: 1, entries }, null, 2), { mode: 0o600 })
}

/** The raw stored vocabulary (strings only), so a learn appends without rewriting placeholder handling. */
function storedWords(): GlossaryWords {
  const raw = loadProfileObject().vocabulary
  const vocabulary = Array.isArray(raw) ? raw.filter((term): term is string => typeof term === 'string') : []
  return { vocabulary, corrections: readCorrections() }
}

/** Log first, then the profile; a failed profile write puts the old log back. */
function commitWords(words: GlossaryWords, nextLog: CorrectionLogEntry[], previousLog: CorrectionLogEntry[]): void {
  writeCorrectionsLog(nextLog)
  try {
    updateProfileFields({ vocabulary: words.vocabulary, whisper_corrections: JSON.stringify(words.corrections) })
  } catch (err) {
    try { writeCorrectionsLog(previousLog) } catch { /* the profile is unchanged; a stale log row only refuses its own undo */ }
    throw err
  }
  resetDecoderCaches()
  resetVocabEchoCache()
}

type Outcome = { status: number; body: unknown }

function serialized(work: () => Outcome): Promise<Outcome> {
  const run = putChain.catch(() => {}).then(work)
  putChain = run
  return run
}

glossaryRouter.post('/transcription-glossary/correction', async (req, res) => {
  const body = req.body ?? {}
  try {
    const outcome = await serialized(() => {
      const previousLog = readCorrectionsLog()
      const learned = learnCorrection(storedWords(), body, { id: randomUUID(), at: new Date().toISOString() })
      if (!learned.ok) return { status: learned.status, body: { error: learned.error } }
      if (learned.unchanged) return { status: 200, body: { unchanged: true, entry: null, glossary: currentGlossary() } }
      commitWords(learned.words, appendLog(previousLog, learned.entry), previousLog)
      return { status: 200, body: { unchanged: false, entry: learned.entry, glossary: currentGlossary() } }
    })
    return res.status(outcome.status).json(outcome.body)
  } catch (err) {
    return res.status(500).json({ error: errMsg(err) })
  }
})

glossaryRouter.get('/transcription-glossary/recent', (_req, res) => {
  try {
    res.json({ entries: readCorrectionsLog() })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

glossaryRouter.post('/transcription-glossary/correction/undo', async (req, res) => {
  const id = (req.body ?? {}).id
  try {
    const outcome = await serialized(() => {
      const previousLog = readCorrectionsLog()
      const undone = undoCorrection(storedWords(), previousLog, id)
      if (!undone.ok) return { status: undone.status, body: { error: undone.error } }
      commitWords(undone.words, undone.log, previousLog)
      return { status: 200, body: { undone: undone.entry, glossary: currentGlossary() } }
    })
    return res.status(outcome.status).json(outcome.body)
  } catch (err) {
    return res.status(500).json({ error: errMsg(err) })
  }
})
