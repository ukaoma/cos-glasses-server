// Whisper hallucination detection + stripping.
// Extracted from transcribe-stream.ts so /api/transcribe (one-shot message query)
// can apply the same filters the streaming meeting path uses.
//
// Two surfaces:
//   stripInlineHallucinations(text, sessionId) — streaming path; maintains per-session
//     frequency map and promotes "Name:" patterns to a blocklist after N chunks.
//   stripInlineHallucinationsOneShot(text) — one-shot path; applies sound-descriptor
//     + known-name stripping WITHOUT per-session state (no learning benefit on a
//     single-chunk request).
//   isFullHallucination(text) — returns true if the text IS a hallucination in its
//     entirety (silence artifacts, caption training, foreign script, filler-only).

import { getNegativeRules, getVocabulary, getOwnerName, loadProfileField } from './profile.js'

// ── Whole-chunk silence hallucinations ─────────────────────────────────────
const KNOWN_HALLUCINATIONS = [
  /^subtitles?\s+by\b/i,
  /\blike\s+and\s+subscribe\b/i,
  /\bthanks?\s+for\s+watching\b/i,
  /\bplease\s+subscribe\b/i,
  /\bdon'?t\s+forget\s+to\s+subscribe\b/i,
  /\bsee\s+you\s+(next|in\s+the)\b/i,
  /\bthe\s+end\.?\s*$/i,
  /^\s*\*[^*\n]{1,40}\*\s*$/,
  /^\s*\[[^\]\n]{1,40}\]\s*$/,
  /^\s*♪+\s*[^♪\n]{0,40}\s*♪+\s*$/,
]

// ── Inline "Name:" detector (session-aware in streaming, static in one-shot) ──
const INLINE_HALLUCINATION_THRESHOLD = 3
// Seed list of known Whisper "Name:" training artifacts. Empty by default — the
// streaming path auto-learns repeated artifacts after N chunks, and users can add
// their own via the negative-rules glossary (see applyNegativeRules below).
const KNOWN_INLINE_HALLUCINATIONS = new Set<string>()

const inlineNameFrequency = new Map<string, Map<string, number>>()
const inlineBlocklist = new Map<string, Set<string>>()

/**
 * Release per-session hallucination state. Call when a session ends or during
 * periodic cleanup sweeps so long-running processes don't leak memory.
 */
export function clearSessionHallucinationState(sessionId: string): void {
  inlineNameFrequency.delete(sessionId)
  inlineBlocklist.delete(sessionId)
}

