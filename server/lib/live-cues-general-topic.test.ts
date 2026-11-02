import { describe, expect, it } from 'vitest'
import {
  HASHABLE_REJECTIONS, admitCueTopic, blockedNameWords, cachedNames, isGenericSpeakerLabel, normalizeForMatch, normalizeQuery, ownerTermJoins, ownerTermPhrases, queryHash,
  sensitiveWindow, withHomeArea, type AdmitContext, type ProfileNameSource,
} from './live-cues-general-topic.js'

// Every name here is made up. The module holds none: it reads them from the profile and the transcript.
const PROFILE: ProfileNameSource = {
  ownerName: () => 'Zephyrine Quillon',
  speakerLabel: () => 'ZQX',
  // The real vocabulary holds plain work words inside longer terms ("retail", "pos"), so the tests do too.
  vocabulary: () => ['Frobnitz', 'Gizmoworks', 'a', 'retail analytics hub', 'POS', 'Bottle POS', 'ITRetail', 'Markt POS'],
  domainKeywords: () => ({ quillco_corp: ['Quillco', 'Brandlet'] }),
  voiceProfileNames: () => ['Thaddeus Orme', 'José Valdez'],
}
const NO_NAMES: AdmitContext = { nameWords: new Set(), terms: [], joins: [], recent: new Set() }
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
  /** One trigger word each, so the gate can take a stem out and see this test fail. */
  const WIDENED = [
    ['health', 'chemo*', 'she started chemo last week'], ['health', 'ob gyn', 'the OB-GYN moved it'], ['health', 'c section', 'after the C-section she rested'],
    ['health', 'adhd', 'ADHD at work'], ['health', 'psychiatr*', 'the psychiatrist agrees'], ['health', 'psycholog*', 'the psychologist agrees'],
    ['health', 'pediatric*', 'a pediatric ward'], ['health', 'hospice', 'the hospice called'], ['health', 'pharmac*', 'the pharmacy called'], ['health', 'autis*', 'autism screening'],
    ['finance', 'irs', 'the I.R.S. called'], ['finance', 'installment*', 'an installment plan'], ['finance', 'escrow', 'the escrow account'],
    ['finance', 'credit score', 'his credit score'], ['finance', 'pension*', 'his pension'], ['finance', 'insurance', 'the insurance claim'],
    ['family', 'husband*', 'both husbands came along'], ['family', 'wives', 'their wives came'], ['family', 'moms', 'the moms organized it'], ['family', 'parent*', 'his parents are in town'],
    ['family', 'grandma*', 'my grandma came'], ['family', 'aunt*', 'an aunt came'], ['family', 'uncle*', 'his uncle came'], ['family', 'cousin*', 'the cousins came'],
    ['family', 'nephew*', 'her nephew visits'], ['family', 'niece*', 'her niece visits'],
    ['school', 'dnp', 'the DNP program'], ['school', 'dissertation*', 'the dissertation is due'], ['school', 'nursery', 'the nursery pickup'],
    ['funeral', 'die', 'the plant will die'], ['funeral', 'dies', 'the plant dies'], ['funeral', 'died', 'the plant died'], ['funeral', 'dying', 'the plant is dying'],
  ] as const
  it.each(WIDENED)('widened list: skips a %s window (%s): %s', (category, _stem, text) => {
    expect(sensitiveWindow(text)).toBe(category)
  })
  it('reads the window normalized: full-width letters, accents, dotted acronyms, hyphens and slashes', () => {
    expect(normalizeForMatch('The I.R.S. said  C-SECTION / OB-GYN, Zoë')).toBe('the irs said c section ob gyn, zoe')
    expect(normalizeForMatch('ＩＲＳ')).toBe('irs')
    expect(sensitiveWindow('ＩＲＳ called')).toBe('finance')
    expect(sensitiveWindow('the i.r.s. called')).toBe('finance')
    expect(sensitiveWindow('Ob-Gyn')).toBe('health')
    expect(normalizeForMatch('e.g. this')).toBe('eg this')
  })
  it('does not fire on public words that merely begin like a private one', () => {
    for (const text of ['a moment of momentum', 'the kidney bean', 'a taxi to the taxonomy lab', 'the Grand Prix and the grandstands', 'a motherboard upgrade', 'the underwriters', 'a psychedelic poster', 'sonic the hedgehog']) {
      expect(sensitiveWindow(text), text).toBeNull()
    }
  })
  it('answers with the category only, never a word from the window', () => {
    expect(JSON.stringify(sensitiveWindow('the mortgage on the lake house'))).toBe('"finance"')
  })
  it('does not fire on look-alike words (whole words only)', () => {
    expect(sensitiveWindow('the reason this season is personal for the arena crowd, an issue of taxonomy and courtesy')).toBeNull()
    expect(sensitiveWindow('the new team joins the Formula One grid at the circuit this weekend')).toBeNull()
  })
  it('takes no profile input: the owner\'s own terms never skip a window', () => {
    expect(sensitiveWindow.length).toBe(1)
    expect(sensitiveWindow('we were talking about Frobnitz and the retail analytics hub')).toBeNull()
  })
})

