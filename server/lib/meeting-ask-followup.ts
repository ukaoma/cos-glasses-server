import type { AskInput, AskSource, AskTurn } from './live-cos-ask.js'
import { evidenceRelevance } from './meeting-ask-evidence.js'

/** Prior prose is navigation only. In particular its request-local T/F/H/W IDs
 * must never be mistaken for identically numbered evidence in a new request. */
export function followupContext(input: AskInput): { history: { question: string; answer: string }[]; turns: AskTurn[]; priorityIds: number[] } {
  const history = input.history.slice(-4).map(h => ({ question: h.question.slice(0, 2000), answer: h.answer.slice(0, 4000).replace(/\[(?:[THFW]\d+|source unavailable)\]/g, '').replace(/\s+/g, ' ').trim() }))
  const current = new Map(input.turns.map(t => [t.id, t]))
  const candidates = input.history.slice(-4).reverse().flatMap(h => h.sources ?? [])
    .filter((s: AskSource) => s.kind === 'transcript' && !s.finalizedTranscript && s.sessionId === input.sessionId && Number.isSafeInteger(s.turnId) &&
      Number.isFinite(s.elapsedMs) && s.elapsedMs! >= 0 && s.elapsedMs! <= input.elapsedMs && s.text.trim())
    .sort((a, b) => evidenceRelevance(input.question, b.text) - evidenceRelevance(input.question, a.text))
  const priorityIds: number[] = []
  let used = 0
  for (const s of candidates) {
    if (priorityIds.includes(s.turnId!)) continue
    const present = current.get(s.turnId!)
    // Current admitted wording wins over an earlier preliminary quote. Otherwise
    // recover the immutable server-owned quote, never a generated answer's wording.
    const turn = present ?? { id: s.turnId!, elapsedMs: s.elapsedMs!, speaker: s.title.split(' · ')[0].slice(0, 100), text: s.text }
    const cost = turn.text.length + turn.speaker.length + 160
    if (priorityIds.length >= 16 || used + cost > 6000) continue
    if (input.action === 'ask' && evidenceRelevance(input.question, turn.text) === 0 && /\b(?:money|financial|cash|balances?)\b/i.test(input.question)) continue
    current.set(turn.id, turn); priorityIds.push(turn.id); used += cost
  }
  return { history, turns: [...current.values()].sort((a, b) => a.elapsedMs - b.elapsedMs || a.id - b.id), priorityIds }
}
