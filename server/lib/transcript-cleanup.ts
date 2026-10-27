// Transcript cleanup (6.77.0): a post-save pass that resolves the words a transcription
// engine was unsure about, using the meeting's text and screen context.
//
// Miles, 2026-10-17: "We need the ability to run a Sonnet or a Haiku to clean up some of
// those passages where we're unsure. It should have some screen awareness as well as some
// textual awareness so that the word hallucinations are resolved."
//
// WHERE IT RUNS. Once per saved meeting, from the durable finalization job (routes/
// meeting.ts), after the HQ batch transcript and the Nemotron relabel are written and
// BEFORE the meeting is handed to COS operations or summarised, so both see cleaned text.
// NEVER during live transcription: no transcription module imports this file (Miles's rule
// "Transcription MUST NEVER call claude -p"; pinned by a test), and a meeting whose session
// is still live is skipped.
//
// WHAT IT DOES.
//   1. Reads the saved `## Transcript` and the sidecar's batch words (confidence, time).
//   2. Builds the context pack (transcript-cleanup-context.ts).
//   3. Deterministic fixes: fuzzy-correct with the dictionary and this meeting's own screen
//      and file terms (transcript-cleanup-spans.ts). Free.
//   4. Picks the doubtful spans with no model (transcript-cleanup-spans.ts).
//   5. One batched model call for the spans, unless a stop applies (transcript-cleanup-
//      state.ts); every proposed edit is validated (transcript-cleanup-model.ts).
//   6. Applies fixes and accepted edits through the undoable ledger
//      (transcript-cleanup-ledger.ts) and records dictionary suggestions for written forms
//      the meeting's context supplied (transcript-cleanup-suggestions.ts).
//   7. One trace row: counts, tokens and milliseconds. No transcript text, no screen text,
//      no names in any log line.

