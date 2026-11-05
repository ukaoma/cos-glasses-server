/**
 * Drop it test fixtures: a fake bridge (writers that record every call and keep their own little stores), a fake
 * decision client that answers from a script keyed by the drop's words, and the replay set for canary 1.
 *
 * The replay set's Jev answers are SCRIPTED, not recorded from TypeSafe. Canary 1 therefore measures the router's own
 * logic (rules, candidate selection, thresholds, the one-question fallback) against hand labels. It does not measure
 * Jev's accuracy; that needs a live run with a real key (drop-canaries.test.ts, COS_DROP_LIVE_REPLAY=1).
 */
import { searchOptionText } from '../work-search.js'
import type { DecisionClient } from '../decision-provider.js'
import type { JevAnswers } from '../jev.js'
import type { DropWriters } from '../drop-destinations.js'
import { DropDestinationError } from '../drop-destinations.js'
import { rankByOverlap, type RouteCandidates } from '../drop-router.js'

export const DOMAINS = [
  { name: 'work', label: 'Work' }, { name: 'side_shop', label: 'Side shop' },
  { name: 'consulting', label: 'Consulting' }, { name: 'personal', label: 'Personal' },
]

const hex = (n: number) => n.toString(16).padStart(12, 'a')
const CARD_TEXT: Array<[string, string]> = [
  ['work', 'Run the price test for a first-month discount'], ['work', 'Build the kickoff deck outline'],
  ['consulting', 'Send invoice reminder to the consulting client'], ['work', 'Fix the HubSpot theme settings for the blog'],
  ['work', 'Write the onboarding flow copy for new stores'], ['work', 'Pull the weekly lead numbers for the pacing call'],
  ['work', 'Review the pet persona interview notes'], ['side_shop', 'Migrate the side shop product feed'],
  ['side_shop', 'Answer the marketplace listing questions'], ['consulting', 'Scope the academy design project'],
  ['consulting', 'Set up the donation sync for the nonprofit client'], ['personal', 'Renew the car registration'],
  ['personal', 'Plan the family weekend trip'], ['work', 'Draft the trade show booth brief'],
  ['work', 'Clean up the comparison pages sitemap'], ['work', 'Prep the quarterly business review slides'],
  ['work', 'Update the case study template'], ['work', 'Audit the form modules for device capture'],
  ['side_shop', 'Fix the checkout button color on mobile'], ['consulting', 'Review the VPS cutover plan'],
  ['work', 'Send the field team the updated pricing sheet'], ['work', 'Reply to the agency about the video edit'],
  ['work', 'Outline the industry report on thrift stores'], ['personal', 'Order school supplies'],
  ['work', 'Check the A/B test conversion read'], ['work', 'Book the venue walkthrough for the summit'],
  ['consulting', 'Write the monthly hours summary'], ['side_shop', 'Draft the Breeze marketplace submission'],
  ['work', 'Rewrite the hero copy for the grocery page'], ['work', 'Line up two customer quotes for the webinar'],
  ['work', 'Update the brand kit colors'], ['work', 'Plan the email nurture for jewelry leads'],
  ['personal', 'Call the plumber about the kitchen sink'], ['work', 'Clean up the CRM duplicate contacts'],
  ['work', 'Review the partner co-marketing proposal'], ['work', 'Finalize the summit speaker list'],
  ['work', 'Ship the blog post on bottle shop margins'], ['work', 'Prepare the board recap notes'],
  ['consulting', 'Send the academy wireframes for review'], ['work', 'Refresh the persona data for pet stores'],
]
export const CARDS = CARD_TEXT.map(([domain, text], i) => ({ id: hex(i + 1), workIdentity: hex(i + 1), domain, text }))
export const THREADS = [
  'Kickoff 2027 Planning', 'Trade show budget', 'Pricing tests', 'Pet persona research', 'Summit logistics',
  'Hiring a content writer', 'Website redesign', 'Agency relationship', 'Board reporting', 'Academy design',
  'Donation sync', 'Family travel', 'Home repairs', 'Comparison pages', 'Industry reports',
].map((name, i) => ({ id: `thread-${i + 1}`, name, topics: [] as string[] }))

