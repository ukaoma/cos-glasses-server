import type { AskInput, AskTurn } from './live-cos-ask.js'

const STOP = new Set('what are the is a an this that it we our you your so far about tell me give summarize highlights highliights'.split(' '))
const FINANCE = /\b(?:money|financ\w*|cash|balances?|assets?|net worth|invest\w*|tax\w*|crypto|mortgage|budget|cost\w*)\b/i
const FINANCE_WORDS = /\b(?:cash|balance|assets?|net worth|roth|ira|tax\w*|withdraw\w*|contribut\w*|mortgage|owe|owed|paid off|bitcoin|crypto|gains?|bill|expense|saved|grocer\w*|conver\w*|allocat\w*)\b/gi
/** Matching aliases only. Canonical evidence and quotes always retain original ASR. */
export function matchingText(text: string): string {
  return text.toLowerCase().replace(/401\s*\(?k\)?/g, '401k').replace(/4013403b|4013b|four\s+(?:or\s+)?3b|four\s+oh\s+three\s+b|403\s*\(?b\)?/g, '403b')
}
const RULE_QUESTION = /(?:401k|403b|retirement).{0,160}\b(?:leave|leaving|keep|allowed|rule|true|claim)|\b(?:leave|leaving|keep|allowed|rule|true|claim).{0,160}(?:401k|403b|retirement)/i
function similar(a: string, b: string): boolean {
  if(a.length<5||b.length<5||Math.abs(a.length-b.length)>3)return false
  const grams=(s:string)=>new Set(Array.from({length:s.length-2},(_,i)=>s.slice(i,i+3)))
  const x=grams(a),y=grams(b);let same=0;for(const g of x)if(y.has(g))same++
  return 2*same/(x.size+y.size)>=.7
}
export function evidenceRelevance(question: string, text: string): number {
  const q=matchingText(question),hay=matchingText(text),tokens: string[]=hay.match(/[a-z0-9]{3,}/g)??[]
  const words = [...new Set(q.match(/[a-z0-9]{3,}/g) ?? [])].filter(w => !STOP.has(w))
  const lexical = words.reduce((n, w) => n + (tokens.includes(w) ? 2 : tokens.some(t=>similar(w,t)) ? .7 : 0), 0)
  const ruleAnchor=RULE_QUESTION.test(q)&&/401k|403b|retirement/.test(hay)?8:0
  return lexical + ruleAnchor + (!RULE_QUESTION.test(q) && FINANCE.test(question) ? Math.min(6, (text.match(FINANCE_WORDS) ?? []).length) + (/\$\s*\d|\b\d+(?:,\d{3})*(?:\s*(?:k|grand|million|thousand))\b/i.test(text) ? 2 : 0) : 0)
}

/** Select complete, overlapping neighborhoods instead of isolated six-second fragments.
 * The existing recent-window contract for What to ask is handled by its caller. */