import { existsSync, mkdirSync, appendFileSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { LensGistLimitError, runLensGistEngine } from './lens-gist-engines.js'
import { resolveProviderBinary } from './provider-binary.js'
import { getVocabulary, getWhisperCorrections } from './profile.js'
import { ownerCardFromProfile, type OwnerCard } from './meeting-ask-owner.js'
import { alignWordInfo, fold, joinTranscriptLines, parseTranscriptLines, tokenize, wordInfoFromSidecar } from './transcript-cleanup-text.js'
import { addNotes, buildContextPack, evidenceSources, inDictionary, knownKeys, nameTargets, type CleanupFile, type CleanupNote, type ContextPack } from './transcript-cleanup-context.js'
import { deterministicFixes, selectSpans, type SpanReason } from './transcript-cleanup-spans.js'
import { buildCleanupPrompt, CLEANUP_SYSTEM, MODEL_LIMITS, parseCleanupReply, validateCleanupEdits, type RejectReason } from './transcript-cleanup-model.js'
import {
  appendLedger, applyPlannedEdits, alreadyCleaned, commitCleanTranscript, CleanupWriteError, newEditId, newRunId,
  readTranscriptSection, sha256, type AppliedEdit, type PlannedEdit,
} from './transcript-cleanup-ledger.js'
import { cleanupLimits, resolveCleanupModel, resolveCleanupSwitch, transcriptCleanupBudget, transcriptCleanupSettings, type TranscriptCleanupBudget, type TranscriptCleanupSettings } from './transcript-cleanup-state.js'
import { suggestionStore, type SuggestionStore } from './transcript-cleanup-suggestions.js'
import { cleanupDir, readScreenContext, type ScreenLine } from './transcript-cleanup-screen.js'

export interface ModelRun { text: string; inputTokens?: number; outputTokens?: number; model?: string }

export interface CleanupDeps {
  env: NodeJS.ProcessEnv
  now: () => Date
  settings: TranscriptCleanupSettings
  budget: TranscriptCleanupBudget
  suggestions: SuggestionStore
  sessionLive: (sessionId: string) => boolean
  claudeAvailable: () => boolean
  callModel: (modelId: string, system: string, prompt: string, opts: { timeoutMs: number; maxOutputTokens: number }) => Promise<ModelRun>
  speakers: () => Promise<string[]> | string[]
  vocabulary: () => string[]
  corrections: () => Record<string, string>
  owner: () => OwnerCard | null
  files: (sessionId: string) => Promise<CleanupFile[]> | CleanupFile[]
  screen: (sessionId: string) => ScreenLine[]
  searchNotes: (queries: string[], sessionId: string, signal: AbortSignal) => Promise<CleanupNote[]>
  trace: (row: CleanupTrace) => void
}

export interface CleanupTrace {
  at: string
  sessionId: string
  runId?: string
  status: CleanupOutcome['status']
  reason?: string
  modelSkipped?: string
  model?: string
  words: number
  aligned: number
  fixes: number
  spansFound: number
  spansSent: number
  byReason?: Record<SpanReason, number>
  accepted: number
  kept: number
  rejected: Partial<Record<RejectReason, number>>
  modelError?: string
  suggestions: number
  screenLines: number
  files: number
  notes: number
  promptChars: number
  inputTokens: number
  outputTokens: number
  modelMs: number
  ms: number
}

export interface CleanupOutcome {
  status: 'skipped' | 'done' | 'failed'
  reason?: string
  /** Set when fuzzy fixes ran but the model was not asked (correction_skipped style). */
  modelSkipped?: string
  runId?: string
  applied: number
}

export const NOTES_BUDGET_MS = 3_000
const inProgress = new Set<string>()

/** The local searches the notes lookup uses. Each one may fail or answer nothing; none leaves the Mac. */
export interface NotesSearchers {
  memories(query: string, signal: AbortSignal): Promise<Array<{ id: string; title?: string; snippet?: string }>>
  meetings(query: string, signal: AbortSignal): Promise<Array<{ recordId: string; sessionId?: string; title: string; snippet?: string }>>
  /** The memory bridge listing (cos-bridge-notes.ts): on the public memory runtime it is where the owner's notes are. */
  bridge(signal: AbortSignal): Promise<Array<{ id: string; content: string; summary?: string }>>
  score(rows: Array<{ id: string; content: string; summary?: string }>, query: string): Array<{ row: { id: string; content: string; summary?: string } }>
}

/**
 * Notes for the names the doubtful spans are near: memories and earlier meetings by keyword (never this meeting), and,
 * when memory search finds nothing for a name, the memory bridge listing scored by keyword, as the Live COS Ask does.
 */
export function createNotesSearch(searchers: NotesSearchers): CleanupDeps['searchNotes'] {
  return async (queries, sessionId, signal) => {
    const notes: CleanupNote[] = []
    const seen = new Set<string>()
    let listed: Array<{ id: string; content: string; summary?: string }> | null = null
    const push = (note: CleanupNote) => { if (!seen.has(note.ref)) { seen.add(note.ref); notes.push(note) } }
    for (const query of queries) {
      if (signal.aborted) break
      let memoryHits = 0
      try {
        for (const hit of (await searchers.memories(query, signal)).slice(0, 3)) {
          if (!hit.id) continue
          memoryHits++
          push({ id: '', ref: `memory:${hit.id}`, kind: 'memory', title: hit.title || hit.id, snippet: hit.snippet || '', query })
        }
      } catch { /* a source that fails is skipped */ }
      if (!memoryHits && !signal.aborted) {
        try {
          listed ??= await searchers.bridge(signal)
          for (const { row } of searchers.score(listed, query).slice(0, 2)) {
            push({ id: '', ref: `memory:${row.id}`, kind: 'memory', title: (row.summary || row.content.split('\n')[0] || row.id).slice(0, 120), snippet: row.content, query })
          }
        } catch { listed = [] }
      }
      if (signal.aborted) break
      try {
        for (const hit of (await searchers.meetings(query, signal)).slice(0, 3)) {
          if (!hit.recordId || hit.sessionId === sessionId) continue
          push({ id: '', ref: `meeting:${hit.recordId}`, kind: 'meeting', title: hit.title, snippet: hit.snippet || '', query })
        }
      } catch { /* skipped */ }
    }
    return notes
  }
}

const notesSearchDefault: CleanupDeps['searchNotes'] = async (queries, sessionId, signal) => {
  const [{ searchMemories }, { searchMeetingLibrary }, bridgeNotes] = await Promise.all([
    import('./context-library-search.js'), import('./meeting-library-search.js'), import('./cos-bridge-notes.js'),
  ])
  return createNotesSearch({
    memories: async (query, s) => (await searchMemories({ query, limit: 3, semantic: false, signal: s })).hits,
    meetings: async (query, s) => (await searchMeetingLibrary({ query, limit: 3, semantic: false, signal: s })).hits,
    bridge: s => bridgeNotes.listBridgeMemories(s, NOTES_BUDGET_MS),
    score: (rows, query) => bridgeNotes.scoreBridgeMemories(rows, query),
  })(queries, sessionId, signal)
}

const filesDefault: CleanupDeps['files'] = async sessionId => {
  try {
    const { MeetingAskStore } = await import('./meeting-ask-store.js')
    return new MeetingAskStore().files(sessionId).filter(f => f.status === 'ready' && typeof f.text === 'string' && f.text.trim()).map(f => ({ name: f.name, text: f.text }))
  } catch { return [] }
}

const speakersDefault: CleanupDeps['speakers'] = async () => {
  try { return (await import('./speaker-embeddings.js')).getAllSpeakerNames() } catch { return [] }
}

/** One row per meeting, rotated once at 2 MB (about 4,000 meetings) so it can never grow without bound. */
export const TRACE_MAX_BYTES = 2 * 1024 * 1024
function traceDefault(row: CleanupTrace): void {
  const file = cleanupDir('trace.jsonl')
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    try { if (statSync(file).size > TRACE_MAX_BYTES) renameSync(file, `${file}.1`) } catch { /* no file yet */ }
    appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 })
  } catch { /* best effort */ }
}

