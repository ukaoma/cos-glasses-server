/**
 * The web side of "Show files and images your sessions make" (6.99.35): the Settings toggle under Privacy, the one line
 * the reader and Today show when it is off, and the words a fetch refused with 403 previews_off gets. Real files, vm.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const APP = read('./app.js'), TODAY = read('./panes/today-actions.js'), MEDIA = read('./panes/reader-media.js'), SETTINGS = read('./panes/settings.js')
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)
const region = (src: string, from: string, to: string) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  if (a < 0 || b <= a) throw new Error('Production region missing: ' + from)
  return src.slice(a, b)
}
const OFF = 'Previews are off. Turn them on in Settings, Privacy.'

describe('the reader and Today when previews are off', () => {
  const ctx: any = vm.createContext({ JSON, String, Array })
  vm.runInContext('var esc = ' + esc.toString() + ';' + region(APP, '  function readerImagesHtml(turn)', '  function readerImagesStop(host)') + ';this.html = readerImagesHtml;', ctx)
  it('one line per message, no slot for the viewer, nothing named', () => {
    const out = ctx.html({ previewsOff: true, outputImages: [{ id: 'ai_' + 'a'.repeat(64), label: 'secret.png', state: 'available' }] })
    expect(out).toBe('<p class="rm-status rm-off">' + OFF + '</p>')
    expect(ctx.html({ previewsOff: false })).toBe('')
  })
  it('Today keeps the mark on its last reply, so the line shows there too', () => {
    expect(TODAY).toContain('outputImages: lastA.outputImages, outputFiles: lastA.outputFiles, previewsOff: lastA.previewsOff }')
  })
  it('a fetch refused because previews were turned off says so, for images and files', () => {
    expect(MEDIA).toContain("if (err && err.status === 403) return '" + OFF + "';")
    expect(MEDIA.split("if (err && err.status === 403) return '" + OFF + "';").length - 1).toBe(2)
  })
})

describe('Settings, Privacy: the toggle', () => {
  function settings(sf: any) {
    const src = region(SETTINGS, '  function row(name, desc, control)', '  function onMac(names)') + region(SETTINGS, '  function sessionFilesGroup(d)', '\n  }\n') + '\n  }\n'
    const ctx: any = vm.createContext({ esc })
    vm.runInContext(src + ';this.g = sessionFilesGroup;', ctx)
    return ctx.g({ sf })
  }
  it('says what it does in one sentence, under Privacy, on by default', () => {
    const html = settings({ enabled: true, source: 'default', saved: null })
    // 7.0.4: the label and description name everything the switch covers.
    expect(html).toContain('Show session files, screenshots and images')
    expect(html).toContain('Lets this page show the files and images your sessions send you, the screenshots and images they open, and images attached to your prompts. Files stay on your Mac.')
    expect(html).not.toContain('project folder')
    expect(html).not.toMatch(/[\u2013\u2014\u2192]/)
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('data-set="session-files"')
    expect(html).not.toContain(' disabled')
  })
  it('forced off on the Mac: off, disabled, and it says why', () => {
    const html = settings({ enabled: false, source: 'env', saved: true })
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain(' disabled')
    expect(html).toContain('Turned off on the Mac by the server environment (COS_WEB_SESSION_FILES=0).')
  })
  // QA 7.0.0: a saved setting the Mac could not read is off, and the row says why in words, still changeable.
  it('a damaged saved setting: off, says it could not read it, and the toggle can save it again', () => {
    const html = settings({ enabled: false, source: 'damaged', saved: null })
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('Couldn\u2019t read the saved setting, so previews are off. Turn it on to save it again.')
    expect(html).not.toContain('Lets this page show images')
    expect(html).not.toContain(' disabled')
  })
  it('nothing renders when the server has no such setting (an older server)', () => {
    expect(settings(null)).toBe('')
    expect(settings({}), 'an answer without the switch').toBe('')
    expect(settings({ enabled: 'yes' })).toBe('')
  })
  it('wired: loaded with the other settings, shown in Privacy, saved by POST, and the readers repaint', () => {
    expect(SETTINGS).toContain("soft(api('/api/session-files/settings'))")
    expect(SETTINGS).toContain("if (cat.id === 'privacy') out += sessionFilesGroup(d);")
    expect(SETTINGS).toContain("api('/api/session-files/settings', { method: 'POST', body: { enabled: !son } })")
  })
})