export function connectedEvidence(input: AskInput, budget: number, priorityIds: readonly number[] = []): AskTurn[] {
  const rows = input.turns
  const cost = (t: AskTurn) => t.text.length + t.speaker.length + 160
  if (rows.reduce((n, t) => n + cost(t), 0) <= budget) return rows
  const selected = new Set<number>()
  let used = 0
  const scores = rows.map(t => evidenceRelevance(input.action === 'ask' ? input.question : '', t.text) +
    (/\b(?:correction|replacing|no, no|saved|will send|will follow|touch base|not approved)\b/i.test(t.text) ? 3 : 0))
  const window = (i: number) => Array.from({ length: Math.min(rows.length - 1, i + 4) - Math.max(0, i - 4) + 1 }, (_, n) => Math.max(0, i - 4) + n).filter(j => Math.abs(rows[j].elapsedMs - rows[i].elapsedMs) <= 45_000)
  const add = (i: number, cap = budget) => {
    if (i < 0) return
    const fresh = window(i).filter(j => !selected.has(j))
    const size = fresh.reduce((n, j) => n + cost(rows[j]), 0)
    // Never spend the last bytes on half a correction or half a scenario.
    if (used + size > cap) return
    fresh.forEach(j => selected.add(j)); used += size
  }
  // A speaker named in the user's question is a retrieval hint, not identity proof.
  // Reserve complete neighborhoods before old-answer quotes and broad time coverage.
  if (input.action === 'ask') {
    const requested = new Set(input.question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
    const named = rows.map((t, i) => ({t, i})).filter(({t}) =>
      !/^(?:ext|you|speaker(?: \d+)?|mu)$/i.test(t.speaker.trim()) &&
      (t.speaker.toLowerCase().match(/[a-z]{3,}/g) ?? []).some(w => requested.has(w)))
    named.sort((a,b) => scores[b.i] - scores[a.i] || a.i - b.i)
    const cap = Math.floor(budget * .7)
    const neighborhood = [...new Set(named.flatMap(({i}) => window(i)))]
    const core = named.map(({i}) => i)
    const preferred = neighborhood.reduce((n,i)=>n+cost(rows[i]),0) <= cap ? neighborhood : core
    if (preferred.reduce((n,i)=>n+cost(rows[i]),0) <= cap) {
      preferred.forEach(i => { selected.add(i); used += cost(rows[i]) })
    }
    named.forEach(({i}) => add(i, cap))
  }
  // Follow-up evidence has already been scoped and bounded by the server.
  priorityIds.forEach(id => add(rows.findIndex(t => t.id === id), Math.floor(budget / 5)))
  // Financial summaries must retain the setup of conditional proceeds and the
  // separate actual-balance discussion, even after a long earlier answer.
  if (input.action === 'ask' && FINANCE.test(input.question) && !RULE_QUESTION.test(matchingText(input.question))) {
    for (const pattern of [/\b(?:if|let.s say)\b.{0,100}\b(?:bitcoin|price|sell|cash)\b/i, /\b(?:owe|owed|mortgage|cash balance)\b/i]) {
      const candidates = rows.map((_, i) => i).filter(i => pattern.test(rows[i].text))
      candidates.sort((a, b) => scores[b] - scores[a] || a - b)
      if (candidates.length) add(candidates[0])
    }
  }
  if (input.action !== 'ask') { add(0); add(rows.length - 1) }
  // Specific questions spend their first budget on strongest connected matches,
  // before broad temporal coverage. Otherwise an old generic 'plan' passage can
  // fill a small budget before the retirement-plan passage near the end.
  if(input.action==='ask')rows.map((_,i)=>i).sort((a,b)=>scores[b]-scores[a]||rows[b].elapsedMs-rows[a].elapsedMs).filter(i=>scores[i]>0).forEach(i=>add(i,Math.floor(budget*.7)))
  // Topic coverage across the whole recording before filling with additional matches.
  const bins = 10
  for (let bin = 0; bin < bins; bin++) {
    const candidates = rows.map((_, i) => i).filter(i => Math.min(bins - 1, Math.floor(rows[i].elapsedMs * bins / Math.max(1, input.elapsedMs))) === bin)
    candidates.sort((a, b) => scores[b] - scores[a] || a - b)
    if (candidates.length && (input.action !== 'ask' || scores[candidates[0]] > 0)) add(candidates[0])
  }
  const ranked = rows.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b)
  priorityIds.forEach(id => add(rows.findIndex(t => t.id === id)))
  ranked.forEach(i => add(i))
  // One oversized turn is still answerable, but explicitly marked incomplete.
  if (!selected.size && rows.length) {
    const t = rows[ranked[0]], remaining = budget - t.speaker.length - 160 - 24
    return remaining > 0 ? [{ ...t, text: t.text.slice(0, remaining) + ' [passage truncated]' }] : []
  }
  return rows.filter((_, i) => selected.has(i))
}
