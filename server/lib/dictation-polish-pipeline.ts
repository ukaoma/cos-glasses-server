import type { DictationCleanModel } from './dictation-clean-models.js'
import { applyNegativeRules } from './hallucination-filter.js'
import { applyCorrections } from './whisper-local.js'
import { applyFuzzyCorrections } from './fuzzy-correct.js'
import { getAllSpeakerNames } from './speaker-embeddings.js'
import { autoCleanDictation, AUTOCLEAN_MAX_CHARS } from './dictation-clean.js'
import { dictationPolishPromptVersion, styleAndRegisterApply, type DictationPolishPromptVersion } from './dictation-polish-options.js'
import { fillerPassEnabled, stripFillersIfEnglish } from './dictation-fillers.js'
import { polishBudgetExhausted, recordPolishCall, type PolishBucket } from './dictation-polish-budget.js'
import { polishNeed, skipCleanEnabled } from './dictation-polish-need.js'
import { discardPolishPrewarm, PrewarmUnavailableError, runWarmPolish, takePolishPrewarm } from './dictation-prewarm.js'
import { getVocabulary, getWhisperCorrections } from './profile.js'
import { correctionOnlyForms } from './glossary-learn.js'
import { polishLinkProblem, renderSpokenPaths, spokenPathsEnabled } from './dictation-format.js'
import { customInstructionsHash, readCustomInstructions } from './dictation-polish-instructions.js'
import { learnedStyleEnabled, learnedStyleLinesFor, readLearnedStyle } from './dictation-learned-style.js'
import { literalAnswer, type DictationRegister } from './dictation-register.js'
import { meaningGuardCounts, meaningGuardEnabled, meaningGuardProblem, type MeaningGuardKind } from './dictation-meaning-guard.js'
import { createBreaker, type ClaudeBreaker } from './claude-circuit.js'
import { logTokenAudit } from './token-audit.js'

/**
 * The outbound dictation polish: the one pipeline behind POST /api/dictation/finalize and the
 * prompt-draft finalize (routes/prompt-drafts.ts). 6.91.0 moved it here, unchanged in order, so
 * the offline evals call this function itself instead of a copy of it:
 *
 *   dictionary (exact corrections and negative rules), the fuzzy name pass, the filler pass and
 *   spoken paths (not for meeting lines), the gates (disabled, too long, clean, breaker, daily
 *   cap), the model (warm when a prewarm token matches, else cold), then the guards: the link
 *   guard on every surface; for message and prompt_draft on the canaried pair only (Sonnet with
 *   prompt v4), the literal register's word check and the meaning guard.
 *
 * Meeting lines are a faithful record and stay as 6.90.0 had them: prompt v3 (or older), no
 * register, no instructions, no learned style, no meaning guard.
 */

/**
 * 6.92.0 (plan r3, A-W0a): the breakers are keyed by (model, bucket group). Meeting lines have their
 * own, so a G2 meeting that fails can no longer turn off Mac dictation and G2 message polish; message
 * and prompt_draft share the `dictation` group. Each key has two breakers:
 *
 * - failure: 2 consecutive CLI failures open it for 30 minutes, as before. A client abort (the
 *   request closed, `signal.aborted`) is neutral: it neither counts nor resets.
 * - slow: COS_DICTATION_SLOW_BREAKER_ABORTS (default 4) consecutive aborts, each after at least
 *   SLOW_ABORT_MIN_MODEL_MS of model time, with no success between, open it for
 *   COS_DICTATION_SLOW_BREAKER_MS (default 300000, 5 minutes). An abort sooner than that (a disconnect
 *   right after a sidecar restart) does not count.
 *
 * Either one open skips the polish as `breaker_open`; any success closes both.
 */
export type PolishBreakerGroup = 'dictation' | 'meeting'
export const SLOW_ABORT_MIN_MODEL_MS = 4_000

export function breakerGroupFor(bucket: PolishBucket): PolishBreakerGroup {
  return bucket === 'meeting' ? 'meeting' : 'dictation'
}

function envPositiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim() ?? ''
  if (!/^\d+$/.test(trimmed)) return fallback
  const value = Number(trimmed)
  return value > 0 ? value : fallback
}
export const slowBreakerAborts = (env: NodeJS.ProcessEnv = process.env) => envPositiveInt(env.COS_DICTATION_SLOW_BREAKER_ABORTS, 4)
export const slowBreakerMs = (env: NodeJS.ProcessEnv = process.env) => envPositiveInt(env.COS_DICTATION_SLOW_BREAKER_MS, 300_000)