describe('names from the profile and the transcript', () => {
  it('collects the owner and their label, the known speakers and the speaker labels that open window lines, one word each', async () => {
    const window = 'Marlowe: have you seen the new circuit\n[12] **Prunella Voss**: not yet\nYou: ok\nMe: fine\nSpeaker 3: hello'
    const names = await blockedNameWords(window, ['Thaddeus Orme'], PROFILE)
    for (const w of ['zephyrine', 'quillon', 'thaddeus', 'orme', 'marlowe', 'prunella', 'voss']) expect(names, w).toContain(w)
    for (const w of ['you', 'me', 'speaker']) expect(names, w).not.toContain(w)
  })
  it('does not block the profile\'s vocabulary or domain keywords word by word: they are whole terms (ownerTermPhrases)', async () => {
    const names = await blockedNameWords('', [], PROFILE)
    for (const w of ['retail', 'analytics', 'hub', 'pos', 'frobnitz', 'gizmoworks', 'quillco', 'brandlet', 'corp']) expect(names, w).not.toContain(w)
  })
  it('survives a profile that throws', async () => {
    const broken: ProfileNameSource = { ownerName() { throw new Error('x') }, speakerLabel() { throw new Error('x') }, vocabulary() { throw new Error('x') }, domainKeywords() { throw new Error('x') } }
    expect([...await blockedNameWords('Marlowe: hi', [], broken)]).toEqual(['marlowe'])
    expect(ownerTermPhrases(broken)).toEqual([])
    expect(ownerTermJoins(broken)).toEqual([])
  })
  it('blocks every word of every enrolled voice profile name, with accents folded too', async () => {
    const names = await blockedNameWords('', [], PROFILE)
    for (const w of ['thaddeus', 'orme', 'josé', 'jose', 'valdez']) expect(names, w).toContain(w)
  })
  it('REJECTS when the voice profile names cannot be read (sync or async), so the caller can withhold', async () => {
    const unreadable: ProfileNameSource = { ...PROFILE, voiceProfileNames() { throw new Error('store unreadable') } }
    await expect(blockedNameWords('', [], unreadable)).rejects.toThrow('store unreadable')
    await expect(blockedNameWords('', [], { ...PROFILE, voiceProfileNames: async () => { throw new Error('async store unreadable') } })).rejects.toThrow('async store unreadable')
    expect([...await blockedNameWords('', [], { ...PROFILE, voiceProfileNames: async () => ['Async Person'] })]).toEqual(expect.arrayContaining(['async', 'person']))
  })
  it('a source with no voice store adds no voice names', async () => {
    const { voiceProfileNames: _unused, ...noVoices } = PROFILE
    expect(await blockedNameWords('', [], noVoices as ProfileNameSource)).not.toContain('thaddeus')
  })
  it('reads a name reported by the ASR path as a speaker, but never a generic label', async () => {
    const names = await blockedNameWords('', ['Prunella Voss', 'Ext', 'Unidentified', 'Speaker 2', 'You', 'MU', 'Guest 3', 'unknown'], PROFILE)
    expect(names).toContain('prunella')
    expect(names).toContain('voss')
    for (const w of ['ext', 'unidentified', 'speaker', 'you', 'guest', 'unknown']) expect(names, w).not.toContain(w)
    for (const label of ['Ext', 'Unidentified', 'Speaker 2', 'speaker', 'You', 'Me', 'MU', 'Guest 3', 'Voice 1', 'Note', 'unknown', 'Host']) expect(isGenericSpeakerLabel(label), label).toBe(true)
    for (const name of ['Prunella', 'Speaker Voss', 'Ghost Rider']) expect(isGenericSpeakerLabel(name), name).toBe(false)
  })
})

