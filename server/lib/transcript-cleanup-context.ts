// Transcript cleanup (6.77.0): what the cleanup knows about a meeting besides its audio.
//
// TEXTUAL AWARENESS. The meeting's title and attendees, the enrolled speaker names (COS
// people), the owner card (meeting-ask-owner.ts), the profile vocabulary and the
// heard-to-written corrections (the COS dictionary, which dictation also uses), the text
// of files dropped on the meeting (the Meeting Ask file list), and a few local notes hits
// for the names the doubtful passages are near (searchMemories and searchMeetingLibrary in
// keyword-only mode: nothing leaves the Mac).
//
// SCREEN AWARENESS. On-screen text lines COS Control recorded during the meeting
// (transcript-cleanup-screen.ts), shown beside each passage by time.
//
// TERMS. Every source contributes terms: capitalised words and runs of them ("Grace
// Ukaoma", "Jewel360"). Terms are the per-meeting vocabulary: deterministic correction
// may write a term from this meeting's screen or files, the model may write any term,
// and a term the model writes that came from the meeting (not the dictionary) becomes a
// dictionary SUGGESTION, never an automatic addition.

import { isCommonEnglishWord } from './fuzzy-correct.js'
import { redactSecrets } from './lens-gist-engines.js'
import type { OwnerCard } from './meeting-ask-owner.js'
import { fold } from './transcript-cleanup-text.js'
import type { ScreenLine } from './transcript-cleanup-screen.js'

/** Where a term came from. vocabulary and correction are the dictionary itself; the rest are evidence. */
export type TermSource = 'vocabulary' | 'correction' | 'speaker' | 'owner' | 'attendee' | 'screen' | 'file' | 'notes'
/** Sources that make a written form a dictionary suggestion. Matches Control's evidence enum. */
export type EvidenceSource = 'screen' | 'file' | 'owner' | 'people' | 'notes'

export interface ContextTerm {
  display: string
  key: string
  sources: Set<TermSource>
  /** A file name, memory id or app name for the evidence row. Never transcript or OCR text. */
  details: Map<TermSource, string>
}

export interface CleanupFile { name: string; text: string }
/** `id` is the prompt's own label (N1, N2); `ref` the memory id or meeting record id, for evidence rows. */
export interface CleanupNote { id: string; ref: string; kind: 'memory' | 'meeting'; title: string; snippet: string; query: string }

export interface ContextPack {
  title: string
  date: string
  attendees: string[]
  speakers: string[]
  owner: OwnerCard | null
  vocabulary: string[]
  corrections: Array<{ heard: string; written: string }>
  files: Array<{ name: string; excerpt: string }>
  screen: ScreenLine[]
  notes: CleanupNote[]
  terms: Map<string, ContextTerm>
}

export const CONTEXT_LIMITS = {
  speakers: 150,
  vocabulary: 300,
  corrections: 120,
  files: 6,
  fileChars: 60_000,
  fileExcerptChars: 900,
  termsPerSource: 400,
  notes: 6,
  noteChars: 280,
  noteQueries: 4,
} as const

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu

function looksLikeName(word: string): boolean {
  if (!/^\p{Lu}/u.test(word)) return false
  const f = fold(word)
  if (f.length < 4) return false
  if (isCommonEnglishWord(f)) return false
  // An all-caps run of five letters or fewer is an acronym or a UI label, not a name.
  if (/^\p{Lu}+$/u.test(word) && f.length <= 5) return false
  return true
}

