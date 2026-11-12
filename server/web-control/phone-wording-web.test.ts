/**
 * 7.0.30 item 5 (Anand: it says iPhone, but Android works): Settings names the phone's camera, not the iPhone's. The file
 * must still parse (a straight apostrophe in a single-quoted string broke it once while this was written).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SET = readFileSync(join(HERE, 'panes', 'settings.js'), 'utf8')
describe('Settings says phone, not iPhone', () => {
  it('the sign-in row says "your phone’s camera", and no iPhone Camera is left in Control Web\'s own files', () => {
    expect(SET).toContain('A QR for your phone’s camera, and a code to type.')
    for (const f of ['app.js', 'index.html', 'panes/settings.js', 'panes/cos-chat.js', 'panes/messages.js']) expect(readFileSync(join(HERE, f), 'utf8'), f).not.toMatch(/iPhone Camera/)
  })
  it('settings.js parses', () => {
    expect(() => new vm.Script(SET)).not.toThrow()
  })
})
