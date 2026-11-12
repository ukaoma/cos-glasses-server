/**
 * 7.0.30 item 3 (Anand on the 11-12 HC call: Summary and Full did not say they copy): the Speakers review's buttons say
 * Copy, the tapped one says Copied for a moment, and a status region outside the rebuilt pane tells a screen reader what
 * was copied. Runs speakers.js's own spAnnounce and spCopied against fakes; the button wording is pinned here and checked
 * in WebKit (W1_evidence/7030/items_check.cjs).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SP = readFileSync(join(HERE, 'panes', 'speakers.js'), 'utf8')
const BLOCK = (() => { const a = SP.indexOf('  var COPIED_MS = 2500;'), b = SP.indexOf('  function render() {', a); expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a); return SP.slice(a, b) })()

function kit() {
  const timers: Array<{ fn: () => void; ms: number }> = [], body: any[] = []
  let renders = 0
  const byId: Record<string, any> = {}
  const document = {
    getElementById: (id: string) => byId[id] || null,
    createElement: () => { const el: any = { attrs: {} as Record<string, string>, textContent: '', setAttribute(k: string, v: string) { el.attrs[k] = v } }; return el },
    body: { appendChild: (el: any) => { body.push(el); byId[el.id] = el } },
  }
  let now = 1000
  const deps = { document, setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }) }, render: () => { renders++ }, Date: { now: () => now } }
  // eslint-disable-next-line no-new-func
  const f = new Function('deps', `with (deps) {\n${BLOCK}\nreturn { spCopied, spAnnounce, COPIED_MS };\n}`)(deps)
  return { f, timers, body, byId, get renders() { return renders }, later: (ms: number) => { now += ms } }
}

describe('the copy confirms on its button, and a screen reader hears it', () => {
  it('Copied shows on the tapped button (R.copied), then goes back after 2.5 s', () => {
    const k = kit(), R: any = {}
    k.f.spCopied(R, 'full', 'Copied full meeting (12 KB)')
    expect(R.copied).toEqual({ which: 'full', at: 1000 })
    expect(k.renders).toBe(1)
    k.timers.filter(t => t.ms === 30).forEach(t => t.fn())
    expect(k.byId['sp-copy-live'].textContent, 'the copy is announced').toBe('Copied full meeting (12 KB)')
    const back = k.timers.find(t => t.ms === 2500)!
    back.fn()
    expect(R.copied).toBe(null)
    expect(k.renders).toBe(2)
  })
  it('a second tap restarts the confirmation; the first one\'s timer does not clear it', () => {
    const k = kit(), R: any = {}
    k.f.spCopied(R, 'summary', 'Copied summary (2 KB)')
    const first = k.timers.find(t => t.ms === 2500)!
    k.later(800)
    k.f.spCopied(R, 'full', 'Copied full meeting (12 KB)')
    first.fn()
    expect(R.copied).toEqual({ which: 'full', at: 1800 })
  })
  it('the words go to one status region outside the pane (made once, polite)', () => {
    const k = kit()
    k.f.spAnnounce('Copied summary (2 KB)')
    k.f.spAnnounce('Copied full meeting (12 KB)')
    expect(k.body).toHaveLength(1)
    const live = k.byId['sp-copy-live']
    expect(live.attrs).toEqual({ role: 'status', 'aria-live': 'polite' })
    expect(live.className).toBe('sr-only')
    k.timers.filter(t => t.ms === 30).forEach(t => t.fn())
    expect(live.textContent).toBe('Copied full meeting (12 KB)')
  })
  it('the buttons say Copy, the tapped one says Copied, and each has an id so a rebuild keeps focus on it', () => {
    expect(SP).toContain("id=\"sp-copy-summary\" data-sp=\"copy-summary\" title=\"Copy the meeting without the transcript\">' + (cp === 'summary' ? 'Copied' : 'Copy summary') + '</button>'")
    expect(SP).toContain("(cp === 'full' ? 'Copied' : 'Copy full (' + Math.max(1, Math.floor(R.content.fullChars / 1024)) + ' KB)')")
    expect(SP).toContain("spCopied(R, full ? 'full' : 'summary', R.copyNote);")
  })
})
