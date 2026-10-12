import type { MeetingAskSection } from '../../shared/meeting-ask.js'
import { redactSecrets } from './lens-gist-engines.js'
/** Qualitative evidence assessment, never an ASR probability. Every completed answer gets a row. */
export function answerConfidence(raw: unknown, sections: readonly MeetingAskSection[], coverage: readonly string[]): MeetingAskSection {
  const v = raw as { level?: unknown; reason?: unknown } | null
  const cited = sections.some(s => s.sources.length)
  const reason = typeof v?.reason === 'string' ? redactSecrets(v.reason).replace(/\s+/g, ' ').replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 360) : ''
  const valid = !!v && ['supported', 'limited', 'low'].includes(String(v.level)) && !!reason && !/\d\s*%|\b(?:percent|probability|accuracy score)\b/i.test(reason)
  const partial = coverage.some(n => /not ready|refin.*unavailable/i.test(n)) || sections.some(s => s.text.includes('[source unavailable]'))
  const uncertain = /\b(?:uncertain|uncertainty|unverified|unclear|ambiguous|misheard|missing|incomplete)\b|not (?:confirmed|established)/i.test(reason)
  const level = !cited ? 'low' : !valid || partial || uncertain ? (v?.level === 'low' ? 'low' : 'limited') : v!.level as string
  const explanation = !cited ? 'No cited evidence supports this answer; treat it as a suggestion.'
    : valid ? reason + (partial && !/incomplete|coverage/i.test(reason) ? ' Context coverage is incomplete.' : '')
    : 'Based on the supplied transcript and sources. G2 audio can mishear names and numbers; unclear details need confirmation.'
  return { label: 'Confidence', text: `${level[0].toUpperCase() + level.slice(1)} — ${explanation}`, sources: [] }
}