export interface ReplayEntry {
  text: string
  /** The hand label: where it should go. `target` is a card's text, a thread's name or a domain name. */
  label: { dest: string; target?: string }
  hint?: { sessionId: string; label: string }
  /** The scripted Jev answer. Absent for rule-routed drops (no Jev call expected). */
  jev?: { dest: Record<string, number>; domain?: string; domainP?: number; card?: string; cardP?: number; thread?: string; threadP?: number; session?: number; clear?: number }
}

export const REPLAY: ReplayEntry[] = [
  { text: 'remind me Thursday 9am to send the QBR numbers', label: { dest: 'reminder' } },
  { text: 'remind me to call the bank tomorrow', label: { dest: 'reminder' } },
  { text: 'remember that the Tulsa store prefers email over phone', label: { dest: 'memory' } },
  { text: 'Remember I take my coffee black', label: { dest: 'memory' } },
  { text: 'what did we decide about the price test?', label: { dest: 'ask' } },
  { text: 'how many leads came in last week', label: { dest: 'ask' } },
  { text: 'Is the deck ready for Friday?', label: { dest: 'ask' } },
  { text: 'Draft the onboarding email sequence for new liquor stores', label: { dest: 'new_card', target: 'work' },
    jev: { dest: { new_card: 0.9, existing_card: 0.05, note: 0.05 }, domain: 'work', domainP: 0.92, card: 'none', cardP: 0.8, clear: 0.8 } },
  { text: 'Order a new HDMI cable for the conference room', label: { dest: 'new_card', target: 'work' },
    jev: { dest: { new_card: 0.86, note: 0.1 }, domain: 'work', domainP: 0.81, clear: 0.9 } },
  { text: 'Update the side shop theme footer links', label: { dest: 'new_card', target: 'side_shop' },
    jev: { dest: { new_card: 0.88, existing_card: 0.08 }, domain: 'side_shop', domainP: 0.9, card: 'none', cardP: 0.7, clear: 0.8 } },
  { text: 'Invoice the consulting client for October hours', label: { dest: 'new_card', target: 'consulting' },
    jev: { dest: { new_card: 0.91, existing_card: 0.06 }, domain: 'consulting', domainP: 0.95, card: 'none', cardP: 0.6, clear: 0.9 } },
  { text: 'Book the dentist for the kids', label: { dest: 'new_card', target: 'personal' },
    jev: { dest: { new_card: 0.84, note: 0.1 }, domain: 'personal', domainP: 0.9, clear: 0.8 } },
  { text: 'Build a landing page for the spring trade show', label: { dest: 'new_card', target: 'work' },
    jev: { dest: { new_card: 0.83, thread: 0.1 }, domain: 'work', domainP: 0.88, thread: 'none', threadP: 0.7, clear: 0.8 } },
  { text: 'Add the Clover switcher stat to the price test card', label: { dest: 'existing_card', target: 'Run the price test for a first-month discount' },
    jev: { dest: { existing_card: 0.87, new_card: 0.08 }, card: 'Run the price test for a first-month discount', cardP: 0.9, domain: 'work', domainP: 0.9, clear: 0.8 } },
  { text: 'Kickoff deck: the agenda needs a customer story slide', label: { dest: 'existing_card', target: 'Build the kickoff deck outline' },
    jev: { dest: { existing_card: 0.85, thread: 0.1 }, card: 'Build the kickoff deck outline', cardP: 0.88, thread: 'Kickoff 2027 Planning', threadP: 0.6, clear: 0.7 } },
  { text: 'For the invoice reminder, include the PO number', label: { dest: 'existing_card', target: 'Send invoice reminder to the consulting client' },
    jev: { dest: { existing_card: 0.9, new_card: 0.05 }, card: 'Send invoice reminder to the consulting client', cardP: 0.93, clear: 0.9 } },
  { text: 'Kickoff planning: open with three store stories, not numbers', label: { dest: 'thread', target: 'Kickoff 2027 Planning' },
    jev: { dest: { thread: 0.85, existing_card: 0.05 }, thread: 'Kickoff 2027 Planning', threadP: 0.9, card: 'Build the kickoff deck outline', cardP: 0.4, clear: 0.7 } },
  { text: 'Trade show budget might need another booth panel', label: { dest: 'thread', target: 'Trade show budget' },
    jev: { dest: { thread: 0.88, new_card: 0.06 }, thread: 'Trade show budget', threadP: 0.92, clear: 0.6 } },
  { text: 'Pricing tests: the annual plan discount could hurt renewals', label: { dest: 'thread', target: 'Pricing tests' },
    jev: { dest: { thread: 0.84, note: 0.1 }, thread: 'Pricing tests', threadP: 0.87, clear: 0.4 } },
  { text: 'The accountant needs receipts by the 5th every month', label: { dest: 'memory' },
    jev: { dest: { memory: 0.93, new_card: 0.04 }, clear: 0.9 } },
  { text: 'Jordan prefers Teams over Slack for quick questions', label: { dest: 'memory' },
    jev: { dest: { memory: 0.92, note: 0.05 }, clear: 0.9 } },
  { text: 'Interesting thought: loyalty points could work for pet stores', label: { dest: 'note' },
    jev: { dest: { note: 0.85, thread: 0.08 }, thread: 'Pet persona research', threadP: 0.4, clear: 0.3 } },
  { text: 'Saw a nice hero animation on a competitor site', label: { dest: 'note' },
    jev: { dest: { note: 0.82, new_card: 0.1 }, domain: 'work', domainP: 0.6, clear: 0.4 } },
  { text: 'Weekly numbers looked flat but leads were fine', label: { dest: 'note' },
    jev: { dest: { note: 0.88, existing_card: 0.06 }, card: 'Pull the weekly lead numbers for the pacing call', cardP: 0.3, clear: 0.7 } },
  { text: 'also add the Q4 numbers to the summary', label: { dest: 'session' }, hint: { sessionId: 'claude:5f1c', label: 'Marketing priorities slides' },
    jev: { dest: { session: 0.9, note: 0.05 }, session: 0.9, clear: 0.8 } },
  { text: 'Call Dale about the Kickoff deck', label: { dest: 'new_card', target: 'work' },
    jev: { dest: { new_card: 0.55, thread: 0.35 }, domain: 'work', domainP: 0.8, thread: 'Kickoff 2027 Planning', threadP: 0.7, card: 'Build the kickoff deck outline', cardP: 0.3, clear: 0.8 } },
  { text: 'Maybe revisit the onboarding flow', label: { dest: 'note' },
    jev: { dest: { note: 0.5, new_card: 0.4 }, domain: 'work', domainP: 0.7, card: 'Write the onboarding flow copy for new stores', cardP: 0.5, clear: 0.3 } },
  { text: 'Follow up on the HubSpot theme settings', label: { dest: 'existing_card', target: 'Fix the HubSpot theme settings for the blog' },
    jev: { dest: { existing_card: 0.6, new_card: 0.3 }, card: 'Fix the HubSpot theme settings for the blog', cardP: 0.75, domain: 'work', domainP: 0.9, clear: 0.7 } },
  { text: 'The pet persona could use more store-owner quotes', label: { dest: 'thread', target: 'Pet persona research' },
    jev: { dest: { thread: 0.62, memory: 0.2 }, thread: 'Pet persona research', threadP: 0.8, card: 'Review the pet persona interview notes', cardP: 0.4, clear: 0.6 } },
  { text: 'Try $10 off the first month for stores switching', label: { dest: 'existing_card', target: 'Run the price test for a first-month discount' },
    jev: { dest: { existing_card: 0.7, new_card: 0.25 }, card: 'Run the price test for a first-month discount', cardP: 0.85, domain: 'work', domainP: 0.9, clear: 0.6 } },
  { text: 'Jordan has a birthday in March', label: { dest: 'memory' },
    jev: { dest: { memory: 0.85, note: 0.1 }, clear: 0.9 } },
  // Jev confidently wrong on the domain: filed to Consulting, labelled Work. Counts as filed wrong.
  { text: 'Send the board recap to the team', label: { dest: 'new_card', target: 'work' },
    jev: { dest: { new_card: 0.9, existing_card: 0.05 }, domain: 'consulting', domainP: 0.85, card: 'Prepare the board recap notes', cardP: 0.4, clear: 0.9 } },
  { text: 'Renew the domain for the side shop', label: { dest: 'new_card', target: 'side_shop' },
    jev: { dest: { new_card: 0.9, note: 0.05 }, domain: 'side_shop', domainP: 0.9, clear: 0.9 } },
  { text: 'Schedule the oil change', label: { dest: 'new_card', target: 'personal' },
    jev: { dest: { new_card: 0.85, note: 0.1 }, domain: 'personal', domainP: 0.86, clear: 0.9 } },
  { text: 'Summit logistics: shuttle times need to be on the invite', label: { dest: 'thread', target: 'Summit logistics' },
    jev: { dest: { thread: 0.86, existing_card: 0.08 }, thread: 'Summit logistics', threadP: 0.9, card: 'Finalize the summit speaker list', cardP: 0.2, clear: 0.8 } },
]