interface PolishBreakers { failure: ClaudeBreaker; slow: ClaudeBreaker }
const BREAKER_MODELS = ['sonnet', 'luna-5.6-fast', 'haiku'] as const
function breakersFor(group: PolishBreakerGroup): Record<DictationCleanModel, PolishBreakers> {
  return Object.fromEntries(BREAKER_MODELS.map(model => {
    const label = `dictation-autoclean-${model === 'luna-5.6-fast' ? 'luna' : model}${group === 'meeting' ? '-meeting' : ''}`
    return [model, {
      failure: createBreaker({ label }),
      slow: createBreaker({ label: `${label}-slow`, maxFailures: () => slowBreakerAborts(), cooldownMs: () => slowBreakerMs() }),
    }]
  })) as Record<DictationCleanModel, PolishBreakers>
}
export const autoCleanBreakers: Record<PolishBreakerGroup, Record<DictationCleanModel, PolishBreakers>> = {
  dictation: breakersFor('dictation'),
  meeting: breakersFor('meeting'),
}

export function polishBreakersFor(model: DictationCleanModel, bucket: PolishBucket): PolishBreakers {
  return autoCleanBreakers[breakerGroupFor(bucket)][model]
}

/** The keyed breakers for this model and bucket: open when either is. The prewarm route asks this too. */
export function polishBreakerOpen(model: DictationCleanModel, bucket: PolishBucket): boolean {
  const breakers = polishBreakersFor(model, bucket)
  return breakers.failure.isOpen() || breakers.slow.isOpen()
}
const autoCleanDefaultEnabled = () => ['1', 'true', 'on'].includes((process.env.COS_DICTATION_AUTOCLEAN ?? '').toLowerCase())

/** 6.79.1, additive on finalize answers: why the polish model did not run (or did not finish).
 * 6.91.0: a guard that refuses the model's answer says "failed" too (link_guard keeps its own
 * code), so 0.5.325 to 0.5.343 log fillers_only:failed and never claim polish. */
export type PolishSkipped = 'disabled' | 'too_long' | 'breaker_open' | 'daily_cap' | 'failed' | 'clean' | 'link_guard'
/** 6.79.2, additive when finalize was given a prewarmToken: what became of that warm process. */
export type PrewarmOutcome = 'used' | 'missed' | 'discarded'
/** 6.91.0, additive, present exactly when the model answered: what became of its answer. */
export type PolishOutcome = 'polished' | 'unchanged' | 'guarded'
export type PolishGuard = 'link' | 'literal' | MeaningGuardKind
/** 6.91.0, additive: the prompt the model ran, as a closed set (v1 and v2 are not reported). */
export type PolishPrompt = 'v3' | 'v4'

export interface AutoCleanRequest { enabled?: boolean; model?: DictationCleanModel }
export type OutboundOptions = AutoCleanRequest & {
  bucket: PolishBucket
  signal?: AbortSignal
  prewarmToken?: string
  /** 6.91.0: the target app's register (finalize reads it from `context.app`). */
  register?: DictationRegister
  /** Offline evals only: the prompt to use instead of the configured one. */
  promptVersion?: DictationPolishPromptVersion
}

/** 6.85.0 and 6.91.0: additive, present only when the model was given them. */
export interface PolishInstructionsUse {
  customInstructions?: true
  instructionsHash?: string
  learnedStyle?: true
  learnedStyleHash?: string
  /** 6.91.0: the register the model was given, only on a pair the register was canaried on (Sonnet with v4). */
  polishRegister?: DictationRegister
  /** 6.91.0: the prompt the model ran (v3 or v4), whenever the model was called. */
  polishPrompt?: PolishPrompt
  /** 6.91.0: false whenever the model was called without the learned style. */
  learnedStyleOff?: true
}
export type PolishResult = {
  text: string
  polishSkipped?: PolishSkipped
  prewarm?: PrewarmOutcome
  polishOutcome?: PolishOutcome
  guard?: PolishGuard
  /** Never sent by a route: the model's own answer, before any guard (the offline evals score it). */
  modelText?: string
} & PolishInstructionsUse

export async function cleanOutboundDictation(
  text: string,
  opts: OutboundOptions,
): Promise<PolishResult> {
  const result = await polishOutboundDictation(text, opts)
  // A warm process the model call did not take must not sit until its TTL.
  if (opts.prewarmToken && !result.prewarm) {
    return { ...result, prewarm: discardPolishPrewarm(opts.prewarmToken) ? 'discarded' : 'missed' }
  }
  return result
}

