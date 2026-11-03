// The meeting assistant and Tableau: a question about Quilt funnel numbers, budget or pacing, or one that says Tableau, gets the
// Tableau facts as one more local source. No network, never in a personal meeting, and an honest notice when Tableau was asked for
// by name and the file cannot be used.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeetingAskRuntime } from './meeting-ask-runtime.js'
import { MeetingAskStore } from './meeting-ask-store.js'
import { DATA_ASK_ADDENDUM, parseDataFacts, type DataFactsRead } from './live-cues-v2-data.js'
import { NOW, rawFacts, rawSourceFacts } from './__fixtures__/live-cues-v2-data-fixture.js'

const base = { requestId: 'request_12345678', sessionId: 'meeting_test', serverInstanceId: 'server-one', action: 'ask' as const, question: 'What was decided?', elapsedMs: 1000,
  turns: [{ id: 0, elapsedMs: 0, speaker: 'Person', text: 'SBU closed at 120% of MRR budget, 148 vs 131 locations.' }] }
const ok = (): DataFactsRead => parseDataFacts(rawFacts(), NOW)
const withSources = (): DataFactsRead => parseDataFacts(rawSourceFacts(), NOW)
const tableauOf = (f: ReturnType<typeof fixture>) => evidenceOf(f).find(s => s.title.startsWith('Tableau'))

