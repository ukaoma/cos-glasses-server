// Live cues v2 post-writer filter (6.79.0): zero model calls. A TypeScript port of the offline reference
// (cue_verdicts_mvp/v4_replay/filter_cues.py, RESULTS_filter.md); it must agree with it on every vector.
//
// tokens(cue): lowercase, scan [a-z0-9]+(?:[.,][0-9]+)*, drop commas inside a match ("3,000" -> "3000"), keep a token
// with a digit and length >= 2, or an all-letter token of length >= 3 that is not a stopword. The SET of those.
// overlap(A, B) = |A ∩ B| / min(|A|, |B|), 0 when either is empty.
// isTemplate(cue): TEMPLATE_RE anywhere in the raw text (an owner or date ask).
//
// The repeat rule (enforced only when COS_LIVE_CUES_V2_REPEAT_OVERLAP is set) withholds a cue whose overlap with an
// earlier SHOWN cue is >= the threshold. The template rules are shadow only: logged as `wouldWithhold`, never enforced.

/** The last two lines are cue scaffolding, so two different owner/date asks do not look like repeats. */
export const CUE_FILTER_STOPWORDS: ReadonlySet<string> = new Set(`
all and any are ask but can did don for get got had has her him his how its let may new not now off one our out own per put say see set she the too two use was way who why yet you
about above after again against also already another anyone around back because been before being below between both cannot
could didn does doesn doing done down during each else even ever every everyone from further going gonna have haven having
here into itself just know like made make many more most much must need needs next only onto other ours over really said says
same should since some someone something still such than that their theirs them then there these they thing things think this
those through under until upon very wasn well were what when where whether which while will with within without would wouldn
yeah your yours okay
settle decide decides decided name named names room nobody none owner owners owns ownership date dates deadline stated
moving moves ends call meeting asks check
`.split(/\s+/).filter(Boolean))

const TOKEN_RE = /[a-z0-9]+(?:[.,][0-9]+)*/g
export const CUE_TEMPLATE_RE = /\b(owner|owners|owns|ownership|deadline|due date|by when|by what date|a date|no date|set a date|settle a date|who (owns|will|should|builds|takes|drives|runs|tracks|chases|approves|signs off|finalizes|tests|gathers|asks|computes|is computing|does))\b/i
/** The shadow per-topic rule's threshold (RESULTS_filter.md: 0.25 against earlier shown template cues). */
export const CUE_TOPIC_OVERLAP = 0.25

export function cueTokens(cue: string): Set<string> {
  const out = new Set<string>()
  for (const m of (cue || '').toLowerCase().match(TOKEN_RE) ?? []) {
    const t = m.replace(/,/g, '')
    if (/[0-9]/.test(t)) { if (t.length >= 2) out.add(t) }
    else if (t.length >= 3 && !CUE_FILTER_STOPWORDS.has(t)) out.add(t)
  }
  return out
}

export function cueOverlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared += 1
  return shared / Math.min(a.size, b.size)
}

export function isTemplateCue(cue: string): boolean { return CUE_TEMPLATE_RE.test(cue || '') }

export interface ShownCue { cueId: string; detail: string }

/** Rule R: the first earlier shown cue this one repeats at >= threshold, or null. */
export function repeatOf(detail: string, shown: readonly ShownCue[], threshold: number): { blocker: string; overlap: number } | null {
  const mine = cueTokens(detail)
  for (const s of shown) {
    const o = cueOverlap(mine, cueTokens(s.detail))
    if (o >= threshold) return { blocker: s.cueId, overlap: Math.round(o * 1000) / 1000 }
  }
  return null
}

export interface WouldWithhold { perMeeting: boolean; perTopic: boolean; blockerCueId?: string }

/** Rule T in shadow, both forms: per meeting (any earlier shown template cue) and per topic (one with overlap >= 0.25).
 *  The blocker is the per-topic one when that form fires, else the per-meeting one. */
export function wouldWithhold(detail: string, shown: readonly ShownCue[]): WouldWithhold {
  if (!isTemplateCue(detail)) return { perMeeting: false, perTopic: false }
  const mine = cueTokens(detail)
  const templates = shown.filter(s => isTemplateCue(s.detail))
  const topic = templates.find(s => cueOverlap(mine, cueTokens(s.detail)) >= CUE_TOPIC_OVERLAP)
  const blocker = topic ?? templates[0]
  return { perMeeting: templates.length > 0, perTopic: !!topic, ...(blocker ? { blockerCueId: blocker.cueId } : {}) }
}
