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
//     ONE correction and its spelling (6.73.11, Fix a word), logged for undo. A
//     written link, email or path is a correction only (6.83.1): the answer adds
//     correctionOnly: true and a note, and the vocabulary is untouched.
//   GET  /api/transcription-glossary/recent → { entries } newest first.
//   POST /api/transcription-glossary/correction/undo {id} → revert that entry.
//   POST /api/transcription-glossary/vocabulary/add {term}, /vocabulary/remove {term},
//        /correction/remove {heard} → one atomic hand edit (6.73.12), not logged.

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
  addVocabulary,
  appendLog,
  CORRECTION_ONLY_NOTE,
  isCorrectionOnly,
  learnCorrection,
  looksLikeUrlEmailPath,
  parseLog,
  removeCorrection,
  removeVocabulary,
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

export type Outcome = { status: number; body: unknown }

function serialized(work: () => Outcome): Promise<Outcome> {
  const run = putChain.catch(() => {}).then(work)
  putChain = run
  return run
}

/**
 * Learn one correction inside the glossary write chain, exactly as POST
 * /transcription-glossary/correction does (logged, undoable). Exported for the transcript
 * cleanup's dictionary suggestions (6.77.0), so an accepted suggestion uses this writer and
 * never a second copy of it.
 */
export function glossaryLearnCorrection(body: unknown): Promise<Outcome> {
  return serialized(() => {
    const previousLog = readCorrectionsLog()
    const learned = learnCorrection(storedWords(), (body ?? {}) as { heard: unknown; written: unknown; source: unknown }, { id: randomUUID(), at: new Date().toISOString() })
    if (!learned.ok) return { status: learned.status, body: { error: learned.error } }
    if (learned.unchanged) return { status: 200, body: { unchanged: true, entry: null, glossary: currentGlossary() } }
    commitWords(learned.words, appendLog(previousLog, learned.entry), previousLog)
    // 6.83.1: a link, email or path is kept as a correction only; say so in words a client can show.
    const correctionOnly = isCorrectionOnly(learned.entry.written)
    return {
      status: 200,
      body: {
        unchanged: false, entry: learned.entry, glossary: currentGlossary(),
        ...(correctionOnly ? { correctionOnly: true, note: CORRECTION_ONLY_NOTE } : {}),
      },
    }
  })
}

glossaryRouter.post('/transcription-glossary/correction', async (req, res) => {
  const body = req.body ?? {}
  try {
    const outcome = await glossaryLearnCorrection(body)
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

// ── Single-item hand edits (6.73.12) ─────────────────────────────────────────
// One word or one correction at a time, inside the same chain as PUT and learn,
// so COS Control never has to read the whole map and write it back.
function runSingleEdit(edit: (words: GlossaryWords, raw: unknown) => ReturnType<typeof addVocabulary>, raw: unknown): Promise<Outcome> {
  return serialized(() => {
    const result = edit(storedWords(), raw)
    if (!result.ok) return { status: result.status, body: { error: result.error } }
    if (!result.unchanged) {
      updateProfileFields({ vocabulary: result.words.vocabulary, whisper_corrections: JSON.stringify(result.words.corrections) })
      resetDecoderCaches()
      resetVocabEchoCache()
    }
    return { status: 200, body: { unchanged: result.unchanged, glossary: currentGlossary() } }
  })
}

/** Add one vocabulary word inside the glossary write chain (same as POST /transcription-glossary/vocabulary/add). */
export function glossaryAddVocabulary(term: unknown): Promise<Outcome> {
  return runSingleEdit(addVocabulary, term)
}

function singleEdit(path: string, field: 'term' | 'heard', edit: (words: GlossaryWords, raw: unknown) => ReturnType<typeof addVocabulary>) {
  glossaryRouter.post(path, async (req, res) => {
    const raw = (req.body ?? {})[field]
    try {
      const outcome = await runSingleEdit(edit, raw)
      return res.status(outcome.status).json(outcome.body)
    } catch (err) {
      return res.status(500).json({ error: errMsg(err) })
    }
  })
}

singleEdit('/transcription-glossary/vocabulary/add', 'term', addVocabulary)
singleEdit('/transcription-glossary/vocabulary/remove', 'term', removeVocabulary)
singleEdit('/transcription-glossary/correction/remove', 'heard', removeCorrection)
