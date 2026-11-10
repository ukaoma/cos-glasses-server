/**
 * W1 (audit 02 F1): /control opened from outside Tailscale. Still 403; a browser gets a short help page instead of one line
 * of text. The page says nothing the old line did not: no name, address, version, link or script. Anything that is not a
 * browser page request keeps the old text.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WEB_CONTROL_OFFNET_CSP, WEB_CONTROL_OFFNET_HTML, WEB_CONTROL_OFFNET_TEXT, webControlOffnetResponse } from './web-control-offnet-page.js'

const INDEX = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8')

describe('the off-Tailscale page', () => {
  it('a browser gets the page with its own locked-down policy; anything else gets the old line', () => {
    expect(webControlOffnetResponse(true)).toEqual({ type: 'html', body: WEB_CONTROL_OFFNET_HTML, csp: WEB_CONTROL_OFFNET_CSP })
    expect(webControlOffnetResponse(false)).toEqual({ type: 'text', body: WEB_CONTROL_OFFNET_TEXT, csp: null })
    expect(WEB_CONTROL_OFFNET_TEXT).toBe('COS Control Web is available on this Mac and over Tailscale.')
  })
  it('says why and what to do, in plain words', () => {
    expect(WEB_CONTROL_OFFNET_HTML).toContain('<title>Open COS over Tailscale</title>')
    expect(WEB_CONTROL_OFFNET_HTML).toContain('It only opens over Tailscale')
    expect(WEB_CONTROL_OFFNET_HTML).toContain('Install <strong>Tailscale</strong>')
    expect(WEB_CONTROL_OFFNET_HTML).toContain('<meta name="viewport"')
  })
  it('carries no script, link, address, version or LAN way in', () => {
    expect(WEB_CONTROL_OFFNET_HTML).not.toMatch(/<script|<a\s|href=|src=|https?:\/\//i)
    expect(WEB_CONTROL_OFFNET_HTML).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b|ts\.net|:3141|COS_WEB_CONTROL_LAN|version/i)
    expect(WEB_CONTROL_OFFNET_HTML).not.toMatch(/[—→]/)   // house copy rules: no em dash, no arrow
    expect(WEB_CONTROL_OFFNET_CSP).toContain("default-src 'none'")
    expect(WEB_CONTROL_OFFNET_CSP).not.toMatch(/script-src/)
  })
  it('index.ts keeps the 403 and picks the page only for a text/html request', () => {
    const block = INDEX.slice(INDEX.indexOf("app.use('/control', (req, res, next) => {"), INDEX.indexOf("res.setHeader('Content-Security-Policy', webControlCsp(req.path))"))
    expect(block).toContain('webControlOffnetResponse(/\\btext\\/html\\b/i.test(String(req.headers.accept ?? \'\')))')
    expect(block).toContain('res.status(403).type(offnet.type).send(offnet.body)')
    expect(block).not.toContain("send('COS Control Web is available")
  })
})
