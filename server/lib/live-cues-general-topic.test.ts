import { describe, expect, it } from 'vitest'
import {
  admitCueTopic, blockedNameWords, normalizeQuery, profileWorldWords, queryHash, sensitiveWindow, withHomeArea, type AdmitContext, type ProfileNameSource,
} from './live-cues-general-topic.js'

// Every name here is made up. The module holds none: it reads them from the profile and the transcript.
const PROFILE: ProfileNameSource = {
  ownerName: () => 'Zephyrine Quillon',
  speakerLabel: () => 'ZQX',
  vocabulary: () => ['Frobnitz', 'Gizmoworks', 'a'],
  domainKeywords: () => ({ quillco_corp: ['Quillco', 'Brandlet'] }),
}
const NO_NAMES: AdmitContext = { nameWords: new Set(), recent: new Set() }
const ctx = (over: Partial<AdmitContext> = {}): AdmitContext => ({ ...NO_NAMES, ...over })

describe('sensitive window', () => {
  it.each([
    ['health', 'she said her doctor wants the surgery done before the summer'],
    ['health', 'the clinic called about the prescription'],
    ['family', 'my wife and the kids are away this weekend'],
    ['family', 'his mother is turning seventy and we are planning the birthday'],
    ['finance', 'we still owe the IRS and the mortgage is due'],
    ['finance', 'what is the tax situation with the payroll'],
    ['finance', 'rolling over the 401k before retirement'],
    ['legal', 'the lawsuit settlement is with the attorney now'],
    ['school', 'the daycare called and tuition is due'],
    ['school', 'he forgot his homework at school again'],
    ['funeral', 'the funeral is on Friday and the obituary ran today'],
    ['funeral', 'she passed away on Tuesday'],
  ] as const)('skips a %s window: %s', (category, text) => {
    expect(sensitiveWindow(text)).toBe(category)
  })
  it('answers with the category only, never a word from the window', () => {
    expect(JSON.stringify(sensitiveWindow('the mortgage on the lake house'))).toBe('"finance"')
  })
  it('does not fire on look-alike words (whole words only)', () => {
    expect(sensitiveWindow('the reason this season is personal for the arena crowd, an issue of taxonomy and courtesy')).toBeNull()
    expect(sensitiveWindow('the new team joins the Formula One grid at the circuit this weekend')).toBeNull()
  })
  it('also skips a window that names a word of the owner\'s own world from the profile', () => {
    const world = profileWorldWords(PROFILE)
    expect(sensitiveWindow('we were talking about Frobnitz and the roadmap', world)).toBe('profile')
    expect(sensitiveWindow('we were talking about the roadmap', world)).toBeNull()
  })
  it('a profile word skips nothing when the profile has none', () => {
    expect(sensitiveWindow('we were talking about Frobnitz', new Set())).toBeNull()
  })
})

describe('names from the profile and the transcript', () => {
  it('collects the owner, the profile world, the known speakers and the speaker labels that open window lines', () => {
    const window = 'Marlowe: have you seen the new circuit\n[12] **Prunella Voss**: not yet\nYou: ok\nMe: fine\nSpeaker 3: hello'
    const names = blockedNameWords(window, ['Thaddeus Orme'], PROFILE)
    for (const w of ['zephyrine', 'quillon', 'frobnitz', 'gizmoworks', 'quillco', 'brandlet', 'corp', 'thaddeus', 'orme', 'marlowe', 'prunella', 'voss']) expect(names, w).toContain(w)
    for (const w of ['you', 'me', 'speaker']) expect(names, w).not.toContain(w)
  })
  it('lets the owner\'s own name block a query but never skip a whole window', () => {
    expect(blockedNameWords('', [], PROFILE)).toContain('zephyrine')
    expect(profileWorldWords(PROFILE)).not.toContain('zephyrine')
    expect(profileWorldWords(PROFILE)).toContain('quillco')
  })
  it('survives a profile that throws', () => {
    const broken: ProfileNameSource = { ownerName() { throw new Error('x') }, speakerLabel() { throw new Error('x') }, vocabulary() { throw new Error('x') }, domainKeywords() { throw new Error('x') } }
    expect([...blockedNameWords('Marlowe: hi', [], broken)]).toEqual(['marlowe'])
    expect(profileWorldWords(broken).size).toBe(0)
  })
})