/**
 * 6.85.0: the user's polish instructions apply to dictation (Mac dictation and G2 messages, which
 * are surface "message", and prompt drafts). Meeting lines are a faithful record, so they stay on
 * the built-in rules alone, the same way they skip the filler pass and spoken paths.
 */
export function polishInstructionsFor(bucket: PolishBucket): string {
  return bucket === 'meeting' ? '' : readCustomInstructions().customInstructions
}

/**
 * 6.91.0: the learned style for one polish: the lines for its register and the setting's hash.
 * Never for meeting lines or a literal target, and nothing at all when the server switch
 * (COS_DICTATION_LEARNED_STYLE=0) or the person's own switch (enabled: false) is off.
 */
export function learnedStyleFor(bucket: PolishBucket, register: DictationRegister): { lines: string; hash: string } {
  if (bucket === 'meeting' || !learnedStyleEnabled()) return { lines: '', hash: '' }
  const stored = readLearnedStyle()
  const lines = learnedStyleLinesFor(stored, register)
  return lines ? { lines, hash: stored.hash } : { lines: '', hash: '' }
}

/**
 * 6.91.0: the prompt for one polish. The configured prompt for its model (v4 on Sonnet, v3 on Haiku,
 * Luna or anything else, unless the environment or "Previous polish" says otherwise); meeting lines
 * never take v4.
 */
export function polishPromptVersionFor(bucket: PolishBucket, wanted?: DictationPolishPromptVersion, model?: string): DictationPolishPromptVersion {
  const version = wanted ?? dictationPolishPromptVersion(process.env, model)
  return bucket === 'meeting' && version === 'v4' ? 'v3' : version
}

/** The deterministic passes, in route order: what the model is given ("cleaned"). */
export function prepareOutboundDictation(text: string, bucket: PolishBucket): string {
  let cleaned = applyNegativeRules(applyCorrections(text)).replace(/\s+/g, ' ').trim() || text
  // applyCorrections above is an EXACT string map, so it only fixes misspellings someone
  // already hand-authored. A novel miss ("Rileyy" for Riley, "Exampel" for Example) sails
  // through it. The Levenshtein pass is what catches those, and until now it had exactly
  // ONE call site — transcribe-audio.ts:252, the server-transcription route — so phone
  // Moonshine dictation, which arrives here as text, never got it. Same construction and
  // same non-fatal posture as that site, deliberately: targets are speaker names plus
  // vocabulary, and a throw must never cost the user their transcript.
  //
  // Runs BEFORE the autoclean LLM so the model sees corrected proper nouns rather than
  // being asked to guess at them, and it still helps on every path where autoclean is
  // off, over the char cap, or breaker-open.
  try {
    const fuzzyTargets = [...getAllSpeakerNames(), ...getVocabulary()]
    const { text: corrected, replacements } = applyFuzzyCorrections(cleaned, fuzzyTargets)
    if (replacements > 0) {
      console.log(`[prompt-draft] Fuzzy corrected ${replacements} word(s)`)
      cleaned = corrected
    }
  } catch (fuzzyErr: any) {
    console.warn(`[prompt-draft] Fuzzy correction failed (non-fatal): ${fuzzyErr?.message ?? fuzzyErr}`)
  }
  // 6.79.1: um/uh never survive a skipped polish. Meeting lines stay faithful.
  // 6.92.0: only when the text is mostly English ("um 5 Uhr" and "um carro" are words).
  if (bucket !== 'meeting' && fillerPassEnabled()) cleaned = stripFillersIfEnglish(cleaned)
  // 6.83.1: "forward slash pricing," is "/pricing," even when the model is skipped. One word
  // at a phrase end only; slugs of several words are the model's (dictation-format.ts).
  if (bucket !== 'meeting' && spokenPathsEnabled()) cleaned = renderSpokenPaths(cleaned)
  return cleaned
}

/**
 * 6.91.0: the guards after the model, for one answer. Pure apart from reading the dictionary.
 * `text` is what goes out: the answer (repaired for a literal target), or `cleaned` when a guard
 * refused it. The link guard runs on every answer, as in 6.83.1. The literal check and the meaning
 * guard run only on the canaried pair (Sonnet with prompt v4, `canaried`), never on meeting lines:
 * Haiku, Luna, any other model and prompt v3 (the environment or "Previous polish") get 6.90.0's
 * answer, guard for guard.
 */
