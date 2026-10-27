// 6.76.0: who owns this COS, for Live COS Ask. Read from the profile the server already keeps
// (owner_name, owner_speaker_label, home_city, system_prompt_context). No new store, no addresses.
import { getOwnerName, getOwnerSpeakerLabel, getOwnerHomeArea, getSystemContext } from './profile.js'
import { redactSecrets } from './lens-gist-engines.js'
import type { MeetingAskSource } from '../../shared/meeting-ask.js'

export interface OwnerCard {
  name: string
  speakerLabel: string | null
  homeArea: string | null
  /** The owner's own profile notes (system_prompt_context), address-like sentences removed. */
  notes: string | null
}

const PLACEHOLDER_LABELS = new Set(['', 'me', 'you', 'speaker', 'wearer', 'owner', 'user'])
/** A sentence that carries a street address, zip, phone number or email is dropped from the card. */
const ADDRESS_LIKE = /\b\d+\s+(?:[\p{L}'-]+\s+){0,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway|cir|circle|trl|trail|ter|terrace)\b\.?|\b\d{5}(?:-\d{4})?\b|\bp\.?\s?o\.?\s+box\b|\b(?:apt|apartment|suite|unit)\s*#?\s*\d+|[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s().-]{8,}\d/iu
export const OWNER_NOTES_MAX = 600

/** Profile notes, one sentence at a time, without address, phone or email sentences. */
export function ownerNotes(raw: string): string | null {
  const kept = redactSecrets(raw).replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(s => s && !ADDRESS_LIKE.test(s))
  let out = ''
  for (const sentence of kept) {
    if ((out ? out.length + 1 : 0) + sentence.length > OWNER_NOTES_MAX) break
    out = out ? `${out} ${sentence}` : sentence
  }
  return out || null
}

/** The owner card, or null when the profile has no real owner name (then the Ask is unchanged). */
export function ownerCardFromProfile(): OwnerCard | null {
  try {
    const name = getOwnerName().trim()
    if (!name || name === 'User') return null
    const label = (() => { try { return getOwnerSpeakerLabel().trim() } catch { return '' } })()
    const homeArea = (() => { try { return getOwnerHomeArea() } catch { return null } })()
    const notes = (() => { try { return ownerNotes(getSystemContext()) } catch { return null } })()
    return { name: name.slice(0, 120), speakerLabel: PLACEHOLDER_LABELS.has(label.toLowerCase()) ? null : label.slice(0, 60), homeArea, notes }
  } catch { return null }
}

/** The card as an Ask source (kind 'profile'), so an answer about the owner can cite it like any COS source. */
export function ownerCardSource(card: OwnerCard, id: string): MeetingAskSource {
  const parts = [`This COS belongs to ${card.name}. The glasses wearer is normally ${card.name}.`]
  if (card.speakerLabel) parts.push(`${card.name} appears in transcripts as "${card.speakerLabel}".`)
  if (card.homeArea) parts.push(`Home area: ${card.homeArea}.`)
  if (card.notes) parts.push(`${card.name}'s profile notes: ${card.notes}`)
  return { id, kind: 'profile', title: `COS profile · ${card.name}`, text: parts.join(' ') }
}

const fold = (word: string) => word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}
/**
 * One heard word against one name word. Short words must match exactly. Otherwise one edit (two from
 * seven letters), or one edit after a leading y the recognizer added before a vowel: Ukmya and Yukmya
 * both read as Ukamya.
 */
export function nameWordMatches(heard: string, name: string): boolean {
  const a = fold(heard), b = fold(name)
  if (!a || !b) return false
  if (a === b) return true
  if (Math.min(a.length, b.length) < 4) return false
  const allowed = Math.max(a.length, b.length) >= 7 ? 2 : 1
  if (distance(a, b) <= allowed) return true
  return /^y[aeiou]/.test(a) && !/^y/.test(b) && distance(a.slice(1), b) <= 1
}

const LEAD_IN = new Set(['is', 'was', 'about', 'with', 'for', 'from', 'to', 'of', 'and', 'mr', 'mrs', 'ms', 'miss', 'dr', 'doctor', 'named', 'called'])
export interface OwnerMatch { heard: string; owner: string }
/**
 * Whether the question names the owner, allowing ASR spellings. Full name: first and last words, in
 * order and adjacent. Surname alone: only after a lead-in word ("who is Ukmya"), never after another
 * first name ("Felix Ukamya" is someone else). First name alone: only when it is the whole subject of
 * a who question, compared exactly.
 */
export function matchOwnerName(question: string, ownerName: string | null | undefined): OwnerMatch | null {
  const owner = (ownerName ?? '').trim()
  const parts = owner.split(/\s+/).map(fold).filter(Boolean)
  if (!owner || !parts.length) return null
  const words = [...question.matchAll(/[\p{L}\p{N}'’-]+/gu)].map(m => ({ raw: m[0].replace(/['’]s$/i, ''), at: m.index! }))
  const first = parts[0], last = parts.at(-1)!
  for (let i = 0; i < words.length; i++) {
    if (parts.length >= 2 && i + 1 < words.length && nameWordMatches(words[i].raw, first) && nameWordMatches(words[i + 1].raw, last)) {
      return { heard: question.slice(words[i].at, words[i + 1].at + words[i + 1].raw.length), owner }
    }
  }
  if (parts.length >= 2) {
    for (let i = 0; i < words.length; i++) {
      if (!nameWordMatches(words[i].raw, last)) continue
      const before = i > 0 ? fold(words[i - 1].raw) : ''
      if (i === 0 || LEAD_IN.has(before)) return { heard: words[i].raw, owner }
    }
  }
  const subject = personQuestion(question)
  if (subject?.kind === 'who' && subject.subject && fold(subject.subject) === first) return { heard: subject.subject, owner }
  return null
}