const INLINE_NAME_PATTERN = /\b([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*:/g

// ── Sound descriptor hallucinations (caption training leakage) ────────────
const SOUND_DESCRIPTORS = [
  'music', 'sad music', 'upbeat music', 'dramatic music', 'tense music',
  'soft music', 'somber music', 'gentle music', 'soothing music', 'slow music',
  'music playing', 'music fades', 'music continues', 'music stops', 'music ends',
  'applause', 'laughter', 'laughs', 'laughing', 'cheering', 'clapping',
  'sighs', 'sighing', 'coughs', 'coughing', 'breathing', 'sneezes',
  'silence', 'inaudible', 'indistinct', 'crosstalk', 'no speech',
  'blank audio', 'blank_audio', 'no_speech',
  'background noise', 'crowd noise', 'crowd cheering', 'crowd chatter',
  'indistinct chatter', 'door closes', 'door opens', 'phone rings',
  'typing', 'keyboard typing', 'footsteps',
]
const SOUND_DESCRIPTOR_ALT = SOUND_DESCRIPTORS.map(s => s.replace(/\s+/g, '\\s+')).join('|')
const SOUND_DESCRIPTOR_PATTERN = new RegExp(
  `[*\\[(♪]\\s*(?:${SOUND_DESCRIPTOR_ALT})\\s*[*\\])♪]`,
  'gi'
)
const ASTERISK_CAPTION = /\*\s*[a-z][a-z'\s]{0,35}[a-z]\s*\*/g

function stripSoundDescriptors(text: string): string {
  let cleaned = text.replace(SOUND_DESCRIPTOR_PATTERN, '')
  cleaned = cleaned.replace(ASTERISK_CAPTION, '')
  return cleaned
}

// ── Prompt dictation artifacts ─────────────────────────────────────────────
// Whisper sometimes fills short/silent dictation chunks with caption-training
// residue. Configure brand/vocab domains you want treated as silence artifacts
// here (e.g. company domains Whisper hallucinates during silence); empty by
// default. Generic one-shot dictation always preserves user-spoken URLs.
const URL_ARTIFACT_DOMAINS: string[] = []
const URL_ARTIFACT_PATTERN = URL_ARTIFACT_DOMAINS.length > 0
  ? new RegExp(
      `\\b(?:https?:\\/\\/)?(?:www\\.)?(?:${URL_ARTIFACT_DOMAINS
        .map(domain => domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})(?:\\/\\S*)?\\b`,
      'gi',
    )
  : /(?!)/gi  // no domains configured → never matches (standalone default)

// Generic URL detector — ANY domain, not just brand vocab. Used ONLY to decide if a
// whole chunk/line is nothing but a URL (the silence-hallucination shape: patreon.com,
// plastics-car.com, youtube.com, etc.). Never used to strip mid-sentence. Requires an
// explicit https://|www. prefix OR a common TLD so "U.S.", "e.g.", "v5.9.72", "a.m."
// are NOT matched as URLs.
const GENERIC_URL_PATTERN = new RegExp(
  '\\b(?:https?:\\/\\/|www\\.)[^\\s]+' +
  '|\\b[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:com|org|net|io|co|gov|edu|us|uk|tv|me|app|dev|ai|info|biz|store|shop|online|ing)\\b(?:\\/\\S*)?',
  'gi',
)
const PROMPT_DICTATION_ARTIFACTS: RegExp[] = [
  /\bTranscript\s+by\s+Rev\.com\b(?:\s+Page\s+(?:of|\d+))*\.?/gi,
  /\bThanks?\s+for\s+watching!?/gi,
  /\bThank\s+you\s+for\s+watching!?/gi,
]
const PROMPT_DICTATION_ARTIFACT_CONTEXT = /\b(?:Transcript\s+by\s+Rev\.com|Thanks?\s+for\s+watching|Thank\s+you\s+for\s+watching)\b/i

function knownDomainMatches(text: string): string[] {
  return Array.from(text.matchAll(URL_ARTIFACT_PATTERN))
    .map(match => match[0]
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, ''))
}

function shouldStripKnownDomainArtifacts(text: string): boolean {
  const domains = knownDomainMatches(text)
  if (domains.length === 0) return false
  if (PROMPT_DICTATION_ARTIFACT_CONTEXT.test(text)) return true

  const counts = new Map<string, number>()
  for (const domain of domains) counts.set(domain, (counts.get(domain) ?? 0) + 1)
  if ([...counts.values()].some(count => count >= 2)) return true

  const nonUrlWords = text
    .replace(URL_ARTIFACT_PATTERN, ' ')
    .toLowerCase()
    .replace(/[.!?,;:'"()\-\n]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return domains.length >= 3 && nonUrlWords.length <= 10
}

export function stripPromptDictationArtifacts(text: string): string {
  let cleaned = text
  for (const re of PROMPT_DICTATION_ARTIFACTS) cleaned = cleaned.replace(re, ' ')
  if (shouldStripKnownDomainArtifacts(text)) cleaned = cleaned.replace(URL_ARTIFACT_PATTERN, ' ')
  cleaned = cleaned
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/(?:^|\s+)[,.!?;:](?=\s+|$)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return cleaned
}

/**
 * Streaming variant. Maintains per-session "Name:" frequency/blocklist.
 */
export function stripInlineHallucinations(text: string, sessionId: string): string {
  if (!text) return text

  let cleaned = stripSoundDescriptors(text)

  if (!inlineNameFrequency.has(sessionId)) inlineNameFrequency.set(sessionId, new Map())
  if (!inlineBlocklist.has(sessionId)) inlineBlocklist.set(sessionId, new Set(KNOWN_INLINE_HALLUCINATIONS))
  const freq = inlineNameFrequency.get(sessionId)!
  const blocklist = inlineBlocklist.get(sessionId)!

  const namesInChunk = new Set<string>()
  let match: RegExpExecArray | null
  const patternCopy = new RegExp(INLINE_NAME_PATTERN.source, INLINE_NAME_PATTERN.flags)
  while ((match = patternCopy.exec(cleaned)) !== null) {
    const norm = match[1].toLowerCase()
    if (!namesInChunk.has(norm)) {
      namesInChunk.add(norm)
      const count = (freq.get(norm) ?? 0) + 1
      freq.set(norm, count)
      if (count >= INLINE_HALLUCINATION_THRESHOLD && !blocklist.has(norm)) {
        blocklist.add(norm)
        console.log(`[hallucination] Inline name auto-blocked after ${count} chunks (${match[1].length} chars)`)
      }
    }
  }

  for (const blocked of blocklist) {
    const escaped = blocked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const stripRe = new RegExp(`\\b${escaped}\\s*:\\s*`, 'gi')
    cleaned = cleaned.replace(stripRe, '')
  }

  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim()

  if (cleaned !== text.trim()) {
    console.log(`[hallucination] Inline strip: ${text.trim().length} chars → ${cleaned.length} chars`)
  }

  return cleaned
}

/**
 * One-shot variant (e.g., /api/transcribe for ASK voice).
 * Strips sound descriptors + well-known inline names. No per-session learning —
 * a single request has no history to build a frequency map from.
 */
export function stripInlineHallucinationsOneShot(text: string): string {
  if (!text) return text
  let cleaned = stripSoundDescriptors(text)
  for (const blocked of KNOWN_INLINE_HALLUCINATIONS) {
    const escaped = blocked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const stripRe = new RegExp(`\\b${escaped}\\s*:\\s*`, 'gi')
    cleaned = cleaned.replace(stripRe, '')
  }
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim()
  if (cleaned !== text.trim()) {
    console.log(`[hallucination] One-shot strip: ${text.trim().length} chars → ${cleaned.length} chars`)
  }
  return cleaned
}

// ── Full-chunk hallucination detector ──────────────────────────────────────
const FILLER_WORDS = new Set([
  'you', 'so', 'and', 'but', 'well', 'okay', 'oh', 'uh', 'um', 'right',
  'yeah', 'yes', 'no', 'the', 'a', 'i', 'it', 'is', 'was', 'we', 'they',
  'he', 'she', 'that', 'this', 'to', 'of', 'in', 'for', 'on', 'do',
])

/**
 * Returns true if the text as a whole is a known hallucination class
 * (silence artifacts, caption training, foreign script, filler-only, low entropy).
 * Callers typically return 204 / drop the chunk when this is true.
 */
export function isFullHallucination(text: string): boolean {
  if (!text || !text.trim()) return true

  for (const re of KNOWN_HALLUCINATIONS) {
    if (re.test(text)) return true
  }
  // Foreign script in English-only context (CJK, Arabic, Devanagari)
  if (/[　-鿿؀-ۿऀ-ॿ]/.test(text)) return true

  const clean = text.toLowerCase().replace(/[.!?,;:'"()\-\n]/g, '').replace(/\s+/g, ' ').trim()
  const words = clean.split(' ').filter(w => w)
  if (words.length === 0) return true

  const thankMatches = clean.match(/thank(?:s|\s*you)/g)
  if (thankMatches && thankMatches.length >= 3) return true

  // Filler-only chunk threshold raised 2 → 6 on 2026-04-25 after audit.
  // At length 2, this killed legitimate sentence-starts: "Yeah, this is" →
  // ['yeah','this','is'] all in FILLER_WORDS → dropped. At 6+ words of pure
  // fillers, the chunk is almost certainly a hallucination loop ("yeah yeah
  // yeah yeah yeah yeah") because real conversational sentences of 6+ short
  // words almost always include at least one content word.
  if (words.length >= 6 && words.every(w => FILLER_WORDS.has(w))) return true

  if (words.length >= 15) {
    const unique = new Set(words)
    if (unique.size / words.length < 0.3) return true
  }

  return false
}

// ── Brand-URL silence helpers ──────────────────────────────────────────────
// Reuse the URL_ARTIFACT_PATTERN / URL_ARTIFACT_DOMAINS above (the configured
// brand/vocab domains, empty by default). These power the streaming + final-transcript silence cleanup.
//
// IMPORTANT contract distinction (3 coexisting URL surfaces — keep coherent):
//   stripPromptDictationArtifacts() — prompt-draft path, context-GATED strip.
//   stripBrandUrls()                — UNCONDITIONAL brand-URL removal. Used ONLY
//     for prompt-CONTEXT hygiene (decoder priming), never to mutate stored output.
//   isBrandUrlOnly()                — true iff a chunk/line is NOTHING but brand
//     URLs. Used to DROP whole chunks/lines (output), so real speech that merely
//     mentions a brand URL ("go to example.com later") is never altered.

/** Remove brand-vocab URL tokens unconditionally. Output-safe ONLY for decoder
 *  priming context — do not use to rewrite a stored transcript line (use the
 *  drop path via isBrandUrlOnly instead, which preserves mixed real speech). */
export function stripBrandUrls(text: string): string {
  if (!text) return text
  let cleaned = text.replace(URL_ARTIFACT_PATTERN, ' ')
  cleaned = cleaned
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/(?:^|\s+)[,.!?;:](?=\s+|$)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return cleaned
}

/** True iff the text is non-empty and contains nothing but brand URLs (plus
 *  punctuation/whitespace). The classic silence hallucination shape
 *  ("www.example.com www.acme.com"). Mixed speech returns false. */
export function isBrandUrlOnly(text: string): boolean {
  if (!text || !text.trim()) return false
  return !/[a-z0-9]/i.test(stripBrandUrls(text))
}

/** True iff the text is non-empty and contains nothing but URL(s) of ANY domain
 *  (plus punctuation/whitespace) — e.g. "https://www.patreon.com", "plastics-car.com".
 *  Superset of isBrandUrlOnly. Mixed speech ("go to patreon.com later") returns false. */
export function isUrlOnly(text: string): boolean {
  if (!text || !text.trim()) return false
  return !/[a-z0-9]/i.test(text.replace(GENERIC_URL_PATTERN, ' '))
}

/** True iff the text is ONLY repeated thanks (the "Thank you! Thank you!" silence
 *  artifact). Tighter than isFullHallucination's >=3 rule so it can catch the 2x
 *  case — callers MUST AND-gate this with a silence signal (isQuiet) so a genuine
 *  soft closing is never dropped. Guards: >=2 thanks, zero content words, <=4 words.
 *  "No, thank you. Thank you." (5 words) and "thanks, appreciate it" (content word)
 *  both return false. */
export function isRepeatedThankYouOnly(text: string): boolean {
  if (!text) return false
  const clean = text.toLowerCase().replace(/[.!?,;:'"()\-\n]/g, '').replace(/\s+/g, ' ').trim()
  const words = clean.split(' ').filter(Boolean)
  if (words.length === 0 || words.length > 4) return false
  const thankMatches = clean.match(/thank(?:s|\s*you)/g)
  if (!thankMatches || thankMatches.length < 2) return false
  const content = words.filter(w => w !== 'thank' && w !== 'thanks' && w !== 'you' && !FILLER_WORDS.has(w))
  return content.length === 0
}

// ── Vocab-echo (prompt-regurgitation) hallucination ────────────────────────
// Whisper is seeded with an initial_prompt = the profile vocabulary (owner +
// brands + products + people). On silence / music / ambiguous audio it ECHOES
// that prompt, emitting the seeded terms the user never said. The brand-URL
// filters above only catch URL echoes; a bare brand-NAME echo slips through.
// This detector drops a chunk that is NOTHING but seeded vocab terms (+
// punctuation). Real speech that MENTIONS a term in a sentence keeps its
// non-vocab content words and is never dropped.
let _vocabEchoRe: RegExp | null = null

/** Bust the cached vocab matcher after a profile write. */
export function resetVocabEchoCache(): void { _vocabEchoRe = null }

function getVocabEchoMatcher(): RegExp {
  if (_vocabEchoRe) return _vocabEchoRe
  const raw = new Set<string>()
  const owner = getOwnerName()
  if (owner) raw.add(owner)
  for (const v of getVocabulary()) if (v && v.trim()) raw.add(v.trim())
  // Include whisper_corrections key/value variants so the echo matches whatever
  // spelling whisper emits ("POS Nation" ↔ "POSNation", "Jewel 360" ↔ "Jewel360").
  try {
    const corrRaw = loadProfileField('whisper_corrections', '')
    if (corrRaw) {
      const map = JSON.parse(corrRaw) as Record<string, string>
      for (const [k, val] of Object.entries(map)) { if (k) raw.add(k); if (val) raw.add(val) }
    }
  } catch { /* malformed corrections — ignore */ }
  // Only UNAMBIGUOUS terms trigger an echo drop: multi-word phrases ("POS Nation",
  // "IT Retail", "Jeremy Sokolic") and brand-shaped single tokens with an internal
  // capital or digit ("POSNation", "CaratIQ", "Jewel360"). Plain single-word tokens
  // ("Austin", "Miles", "Ukaoma") are common words / ambiguous and are EXCLUDED —
  // they carry too much false-drop risk for an always-on list rule.
  const terms = [...raw].filter(t => {
    if (t.length < 2) return false
    if (/\s/.test(t)) return true                 // multi-word phrase
    return /[A-Z0-9]/.test(t.slice(1))            // single token only if brand-shaped
  }).sort((a, b) => b.length - a.length)
  if (terms.length === 0) { _vocabEchoRe = /(?!)/g; return _vocabEchoRe }
  // Escape regex metachars; flex internal whitespace so "IT Retail" also matches
  // "ITRetail". Word-bounded so terms don't match inside larger words.
  const alt = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')).join('|')
  _vocabEchoRe = new RegExp(`\\b(?:${alt})\\b`, 'gi')
  return _vocabEchoRe
}

/** Count distinct seeded-vocab terms present in `text`. */
export function countVocabTerms(text: string): number {
  if (!text) return 0
  const re = getVocabEchoMatcher()
  re.lastIndex = 0
  const found = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    found.add(m[0].toLowerCase().replace(/\s+/g, ''))
    if (m.index === re.lastIndex) re.lastIndex++  // guard against a zero-width match loop
  }
  return found.size
}

/** True iff `text` is non-empty and contains NOTHING but seeded vocab terms (plus
 *  punctuation/whitespace) — the prompt-echo hallucination shape. Any non-vocab
 *  content word (incl. connectives like "and"/"the") makes it real speech → false. */
export function isVocabEchoOnly(text: string): boolean {
  if (!text || !text.trim()) return false
  if (countVocabTerms(text) === 0) return false
  const residual = text.replace(getVocabEchoMatcher(), ' ').replace(/[^a-z0-9]/gi, '')
  return residual.length === 0
}

/** Streaming-chunk silence-drop decision. Pure + exported so the gate is testable
 *  (sanitizeStreamTranscript is private). Returns a fallbackReason or null. Contract:
 *    brand-URL-only  -> 'brand_url'        DROP ALWAYS — brand URLs are vocab-seeded,
 *                                          never a real standalone meeting utterance.
 *    any-URL-only    -> 'url_silence'      DROP only when isQuiet — a clearly-dictated
 *                                          third-party URL during speech is preserved.
 *    thank-you-only  -> 'thankyou_silence' DROP only when isQuiet — soft real closings
 *                                          stay (see isRepeatedThankYouOnly).
 *  Vocab-echo (prompt regurgitation) is handled SEPARATELY in sanitizeStreamTranscript
 *  because the safe rule is session-aware (drop a silence echo or a back-to-back RUN,
 *  but keep a single loud one-off that could be a real terse brand/name list).
 *  Real speech (any chunk with content words) always returns null. */
export function streamSilenceDropReason(text: string, isQuiet: boolean): 'brand_url' | 'url_silence' | 'thankyou_silence' | null {
  if (!text || !text.trim()) return null
  if (isBrandUrlOnly(text)) return 'brand_url'
  if (isQuiet && isUrlOnly(text)) return 'url_silence'
  if (isQuiet && isRepeatedThankYouOnly(text)) return 'thankyou_silence'
  return null
}

// ── Editable negative / cleanup rules (glossary-authored) ──────────────────
// One rule per line, authored via the glossary PUT:
//   whole:<text>           drop any LINE containing <text>
//   <text>                 (bare) same as whole:
//   strip:<text>           remove <text> from the line, keep the rest
//   replace:<bad>=><good>  substitute <bad> with <good>
//   flag:<text>            no-op on text (reserved marker for review surfaces)
//   #...                   comment / ignored
// Patterns match LITERALLY (escaped) with word boundaries, case-insensitive —
// user input never reaches the regex engine as metacharacters, so there is no
// ReDoS surface. Applied ONLY on non-live surfaces (final meeting save +
// outbound dictation finalize), NEVER on the live per-chunk decode path.
interface NegRule {
  kind: 'whole' | 'strip' | 'replace' | 'flag'
  test?: RegExp    // non-global — whole/flag line matching
  search?: RegExp  // global — strip/replace substitution
  replacement: string
}

function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Literal matcher with conditional word boundaries: a \b is added only on an
// edge that is a word character, so word-ish patterns ("um") don't match inside
// other words ("summary") while punctuation patterns ("(a+)+", ".com") still
// match. The body is escaped, so user input never injects regex metacharacters.
function literalMatcher(body: string, global: boolean): RegExp {
  const lead = /^\w/.test(body) ? '\\b' : ''
  const trail = /\w$/.test(body) ? '\\b' : ''
  return new RegExp(`${lead}${escapeRegexLiteral(body)}${trail}`, global ? 'gi' : 'i')
}

export function parseNegativeRules(raw: string[]): NegRule[] {
  const out: NegRule[] = []
  for (const lineRaw of raw) {
    const line = (lineRaw || '').trim()
    if (!line || line.startsWith('#')) continue
    let kind: NegRule['kind'] = 'whole'
    let body = line
    const colon = line.indexOf(':')
    if (colon > 0) {
      const prefix = line.slice(0, colon).toLowerCase()
      if (prefix === 'whole' || prefix === 'strip' || prefix === 'replace' || prefix === 'flag') {
        kind = prefix
        body = line.slice(colon + 1).trim()
      }
    }
    if (!body) continue
    try {
      if (kind === 'replace') {
        const arrow = body.indexOf('=>')
        if (arrow < 0) continue
        const bad = body.slice(0, arrow).trim()
        const good = body.slice(arrow + 2).trim()
        if (!bad) continue
        out.push({ kind, search: literalMatcher(bad, true), replacement: good })
      } else if (kind === 'strip') {
        out.push({ kind, search: literalMatcher(body, true), replacement: '' })
      } else {
        out.push({ kind, test: literalMatcher(body, false), replacement: '' })
      }
    } catch { /* escaped input shouldn't throw; skip defensively */ }
  }
  return out
}

/** Apply editable negative rules to text. Drops whole lines (whole/bare),
 *  strips/replaces inline, ignores flag. Per-rule try/catch so one bad rule
 *  can't break the pass. Never empties a non-empty input (mirrors
 *  cleanTranscriptLines). `rawRules` defaults to the profile's negative_rules. */
export function applyNegativeRules(text: string, rawRules?: string[]): string {
  if (!text) return text
  const rules = parseNegativeRules(rawRules ?? getNegativeRules())
  if (rules.length === 0) return text
  const kept: string[] = []
  for (const line of text.split('\n')) {
    let working = line
    let dropped = false
    for (const r of rules) {
      try {
        if (r.kind === 'whole') {
          if (r.test!.test(working)) { dropped = true; break }
        } else if (r.kind === 'strip' || r.kind === 'replace') {
          working = working.replace(r.search!, r.replacement)
        }
        // 'flag' — no text mutation (reserved for review surfaces)
      } catch { /* one bad rule never breaks the whole pass */ }
    }
    if (dropped) continue
    if (working !== line) working = working.replace(/[ \t]{2,}/g, ' ').trim()
    kept.push(working)
  }
  const cleaned = kept.join('\n')
  return cleaned.trim() ? cleaned : text  // never empty a non-empty input
}

/** Validate one user-authored rule line for the glossary PUT. Patterns are
 *  literal, so the only failures are structural (oversized / malformed replace /
 *  empty body). Returns ok or an error string (route rejects with 400). */
export function validateNegativeRule(lineRaw: string): { ok: true } | { ok: false; error: string } {
  const line = (lineRaw || '').trim()
  if (!line || line.startsWith('#')) return { ok: true }
  if (line.length > 200) return { ok: false, error: 'rule too long (max 200 chars)' }
  const colon = line.indexOf(':')
  const prefix = colon > 0 ? line.slice(0, colon).toLowerCase() : ''
  if (prefix === 'whole' || prefix === 'strip' || prefix === 'replace' || prefix === 'flag') {
    const body = line.slice(colon + 1).trim()
    if (!body) return { ok: false, error: `"${prefix}:" rule has an empty body` }
    if (prefix === 'replace' && body.indexOf('=>') < 0) return { ok: false, error: 'replace rule must be "replace:bad=>good"' }
  }
  return { ok: true }
}

/** Final-transcript cleanup for the saved meeting markdown. First applies the
 *  editable negative rules, then drops a LINE only when its content (with any
 *  "[Speaker]:" label stripped) is NOTHING but URL(s) of any domain — the
 *  saved-notes silence artifact (brand URLs AND patreon/youtube/etc.). Real
 *  sentences are never touched, even if they mention a URL ("go to example.com
 *  later" is kept), and blank lines / speaker labels are preserved. Deliberately
 *  does NOT run isFullHallucination here: that filter's caption regexes ("see you
 *  next", "the end", "thanks for watching") match legitimate meeting closings, and
 *  the final batch/correction text — unlike streaming chunks — has no audio-volume
 *  context to gate them safely. Returns the original transcript unchanged if
 *  cleaning would empty a non-empty input (degenerate guard — never write blank). */
export function cleanTranscriptLines(transcript: string): string {
  if (!transcript || !transcript.trim()) return transcript
  const afterRules = applyNegativeRules(transcript)  // whole/strip/replace first
  const kept: string[] = []
  for (const line of afterRules.split('\n')) {
    const m = line.match(/^(\[[^\]]+\]:\s*)?([\s\S]*)$/)
    const content = (m?.[2] ?? line).trim()
    if (content && isUrlOnly(content)) continue   // drop URL-only line (label included)
    kept.push(line)
  }
  const cleaned = kept.join('\n').trim()
  return cleaned ? cleaned : transcript
}
