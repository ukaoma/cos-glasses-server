// Deterministic fuzzy correction for transcribed text.
// Matches words against a canonical list of proper nouns (enrolled speakers +
// profile vocabulary) and replaces close misses using length-scaled Levenshtein.
//
// Used by:
//   - /api/transcribe       (short-form dictation / messaging)
//   - prompt drafts         (routes/prompt-drafts.ts)
//   - the post-save transcript cleanup (6.77.0, transcript-cleanup.ts), one word at
//     a time through fuzzyReplacementFor, with the meeting's own screen and file
//     terms as extra targets. Not otherwise on the meeting save path: the Phase 3.5
//     LLM pass this file once fed was deleted with the app's server fork.
//
// Zero LLM cost, ~5ms on typical dictation length.
//
// SAFETY RULES (revised after QA 2026-04-10):
//   1. Candidates: any 5+ char word (case-insensitive). This supports lowercase
//      dictation output from Whisper (short /transcribe path) AND mixed-case
//      proper nouns like product names and brands.
//   2. Stop-word list blocks common English (prevents "right"→"Wright",
//      "through"→"Brough"). Must be comprehensive — this is the primary defense.
//   3. Tight distance thresholds (1 for 5-8 char, 2 for 9-11, 3 for 12+)
//   4. Length difference ≤ 2 max (prevents long→short collapses)
//   5. Target must also be a proper noun (starts uppercase in canonical list)
//   6. Canonical min length 4 (allows short 4-character names as targets)

import { getOwnerSpeakerLabel } from './profile.js'