const NOT_A_PERSON = new Set(['going', 'speaking', 'talking', 'this', 'that', 'it', 'here', 'there', 'on', 'in', 'at', 'responsible', 'leading', 'next', 'doing', 'supposed', 'the', 'a', 'an', 'we', 'they', 'he', 'she', 'you', 'i', 'someone', 'somebody', 'everyone', 'anyone', 'everybody', 'anybody', 'these', 'those', 'our', 'your', 'their', 'his', 'her', 'its', 'my', 'calling', 'asking', 'saying', 'paying', 'presenting', 'running', 'handling', 'in', 'up', 'out', 'coming', 'joining', 'missing', 'left', 'right', 'correct', 'wrong', 'better', 'best', 'more', 'most', 'not', 'still', 'also', 'currently', 'now', 'all', 'both', 'each', 'which', 'what', 'who', 'whose', 'how'])
const WHO = /\b(?:who(?:'s|’s|\s+is|\s+was|\s+were|\s+are)|tell\s+me\s+(?:more\s+)?about|what\s+(?:do|does)\s+(?:you|we|i|cos)\s+know\s+about)\s+([^?.!,;:]{1,80})/i
const SELF = /\b(?:who\s+am\s+i|about\s+(?:me|myself)\b|(?:going\s+on|happening|happened)\s+(?:with|to|for)\s+me\b|when\s+i\s+was\b|back\s+when\s+i\b|my\s+(?:pregnancy|history|life|past|childhood)\b|what\s+(?:was|were)\s+i\s+(?:doing|going\s+through|dealing\s+with)\b)/i
export type PersonQuestion = { kind: 'who'; subject: string } | { kind: 'self' }
/** "Who is X", "tell me about X", or the owner's own history ("what was going on with me when..."). */
export function personQuestion(question: string): PersonQuestion | null {
  if (SELF.test(question)) return { kind: 'self' }
  const m = WHO.exec(question)
  if (!m) return null
  const subject = m[1].replace(/\b(?:again|now|exactly|really)\s*$/i, '').replace(/^(?:mr|mrs|ms|miss|dr)\.?\s+/i, '').trim()
  const words = subject.split(/\s+/).filter(Boolean)
  if (!words.length || words.length > 5 || !/\p{L}/u.test(subject)) return null
  if (NOT_A_PERSON.has(fold(words[0]))) return null
  if (/^(?:me|myself)$/i.test(subject)) return { kind: 'self' }
  return { kind: 'who', subject }
}

const QUERY_STOP = new Set(['what', 'was', 'were', 'is', 'are', 'going', 'on', 'with', 'me', 'my', 'myself', 'i', 'when', 'back', 'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'about', 'tell', 'happening', 'happened', 'doing', 'through', 'dealing', 'who', 'am', 'did', 'do', 'does', 'how', 'that', 'this', 'it', 'in', 'at', 'so', 'then', 'there', 'can', 'you', 'please', 'know', 'cos'])
/** The COS search phrase for a person question. The owner is searched by the profile spelling, not the heard one. */
export function personLookupQuery(question: string, person: PersonQuestion, owner: OwnerMatch | null, ownerName: string | null): string {
  if (owner) return owner.owner.slice(0, 240)
  if (person.kind === 'who') return person.subject.slice(0, 240)
  const words = (question.match(/[\p{L}\p{N}'’-]+/gu) ?? []).filter(w => !QUERY_STOP.has(fold(w)))
  return (words.length ? words.join(' ') : ownerName ?? '').slice(0, 240)
}

/** Wording that reads an empty lookup as absence ("these sources say nothing about X"). */
export const ABSENCE_CLAIM = /\b(?:say|says|said|mention|mentions|contain|contains|show|shows)\s+nothing\b|\bno\s+(?:information|mention|record|records|details|context)\b|\bnothing\s+(?:about|on|regarding)\b|\b(?:do|does|did)\s*(?:n['’]t|\s+not)\s+(?:say|mention|identify|establish|describe|include)\b/i
/** The disclosure an answer gets when it reads as absence after an empty COS lookup. */
export function searchedDisclosure(queries: readonly string[]): string {
  const list = [...new Set(queries)].slice(0, 2).map(q => `"${q}"`).join(' and ')
  return `COS searched memories and earlier meetings for ${list} and found no match, which does not mean COS has nothing on it.`
}