/** The world the bridge would answer, filtered the way the real writers filter it. */
export function candidatesFor(text: string, session?: { id: string; label: string }): RouteCandidates {
  return {
    domains: DOMAINS,
    cards: rankByOverlap(text, CARDS, c => c.text, 30),
    threads: rankByOverlap(text, THREADS, t => `${t.name} ${t.topics.join(' ')}`, 15).map(t => ({ id: t.id, name: t.name })),
    ...(session ? { session } : {}),
  }
}

/** Probabilities over `keys`: `top` gets `p`, the rest share what is left. */
function spread(keys: string[], top: string | undefined, p: number): Record<string, number> {
  const out: Record<string, number> = {}
  const rest = keys.filter(k => k !== top)
  for (const k of keys) out[k] = k === top ? p : rest.length ? (1 - (top && keys.includes(top) ? p : 0)) / rest.length : 0
  return out
}

/** Answers like Jev would, from the script, mapping card and thread words back to the offered option keys. */
export function scriptedAnswer(questions: Record<string, { type: string; criteria?: Record<string, string> }>, script: NonNullable<ReplayEntry['jev']>): JevAnswers['answers'] {
  const answers: JevAnswers['answers'] = {}
  const keyFor = (criteria: Record<string, string>, words: string | undefined, isDomain = false): string | undefined => {
    if (!words) return undefined
    if (words === 'none') return 'none'
    if (isDomain) { const label = DOMAINS.find(d => d.name === words)?.label; return Object.keys(criteria).find(k => criteria[k] === label) }
    return Object.keys(criteria).find(k => criteria[k] === searchOptionText(words))
  }
  const dest = questions.dest.criteria!
  const destKeys = Object.keys(dest)
  const offered = Object.entries(script.dest).filter(([k]) => destKeys.includes(k))
  const sum = offered.reduce((s, [, p]) => s + p, 0)
  const restKeys = destKeys.filter(k => !(k in script.dest))
  answers.dest = { type: 'choice', probabilities: Object.fromEntries(destKeys.map(k => [k, k in script.dest ? script.dest[k] : restKeys.length ? Math.max(0, 1 - sum) / restKeys.length : 0])) }
  if (questions.domain) answers.domain = { type: 'choice', probabilities: spread(Object.keys(questions.domain.criteria!), keyFor(questions.domain.criteria!, script.domain, true), script.domainP ?? 0.25) }
  if (questions.card) {
    const key = keyFor(questions.card.criteria!, script.card) ?? 'none'
    answers.card = { type: 'choice', probabilities: spread(Object.keys(questions.card.criteria!), key, key === 'none' && !script.card ? 0.9 : script.cardP ?? 0.9) }
  }
  if (questions.thread) {
    const key = keyFor(questions.thread.criteria!, script.thread) ?? 'none'
    answers.thread = { type: 'choice', probabilities: spread(Object.keys(questions.thread.criteria!), key, key === 'none' && !script.thread ? 0.9 : script.threadP ?? 0.9) }
  }
  if (questions.session) answers.session = { type: 'noul', noul: script.session ?? 0.1 }
  answers.clear = { type: 'noul', noul: script.clear ?? 0.5 }
  return answers
}

