import type { AskSource } from './live-cos-ask.js'
import { meetingAskCitations, type MeetingAskSection } from '../../shared/meeting-ask.js'

export const MONEY_GROUNDING_SYSTEM = `For money questions, classify each amount before answering: current balance, historical event, estimate, proposal, illustrative example, or conditional scenario. Preserve the date, subject, units and governing if/would clause even across adjacent transcript passages. A hypothetical sale and its after-tax proceeds do not establish current cash. An example about somebody else's investment is not the wearer's transaction. Resolve a clear quoted correction using its whole neighborhood; an inconsistent later ASR repetition does not erase an explicit correction, but the final invoice remains unverified. Do not infer the kind of bill or its payee from an adjacent but different story; leave it as a bill unless the source states the kind. Attach a resolution only to the issue actually resolved: correcting a Roth reporting issue does not prove the whole bill was settled. Spoken tax claims are participants' reports, not verified tax treatment. For broad highlights choose at most four central topics, omit unexplained dollar fragments and incidental third-party stories. Do not describe figures you left out. Distinguish historical conversions from a later statement that conversions have stopped. Say which specific figures need confirmation rather than treating every figure as equally uncertain. Facts from previous answers must be recovered from current supplied evidence; omit any fact that cannot be supported. Do not reproduce source-unavailable placeholders. A business widget with several headings does not prove which metric an isolated OCR value belongs to: leave that label unresolved. When comparing exact printed totals, compute the exact difference; do not claim they agree merely because their rounded million-dollar values agree. Do not silently fix inconsistent arithmetic. Never claim that a topic or hypothetical does not exist in the conversation just because selected passages omit it; say it was not captured in the supplied selection. Before returning JSON check that So what and Details agree on the temporal status of every amount. For a personal conversation use natural personal wording; do not add formal business or purchasing disclaimers unless asked about commitments.`

const CONDITIONAL = /\b(?:hypothetical|suppose|imagine|if\b.{0,140}\b(?:goes|reaches|sell|sold)|we would (?:have|sell)|would (?:leave|yield|produce))\b/i
const QUALIFIED = /\b(?:hypothetical|scenario|if|would|could|potential|projected|conditional|future|not (?:current|established|available)|does not establish|isn.t established|unconfirmed)\b/i
const PRESENT_CASH = /(?:\bcash (?:on hand|balance|available|at (?:our|their|your) disposal)|\bcurrently.{0,60}cash|\b(?:have|has|holds?)\b.{0,55}\bcash|\$\s*\d[\d,.]*(?:\s*[kKmM]\b)?\s+(?:(?:in|of)\s+)?cash)\b/i
const amounts = (text: string) => [...text.matchAll(/(?:\$\s*(\d[\d,]*(?:\.\d+)?)(?:\s*(k|m|thousand|million)\b)?|\b(\d[\d,]*(?:\.\d+)?)\s*(k|grand|thousand|million)\b)/gi)].map(m => {
  const value = Number((m[1] ?? m[3]).replace(/,/g, '')), unit = m[2] ?? m[4] ?? ''
  return value * (/^(?:k|grand|thousand)$/i.test(unit) ? 1000 : /^(?:m|million)$/i.test(unit) ? 1000000 : 1)
})

const cashAmounts = (text: string) => [...text.matchAll(/(?:\bcash(?:\s+(?:balance|available|on hand))?\s*[:=]?\s*\$\s*\d[\d,.]*(?:\s*[kKmM]\b)?|\$\s*\d[\d,.]*(?:\s*[kKmM]\b)?\s+(?:in\s+)?cash\b)/gi)].flatMap(m => amounts(m[0]))

export function moneyGroundingHints(sources: readonly AskSource[]): { conditionalSources: string[]; explicitCorrectionSources: string[] } {
  const isConditional = (source: AskSource) => {
    if (CONDITIONAL.test(source.text.replace(/\s+/g, ' '))) return true
    if (source.kind !== 'transcript' || source.elapsedMs == null || /\b(?:current(?:ly)?|today|actually|separately)\b/i.test(source.text)) return false
    // A scenario often spans several six-second chunks: carry its governing
    // clause into the next money fragment, without treating bare 'we have' as
    // a new independently verified balance.
    return sources.some(s => s.kind === 'transcript' && s.elapsedMs != null && s.elapsedMs <= source.elapsedMs! && source.elapsedMs! - s.elapsedMs <= 45_000 && CONDITIONAL.test(s.text.replace(/\s+/g, ' ')))
  }
  return { conditionalSources: sources.filter(s => s.kind === 'transcript' && isConditional(s)).map(s => s.id), explicitCorrectionSources: sources.filter(s => /\b(?:no,?\s*no,?|correction:)\s*\$\s*\d/i.test(s.text)).map(s => s.id) }
}

/** Narrow semantic backstop, not a general financial fact checker. Prevent a
 * cited conditional cash figure from being rendered as a present balance.
 * No provider retry, inferred tax calculation, or private web lookup. */
export function groundMoneySections(sections: readonly MeetingAskSection[], sources: readonly AskSource[], question = ''): { sections: MeetingAskSection[]; corrected: boolean } {
  const byId = new Map(sources.map(s => [s.id, s]))
  const conditionalIds = new Set(moneyGroundingHints(sources).conditionalSources)
  let corrected = false
  return { sections: sections.map(section => {
    const text = section.text.split(/(?<=[.!?])\s+(?=[A-Z])/).map(sentence => {
      if (/\b(?:highlights|highliights|summarize|catch.*up)\b/i.test(question) && /\b(?:left (?:it|them|these) out|I (?:omitted|excluded))\b/i.test(sentence) && /\$\s*\d/.test(sentence)) return ''
      const falseConflict = /\b(?:conflicts?|mismatch|contradict|does not match)\b/i.test(sentence) && /\b(?:cash|balance)\b/i.test(sentence)
      if (((!PRESENT_CASH.test(sentence) || QUALIFIED.test(sentence)) && !falseConflict) || !amounts(sentence).length) return sentence
      const ids = meetingAskCitations(sentence)
      const cited = ids.length ? ids.map(id => byId.get(id)).filter((s): s is AskSource => !!s) : sources.filter(s => amounts(s.text).some(n => amounts(sentence).includes(n)))
      const conditional = cited.filter(s => s.kind === 'transcript' && conditionalIds.has(s.id))
      const disputed = amounts(sentence).filter(n => conditional.some(s => amounts(s.text).includes(n)))
      if (!disputed.length) return sentence
      // A separate current source for the same amount may legitimately establish
      // today's balance, even when a scenario is discussed in the same answer.
      const supported = disputed.every(n => cited.some(s => !conditionalIds.has(s.id) && cashAmounts(s.text).includes(n)))
      if (supported) return sentence
      const currentFiles = cited.filter(s => s.kind === 'file' && /\bcash\b/i.test(s.text))
      if (falseConflict && !currentFiles.length) return sentence
      corrected = true
      if (falseConflict) return `The quoted proceeds are hypothetical; the file provides a separate current cash balance, so these figures do not establish a conflict ${[...conditional, ...currentFiles].map(s => `[${s.id}]`).join('')}.`
      return `The cited cash amount is part of a hypothetical scenario and does not establish a current balance ${conditional.map(s => `[${s.id}]`).join('')}.`
    }).filter(Boolean).join(' ')
    return { ...section, text, sources: meetingAskCitations(text) }
  }), corrected }
}