describe('cached names', () => {
  it('reads once inside the window, again after it, and never serves a stale copy past it', async () => {
    let t = 1_000, reads = 0, fail = false
    const read = cachedNames(() => { reads += 1; if (fail) throw new Error('unreadable'); return ['A', 'B'] }, 300_000, () => t)
    expect(await read()).toEqual(['A', 'B']); expect(await read()).toEqual(['A', 'B'])
    expect(reads).toBe(1)
    t += 299_999
    await read()
    expect(reads).toBe(1)
    t += 1
    await read()
    expect(reads).toBe(2)
    fail = true
    t += 300_000
    await expect(read()).rejects.toThrow('unreadable')
    fail = false
    expect(await read()).toEqual(['A', 'B'])
  })
  it('the default window is five minutes', async () => {
    let t = 0, reads = 0
    const read = cachedNames(() => { reads += 1; return [] }, undefined, () => t)
    await read(); t = 5 * 60_000 - 1; await read()
    expect(reads).toBe(1)
    t = 5 * 60_000; await read()
    expect(reads).toBe(2)
  })
})

describe('owner terms', () => {
  it('lists every vocabulary term and every domain-keyword term and domain name as stemmed lowercase word lists', () => {
    expect(ownerTermPhrases(PROFILE)).toEqual([['frobnitz'], ['gizmowork'], ['retail', 'analytic', 'hub'], ['pos'], ['bottle', 'pos'], ['itretail'], ['markt', 'pos'], ['quillco', 'corp'], ['quillco'], ['brandlet']])
  })
  it('ignores a term under three characters, repeats and non-strings', () => {
    const src: ProfileNameSource = { ownerName: () => '', speakerLabel: () => '', vocabulary: () => ['a', 'Hi', 'Frobnitz', 'frobnitz', 'FROBNITZ'], domainKeywords: () => ({ x: ['Gizmo', 5 as unknown as string], y: 'nope' as unknown as string[] }) }
    expect(ownerTermPhrases(src)).toEqual([['frobnitz'], ['gizmo']])
  })
  it('also lists each term with its spaces taken out, unstemmed, three characters or more', () => {
    expect(ownerTermJoins(PROFILE)).toEqual(['frobnitz', 'gizmoworks', 'retailanalyticshub', 'pos', 'bottlepos', 'itretail', 'marktpos', 'quillcocorp', 'quillco', 'brandlet'])
    expect(ownerTermJoins({ ownerName: () => '', speakerLabel: () => '', vocabulary: () => ['a', 'Hi', 'Ab Cd'], domainKeywords: () => ({}) })).toEqual(['abcd'])
  })
  it('is empty for a profile with no vocabulary and no domain keywords', () => {
    expect(ownerTermPhrases({ ownerName: () => 'X', speakerLabel: () => 'Y', vocabulary: () => [], domainKeywords: () => ({}) })).toEqual([])
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
  it('rejects a speaker or owner name word, with plural-insensitive matching', async () => {
    const names = ctx({ nameWords: await blockedNameWords('Marlowe: hi', [], PROFILE) })
    for (const q of ['Marlowe bakery news', 'Marlowes bakery', 'Zephyrine keynote', 'Quillon interview']) {
      expect(admitCueTopic(q, names), q).toEqual({ ok: false, reason: 'name' })
    }
    expect(admitCueTopic('Formula One circuit news', names).ok).toBe(true)
  })
  it('owner term: rejects a query that carries a WHOLE vocabulary or domain-keyword term, in any case and with other words around it', () => {
    const owner = ctx({ terms: ownerTermPhrases(PROFILE) })
    for (const q of ['Quillco product launch', 'frobnitz review', 'Retail Analytics Hub pricing news', 'news about the RETAIL ANALYTICS HUB', 'Quillco Corp earnings call', 'POS system news']) {
      expect(admitCueTopic(q, owner), q).toEqual({ ok: false, reason: 'owner_term' })
    }
  })
  it('owner term: a query with just one word of a longer term passes, so plain work words do not block work queries', () => {
    const owner = ctx({ terms: ownerTermPhrases(PROFILE) })
    for (const q of ['retail news this week', 'analytics industry news', 'hub airport news', 'retail hub analytics', 'analytics retail hub']) {
      expect(admitCueTopic(q, owner), q).toMatchObject({ ok: true })
    }
  })
  it('owner term: matches whole words and the phrase in order, not substrings of longer words', () => {
    const owner = ctx({ terms: ownerTermPhrases(PROFILE) })
    expect(admitCueTopic('Frobnitzville festival news', owner).ok).toBe(true)
    expect(admitCueTopic('superfrobnitz news', owner).ok).toBe(true)
    expect(admitCueTopic('Retail Analytics Hubs news', owner)).toEqual({ ok: false, reason: 'owner_term' })
    expect(admitCueTopic('retail analytics news hub', owner).ok).toBe(true)
  })
  it('reads the query after NFKC: full-width digits and letters are the plain ones, so they cannot slip past the rules', () => {
    expect(admitCueTopic('Austin FC ２０２６ season', ctx())).toEqual({ ok: false, reason: 'digit' })
    expect(admitCueTopic('ＩＲＳ payment plan', ctx())).toEqual({ ok: false, reason: 'deny_word' })
    expect(admitCueTopic('Ｆormula Ｏne news', ctx())).toMatchObject({ ok: true, query: 'Formula One news' })
  })
  it('allows Latin script only: letters of another script can spell a word the lists never see', () => {
    expect(admitCueTopic('tаx news', ctx())).toEqual({ ok: false, reason: 'characters' })        // the "а" is Cyrillic
    expect(admitCueTopic('Москва news', ctx())).toEqual({ ok: false, reason: 'characters' })
    expect(admitCueTopic('東京 news', ctx())).toEqual({ ok: false, reason: 'characters' })
    expect(admitCueTopic('Café Zoë news', ctx()).ok).toBe(true)
  })
  it('reads the deny list on the normalized query: dotted acronyms, hyphens, accents', () => {
    for (const q of ['I.R.S. payment plan', 'C-section recovery news', 'ob-gyn clinic', 'chemo schedule', 'psychiatrist waiting list']) {
      expect(admitCueTopic(q, ctx()), q).toEqual({ ok: false, reason: 'deny_word' })
    }
    expect(admitCueTopic('Grand Prix grandstand news', ctx()).ok).toBe(true)
  })
  it('rejects ordinals, plurals of the big numbers, zero, a dozen and a half as number words', () => {
    for (const q of ['first look news', 'the third round', 'fifth avenue', 'tenth anniversary', 'thousands of fans', 'millions watching', 'billions raised', 'zero emission cars', 'a dozen teams', 'half marathon news', 'hundreds attend']) {
      expect(admitCueTopic(q, ctx()), q).toEqual({ ok: false, reason: 'number_word' })
    }
    expect(admitCueTopic('one team news', ctx()).ok).toBe(true)
  })
  it('owner term: matches a term written without its spaces, and a term split differently, against single words and adjacent words', () => {
    const owner = ctx({ terms: ownerTermPhrases(PROFILE), joins: ownerTermJoins(PROFILE) })
    for (const q of ['BottlePOS pricing news', 'bottle pos pricing', 'IT Retail launch news', 'ITRetail launch news', 'MarktPOS review', 'Markt POS review', 'Retail Analytics Hub news', 'RetailAnalyticsHub news',
      'Quillco Corp news', 'QuillcoCorp news', 'Gizmo works news']) {
      expect(admitCueTopic(q, owner), q).toEqual({ ok: false, reason: 'owner_term' })
    }
    for (const q of ['bottle shop news', 'retail hub news', 'Markt square news', 'it retail trends']) expect(admitCueTopic(q, owner).ok, q).toBe(q !== 'it retail trends')
  })
  it('a trace may carry a query hash only for a repeat or a length rejection', () => {
    expect([...HASHABLE_REJECTIONS].sort()).toEqual(['repeat', 'too_long', 'too_many_words'])
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
