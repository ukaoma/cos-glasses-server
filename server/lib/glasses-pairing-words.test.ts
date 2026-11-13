/**
 * 7.0.32 (Miles 11/13 06:34, after glasses 6.11.685 paired on his phone with the code alone): the glasses pair by the
 * typed code only. A QR is only ever for the phone's Camera and a browser (signing a browser in by QR stays). So no
 * text the server shows may tell anyone to scan, photograph or use a QR or camera to pair the GLASSES.
 *
 * Two rules, each run on the shipped text:
 * 1. Every glasses pairing answer (PAIRING_REASON_MESSAGE, all of them about pairing the glasses) has no scan word.
 * 2. In the user-facing web and server text (comments taken out), no sentence that mentions the glasses also says scan,
 *    QR, photo, picture or camera. A sentence about a browser's QR that does not name the glasses is allowed.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAIRING_REASON_MESSAGE } from './glasses-pairing.js'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN = /\b(scan\w*|qr|photo\w*|picture\w*|camera\w*)\b/i
const GLASSES = /\bglasses\b/i

// The text a person can see: the web pages and their panes, the sign-in and off-network pages, and the server's own
// answers that a browser or the glasses app shows.
const FILES = [
  'web-control/app.js', 'web-control/index.html', 'web-control/shell.js', 'web-control/theme.js',
  ...readdirSync(join(SERVER, 'web-control/panes')).filter(f => /\.(js|html)$/.test(f)).map(f => 'web-control/panes/' + f),
  'routes/web-control.ts', 'routes/pairing.ts', 'lib/web-control-offnet-page.ts', 'lib/web-session-auth.ts', 'lib/api-auth.ts', 'lib/glasses-pairing.ts',
]
/** Block, line and HTML comments out, so a developer's note is not read as copy. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1 ').replace(/<!--[\s\S]*?-->/g, ' ')
}
/** Sentences that name the glasses and say scan, QR, photo, picture or camera. */
export function glassesScanSentences(text: string): string[] {
  return stripComments(text).split(/(?<=[.!?;:])\s+|\n/).map(s => s.trim()).filter(s => GLASSES.test(s) && SCAN.test(s))
}

describe('the glasses pair by the typed code only: no text tells anyone to scan for them (Miles 11/13)', () => {
  it('no glasses pairing answer says scan, QR, photo, picture or camera', () => {
    const bad = Object.entries(PAIRING_REASON_MESSAGE).filter(([, m]) => SCAN.test(m))
    expect(bad).toEqual([])
    expect(Object.keys(PAIRING_REASON_MESSAGE).length, 'the table is really read').toBeGreaterThan(5)
  })
  it('no sentence in the web pages or the server answers pairs the glasses with a scan', () => {
    const found: string[] = []
    for (const f of FILES) for (const s of glassesScanSentences(readFileSync(join(SERVER, f), 'utf8'))) found.push(`${f}: ${s.slice(0, 160)}`)
    expect(found).toEqual([])
    expect(FILES.length, 'the panes were listed').toBeGreaterThan(15)
  })
  it('the rule itself: it catches a glasses scan sentence, and lets a browser QR sentence and a comment through', () => {
    expect(glassesScanSentences("x = 'Scan the code with COS Glasses to pair.'")).toHaveLength(1)
    expect(glassesScanSentences('<p>Take a photo of the QR on your glasses.</p>')).toHaveLength(1)
    expect(glassesScanSentences("x = 'Scan the QR with your phone\\'s camera to sign in.'")).toHaveLength(0)
    expect(glassesScanSentences('// older glasses builds could scan a QR')).toHaveLength(0)
    expect(glassesScanSentences("x = 'A QR for your phone camera; this is not glasses pairing.'")).toHaveLength(0)
  })
  it('signing a browser in by QR stays: the sign-in page still offers it', () => {
    const page = readFileSync(join(SERVER, 'web-control/index.html'), 'utf8')
    expect(page).toContain("Scan the QR with your phone's camera.")
    expect(page).toContain('The glasses pairing code does not work here.')
  })
})
