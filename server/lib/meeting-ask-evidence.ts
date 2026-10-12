import type { AskInput, AskTurn } from './live-cos-ask.js'

const STOP = new Set('what are the is a an this that it we our you your so far about tell me give summarize highlights highliights'.split(' '))
const FINANCE = /\b(?:money|financ\w*|cash|balances?|assets?|net worth|invest\w*|tax\w*|crypto|mortgage|budget|cost\w*)\b/i
const FINANCE_WORDS = /\b(?:cash|balance|assets?|net worth|roth|ira|tax\w*|withdraw\w*|contribut\w*|mortgage|owe|owed|paid off|bitcoin|crypto|gains?|bill|expense|saved|grocer\w*|conver\w*|allocat\w*)\b/gi
export function evidenceRelevance(question: string, text: string): number {
  const words = [...new Set(question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter(w => !STOP.has(w))
  const lexical = words.reduce((n, w) => n + (text.toLowerCase().includes(w) ? 2 : 0), 0)
  return lexical + (FINANCE.test(question) ? Math.min(6, (text.match(FINANCE_WORDS) ?? []).length) + (/\$\s*\d|\b\d+(?:,\d{3})*(?:\s*(?:k|grand|million|thousand))\b/i.test(text) ? 2 : 0) : 0)
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
  // Follow-up evidence has already been scoped and bounded by the server.
  priorityIds.forEach(id => add(rows.findIndex(t => t.id === id), Math.floor(budget / 5)))
  // Financial summaries must retain the setup of conditional proceeds and the
  // separate actual-balance discussion, even after a long earlier answer.
  if (input.action === 'ask' && FINANCE.test(input.question)) {
    for (const pattern of [/\b(?:if|let.s say)\b.{0,100}\b(?:bitcoin|price|sell|cash)\b/i, /\b(?:owe|owed|mortgage|cash balance)\b/i]) {
      const candidates = rows.map((_, i) => i).filter(i => pattern.test(rows[i].text))
      candidates.sort((a, b) => scores[b] - scores[a] || a - b)
      if (candidates.length) add(candidates[0])
    }
  }
  if (input.action !== 'ask') { add(0); add(rows.length - 1) }
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