export interface FakeDecision extends DecisionClient { calls: Array<{ state: unknown; questions: Record<string, unknown>; estimate: number }> }
/** A decision client answering from the replay script, by the drop's cleaned words. */
export function scriptedDecisionClient(entries: ReplayEntry[] = REPLAY): FakeDecision {
  const byWords = new Map(entries.filter(e => e.jev).map(e => [searchOptionText(e.text), e.jev!]))
  const calls: FakeDecision['calls'] = []
  return {
    provider: 'jev', calls,
    async ask(state, questions, estimate) {
      calls.push({ state, questions, estimate })
      const script = byWords.get((state as { drop: string }).drop)
      if (!script) throw new Error('no script for this drop')
      return { provider: 'jev', answers: scriptedAnswer(questions as never, script), model: 'jev-test', inputTokens: estimate }
    },
  }
}

export interface FakeWriters extends DropWriters {
  cards: Map<string, { domain: string; text: string; archived: boolean; touched: boolean }>
  memories: Map<string, { text: string; pruned: boolean; reviewed: boolean; dropId: string }>
  threadSources: Map<string, { threadId: string; text: string; removed: boolean; touched: boolean }>
  calls: string[]
  missing: Set<string>
}
/** A bridge that records every call and keeps what was written, so Undo can be checked against "before". */
export function fakeWriters(options: { missing?: string[]; candidates?: (text: string, session?: { id: string; label: string }) => RouteCandidates } = {}): FakeWriters {
  const w: FakeWriters = {
    cards: new Map(), memories: new Map(), threadSources: new Map(), calls: [], missing: new Set(options.missing ?? []),
    async captureCard(domain, text, dropId) {
      w.calls.push(`captureCard:${domain}`)
      if (w.missing.has('captureCard')) throw new DropDestinationError('destination_unavailable')
      // Same words as a card already there: that card answers, created false (the bridge's dedup).
      const same = [...w.cards.entries()].find(([, c]) => c.text === text && !c.archived)
      if (same) return { id: same[0], workIdentity: same[0], created: false }
      const id = dropId.replace(/-/g, '').slice(0, 12)
      w.cards.set(id, { domain, text, archived: false, touched: false })
      return { id, workIdentity: id, created: true }
    },
    async archiveCard(_domain, id) {
      w.calls.push(`archiveCard:${id}`)
      const card = w.cards.get(id)
      if (!card) return 'gone'
      if (card.touched) return 'touched'
      card.archived = true
      return 'archived'
    },
    async captureMemory(text, dropId, attempt) {
      w.calls.push('captureMemory')
      if (w.missing.has('captureMemory')) throw new DropDestinationError('destination_unavailable')
      // The memory contract: under 30 characters is refused (memory_contract.MIN_CONTENT_LENGTH).
      if (text.trim().length < 30) throw new DropDestinationError('memory_too_short')
      const id = `mem_${dropId.slice(0, 8)}_${attempt}`
      w.memories.set(id, { text, pruned: false, reviewed: false, dropId })
      return { id, created: true }
    },
    async pruneMemory(id, dropId) {
      w.calls.push(`pruneMemory:${id}`)
      const m = w.memories.get(id)
      if (!m) return 'gone'
      if (m.reviewed || m.dropId !== dropId) return 'touched'
      m.pruned = true
      return 'pruned'
    },
    async sourceThread(threadId, text, dropId) {
      w.calls.push(`sourceThread:${threadId}`)
      if (w.missing.has('sourceThread')) throw new DropDestinationError('destination_unavailable')
      const sourceId = `note-${dropId.slice(0, 8)}`
      w.threadSources.set(sourceId, { threadId, text, removed: false, touched: false })
      return { sourceId, created: true }
    },
    async unsourceThread(_threadId, sourceId) {
      w.calls.push(`unsourceThread:${sourceId}`)
      const s = w.threadSources.get(sourceId)
      if (!s) return 'gone'
      if (s.touched) return 'touched'
      s.removed = true
      return 'removed'
    },
    async candidates(text, session) { return (options.candidates ?? candidatesFor)(text, session) },
    async cardStates() {
      const map = new Map<string, { workStage: string; checked: boolean }>()
      for (const [id] of w.cards) map.set(id, { workStage: 'planned', checked: false })
      return map
    },
  }
  return w
}