function fixture(dataFacts: () => DataFactsRead, domain: string | null = 'quilt', calendarTitle?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ask-data-')), store = new MeetingAskStore(dir), release = vi.fn()
  const run = vi.fn(async (_model: unknown, _prompt: string, _system: string) => ({ text: JSON.stringify({ sections: [{ label: 'So what', text: 'SBU customers are 54 against 81 in Tableau [F1]' }], searchQuery: null }), model: 'claude-haiku-5-5' }))
  const webSearch = vi.fn(async () => ({ sources: [], notices: [] }))
  const search = vi.fn(async () => ({ sources: [], notices: [] }))
  const runtime = new MeetingAskRuntime({ reviewAnswers: false, finalized: () => ({ sources: [], notices: [] }), domains: () => [{ id: 'quilt', label: 'Quilt' }, { id: 'personal', label: 'Personal' }, { id: 'hermit_crabs', label: 'HC' }],
    store, identity: () => 'server-one', admissions: () => true, lease: () => ({ release, id: 'lease', kind: 'meeting_ask' } as any),
    catalog: async () => [{ engine: 'claude', available: true, defaultModel: 'haiku', models: ['haiku', 'sonnet'] }], run, search, webSearch, webCapability: () => ({ available: true, engine: 'claude' }), dataFacts } as any)
  if (domain || calendarTitle) store.putOrientation(base.sessionId, { revision: 1, domain: domain as any, calendar: calendarTitle ? { id: 'cal_1', title: calendarTitle, start: '2026-11-02T15:00:00Z', end: '2026-11-02T16:00:00Z' } : null })
  return { runtime, store, run, webSearch, search, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
async function terminal(f: ReturnType<typeof fixture>, id = base.requestId) {
  for (let i = 0; i < 200; i++) { const e = f.runtime.get(id); if (!['pending', 'running'].includes(e.status)) return e; await new Promise(r => setTimeout(r, 2)) }
  throw Error('never terminal')
}
const evidenceOf = (f: ReturnType<typeof fixture>) => (JSON.parse(f.run.mock.calls[0][1]) as { evidence: Array<{ id: string; kind: string; title: string; text: string }> }).evidence
const systemOf = (f: ReturnType<typeof fixture>) => f.run.mock.calls[0][2] as string

async function ask(f: ReturnType<typeof fixture>, question: string) {
  await f.runtime.submit({ ...base, question })
  return terminal(f)
}

describe('the meeting assistant and the Tableau facts', () => {
  it('a question about SBU pacing against budget: the facts are a cited local source, the rules say what they are, and nothing goes to the web', async () => {
    const f = fixture(ok)
    try {
      const e = await ask(f, 'How is SBU pacing against budget?')
      expect(e.status).toBe('completed')
      const tableau = evidenceOf(f).find(s => s.title === 'Tableau, Oct 2026 close, marketing sources')!
      expect(tableau).toMatchObject({ id: 'F1', kind: 'file' })
      expect(tableau.text).toContain('SBU (3 of 4 industries: Grocery, Liquor, Tobacco): leads 402 vs 428 (94%)')
      expect(tableau.text).toContain('Not company revenue, MRR, ARR or location counts.')
      expect(tableau.text).toContain('Extract refreshed Nov 2 05:41 CT.')
      expect(systemOf(f)).toContain(DATA_ASK_ADDENDUM)
      expect(e.sources.find(s => s.id === 'F1')).toMatchObject({ kind: 'file', title: 'Tableau, Oct 2026 close, marketing sources' })
      expect(e.sources.find(s => s.id === 'F1')).not.toHaveProperty('fileId')
      expect(e.sections?.[0].sources).toContain('F1')
      expect(f.webSearch).not.toHaveBeenCalled()
    } finally { f.cleanup() }
  })
  it('"check Tableau" with no group gives every group and no source rows', async () => {
    const f = fixture(ok)
    try {
      await ask(f, 'check Tableau')
      const text = evidenceOf(f).find(s => s.title.startsWith('Tableau'))!.text
      for (const name of ['SBU', 'XBU', 'Liquor', 'Thrift']) expect(text).toContain(name)
      expect(text).not.toContain('lead sources')
    } finally { f.cleanup() }
  })
  it('a named industry also gets its lead-source rows', async () => {
    const f = fixture(ok)
    try {
      await ask(f, 'Why were liquor leads down last month?')
      expect(evidenceOf(f).find(s => s.title.startsWith('Tableau'))!.text).toContain('Liquor lead sources (leads/opps/customers): Paid Search - Non-Brand 64/11/4; Organic Direct 63/41/16')
    } finally { f.cleanup() }
  })
  it.each(['What was decided?', 'What is the budget for the offsite?', 'Who is the liquor distributor?'])('an unrelated question (%s) gets no Tableau source, no addendum, no notice', async (q) => {
    const f = fixture(ok)
    try {
      const e = await ask(f, q)
      expect(evidenceOf(f).some(s => s.title.startsWith('Tableau'))).toBe(false)
      expect(systemOf(f)).not.toContain('Tableau source')
      expect(e.notices.join(' ')).not.toMatch(/Tableau/)
    } finally { f.cleanup() }
  })
  it('a Tableau source comes after the attached files, with the next F id', async () => {
    const f = fixture(ok)
    try {
      f.runtime.putFiles(base.sessionId, 'server-one', [{ id: 'file_12345678', revision: '1', name: 'Plan', status: 'ready', text: 'Owner is Nina' }])
      await ask(f, 'check Tableau for thrift')
      const ev = evidenceOf(f)
      expect(ev.find(s => s.title === 'Plan')!.id).toBe('F1')
      expect(ev.find(s => s.title.startsWith('Tableau'))!.id).toBe('F2')
    } finally { f.cleanup() }
  })

  describe('a lead source in the question', () => {
    it('"check that tableau report via paid search": the paid search rows and their budget lines are the cited source, with no all-marketing totals', async () => {
      const f = fixture(withSources)
      try {
        const e = await ask(f, 'Can you check that tableau report via paid search')
        expect(e.status).toBe('completed')
        const text = tableauOf(f)!.text
        expect(tableauOf(f)).toMatchObject({ id: 'F1', kind: 'file' })
        expect(text).toContain('Thrift (leads/opps/customers): Paid Search Non-Brand 45/11/3; Paid Search Brand 8/2/0.')
        expect(text).toContain('Budget line Paid Search Non-Brand (shared with Paid Social): leads 66 vs 47 (140%)')
        expect(text).not.toMatch(/^SBU|^XBU/m)
        expect(systemOf(f)).toContain(DATA_ASK_ADDENDUM)
        expect(systemOf(f)).toContain('A lead-source row covers only that source')
        expect(f.webSearch).not.toHaveBeenCalled()
      } finally { f.cleanup() }
    })
    it('"how did paid search do for thrift": a group beside a specific source is a data question in a Quilt meeting, and only Thrift is given', async () => {
      const f = fixture(withSources)
      try {
        await ask(f, 'how did paid search do for thrift in October')
        const text = tableauOf(f)!.text
        expect(text).toContain('Thrift: leads 151 vs 110 (137%)')
        expect(text).toContain('Thrift (leads/opps/customers): Paid Search Non-Brand 45/11/3; Paid Search Brand 8/2/0.')
        expect(text).not.toContain('Liquor (leads')
      } finally { f.cleanup() }
    })
    it('the gates are as strict as for a group: personal never, another domain only when Tableau is named, no domain needs a brand or a Quilt title', async () => {
      const q = 'how did paid search do for thrift in October'
      for (const [domain, title, served] of [['personal', undefined, false], ['hermit_crabs', undefined, false], [null, undefined, false], [null, 'Quilt weekly forecast', true], ['quilt', undefined, true]] as const) {
        const f = fixture(withSources, domain, title)
        try {
          const e = await ask(f, q)
          expect(tableauOf(f) !== undefined, `${domain} ${title}`).toBe(served)
          if (!served) expect(e.notices.join(' ')).not.toMatch(/Tableau/)
        } finally { f.cleanup() }
      }
      const g = fixture(withSources, null)
      try {
        await ask(g, 'how did paid search do for ThriftCart')
        expect(tableauOf(g)).toBeDefined()                       // a Quilt brand named is the signal, as for a group
      } finally { g.cleanup() }
      const h = fixture(withSources, null)
      try {
        await ask(h, 'what were ppc leads last month')
        expect(tableauOf(h)).toBeUndefined()                      // a source alone is never a Quilt-brand signal
      } finally { h.cleanup() }
      const i = fixture(withSources, 'hermit_crabs')
      try {
        await ask(i, 'check Tableau via paid search')
        expect(tableauOf(i)).toBeDefined()                        // another business domain, but Tableau was named
      } finally { i.cleanup() }
    })
    it('an older file (no budget lines) answers with the rows alone', async () => {
      const f = fixture(() => parseDataFacts(rawFacts({ sources: rawSourceFacts().sources.map(({ budgetLine: _b, ...r }: Record<string, unknown>) => r) }), NOW))
      try {
        await ask(f, 'how did paid search do for thrift')
        expect(tableauOf(f)!.text).toContain('Thrift (leads/opps/customers): Paid Search Non-Brand 45/11/3; Paid Search Brand 8/2/0.')
        expect(tableauOf(f)!.text).not.toContain('Budget line')
      } finally { f.cleanup() }
    })
    it('a question that names no source gets what it always got', async () => {
      const f = fixture(withSources)
      try {
        await ask(f, 'Why were liquor leads down last month?')
        const text = tableauOf(f)!.text
        expect(text).toContain('Liquor lead sources (leads/opps/customers): Paid Search - Non-Brand 64/11/4; Organic Direct 63/41/16; Paid Search - Brand 17/7/4; Paid Social 10/2/1')
        expect(text).not.toContain('Lead source asked about')
      } finally { f.cleanup() }
    })
  })

  describe('domains', () => {
    it('a personal meeting never gets Quilt numbers, even when Tableau is named, and says nothing about it', async () => {
      const f = fixture(ok, 'personal')
      try {
        const e = await ask(f, 'check Tableau for SBU pacing')
        expect(evidenceOf(f).some(s => s.title.startsWith('Tableau'))).toBe(false)
        expect(e.notices.join(' ')).not.toMatch(/Tableau/)
      } finally { f.cleanup() }
    })
    it('another business domain gets it only when the question says Tableau', async () => {
      const f = fixture(ok, 'hermit_crabs')
      try {
        await ask(f, 'How are liquor leads pacing against budget?')
        expect(evidenceOf(f).some(s => s.title.startsWith('Tableau'))).toBe(false)
      } finally { f.cleanup() }
      const g = fixture(ok, 'hermit_crabs')
      try {
        await ask(g, 'Check Tableau for liquor')
        expect(evidenceOf(g).some(s => s.title.startsWith('Tableau'))).toBe(true)
      } finally { g.cleanup() }
    })
    it('a meeting with no confirmed domain is served when a Quilt brand or SBU is named', async () => {
      for (const q of ['How is SBU pacing against budget?', 'How are Bottle POS leads pacing?']) {
        const f = fixture(ok, null)
        try {
          await ask(f, q)
          expect(evidenceOf(f).some(s => s.title.startsWith('Tableau')), q).toBe(true)
        } finally { f.cleanup() }
      }
    })
    it('a meeting with no confirmed domain is not served for an industry word alone, a family or Sprocket Rocket question', async () => {
      for (const q of ['How is the thrift budget doing this month?', 'Are our pet leads on plan?', 'How are liquor opps pacing against the goal?']) {
        const f = fixture(ok, null)
        try {
          const e = await ask(f, q)
          expect(evidenceOf(f).some(s => s.title.startsWith('Tableau')), q).toBe(false)
          expect(e.notices.join(' ')).not.toMatch(/Tableau/)
        } finally { f.cleanup() }
      }
    })
    it('a meeting with no confirmed domain and a Quilt term in the calendar title is served for an industry word', async () => {
      const f = fixture(ok, null, 'Quilt weekly forecast')
      try {
        await ask(f, 'How are liquor opps pacing against the goal?')
        expect(evidenceOf(f).some(s => s.title.startsWith('Tableau'))).toBe(true)
      } finally { f.cleanup() }
    })
    it('a confirmed Quilt meeting is served for an industry word', async () => {
      const f = fixture(ok, 'quilt')
      try {
        await ask(f, 'How are liquor opps pacing against the goal?')
        expect(evidenceOf(f).some(s => s.title.startsWith('Tableau'))).toBe(true)
      } finally { f.cleanup() }
    })
  })

  describe('whose words count', () => {
    const article = 'Pet owners spent more this year. Liquor sales and thrift store customers rose 12 percent while leads for SBU products dipped. Tableau reports were cited. '.repeat(5)
    it('a pasted article does not pull Tableau in, with or without a short question after it', async () => {
      const f = fixture(ok)
      try {
        const e = await ask(f, article)
        expect(evidenceOf(f).some(s => s.title.startsWith('Tableau'))).toBe(false)
        expect(e.notices.join(' ')).not.toMatch(/Tableau/)
      } finally { f.cleanup() }
      const g = fixture(ok)
      try {
        await ask(g, article + '\nWhat is the weather like?')
        expect(evidenceOf(g).some(s => s.title.startsWith('Tableau'))).toBe(false)
      } finally { g.cleanup() }
    })
    it('their own short question on the last line after a paste still works', async () => {
      const f = fixture(ok)
      try {
        await ask(f, article + '\ncheck Tableau for liquor')
        expect(evidenceOf(f).some(s => s.title.startsWith('Tableau'))).toBe(true)
      } finally { f.cleanup() }
    })
    it('a pasted article that says Tableau does not make the missing-file notice appear', async () => {
      const f = fixture(() => ({ ok: false, reason: 'missing' }))
      try {
        expect((await ask(f, article)).notices.join(' ')).not.toMatch(/Tableau data is not available/)
      } finally { f.cleanup() }
    })
  })

  describe('when the file cannot be used', () => {
    it.each([['missing'], ['stale'], ['invalid'], ['unreadable'], ['future']] as const)('Tableau named, file %s: no figures, and the answer says why', async (reason) => {
      const f = fixture(() => ({ ok: false, reason }))
      try {
        const e = await ask(f, 'Check Tableau for liquor')
        expect(evidenceOf(f).some(s => s.title.startsWith('Tableau'))).toBe(false)
        expect(e.notices).toContain(`Tableau data is not available (${reason}), so no Tableau figures were used.`)
      } finally { f.cleanup() }
    })
    it('a question that only names a group stays quiet about a missing file', async () => {
      const f = fixture(() => ({ ok: false, reason: 'missing' }))
      try {
        const e = await ask(f, 'How is SBU pacing against budget?')
        expect(e.notices.join(' ')).not.toMatch(/Tableau/)
      } finally { f.cleanup() }
    })
    it('a reader that throws never fails the answer', async () => {
      const f = fixture(() => { throw new Error('disk gone') })
      try {
        expect((await ask(f, 'Check Tableau for liquor')).status).toBe('completed')
      } finally { f.cleanup() }
    })
  })
})