describe('admitCueTopic', () => {
  it('admits a plain public query and returns it unchanged with its normalized form', () => {
    const r = admitCueTopic('Formula One circuit news', ctx())
    expect(r).toEqual({ ok: true, query: 'Formula One circuit news', normalized: 'formula one circuit news' })
  })
  it('rejects an empty query', () => {
    expect(admitCueTopic('   ', ctx())).toEqual({ ok: false, reason: 'empty' })
  })
  it('rejects any digit, so an amount, date or year never reaches the web', () => {
    for (const q of ['Austin FC 2026 season', 'irs installment agreement 81000', 'tickets under 50', 'room ٣ news']) {
      const r = admitCueTopic(q, ctx())
      expect(r, q).toEqual({ ok: false, reason: 'digit' })
    }
  })
  it('rejects a spoken amount or number word', () => {
    for (const q of ['eighty one thousand dollar settlement', 'two million views', 'ten percent growth']) expect(admitCueTopic(q, ctx()), q).toEqual({ ok: false, reason: 'number_word' })
  })
  it('rejects a deny-list word: private-life vocabulary and the private words the Ask gate already refuses', () => {
    for (const q of ['irs payment plan', 'family court news', 'school daycare news', 'hospital merger', 'client contract news', 'customer lawsuit', 'birthday party venues']) {
      expect(admitCueTopic(q, ctx()), q).toEqual({ ok: false, reason: 'deny_word' })
    }
  })
  it('rejects a speaker, owner or profile name word, with plural-insensitive matching', () => {
    const names = ctx({ nameWords: blockedNameWords('Marlowe: hi', [], PROFILE) })
    for (const q of ['Marlowe bakery news', 'Marlowes bakery', 'Zephyrine keynote', 'Quillco product launch', 'Frobnitz review']) {
      expect(admitCueTopic(q, names), q).toEqual({ ok: false, reason: 'name' })
    }
    expect(admitCueTopic('Formula One circuit news', names).ok).toBe(true)
  })
  it('rejects a secret', () => {
    expect(admitCueTopic('sk-abcdefghijklmnop', ctx())).toEqual({ ok: false, reason: 'secret' })
  })
  it('rejects a query over 80 characters or over 8 words', () => {
    expect(admitCueTopic('a'.repeat(81), ctx())).toEqual({ ok: false, reason: 'too_long' })
    expect(admitCueTopic('a'.repeat(80), ctx()).ok).toBe(true)
    expect(admitCueTopic('alpha beta gamma delta epsilon zeta eta theta iota', ctx())).toEqual({ ok: false, reason: 'too_many_words' })
    expect(admitCueTopic('alpha beta gamma delta epsilon zeta eta theta', ctx()).ok).toBe(true)
  })
  it('rejects operators, quotes and urls: letters, spaces, apostrophes, periods, ampersands and hyphens only', () => {
    expect(admitCueTopic('site:example.org news', ctx())).toEqual({ ok: false, reason: 'characters' })
    expect(admitCueTopic('"exact phrase" news', ctx())).toEqual({ ok: false, reason: 'characters' })
    expect(admitCueTopic('visit www example', ctx())).toEqual({ ok: false, reason: 'url' })
    expect(admitCueTopic("Ben & Jerry's ice-cream news", ctx()).ok).toBe(true)
  })
  it('rejects a repeat of a recent query however it is cased or punctuated', () => {
    const recent = ctx({ recent: new Set([normalizeQuery('Formula One circuit news')]) })
    expect(admitCueTopic('FORMULA ONE circuit   news', recent)).toEqual({ ok: false, reason: 'repeat' })
    expect(admitCueTopic('Formula-One circuit news', recent)).toEqual({ ok: false, reason: 'repeat' })
    expect(admitCueTopic('Formula One circuit news today', recent).ok).toBe(true)
  })
})

describe('local area', () => {
  it('appends the owner\'s city-level label, without its comma', () => {
    expect(withHomeArea('street food festival', 'Austin, TX')).toBe('street food festival Austin TX')
    expect(withHomeArea('street food festival', '  Kansas   City, MO ')).toBe('street food festival Kansas City MO')
  })
  it('appends nothing unless the label passes HOME_AREA_LABEL (letters, spaces and . , \' - only): never an address', () => {
    expect(withHomeArea('street food festival', '1200 Main St, Austin')).toBeNull()
    expect(withHomeArea('street food festival', 'Austin 78701')).toBeNull()
    expect(withHomeArea('street food festival', '')).toBeNull()
    expect(withHomeArea('street food festival', null)).toBeNull()
  })
  it('the longer string is a new query: it can break the length limits and must be admitted again', () => {
    const base = 'riverside street food festival lineup tonight'
    expect(admitCueTopic(base, ctx()).ok).toBe(true)
    expect(admitCueTopic(withHomeArea(base, 'San Francisco, CA')!, ctx())).toEqual({ ok: false, reason: 'too_many_words' })
  })
})

describe('query hash', () => {
  it('is the first 12 hex of sha256 of the normalized query, so case and punctuation do not change it', () => {
    const h = queryHash('Formula One circuit news')
    expect(h).toMatch(/^[0-9a-f]{12}$/)
    expect(queryHash('formula one -- circuit NEWS')).toBe(h)
    expect(queryHash('Formula One circuit')).not.toBe(h)
  })
  it('never contains the query', () => {
    expect(queryHash('Formula One circuit news')).not.toMatch(/formula/i)
  })
})
