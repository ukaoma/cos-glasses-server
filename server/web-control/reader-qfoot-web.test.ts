/**
 * F1 (lead 16:46, W1's OK 16:54): in the Sessions reader the question card's footer ("Not answered yet", Submit, Leave
 * for the Mac) must not stick. The card (356 px) scrolls inside #session-body, which is smaller than the card at every
 * size measured on 7.0.42 (265 px at 449x798, 110 px at 382x557, 270 px at 1119x787), so a sticky footer pinned itself to
 * the area's bottom edge over the question and the options (44 to 60 px; folded, the reader opened showing only the
 * footer). Measurement: lanes/F1_evidence/reader_qcard_finding.md. In the reader the card's parts scroll in order:
 * question, options, then Submit. Today's page and sheet keep the sticky footer (W1's pins below).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const QCSS = strip(readFileSync(join(HERE, 'panes/questions.css'), 'utf8'))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')

/** Top-level rules (outside any @media), in source order. */
function topRules(css: string): Array<{ sel: string[]; decls: string; at: number }> {
  const out: Array<{ sel: string[]; decls: string; at: number }> = []
  let i = 0, depth = 0, start = 0
  while (i < css.length) {
    const c = css[i]
    if (c === '{') {
      if (depth === 0) {
        const sel = css.slice(start, i).trim(), end = css.indexOf('}', i)
        if (!sel.startsWith('@')) { out.push({ sel: sel.split(/\s*,\s*/), decls: css.slice(i + 1, end), at: i }); i = end + 1; start = i; continue }
      }
      depth++
    } else if (c === '}') { depth--; if (depth === 0) start = i + 1 }
    i++
  }
  return out
}
const TOP = topRules(QCSS)
const ruleFor = (sel: string) => TOP.filter(r => r.sel.includes(sel))
/** (ids, classes/attrs/pseudo-classes, types) */
function spec(sel: string) {
  const ids = (sel.match(/#[\w-]+/g) || []).length
  const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length
  return ids * 100 + cls * 10
}

describe('Sessions reader: the question card footer scrolls with the card', () => {
  it('the reader mounts its question cards inside its own scroll (#session-questions in #session-body)', () => {
    const body = APP.indexOf('<div class="sx-body" id="session-body">'), q = APP.indexOf('<div class="sx-questions" id="session-questions"></div>', body)
    expect(body).toBeGreaterThan(0)
    expect(q).toBeGreaterThan(body)
  })
  it('inside the reader the footer is static', () => {
    const r = ruleFor('#session-questions .sq-foot')
    expect(r.length).toBe(1)
    expect(r[0].decls).toMatch(/position:\s*static/)
  })
  it('no rule that also reaches the reader turns it sticky again (by specificity or by order)', () => {
    const mine = ruleFor('#session-questions .sq-foot')[0]
    for (const r of TOP) for (const s of r.sel) {
      if (!/\.sq-foot\s*$/.test(s) || s === '#session-questions .sq-foot') continue
      if (!/position:\s*sticky/.test(r.decls)) continue
      // A sticky rule must be weaker than the reader's, or (equal) come before it.
      expect(spec(s) < spec('#session-questions .sq-foot') || (spec(s) === spec('#session-questions .sq-foot') && r.at < mine.at), s).toBe(true)
    }
  })
})

describe("W1's pins: everywhere else the footer is as before", () => {
  it('.sq-foot is sticky by default', () => {
    expect(ruleFor('.sq-foot').some(r => /position:\s*sticky/.test(r.decls))).toBe(true)
  })
  it('.sq-host keeps its sticky footer, riding above whatever covers the bottom', () => {
    const r = ruleFor('.sq-host .sq-foot')
    expect(r.length).toBe(1)
    expect(r[0].decls).toMatch(/bottom:\s*max\(var\(--safe-bottom, 0px\), var\(--sq-kb, 0px\)\)/)
    expect(r[0].decls).not.toMatch(/position:\s*static/)
  })
  it("Today's sheet (.ta-q) keeps bottom: 0", () => {
    const r = ruleFor('.ta-q .sq-foot')
    expect(r.length).toBe(1)
    expect(r[0].decls).toMatch(/bottom:\s*0\b/)
  })
  it('the two existing static rules are unchanged (keyboard up, viewport reading lost)', () => {
    for (const s of ['.sq-host.sq-kb-up .sq-foot', '.sq-host.sq-vv-lost .sq-foot']) {
      const r = ruleFor(s)
      expect(r.length, s).toBe(1)
      expect(r[0].decls.trim(), s).toBe('position: static;')
    }
  })
})
