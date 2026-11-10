/**
 * W1 (Miles 2026-11-09 21:24, closed Duo): a composer's placeholder wrapped onto two lines and the second was clipped.
 * Every composer holds its placeholder on one line at 382, 440, 520 and 951 px. The real check is the WebKit measurement
 * (lanes/W1_evidence/duo_measure.cjs, exit 2 on any wrap); a source test cannot see layout. These pins keep the two
 * things that measurement depends on: the reader box sizes from its own space, and every placeholder stays short.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHAT_CSS = readFileSync(join(HERE, 'panes', 'cos-chat.css'), 'utf8')
const APP_CSS = readFileSync(join(HERE, 'app.css'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
const CHAT_JS = readFileSync(join(HERE, 'panes', 'cos-chat.js'), 'utf8')
const APP_JS = readFileSync(join(HERE, 'app.js'), 'utf8')

describe('Duo composers: the placeholder sits on one line', () => {
  it('the session reply box needs 19rem before its buttons share the row, and the narrow rule still wins below 430 px', () => {
    const base = CHAT_CSS.indexOf('.att-composer > textarea { flex: 1 1 19rem; min-width: 0; }')
    const narrow = CHAT_CSS.indexOf('@media (max-width: 429px) {\n  .att-composer > textarea { flex: 1 1 100%; }')
    expect(base, 'the 19rem basis').toBeGreaterThan(-1)
    expect(narrow, 'the under-430 full row').toBeGreaterThan(-1)
    expect(base, 'the base rule comes first, so the media rule is not overridden by it').toBeLessThan(narrow)
    expect(CHAT_CSS.match(/\.att-composer > textarea \{/g)?.length, 'no later rule undoes either').toBe(2)
  })
  it('the COS chat composer (and Today ask, a reply) wraps by its own width: words 19rem, the buttons below when they do not fit', () => {
    expect(CHAT_CSS).toContain('display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: flex-end; }')
    expect(CHAT_CSS).toContain('.cc-composer > .cc-input { flex: 1 1 19rem; min-width: 0; }')
    expect(CHAT_CSS).toContain('.cc-composer > .cc-buttons { flex: none; margin-left: auto; }')
    expect(CHAT_CSS, 'no grid row that pins the buttons beside the box').not.toContain('grid-template-columns: minmax(0, 1fr) auto;')
  })
  it('the COS chat header: the description keeps 16rem; the links wrap beneath it in a narrow column', () => {
    expect(CHAT_CSS).toContain('.cc-head-text { min-width: 0; flex: 1 1 16rem; }')
    expect(CHAT_CSS).toContain('.cc-head-acts { display: flex; flex-wrap: wrap; gap: 4px 14px; }')
  })
  it('the Ask sheet field keeps 15rem; the camera, clip and Cancel move to the row below when they do not fit', () => {
    expect(APP_CSS).toContain('#ask-form { flex-wrap: wrap; }')
    expect(APP_CSS).toContain('#ask-form > .field { flex: 1 1 15rem; min-width: 0; }')
  })
  it('every composer placeholder is 36 characters or fewer (the longest measured 277 px at 382 wide, 47 px to spare)', () => {
    const found: string[] = []
    for (const m of HTML.matchAll(/<(?:textarea|input)[^>]*\bid="(today-ask-input|ask-q)"[^>]*placeholder="([^"]*)"/g)) found.push(m[2])
    for (const m of CHAT_JS.matchAll(/placeholder: drop \? '([^']*)' : '([^']*)'/g)) found.push(m[1], m[2])
    for (const m of APP_JS.matchAll(/id="session-input"[^>]*placeholder="([^"]*)"/g)) found.push(m[1])
    for (const m of APP_JS.matchAll(/setAttribute\('placeholder', [^?']*\? '([^']*)' : '([^']*)'\)/g)) found.push(m[1], m[2])
    expect(found).toContain('Ask COS or drop a thought')
    expect(found).toContain('Ask about this or steer a session')
    expect(found).toContain('Ask COS or find a session')
    expect(found).toContain('Continue this session…')
    for (const p of found) expect(p.length, p).toBeLessThanOrEqual(36)
  })
})