export function defaultCleanupDeps(): CleanupDeps {
  return {
    env: process.env,
    now: () => new Date(),
    settings: transcriptCleanupSettings(),
    budget: transcriptCleanupBudget(),
    suggestions: suggestionStore(),
    sessionLive: () => false,
    claudeAvailable: () => resolveProviderBinary('claude').ok,
    callModel: async (modelId, system, prompt, opts) => {
      const run = await runLensGistEngine('claude', modelId, prompt, { system, timeoutMs: opts.timeoutMs, source: 'transcript-cleanup', maxOutputTokens: opts.maxOutputTokens })
      return { text: run.text, inputTokens: run.usage?.inputTokens, outputTokens: run.usage?.outputTokens, model: run.model }
    },
    speakers: speakersDefault,
    vocabulary: () => getVocabulary(),
    corrections: () => getWhisperCorrections(),
    owner: () => ownerCardFromProfile(),
    files: filesDefault,
    screen: sessionId => readScreenContext(sessionId),
    searchNotes: notesSearchDefault,
    trace: traceDefault,
  }
}

function titleOf(markdown: string, sidecar: Record<string, unknown>): string {
  if (typeof sidecar.title === 'string' && sidecar.title.trim()) return sidecar.title.trim()
  return /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? ''
}

/** Run the cleanup for one saved meeting. Never throws: every failure is an outcome. */
export async function runTranscriptCleanup(
  input: { sessionId: string; meetingPath: string; sidecarPath: string },
  partial: Partial<CleanupDeps> = {},
): Promise<CleanupOutcome> {
  const deps: CleanupDeps = { ...defaultCleanupDeps(), ...partial }
  const started = Date.now()
  // Switch first, before ANY read or write: off means nothing happens at all.
  if (!resolveCleanupSwitch(deps.env, deps.settings).enabled) return { status: 'skipped', reason: 'switch_off', applied: 0 }

  const trace: CleanupTrace = {
    at: deps.now().toISOString(), sessionId: input.sessionId, status: 'skipped', words: 0, aligned: 0, fixes: 0, spansFound: 0, spansSent: 0,
    accepted: 0, kept: 0, rejected: {}, suggestions: 0, screenLines: 0, files: 0, notes: 0, promptChars: 0, inputTokens: 0, outputTokens: 0, modelMs: 0, ms: 0,
  }
  const finish = (outcome: CleanupOutcome): CleanupOutcome => {
    trace.status = outcome.status
    if (outcome.reason) trace.reason = outcome.reason
    if (outcome.modelSkipped) trace.modelSkipped = outcome.modelSkipped
    if (outcome.runId) trace.runId = outcome.runId
    trace.ms = Date.now() - started
    try { deps.trace(trace) } catch { /* trace is best effort */ }
    console.log(`[transcript-cleanup] ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}${outcome.modelSkipped ? ` model skipped: ${outcome.modelSkipped}` : ''}: `
      + `${trace.spansFound} spans found, ${trace.spansSent} sent, ${trace.accepted} accepted, ${Object.values(trace.rejected).reduce((a, b) => a + (b ?? 0), 0)} rejected, `
      + `${trace.fixes} fixes, ${trace.inputTokens + trace.outputTokens} tokens, ${trace.ms} ms`)
    return outcome
  }

  if (inProgress.has(input.sessionId)) return finish({ status: 'skipped', reason: 'busy', applied: 0 })
  inProgress.add(input.sessionId)
  try {
    let live = false
    try { live = deps.sessionLive(input.sessionId) } catch { live = true }
    if (live) return finish({ status: 'skipped', reason: 'session_live', applied: 0 })
    if (!existsSync(input.meetingPath) || !existsSync(input.sidecarPath)) return finish({ status: 'skipped', reason: 'meeting_missing', applied: 0 })
    const markdown = readFileSync(input.meetingPath, 'utf8')
    const sidecarText = readFileSync(input.sidecarPath, 'utf8')
    let sidecar: Record<string, unknown>
    try { sidecar = JSON.parse(sidecarText) as Record<string, unknown> } catch { return finish({ status: 'failed', reason: 'sidecar_unreadable', applied: 0 }) }
    const section = readTranscriptSection(markdown)
    if (!section || !section.trim()) return finish({ status: 'skipped', reason: 'no_transcript', applied: 0 })
    const inputSha = sha256(section)
    if (alreadyCleaned(input.sessionId, inputSha)) return finish({ status: 'skipped', reason: 'already_done', applied: 0 })

    const runId = newRunId()
    const at = () => deps.now().toISOString()
    if (!appendLedger(input.sessionId, [{ kind: 'run', runId, phase: 'intent', at: at(), inputSha }])) {
      // An unrecorded edit is exactly what the ledger exists to prevent.
      return finish({ status: 'failed', reason: 'ledger_unwritable', applied: 0 })
    }

    const lines = parseTranscriptLines(section)
    const tokens = tokenize(lines)
    trace.words = tokens.length
    trace.aligned = alignWordInfo(tokens, wordInfoFromSidecar(sidecar))
    const startMs = typeof sidecar.startTime === 'number' ? sidecar.startTime : null
    const screen = deps.screen(input.sessionId)
    const files = await deps.files(input.sessionId)
    const pack: ContextPack = buildContextPack({
      title: titleOf(markdown, sidecar),
      date: startMs !== null ? new Date(startMs).toLocaleDateString('en-CA') : '',
      attendees: Array.isArray(sidecar.speakers) ? sidecar.speakers.filter((s): s is string => typeof s === 'string') : [],
      speakers: await deps.speakers(),
      owner: deps.owner(),
      vocabulary: deps.vocabulary(),
      corrections: deps.corrections(),
      files,
      screen,
    })
    trace.screenLines = pack.screen.length
    trace.files = pack.files.length

    // Free deterministic fixes first.
    // The curated dictionary and the owner only: attendee names swapped a product for a surname on real
    // meetings (Slack to Black), so people reach the model as context and near-name spans instead.
    const strongTargets = [...pack.vocabulary, ...pack.corrections.map(c => c.written), ...(pack.owner ? [pack.owner.name] : [])]
    const targets = nameTargets(pack)
    const known = knownKeys(pack)
    const fixes = deterministicFixes(tokens, strongTargets, targets, known)
    trace.fixes = fixes.length
    for (const fix of fixes) { const t = tokens[fix.token]; t.core = fix.replacement; t.key = fold(fix.replacement) }

    const limits = cleanupLimits(deps.env)
    const selection = selectSpans(lines, tokens, targets, known, { maxSpans: limits.maxSpans, fixed: new Set(fixes.map(f => f.token)) })
    trace.spansFound = selection.found
    trace.byReason = selection.byReason

    const planned: PlannedEdit[] = fixes.map(f => ({ line: f.line, start: f.start, end: f.end, replacement: f.replacement, source: 'fuzzy' as const, reasons: [f.fromMeeting ? 'meeting_term' : 'dictionary'] }))
    let modelSkipped: string | undefined
    const model = resolveCleanupModel(deps.env, deps.settings)
    if (!selection.spans.length) modelSkipped = 'no_spans'
    else if (deps.env.ANTHROPIC_API_KEY && deps.env.COS_ALLOW_API_FALLBACK !== '1') modelSkipped = 'api_key_in_env'
    else if (!deps.claudeAvailable()) modelSkipped = 'claude_not_found'
    else modelSkipped = deps.budget.gate(limits) ?? undefined

    if (!modelSkipped) {
      // Local notes for the names the spans are near, bounded in time.
      const queries = [...new Set(selection.spans.flatMap(s => s.near))].slice(0, 4)
      if (queries.length) {
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), NOTES_BUDGET_MS)
        try {
          const found = await Promise.race([
            deps.searchNotes(queries, input.sessionId, abort.signal),
            new Promise<CleanupNote[]>(resolve => abort.signal.addEventListener('abort', () => resolve([]), { once: true })),
          ])
          addNotes(pack, found.map((n, i) => ({ ...n, id: `N${i + 1}` })))
        } catch { /* notes are optional */ } finally { clearTimeout(timer); abort.abort() }
        trace.notes = pack.notes.length
      }
      const built = buildCleanupPrompt(pack, selection.spans, startMs)
      trace.spansSent = built.sent.length
      trace.promptChars = built.chars
      trace.model = model.id
      if (!built.sent.length) modelSkipped = 'prompt_too_large'
      else if (!deps.budget.charge(limits)) modelSkipped = 'daily_calls'
      else {
        const modelStarted = Date.now()
        try {
          const run = await deps.callModel(model.id, CLEANUP_SYSTEM, built.prompt, { timeoutMs: MODEL_LIMITS.timeoutMs, maxOutputTokens: MODEL_LIMITS.maxOutputTokens })
          trace.modelMs = Date.now() - modelStarted
          trace.inputTokens = run.inputTokens ?? Math.ceil(built.chars / 4)
          trace.outputTokens = run.outputTokens ?? Math.ceil(run.text.length / 4)
          deps.budget.recordUsage(trace.inputTokens + trace.outputTokens)
          const raw = parseCleanupReply(run.text)
          deps.budget.recordSuccess()
          const checked = validateCleanupEdits(raw, selection.spans, built.sent, pack)
          trace.accepted = checked.accepted.length
          trace.kept = checked.kept
          trace.rejected = checked.rejected
          for (const { span, text } of checked.accepted) planned.push({ line: span.line, start: span.start, end: span.end, replacement: text, source: 'model', reasons: span.reasons })
        } catch (error) {
          trace.modelMs = trace.modelMs || Date.now() - modelStarted
          const limit = error instanceof LensGistLimitError
          deps.budget.recordFailure(limits, limit)
          trace.modelError = limit ? 'provider_limit' : error instanceof Error && error.message === 'no_json_edits' ? 'bad_reply' : /timed out/.test(String((error as Error)?.message)) ? 'timeout' : 'call_failed'
          modelSkipped = 'model_failed'
        }
      }
    }

    if (!planned.length) {
      appendLedger(input.sessionId, [{ kind: 'run', runId, phase: 'done', at: at(), inputSha, outputSha: inputSha, model: trace.model, ...(modelSkipped ? { modelSkipped } : {}) }])
      return finish({ status: 'done', runId, applied: 0, ...(modelSkipped ? { modelSkipped } : {}) })
    }

    const { lines: cleaned, applied } = applyPlannedEdits(lines, planned)
    const transcript = joinTranscriptLines(cleaned)
    const outputSha = sha256(transcript)
    const stamp = at()
    const editRows = applied.map(e => ({ kind: 'edit' as const, id: newEditId(), runId, at: stamp, line: e.line, offset: e.offset, original: e.original, replacement: e.replacement, before: e.before, after: e.after, lineSha: e.lineSha, source: e.source, ...(e.reasons ? { reasons: e.reasons } : {}) }))
    if (!appendLedger(input.sessionId, editRows)) return finish({ status: 'failed', reason: 'ledger_unwritable', runId, applied: 0 })
    try {
      commitCleanTranscript({
        meetingPath: input.meetingPath, sidecarPath: input.sidecarPath, markdown, sidecarText, transcript,
        summary: { version: 1, runId, at: stamp, model: trace.model ?? null, fixes: applied.filter(e => e.source === 'fuzzy').length, edits: applied.filter(e => e.source === 'model').length, liveEdits: applied.length, ...(modelSkipped ? { modelSkipped } : {}) },
      })
    } catch (error) {
      const code = error instanceof CleanupWriteError ? error.code : 'write_failed'
      appendLedger(input.sessionId, [{ kind: 'run', runId, phase: 'failed', at: at(), inputSha, reason: code }])
      return finish({ status: 'failed', reason: code, runId, applied: 0, ...(modelSkipped ? { modelSkipped } : {}) })
    }
    appendLedger(input.sessionId, [{ kind: 'run', runId, phase: 'done', at: at(), inputSha, outputSha, model: trace.model, ...(modelSkipped ? { modelSkipped } : {}) }])
    trace.suggestions = recordSuggestions(applied, pack, input.sessionId, stamp, deps)
    return finish({ status: 'done', runId, applied: applied.length, ...(modelSkipped ? { modelSkipped } : {}) })
  } catch (error) {
    console.warn(`[transcript-cleanup] failed: ${error instanceof Error ? error.name : 'error'}`)
    return finish({ status: 'failed', reason: 'error', applied: 0 })
  } finally {
    inProgress.delete(input.sessionId)
  }
}