/** Compute Levenshtein edit distance between two lowercase strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const m = a.length, n = b.length
  let prev = new Array(n + 1).fill(0)
  let curr = new Array(n + 1).fill(0)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,           // deletion
        curr[j - 1] + 1,       // insertion
        prev[j - 1] + cost,    // substitution
      )
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

// Common English words that must NEVER be fuzzy-replaced with proper nouns.
// Deduplicated, alphabetically sorted for maintainability.
// Covers: conversational fillers, verbs, nouns, function words, and common
// first names (which the LLM correction pass can disambiguate contextually).
// Real false positives this prevents:
//   "Alright"→"Wright", "through"→"Brough", "details"→"Retail",
//   "Shelley"→"Kelley", "right"→"Wright", "Christian"→"Cristian"
const COMMON_ENGLISH_WORDS = new Set<string>([
  // A
  'about', 'above', 'absolutely', 'actually', 'admit', 'adopt', 'adult',
  'after', 'again', 'against', 'agent', 'agree', 'ahead', 'album', 'alert',
  'alike', 'alive', 'allow', 'allright', 'alone', 'along', 'aloud', 'alright',
  'also', 'alter', 'although', 'always', 'among', 'amount', 'anger', 'angle',
  'angry', 'another', 'answer', 'answers', 'anyone', 'anything', 'apart',
  'around', 'array', 'arrive', 'arrow', 'aside', 'asked', 'asking', 'aspect',
  // B
  'basic', 'basically', 'beach', 'because', 'become', 'been', 'before', 'began',
  'begin', 'behind', 'being', 'believe', 'below', 'bench', 'beside', 'better',
  'between', 'beyond', 'birth', 'black', 'blame', 'blank', 'blast', 'blind',
  'block', 'blood', 'board', 'booth', 'boost', 'bound', 'brain', 'brand',
  'bread', 'break', 'breed', 'brief', 'bring', 'broad', 'broke', 'broken',
  'brother', 'brought', 'brown', 'brush', 'built', 'bunch', 'business', 'burst',
  // C
  'calling', 'cannot', 'catch', 'caught', 'change', 'changed', 'chances',
  'cheap', 'check', 'chest', 'chief', 'child', 'children', 'choice', 'choose',
  'chose', 'christian', 'civil', 'claim', 'class', 'clean', 'clear', 'climb',
  'clock', 'close', 'cloud', 'coach', 'coast', 'coming', 'company', 'could',
  'count', 'course', 'court', 'cover', 'craft', 'crash', 'crazy', 'cream',
  'create', 'created', 'crime', 'cross', 'crowd', 'crown', 'crude', 'curve',
  'customer', 'customers', 'cycle',
  // D
  'daily', 'dance', 'dated', 'dealt', 'death', 'debut', 'definitely', 'delay',
  'depth', 'despite', 'detail', 'details', 'doing', 'double', 'doubt', 'dozen',
  'draft', 'drawn', 'dream', 'dress', 'drink', 'drive', 'driven', 'drove',
  'during', 'dying',
  // E
  'early', 'earth', 'eight', 'either', 'email', 'emails', 'empty', 'enemy',
  'enjoy', 'enough', 'entry', 'equal', 'error', 'especially', 'even', 'evening',
  'event', 'every', 'everyone', 'everything', 'exactly', 'example', 'examples',
  'except', 'extra',
  // F
  'faith', 'fancy', 'fault', 'feeling', 'fewer', 'field', 'fifth', 'final',
  'finally', 'finish', 'finished', 'first', 'floor', 'focus', 'follow',
  'followed', 'follows', 'following', 'force', 'forth', 'found', 'frame',
  'fresh', 'friend', 'front',
  // G
  'getting', 'given', 'giving', 'going', 'gonna', 'gotta', 'grade', 'grant',
  'great', 'green', 'group', 'groups', 'guess', 'guest', 'guide',
  // H
  'happened', 'happy', 'hard', 'having', 'head', 'heard', 'heavy', 'helping',
  'helped', 'honestly', 'hope', 'hour', 'house', 'however',
  // I
  'ideal', 'image', 'important', 'inner', 'inside', 'instead', 'interest',
  'issue', 'itself',
  // J
  'joined', 'judge',
  // K
  'keep', 'kept', 'kind', 'knew', 'know', 'known', 'knows',
  // L
  'large', 'later', 'latest', 'laugh', 'lead', 'learn', 'least', 'leave',
  'left', 'less', 'level', 'levels', 'letter', 'light', 'line', 'listen',
  'listened', 'literally', 'little', 'local', 'long', 'longer', 'look',
  'looked', 'looking', 'lower',
  // M
  'making', 'many', 'matter', 'matters', 'maybe', 'mean', 'meaning', 'media',
  'meeting', 'meetings', 'member', 'message', 'messages', 'might', 'mind',
  'minor', 'model', 'money', 'month', 'months', 'moral', 'morning', 'mother',
  'mouse', 'moved', 'moving', 'much', 'music', 'must', 'myself',
  // N
  'name', 'names', 'nature', 'near', 'need', 'needed', 'never', 'news', 'next',
  'night', 'nobody', 'north', 'note', 'noted', 'notes', 'nothing', 'notice',
  'number', 'numbers',
  // O
  'obvious', 'obviously', 'offer', 'office', 'offices', 'often', 'okay',
  'once', 'only', 'onto', 'open', 'order', 'orders', 'other', 'outer',
  'outside', 'over',
  // P
  'paper', 'party', 'people', 'perhaps', 'person', 'phone', 'phones', 'photo',
  'piece', 'place', 'plan', 'plant', 'plate', 'point', 'points', 'poor',
  'possible', 'power', 'press', 'pretty', 'price', 'probably', 'problem',
  'problems', 'product', 'products', 'program', 'project', 'projects', 'proud',
  'public',
  // Q
  'queen', 'question', 'questions', 'quick', 'quiet', 'quite',
  // R
  'rather', 'reach', 'reached', 'ready', 'really', 'reason', 'reasons',
  'recent', 'recently', 'report', 'reports', 'respect', 'result', 'results',
  'retail', 'return', 'right', 'rights', 'rough', 'round', 'rural',
  // S
  'sales', 'same', 'school', 'seeing', 'seemed', 'seems', 'sense', 'sent',
  'seven', 'several', 'shall', 'share', 'sharp', 'shelley', 'short', 'should',
  'showing', 'shown', 'sides', 'since', 'small', 'smile', 'social', 'some',
  'someone', 'something', 'sometimes', 'soon', 'sorry', 'sound', 'south',
  'space', 'speak', 'spoke', 'sports', 'staff', 'stage', 'stand', 'start',
  'started', 'state', 'still', 'stood', 'stop', 'stopping', 'story', 'stuff',
  'style', 'subject', 'success', 'such', 'suggest', 'support', 'sure',
  'system', 'systems',
  // T
  'table', 'taking', 'talking', 'taught', 'teach', 'team', 'teams', 'telling',
  'tells', 'terms', 'thanks', 'thank', 'their', 'them', 'then', 'there',
  'these', 'thing', 'things', 'think', 'third', 'this', 'those', 'though',
  'thought', 'three', 'through', 'throughout', 'today', 'together', 'told',
  'tomorrow', 'tonight', 'took', 'total', 'touch', 'toward', 'towards', 'town',
  'trade', 'train', 'tried', 'trouble', 'truly', 'trust', 'truth', 'trying',
  'turn', 'turned', 'turning', 'twelve', 'type',
  // U
  'under', 'underneath', 'understand', 'unique', 'until', 'upon', 'usually',
  // V
  'value', 'various', 'very', 'visit', 'voice',
  // W
  'wait', 'wanna', 'want', 'wanted', 'watch', 'water', 'ways', 'week', 'weeks',
  'weekend', 'well', 'went', 'were', 'what', 'when', 'where', 'whether',
  'which', 'while', 'white', 'whole', 'whose', 'wife', 'will', 'wind', 'wish',
  'with', 'within', 'without', 'women', 'word', 'words', 'work', 'worked',
  'working', 'world', 'worry', 'worse', 'worst', 'would', 'wrong',
  // Y
  'yeah', 'year', 'years', 'yesterday', 'young', 'your', 'yours', 'yourself',

  // ── Common first names ──
  // Whisper frequently capitalizes these at any position. Leave them alone —
  // LLM correction pass handles context-aware disambiguation vs enrolled speakers.
  'aaron', 'albert', 'alexander', 'alice', 'amanda', 'amber', 'amy', 'andrea',
  'angela', 'ann', 'anne', 'anthony', 'arthur', 'ashley', 'barbara', 'becky',
  'benjamin', 'betty', 'brandon', 'brenda', 'brian', 'bruce', 'carl', 'carlos',
  'carol', 'carolyn', 'catherine', 'charles', 'cheryl', 'christina', 'christine',
  'christopher', 'cynthia', 'daniel', 'david', 'dawn', 'deborah', 'denise',
  'dennis', 'diana', 'diane', 'donna', 'douglas', 'dylan', 'edward', 'elizabeth',
  'emily', 'emma', 'eric', 'eugene', 'evelyn', 'frank', 'gary', 'george',
  'gloria', 'grace', 'gregory', 'hannah', 'harold', 'heather', 'helen', 'henry',
  'howard', 'jack', 'jackson', 'jacob', 'jacqueline', 'james', 'jane', 'janet',
  'janice', 'jason', 'jeffrey', 'jennifer', 'jerry', 'jessica', 'joan', 'john',
  'johnny', 'jonathan', 'jordan', 'jose', 'joseph', 'joshua', 'joyce', 'judith',
  'julia', 'julie', 'justin', 'karen', 'katherine', 'kathleen', 'kathryn',
  'keith', 'kelly', 'kenneth', 'kevin', 'kimberly', 'larry', 'laura', 'lauren',
  'lawrence', 'linda', 'lisa', 'lori', 'louis', 'margaret', 'maria', 'marie',
  'mark', 'martha', 'martin', 'mary', 'matthew', 'megan', 'melissa', 'michael',
  'michelle', 'monica', 'nancy', 'natalie', 'nicholas', 'nicole', 'olivia',
  'pamela', 'patricia', 'patrick', 'paul', 'peter', 'philip', 'rachel', 'ralph',
  'randy', 'raymond', 'rebecca', 'richard', 'robert', 'roger', 'ronald', 'rose',
  'roy', 'ruby', 'russell', 'ruth', 'ryan', 'samantha', 'samuel', 'sandra',
  'sara', 'sarah', 'scott', 'sean', 'shannon', 'sharon', 'shirley', 'stephanie',
  'stephen', 'steven', 'susan', 'teresa', 'theresa', 'thomas', 'timothy',
  'tina', 'tony', 'tyler', 'victoria', 'virginia', 'walter', 'wayne', 'william',
  'willie', 'zachary',
])

/** True for a word the stop list protects from ever being replaced (lowercase compare). */
export function isCommonEnglishWord(word: string): boolean {
  return COMMON_ENGLISH_WORDS.has(word.toLowerCase())
}

