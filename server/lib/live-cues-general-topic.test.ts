import { describe, expect, it } from 'vitest'
import {
  HASHABLE_REJECTIONS, admitCueTopic, blockedNameWords, denyWordHit, cachedNames, isGenericSpeakerLabel, normalizeForMatch, normalizeQuery, ownerTermJoins, ownerTermPhrases, queryHash,
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

/** One term each: [category, the term as it is written in WINDOW_TERMS, a sample with that term and nothing else clearly personal].
 *  The mutation gate takes the term out and the test with it in its name must fail. */
const WINDOW_SAMPLES = [
  ['health', 'doctors?', 'her doctor called'], ['health', 'hospitals?', 'at the hospital today'], ['health', 'clinics?', 'the clinic opens early'],
  ['health', 'diagnos*', 'the diagnosis came back'], ['health', 'chemo*', 'she started chemo'], ['health', 'cancer', 'a cancer screening'],
  ['health', 'surger(?:y|ies)', 'after the surgery'], ['health', 'therapists?', 'her therapist said so'], ['health', 'therapy', 'weekly therapy sessions'],
  ['health', 'psychiatr*', 'the psychiatrist agrees'], ['health', 'psycholog*', 'the psychologist agrees'], ['health', 'prescription*', 'a prescription refill'],
  ['health', 'pregnan*', 'she is pregnant'], ['health', 'icu', 'he is in the ICU'], ['health', 'intensive care', 'moved to intensive care'],
  ['health', 'emergency room', 'waited in the emergency room'], ['health', 'er visit', 'an ER visit last night'], ['health', 'urgent care', 'a trip to urgent care'],
  ['health', 'ob gyn', 'the OB-GYN moved it'], ['health', 'obgyn', 'the obgyn called'], ['health', 'c section', 'after the C-section'], ['health', 'csection', 'after the csection'],
  ['health', 'adhd', 'ADHD at work'], ['health', 'autis*', 'autism screening'], ['health', 'hospice', 'the hospice called'],
  ['family', 'wife', 'my wife called'], ['family', 'wives', 'their wives came'], ['family', 'husbands?', 'her husband came'], ['family', 'spouses?', 'each spouse agrees'],
  ['family', 'kids?', 'the kids are loud'], ['family', 'moms?', 'my mom called'], ['family', 'mommy', 'mommy time'], ['family', 'dads?', 'my dad called'],
  ['family', 'daddy', 'daddy duty'], ['family', 'sons?', 'his son plays'], ['family', 'daughters?', 'her daughter plays'], ['family', 'brothers?', 'my brother called'],
  ['family', 'sisters?', 'my sister called'], ['family', 'parents', 'his parents are in town'], ['family', 'step ?(?:son|daughter|mom|dad|kid\\w*)', 'her stepdaughter plays'],
  ['family', 'grandma*', 'my grandma came'], ['family', 'grandpa*', 'my grandpa came'], ['family', 'grandmother*', 'my grandmother came'],
  ['family', 'grandfather*', 'my grandfather came'], ['family', 'grandparent*', 'the grandparents came'], ['family', 'grandchild*', 'a grandchild came'],
  ['family', 'grandson*', 'a grandson came'], ['family', 'granddaughter*', 'a granddaughter came'], ['family', 'grandkid*', 'a grandkid came'],
  ['family', 'nephews?', 'her nephew visits'], ['family', 'nieces?', 'her niece visits'],
  ['finance', 'irs', 'the I.R.S. called'], ['finance', 'tax bills?', 'a big tax bill'], ['finance', 'tax returns?', 'the tax return is due'], ['finance', 'back taxes', 'owes back taxes'],
  ['finance', 'income tax(?:es)?', 'income tax is due'], ['finance', 'property tax(?:es)?', 'property taxes went up'], ['finance', 'debts?', 'too much debt'],
  ['finance', 'loans?', 'a car loan'], ['finance', 'mortgages?', 'the mortgage rate'], ['finance', 'bankrupt*', 'they went bankrupt'], ['finance', 'credit score', 'his credit score'],
  ['finance', 'installment*', 'an installment plan'], ['finance', 'escrow', 'the escrow account'], ['finance', 'pensions?', 'his pension'], ['finance', 'roth', 'a roth account'],
  ['finance', 'ira', 'an IRA account'], ['finance', 'rollover', 'a rollover from work'], ['finance', 'k 1', 'a K-1 form'], ['finance', 'alimony', 'pays alimony'],
  ['finance', 'child support', 'owes child support'],
  ['legal', 'lawsuits?', 'a lawsuit was filed'], ['legal', 'sued', 'they sued us'], ['legal', 'attorneys?', 'the attorney called'], ['legal', 'lawyers?', 'our lawyer called'],
  ['legal', 'custody', 'shared custody'], ['legal', 'divorce*', 'the divorce is final'], ['legal', 'court dates?', 'a court date next week'], ['legal', 'court hearings?', 'a court hearing today'],
  ['school', 'daycare*', 'the daycare called'], ['school', 'preschool*', 'the preschool opens'], ['school', 'kindergarten*', 'she starts kindergarten'],
  ['school', 'school pick ?up', 'school pickup is at three'], ['school', 'report cards?', 'the report card came'], ['school', 'tuition', 'tuition is due'],
  ['school', 'parent teacher', 'a parent-teacher night'], ['school', 'dnp', 'the DNP program'], ['school', 'dissertation*', 'the dissertation is due'],
  ['funeral', 'died', 'the plant died'], ['funeral', 'deaths?', 'after the death of a friend'], ['funeral', 'funeral*', 'the funeral is Friday'],
  ['funeral', 'passed away', 'he passed away'], ['funeral', 'dying', 'the plant is dying'],
] as const

describe('sensitive window (clearly personal only)', () => {
  it.each(WINDOW_SAMPLES)('window: skips a %s window (%s): %s', (category, _term, text) => {
    expect(sensitiveWindow(text)).toBe(category)
  })
  it('skips a window in the category of the first list that fires, and says only the category', () => {
    expect(sensitiveWindow('we still owe the IRS and the mortgage is due')).toBe('finance')
    expect(sensitiveWindow('her doctor and the lawyer')).toBe('health')
    expect(JSON.stringify(sensitiveWindow('the mortgage on the lake house'))).toBe('"finance"')
  })
  /** The words the review measured as the top firings on ordinary work talk (the broad list skipped 37.6% of 974 saved windows). */
  it.each([
    'the court of public opinion', 'a sick day policy', 'baby steps on the roadmap', 'the finance team signed off', 'financial results for the quarter', 'sales taxes by state',
    'the tax software market', 'healthy margins this quarter', 'the health of the pipeline', 'old school marketing', 'the product family', 'a medical device vertical',
    'the tool will die off', 'interest dies down', 'a birthday promotion', 'the mother brand', 'insurance verticals', 'a parent company', 'the nursery rhyme ad',
    'homework for the team', 'a teacher discount program', 'the settlement terms', 'our legal review', 'a doctoral student intern', 'the pharmacy chain', 'a pediatric segment',
    'a cousin of that product', 'an aunt stella brand',
  ])('window: does NOT skip ordinary work talk: %s', text => {
    expect(sensitiveWindow(text)).toBeNull()
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
  /** The query deny list is broad on purpose: a bare word that is harmless in a window is not harmless in a web query. One group per
   *  category, each made only of words that are NOT on the window list, so taking a category's broad words out fails its group. */
  it.each([
    ['health', ['health news today', 'medical devices', 'medicine prices', 'medication guide', 'sick leave policy', 'healthy snacks', 'dentist near', 'anxiety tips', 'nursing jobs', 'ivf clinic costs']],
    ['family', ['family news', 'baby formula', 'mother brand', 'birthday party venues', 'wedding venues', 'cousin visit', 'sibling rivalry', 'aunt stella', 'girlfriend gifts', 'childhood games']],
    ['finance', ['finance news', 'financial markets', 'taxes explained', 'tax software', 'insurance rates', 'payroll software', 'retirement plans', 'net worth rankings', 'k one form']],
    ['legal', ['court news', 'legal news', 'settlement terms', 'litigation trends', 'subpoena rules']],
    ['school', ['school news', 'homework help', 'teacher shortage', 'doctoral programs', 'nursery rhymes', 'prek programs']],
    ['funeral', ['die casting', 'dies down', 'death valley', 'grief tips', 'obituary news', 'condolence cards']],
  ] as const)('deny: broad %s words are refused in a query, window or not', (_category, queries) => {
    for (const q of queries) expect(admitCueTopic(q, ctx()), q).toEqual({ ok: false, reason: 'deny_word' })
  })
  it('deny: every word the window list drops is still refused in a query', () => {
    for (const q of ['court news', 'sick leave', 'baby formula', 'finance news', 'financial markets', 'taxes explained', 'tax software', 'health news', 'healthy snacks', 'school news',
      'family news', 'medical devices', 'die casting', 'dies down']) {
      expect(sensitiveWindow(q), q).toBeNull()
      expect(denyWordHit(q), q).toBe(true)
    }
  })
  it('deny: roth, ira, rollover, k 1 and k one, icu, intensive care and the step family words are refused', () => {
    for (const q of ['roth conversion news', 'ira limits', 'rollover rules', 'k one form', 'icu beds', 'intensive care units', 'stepmom blog', 'step-family tips', 'stepchildren news', 'stepbrother movie']) {
      expect(admitCueTopic(q, ctx()), q).toEqual({ ok: false, reason: 'deny_word' })
    }
  })
  it('deny: a word spelled out in one- and two-letter pieces is the word ("I R S", "ta x", "I C U", "mo m")', () => {
    for (const q of ['I R S payment plan', 'ta x news', 'I C U beds', 'mo m blog', 'R O T H account']) expect(admitCueTopic(q, ctx()), q).toEqual({ ok: false, reason: 'deny_word' })
    for (const q of ['go to it now', 'a b test results', 'Meta Xbox news', 'Formula One news']) expect(admitCueTopic(q, ctx()).ok, q).toBe(true)
  })
  it('denyWordHit reads the normalized text and is pure: dotted acronyms, hyphens, full-width letters, runs of short tokens', () => {
    expect(denyWordHit('I.R.S. news')).toBe(true)
    expect(denyWordHit('ＩＲＳ')).toBe(true)
    expect(denyWordHit('i r a')).toBe(true)
    expect(denyWordHit('a K-1 form')).toBe(true)                       // the digit is the query rules' to refuse; the word list knows k 1 too
    expect(denyWordHit('the Grand Prix')).toBe(false)
    expect(denyWordHit('')).toBe(false)
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
