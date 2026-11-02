import { describe, expect, it } from 'vitest'
import { KNOWN_NAMES_CHARS, KNOWN_NAMES_MAX, KNOWN_NAMES_USE, knownNamesFor } from './live-cues-v2-names.js'
import type { ProfileNameSource } from './live-cues-general-topic.js'

// Every name below is invented.
const source = (over: Partial<ProfileNameSource> = {}): ProfileNameSource => ({
  ownerName: () => 'Pat Quill', speakerLabel: () => 'Me',
  vocabulary: () => ['Zorvana', 'retail', 'pos', 'KioskPOS', 'a very long phrase of plain work words here', 'Vellum Labs', 'https://example.com/x'],
  domainKeywords: () => ({}),
  voiceProfileNames: () => ['Kestrel Mo', 'Dara'],
  ...over,
})

describe('known names for the cue writer (6.97.8)', () => {
  it('lists the meeting speakers first, then the owner, vocabulary that is written like a name, then enrolled voices', async () => {
    const names = await knownNamesFor(['Tamsin', 'Speaker 2', 'You', 'unidentified'], source())
    expect(names).toEqual(['Tamsin', 'Pat Quill', 'Zorvana', 'KioskPOS', 'Vellum Labs', 'Kestrel Mo', 'Dara'])
  })

  it('drops plain work words, long phrases, links, the placeholder owner and repeats in any case', async () => {
    const names = await knownNamesFor(['dara', 'DARA'], source({ ownerName: () => 'User' }))
    expect(names).not.toContain('retail')
    expect(names).not.toContain('pos')
    expect(names).not.toContain('User')
    expect(names.filter(n => n.toLowerCase() === 'dara')).toEqual(['dara'])
    expect(names.some(n => n.includes('plain work words') || n.includes('http'))).toBe(false)
  })

  it('caps the count and the characters', async () => {
    const many = Array.from({ length: 200 }, (_, i) => `Name${i}`)
    const byCount = await knownNamesFor([], source({ voiceProfileNames: () => many, vocabulary: () => [] }))
    expect(byCount.length).toBeLessThanOrEqual(KNOWN_NAMES_MAX)
    const wide = Array.from({ length: 40 }, (_, i) => `Wide${String(i).padStart(2, '0')}${'x'.repeat(26)}`)
    const byChars = await knownNamesFor([], source({ voiceProfileNames: () => wide, vocabulary: () => [] }))
    expect(byChars.join('').length).toBeLessThanOrEqual(KNOWN_NAMES_CHARS)
    expect(byChars.length).toBeLessThan(wide.length)
  })

  it('QA fix: 70 enrolled voices never push out the speakers, the owner or the vocabulary names', async () => {
    const voices = Array.from({ length: 70 }, (_, i) => `Person Number${i}`)
    const names = await knownNamesFor(['Gina'], source({ voiceProfileNames: () => voices, vocabulary: () => ['Vori', 'Niala'] }))
    expect(names.slice(0, 4)).toEqual(['Gina', 'Pat Quill', 'Vori', 'Niala'])
    expect(names.length).toBeLessThanOrEqual(KNOWN_NAMES_MAX)
  })

  it('QA fix: a name that does not fit is skipped, not the end of the list; the JSON overhead of each name counts', async () => {
    const fill = Array.from({ length: 30 }, (_, i) => `Filler${String(i).padStart(2, '0')}${'x'.repeat(20)}`)   // 28 characters each
    const names = await knownNamesFor([], source({ ownerName: () => 'Pat Quill', voiceProfileNames: () => [...fill, 'Zed'], vocabulary: () => [] }))
    const cost = (list: string[]) => list.reduce((n, x) => n + x.length + 4, 0)
    expect(cost(names)).toBeLessThanOrEqual(KNOWN_NAMES_CHARS)
    expect(names).toContain('Zed')                                                                           // a short name after the ones that did not fit
    expect(names.length).toBeLessThan(fill.length + 2)
  })

  it('the overhead of the name being added counts: a name that fits only without its quotes and comma is left out', async () => {
    const fillers = Array.from({ length: 22 }, (_, i) => `F${String(i).padStart(2, '0')}${'x'.repeat(23)}`)     // 26 characters, 30 with overhead
    const edge = 'B'.repeat(29)                                                                              // owner 9 + 22 x 30 = 669; 669 + 29 = 698 fits, 669 + 33 = 702 does not
    const names = await knownNamesFor([], source({ ownerName: () => 'Owner', vocabulary: () => [], voiceProfileNames: () => [...fillers, edge] }))
    expect(names).toHaveLength(23)
    expect(names).not.toContain(edge)
  })

  it('a reader that throws or rejects contributes nothing and never fails the call', async () => {
    const names = await knownNamesFor(['Tamsin'], source({ voiceProfileNames: () => { throw new Error('store unreadable') }, vocabulary: () => { throw new Error('no profile') }, ownerName: () => { throw new Error('x') } }))
    expect(names).toEqual(['Tamsin'])
    expect(await knownNamesFor([], source({ voiceProfileNames: () => Promise.reject(new Error('store unreadable')) }))).toEqual(['Pat Quill', 'Zorvana', 'KioskPOS', 'Vellum Labs'])
    expect(await knownNamesFor([], { ownerName: () => 'User', speakerLabel: () => 'Me', vocabulary: () => [], domainKeywords: () => ({}) })).toEqual([])
  })

  it('the instruction carries no em dash or arrow and tells the writer not to invent a name', () => {
    expect(KNOWN_NAMES_USE).not.toMatch(/[—–→]/)
    expect(KNOWN_NAMES_USE).toMatch(/Never add a name the window does not hint at/)
  })
})