/**
 * The proper-noun targets fuzzy correction may write, in first-seen order: speaker
 * tokens (Ext, Unknown, the owner label) and entries that do not start uppercase or
 * are shorter than 4 characters are dropped.
 */
export function canonicalFuzzyTargets(targets: string[]): string[] {
  const owner = getOwnerSpeakerLabel()
  return Array.from(new Set(
    targets
      .filter(t => {
        if (!t || t.length < 4) return false
        if (t === 'Ext' || t === 'Unknown' || t === owner) return false
        return /^[A-Z]/.test(t.trim())
      })
      .map(t => t.trim()),
  ))
}

/**
 * The replacement fuzzy correction would write for ONE word, or null to leave it.
 * `canonical` comes from canonicalFuzzyTargets. Same rules as applyFuzzyCorrections,
 * which calls this for every candidate word.
 */
export function fuzzyReplacementFor(word: string, canonical: string[], targetLowerSet?: ReadonlySet<string>): string | null {
  if (!/^[A-Za-z][A-Za-z'-]{4,}$/.test(word)) return null
  const lower = word.toLowerCase()

  // Skip common English words (primary false-positive defense)
  if (COMMON_ENGLISH_WORDS.has(lower)) return null

  // Skip exact matches (already correct)
  const exact = targetLowerSet ?? new Set(canonical.map(t => t.toLowerCase()))
  if (exact.has(lower)) return null

  // Length-scaled distance threshold
  const len = word.length
  const maxDist = len <= 8 ? 1 : len <= 11 ? 2 : 3

  let bestTarget: string | null = null
  let bestDist = maxDist + 1

  for (const target of canonical) {
    // Split multi-word targets — match on individual tokens
    const tokens = target.split(/\s+/)
    for (const token of tokens) {
      if (token.length < 4) continue
      // Length difference must be small to prevent collapses
      if (Math.abs(token.length - len) > 2) continue
      const dist = levenshtein(lower, token.toLowerCase())
      if (dist > 0 && dist < bestDist && dist <= maxDist) {
        bestDist = dist
        bestTarget = token
      }
    }
  }

  if (!bestTarget) return null
  // Preserve original capitalization pattern
  return /^[A-Z]/.test(word) ? bestTarget : bestTarget.toLowerCase()
}

/**
 * Fuzzy-match transcript words against a canonical list of proper nouns.
 *
 * RULES (all must pass):
 *   - Candidate word length ≥ 5 chars (any case — supports lowercase dictation
 *     AND mixed-case names like GitHub/OpenAI)
 *   - Word must NOT be in COMMON_ENGLISH_WORDS stop-list (primary defense)
 *   - Target must start with uppercase (canonical proper noun)
 *   - Target token length ≥ 4 chars (allows short names like Anna, Ryan, Theo as targets)
 *   - Length difference ≤ 2 chars
 *   - Distance within length-scaled threshold:
 *       5-8 chars  → 1
 *       9-11 chars → 2
 *       12+ chars  → 3
 *
 * Preserves the original word's first-letter case: capitalizes the replacement
 * when the source was capitalized, otherwise lowercases it. This avoids
 * creating sentence-middle capitalizations where none existed.
 */
export function applyFuzzyCorrections(
  text: string,
  targets: string[],
): { text: string; replacements: number } {
  if (targets.length === 0 || !text) return { text, replacements: 0 }

  // Keep only targets that look like proper nouns.
  // Drop speaker tokens and entries that don't start with uppercase.
  const canonical = canonicalFuzzyTargets(targets)
  if (canonical.length === 0) return { text, replacements: 0 }

  const targetLowerSet = new Set(canonical.map(t => t.toLowerCase()))
  let replacements = 0

  // Match any 5+ char word (case-insensitive). Stop-list + strict distance
  // thresholds are the primary defenses against false positives.
  const result = text.replace(/\b[A-Za-z][A-Za-z'-]{4,}\b/g, (word) => {
    const replacement = fuzzyReplacementFor(word, canonical, targetLowerSet)
    if (replacement === null) return word
    replacements++
    return replacement
  })

  if (replacements > 0) {
    // 6.86.0: the count only. The pairs were the words someone said.
    console.log(`[fuzzy-correct] Applied ${replacements} correction(s)`)
  }

  return { text: result, replacements }
}