/** Capitalised name-like words of a text, and runs of two or three of them. */
export function extractTerms(text: string, max: number = CONTEXT_LIMITS.termsPerSource): string[] {
  const out = new Set<string>()
  const words = [...text.matchAll(WORD)].map(m => ({ w: m[0].replace(/['’]s$/i, ''), at: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
  for (let i = 0; i < words.length && out.size < max; i++) {
    const w = words[i].w
    const capital = /^\p{Lu}/u.test(w)
    if (looksLikeName(w)) out.add(w)
    // "Grace Ukaoma": a capitalised word directly before a name-like word, with nothing but a space between.
    if (capital && i + 1 < words.length && text.slice(words[i].end, words[i + 1].at) === ' ' && looksLikeName(words[i + 1].w)) {
      out.add(`${w} ${words[i + 1].w}`)
    }
  }
  return [...out].slice(0, max)
}

function addTerm(terms: Map<string, ContextTerm>, display: string, source: TermSource, detail?: string): void {
  const clean = display.replace(/\s+/g, ' ').trim()
  const key = fold(clean)
  if (!key || key.length < 2 || clean.length > 100) return
  const existing = terms.get(key)
  if (existing) {
    existing.sources.add(source)
    if (detail && !existing.details.has(source)) existing.details.set(source, detail)
    return
  }
  terms.set(key, { display: clean, key, sources: new Set([source]), details: new Map(detail ? [[source, detail]] : []) })
}

export interface ContextInputs {
  title: string
  date: string
  attendees: string[]
  speakers: string[]
  owner: OwnerCard | null
  vocabulary: string[]
  corrections: Record<string, string>
  files: CleanupFile[]
  screen: ScreenLine[]
  notes?: CleanupNote[]
}

const SPEAKER_TOKENS = new Set(['ext', 'unknown', 'me', 'speaker'])

/** The pack, with every text bounded and passed through redactSecrets. */
export function buildContextPack(input: ContextInputs): ContextPack {
  const terms = new Map<string, ContextTerm>()
  const vocabulary = input.vocabulary.map(v => v.trim()).filter(Boolean).slice(0, CONTEXT_LIMITS.vocabulary)
  for (const v of vocabulary) {
    addTerm(terms, v, 'vocabulary')
    for (const part of v.split(/\s+/)) if (looksLikeName(part)) addTerm(terms, part, 'vocabulary')
  }
  const corrections = Object.entries(input.corrections).slice(0, CONTEXT_LIMITS.corrections).map(([heard, written]) => ({ heard, written }))
  for (const c of corrections) addTerm(terms, c.written, 'correction')
  const speakers = [...new Set(input.speakers.map(s => s.trim()).filter(s => s && !SPEAKER_TOKENS.has(s.toLowerCase()) && !/^Unidentified \d+$/.test(s)))].slice(0, CONTEXT_LIMITS.speakers)
  for (const s of speakers) {
    addTerm(terms, s, 'speaker')
    for (const part of s.split(/\s+/)) if (looksLikeName(part)) addTerm(terms, part, 'speaker')
  }
  const attendees = [...new Set(input.attendees.map(s => s.trim()).filter(s => s && !SPEAKER_TOKENS.has(s.toLowerCase())))].slice(0, 40)
  for (const a of attendees) {
    addTerm(terms, a, 'attendee')
    for (const part of a.split(/\s+/)) if (looksLikeName(part)) addTerm(terms, part, 'attendee')
  }
  if (input.owner) {
    addTerm(terms, input.owner.name, 'owner')
    for (const part of input.owner.name.split(/\s+/)) if (looksLikeName(part)) addTerm(terms, part, 'owner')
    if (input.owner.notes) for (const t of extractTerms(input.owner.notes, 60)) addTerm(terms, t, 'owner')
  }
  const files: ContextPack['files'] = []
  for (const file of input.files.slice(0, CONTEXT_LIMITS.files)) {
    const text = redactSecrets(file.text.slice(0, CONTEXT_LIMITS.fileChars))
    const name = file.name.replace(/[\u0000-\u001f]/g, ' ').slice(0, 120)
    for (const t of extractTerms(text)) addTerm(terms, t, 'file', name)
    files.push({ name, excerpt: text.replace(/\s+/g, ' ').trim().slice(0, CONTEXT_LIMITS.fileExcerptChars) })
  }
  const screen = input.screen.map(l => ({ ...l, text: redactSecrets(l.text) }))
  for (const line of screen.slice(0, 2_000)) for (const t of extractTerms(line.text, 20)) addTerm(terms, t, 'screen', line.app)
  const notes = (input.notes ?? []).slice(0, CONTEXT_LIMITS.notes).map(n => ({ ...n, title: redactSecrets(n.title).slice(0, 120), snippet: redactSecrets(n.snippet).replace(/\s+/g, ' ').slice(0, CONTEXT_LIMITS.noteChars) }))
  for (const n of notes) for (const t of extractTerms(`${n.title}. ${n.snippet}`, 40)) addTerm(terms, t, 'notes', n.ref)
  return {
    title: redactSecrets(input.title).slice(0, 200),
    date: input.date.slice(0, 40),
    attendees,
    speakers,
    owner: input.owner,
    vocabulary,
    corrections,
    files,
    screen,
    notes,
    terms,
  }
}

/** Add notes found after the pack was built (the search is async and runs only for spans' names). */
export function addNotes(pack: ContextPack, notes: CleanupNote[]): void {
  for (const n of notes.slice(0, CONTEXT_LIMITS.notes - pack.notes.length)) {
    const note = { ...n, title: redactSecrets(n.title).slice(0, 120), snippet: redactSecrets(n.snippet).replace(/\s+/g, ' ').slice(0, CONTEXT_LIMITS.noteChars) }
    pack.notes.push(note)
    for (const t of extractTerms(`${note.title}. ${note.snippet}`, 40)) addTerm(pack.terms, t, 'notes', note.ref)
  }
}

/** A term the dictionary already holds (vocabulary, a correction's written form) is never suggested. */
export function inDictionary(term: ContextTerm): boolean {
  return term.sources.has('vocabulary') || term.sources.has('correction')
}

/** The evidence a term carries for a dictionary suggestion, or [] when it has none. */
export function evidenceSources(term: ContextTerm): Array<{ source: EvidenceSource; detail: string | null }> {
  const out: Array<{ source: EvidenceSource; detail: string | null }> = []
  const map: Array<[TermSource, EvidenceSource]> = [['screen', 'screen'], ['file', 'file'], ['owner', 'owner'], ['speaker', 'people'], ['attendee', 'people'], ['notes', 'notes']]
  const seen = new Set<EvidenceSource>()
  for (const [from, to] of map) {
    if (!term.sources.has(from) || seen.has(to)) continue
    seen.add(to)
    out.push({ source: to, detail: term.details.get(from)?.slice(0, 120) ?? null })
  }
  return out
}

/** Name-like targets for near-name detection and deterministic correction, each with where it came from. */
export interface NameTarget { display: string; key: string; fromMeeting: boolean }

/**
 * Single-word name targets. `fromMeeting` marks a target ONLY this meeting's screen or
 * files supplied: deterministic correction holds those to stricter rules (the source word
 * must be capitalised and not an inflection of the target), because screen text carries UI
 * labels a dictionary never would.
 */
export function nameTargets(pack: ContextPack): NameTarget[] {
  const out: NameTarget[] = []
  for (const term of pack.terms.values()) {
    if (term.display.includes(' ')) continue
    if (!/^\p{Lu}/u.test(term.display) || term.key.length < 4) continue
    const trusted = ['vocabulary', 'correction', 'speaker', 'owner', 'attendee', 'notes'].some(s => term.sources.has(s as TermSource))
    out.push({ display: term.display, key: term.key, fromMeeting: !trusted })
  }
  return out
}

/** Every known spelling, single words and phrases, folded. An exact match is not doubtful. */
export function knownKeys(pack: ContextPack): Set<string> {
  const keys = new Set<string>()
  for (const term of pack.terms.values()) {
    keys.add(term.key)
    for (const part of term.display.split(/\s+/)) {
      const k = fold(part)
      if (k.length >= 3) keys.add(k)
    }
  }
  return keys
}