export function guardPolishAnswer(
  cleaned: string, polished: string, bucket: PolishBucket, register: DictationRegister, canaried: boolean,
): { text: string; outcome: PolishOutcome; guard?: PolishGuard; polishSkipped?: PolishSkipped } {
  // 6.83.1: the model never invents a link and never drops one the dictionary wrote. Its
  // answer is refused (the pre-polish text goes out, polishSkipped "link_guard") rather than
  // pasting a URL nobody said. The call still counted: it ran.
  const linkProblem = polished ? polishLinkProblem(cleaned, polished, correctionOnlyForms(getWhisperCorrections()), getVocabulary()) : null
  if (linkProblem) {
    console.warn(`[prompt-draft] auto-clean answer refused: ${linkProblem}`)
    return { text: cleaned, outcome: 'guarded', guard: 'link', polishSkipped: 'link_guard' }
  }
  let answer = polished || cleaned
  if (canaried && bucket !== 'meeting') {
    // 6.91.0: a terminal gets the speaker's words. Anything but fillers, stutters, punctuation and
    // case changed means the input goes out; otherwise the input's casing is put back and no
    // closing period is added (dictation-register.ts literalAnswer).
    if (register === 'literal') {
      const literal = literalAnswer(cleaned, answer)
      if (literal === null) {
        console.warn('[prompt-draft] auto-clean answer guarded: literal')
        return { text: cleaned, outcome: 'guarded', guard: 'literal', polishSkipped: 'failed' }
      }
      answer = literal || cleaned
    }
    // 6.91.0: nor may it lose (or add) a negation, number, date or name the speaker kept. A
    // self-correction may drop what it replaced. Counts only in the log, never a word.
    if (meaningGuardEnabled()) {
      let problem: ReturnType<typeof meaningGuardProblem>
      try {
        problem = meaningGuardProblem(cleaned, answer, [...getVocabulary(), ...getAllSpeakerNames()])
      } catch {
        // A guard that could not read the answer does not vouch for it.
        console.warn('[prompt-draft] auto-clean answer guarded: unverified')
        return { text: cleaned, outcome: 'guarded', polishSkipped: 'failed' }
      }
      if (problem) {
        console.warn(`[prompt-draft] auto-clean answer guarded: ${meaningGuardCounts(problem)}`)
        return { text: cleaned, outcome: 'guarded', guard: problem.kind, polishSkipped: 'failed' }
      }
    }
  }
  return { text: answer, outcome: answer !== cleaned ? 'polished' : 'unchanged' }
}