const WORDS = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu

/**
 * A dictionary suggestion for each written form an accepted edit took from the meeting's
 * context and the dictionary lacks. The whole replacement, each word and each adjacent pair
 * are checked against the context terms.
 */
export function recordSuggestions(applied: readonly AppliedEdit[], pack: ContextPack, sessionId: string, at: string, deps: Pick<CleanupDeps, 'suggestions' | 'vocabulary' | 'corrections'>): number {
  let recorded = 0
  let vocabulary: string[] = [], corrections: string[] = []
  try { vocabulary = deps.vocabulary(); corrections = Object.values(deps.corrections()) } catch { /* treat as empty */ }
  const dictionary = new Set([...vocabulary, ...corrections].map(w => w.trim().toLowerCase()))
  for (const edit of applied) {
    const heardKeys = new Set([...edit.original.matchAll(WORDS)].map(m => fold(m[0])))
    const ws = [...edit.replacement.matchAll(WORDS)].map(m => m[0])
    // Longest first: "Faith Ukamya" is one suggestion, not that plus "Ukamya".
    const candidates = [...new Set<string>([edit.replacement, ...ws.slice(0, -1).map((w, i) => `${w} ${ws[i + 1]}`), ...ws])]
      .sort((a, b) => b.split(' ').length - a.split(' ').length)
    const covered = new Set<string>()
    for (const candidate of candidates) {
      const term = pack.terms.get(fold(candidate))
      if (!term || inDictionary(term) || heardKeys.has(term.key)) continue
      const parts = term.display.split(/\s+/).map(fold)
      if (parts.every(p => covered.has(p))) continue
      // Every source a term outside the dictionary can have is evidence (evidenceSources), and record()
      // refuses an empty list as well.
      const evidence = evidenceSources(term)
      for (const p of parts) covered.add(p)
      try {
        if (deps.suggestions.record({ written: term.display, heard: edit.original, evidence, sessionId, at, inDictionary: w => dictionary.has(w.trim().toLowerCase()) })) recorded++
      } catch { /* a suggestion is never worth failing the cleanup */ }
    }
  }
  return recorded
}
