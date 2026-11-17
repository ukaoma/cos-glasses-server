/**
 * 7.0.55 COS route links in Control Web (Miles 2026-11-17 08:29: "On web app view the link isn't clickable"; X1). A COS
 * answer's [words](cos-route:meetings/live/<id>) is drawn by md() (app.js), which the COS chat card and the Messages
 * reader both use, as a same-tab link to #/meetings/live/<id>: the same origin, so no new sign-in. Run from the real
 * app.js in a vm (never re-implemented here), and its route and words pinned to the server's own (lib/cos-route-links.ts).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { COS_ROUTE_LABEL, COS_ROUTE_RE, projectCosRouteLinks } from '../lib/cos-route-links.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1)
  expect(a, from).toBeGreaterThan(-1)
  expect(b, to).toBeGreaterThan(a)
  return src.slice(a, b)
}
const ctx: any = vm.createContext({})
vm.runInContext(slice(APP, '  function esc(s)', '  var WORDS = [') +
  ';this.md = md; this.structure = structureLensAnswer; this.ROUTE = MD_COS_ROUTE; this.LABEL = MD_COS_ROUTE_LABEL;', ctx)
const md = (s: string): string => ctx.md(s)
// The chat card and the Messages reader draw a COS answer as md(structureLensAnswer(text)).
const card = (s: string): string => ctx.md(ctx.structure(s))

const ID = 'meeting_1700000000000_abc123'
const TOKEN = `[${COS_ROUTE_LABEL}](cos-route:meetings/live/${ID})`
const LINK = `<a class="cos-route" href="#/meetings/live/${ID}" data-cos-route="live-meeting">Open the live meeting</a>`

describe('the route link in md()', () => {
  it('is pinned to the server: the same route pattern and the same fixed words', () => {
    expect(ctx.ROUTE.source).toBe(COS_ROUTE_RE.source)
    expect(ctx.ROUTE.flags).toBe(COS_ROUTE_RE.flags)
    expect(ctx.LABEL).toBe(COS_ROUTE_LABEL)
  })

  it("this morning's reply, as the server now serves it: one tappable link per address, opening here in the same tab", () => {
    const served = projectCosRouteLinks(`Open it here:\n\nhttp://127.0.0.1:3141/control#/meetings/live/${ID}\n\nFrom your phone:\n\nhttp://100.64.0.7:3141/control#/meetings/live/${ID}`,
      { hosts: new Set(['127.0.0.1', '100.64.0.7']), ports: new Set(['3141']) })
    const html = card(served)
    expect(html.split(LINK)).toHaveLength(3)
    expect(html).not.toContain('127.0.0.1')
    expect(html).not.toContain('target=')
    expect(html).not.toContain('cos-route:')
  })

  it('the href is built from the checked parts; the model\'s words are never shown', () => {
    expect(md(`[Click for the Acme board](cos-route:meetings/live/${ID})`)).toBe(LINK)
    expect(md(`See ${TOKEN}.`)).toBe(`See ${LINK}.`)
    expect(md(`**${TOKEN}**`)).toBe(`<strong>${LINK}</strong>`)
    expect(md(`- ${TOKEN}`)).toBe(`• ${LINK}`)
  })

  it('a route off the allowlist, or an id that is not a meeting id, is just its words', () => {
    for (const route of ['settings', `meetings/live/${ID}/x`, 'meetings/live/meeting_a.b', `meetings/detail/${ID}`, `meetings/live/${ID}?x=1`,
      'meetings/live/meeting_a"onmouseover="x', 'meetings/live/meeting_<b>', `meetings/live/meeting_${'a'.repeat(90)}`]) {
      const html = md(`[the words](cos-route:${route})`)
      expect(html, route).not.toContain('<a')
      expect(html, route).toContain('the words')
    }
  })

  it('double underscores in an id never let bold reach into the link', () => {
    const odd = 'meeting_a__b__c'
    expect(md(`[x](cos-route:meetings/live/${odd})`)).toBe(LINK.replace(ID, odd))
  })

  it('inside a code span or a fenced block the token stays as written', () => {
    expect(md(`\`${TOKEN}\``)).toBe(`<code>${TOKEN.replace(/&/g, '&amp;')}</code>`)
    const fenced = md(`before ${TOKEN}\n\`\`\`\n${TOKEN}\n\`\`\`\nafter ${TOKEN}`)
    expect(fenced.split('\n')).toEqual([`before ${LINK}`, '```', TOKEN, '```', `after ${LINK}`])
  })

  it('no other scheme or address becomes a link: md() still links nothing but a COS route', () => {
    for (const text of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[docs](https://example.com)', 'https://example.com',
      `[x](http://127.0.0.1:3141/control#/meetings/live/${ID})`, '[x](cos-file:1)']) {
      expect(md(text), text).not.toContain('<a')
    }
  })

  it('the words around a link are escaped as before', () => {
    expect(md(`<b>hi</b> ${TOKEN}`)).toBe(`&lt;b&gt;hi&lt;/b&gt; ${LINK}`)
  })
})