export async function polishOutboundDictation(
  text: string,
  opts: OutboundOptions,
): Promise<PolishResult> {
  const cleaned = prepareOutboundDictation(text, opts.bucket)
  if (!(opts.enabled ?? autoCleanDefaultEnabled())) return { text: cleaned, polishSkipped: 'disabled' }
  const model = opts.model ?? 'haiku'
  const breakers = polishBreakersFor(model, opts.bucket)
  if (cleaned.length > AUTOCLEAN_MAX_CHARS) return { text: cleaned, polishSkipped: 'too_long' }
  // 6.79.2, off by default: nothing for the model to fix (see dictation-polish-need.ts).
  if (skipCleanEnabled() && polishNeed(cleaned) === null) return { text: cleaned, polishSkipped: 'clean' }
  if (polishBreakerOpen(model, opts.bucket)) return { text: cleaned, polishSkipped: 'breaker_open' }
  if (polishBudgetExhausted(opts.bucket)) return { text: cleaned, polishSkipped: 'daily_cap' }
  const startedAt = Date.now()
  recordPolishCall(opts.bucket)
  // Read once per polish: the warm and cold paths see the same prompt.
  const meeting = opts.bucket === 'meeting'
  const promptVersion = polishPromptVersionFor(opts.bucket, opts.promptVersion, model)
  const customInstructions = polishInstructionsFor(opts.bucket)
  const instructionsHash = customInstructionsHash(customInstructions)
  // 6.91.0: the register, the learned style and the meaning guard only where they were canaried
  // (Sonnet with v4); every other pair gets none of them, so its prompt and its answer are 6.90.0's.
  // Meeting lines never reach v4 (polishPromptVersionFor), so they never get any.
  const canaried = styleAndRegisterApply(model, promptVersion)
  const register: DictationRegister = canaried ? opts.register ?? 'default' : 'default'
  const style = canaried ? learnedStyleFor(opts.bucket, register) : { lines: '', hash: '' }
  const used: PolishInstructionsUse = {
    ...(customInstructions ? { customInstructions: true, instructionsHash } : {}),
    ...(style.lines ? { learnedStyle: true, learnedStyleHash: style.hash } : { learnedStyleOff: true }),
    ...(canaried ? { polishRegister: register } : {}),
    ...(promptVersion === 'v3' || promptVersion === 'v4' ? { polishPrompt: promptVersion } : {}),
  }
  const promptExtras = { customInstructions, learnedStyle: style.lines, register, promptVersion }
  // 6.79.2: a warm process started at key press answers without the CLI's start-up cost.
  const warmEntry = opts.prewarmToken ? takePolishPrewarm(opts.prewarmToken, model) : null
  let prewarm: PrewarmOutcome | undefined = opts.prewarmToken ? 'missed' : undefined
  // 6.92.0 QA S1: the model time of an abort is stamped when the abort happens, not in the catch,
  // which runs only after the provider process is terminated (up to 4 s on the cold path).
  let abortedAt: number | null = null
  const onAbort = () => { abortedAt = Date.now() }
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let polished: string | null = null
    if (warmEntry) {
      try {
        polished = (await runWarmPolish(warmEntry, cleaned, getVocabulary(), { signal: opts.signal, ...promptExtras })).trim()
        prewarm = 'used'
      } catch (err) {
        // Nothing was sent: the cold path below is the same call, not a second one.
        if (!(err instanceof PrewarmUnavailableError)) throw err
      }
    }
    if (polished === null) polished = (await autoCleanDictation(cleaned, getVocabulary(), { model, signal: opts.signal, ...promptExtras })).trim()
    // An empty answer is a failed polish, as 6.90.0 reported it (both model paths already refuse
    // one; this holds if either ever stops): the input goes out, polishSkipped "failed", and the
    // breaker counts it. Never "unchanged".
    if (!polished) throw new Error('Auto-clean returned empty text')
    breakers.failure.recordSuccess()
    breakers.slow.recordSuccess()
    const guarded = guardPolishAnswer(cleaned, polished, opts.bucket, register, canaried)
    logTokenAudit({
      source: 'g2-dictation-autoclean', model, inputChars: cleaned.length, outputChars: polished.length,
      durationMs: Date.now() - startedAt, caller: `dictation_autoclean_${opts.bucket}`,
      polishInstructions: { on: Boolean(customInstructions), hash: instructionsHash },
      // 6.91.0: codes and a hash only, never the app name or a word.
      learnedStyle: { on: Boolean(style.lines), hash: style.hash },
      ...(canaried ? { polishRegister: register } : {}),
      ...(used.polishPrompt ? { polishPrompt: used.polishPrompt } : {}),
      polishOutcome: guarded.outcome, ...(guarded.guard ? { polishGuard: guarded.guard } : {}),
    })
    return {
      text: guarded.text, ...(prewarm ? { prewarm } : {}),
      ...(guarded.polishSkipped ? { polishSkipped: guarded.polishSkipped } : {}),
      polishOutcome: guarded.outcome, ...(guarded.guard ? { guard: guarded.guard } : {}),
      modelText: polished, ...used,
    }
  } catch (err: any) {
    if (opts.signal?.aborted) {
      // 6.92.0: the client went away (Control stopped waiting, the phone closed the request). Not a
      // CLI failure: only the slow breaker hears it, and only after real model time. The audit row
      // says `aborted`, codes only; the answer (nobody reads it) keeps PolishOutcome's three values.
      const durationMs = (abortedAt ?? Date.now()) - startedAt
      if (durationMs >= SLOW_ABORT_MIN_MODEL_MS) breakers.slow.recordFailure()
      logTokenAudit({
        source: 'g2-dictation-autoclean', model, inputChars: cleaned.length, outputChars: 0,
        durationMs, caller: `dictation_autoclean_${opts.bucket}`,
        // Key order differs from the answered row's on purpose: each gate anchor matches one row.
        polishInstructions: { hash: instructionsHash, on: Boolean(customInstructions) },
        learnedStyle: { hash: style.hash, on: Boolean(style.lines) },
        ...(canaried ? { polishRegister: register } : {}),
        ...(used.polishPrompt ? { polishPrompt: used.polishPrompt } : {}),
        polishOutcome: 'aborted',
      })
      console.warn('[prompt-draft] auto-clean aborted by the client (glossary-only)')
    } else {
      breakers.failure.recordFailure()
      console.warn(`[prompt-draft] auto-clean failed (glossary-only): ${err?.message ?? err}`)
    }
    return { text: cleaned, polishSkipped: 'failed', ...(prewarm ? { prewarm } : {}), ...used }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
