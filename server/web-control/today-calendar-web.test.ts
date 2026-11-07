import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// PH plan P1: the rest of today under Next up (app.js loadCalendarLater). Runs the real app.js text against fakes.
const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')

class El {
  innerHTML = ''
  hidden = true
  classList = { add: (c: string) => { if (c === 'hidden') this.hidden = true }, toggle: (c: string, on: boolean) => { if (c === 'hidden') this.hidden = on } }
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)

function load(answer: unknown | Error) {
  const start = APP.indexOf('  function loadCalendarLater(n, d)'), end = APP.indexOf('  function prepNext()')
  expect(start, 'loadCalendarLater').toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const box = new El()
  const calls: string[] = []
  const deps = {
    $: (id: string) => (id === 'next-later' ? box : null), esc, TODAY: { gen: 1 },
    toDate: (v: unknown) => (v ? new Date(String(v)) : null),
    clock: (d: Date) => `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
    api: (path: string) => { calls.push(path); return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer) },
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn loadCalendarLater;\n}')(deps)
  return { box, calls, run: (n: unknown, d: Date | null) => { fn(n, d); return new Promise(r => setTimeout(r, 0)) } }
}

const NEXT = { title: 'Pipeline review', time: '2026-11-09T15:00:00Z' }
const row = (title: string, start: string, extra: Record<string, unknown> = {}) => ({ title, start, end: null, allDay: false, calendar: 'Work', meetingUrl: null, ...extra })

describe('Today: later today under Next up', () => {
  it('the markup has the block, hidden until it has rows', () => {
    expect(HTML).toContain('id="next-later" class="next-later hidden"')
  })

  it('lists up to two more, skipping the event Next up already shows, and escapes titles', async () => {
    const t = load({ connected: true, stale: false, asOf: null, next: [row('Pipeline review', '2026-11-09T15:00:00Z'), row('1:1 <Gina>', '2026-11-09T16:00:00Z'), row('Standup', '2026-11-09T17:00:00Z')] })
    await t.run(NEXT, new Date(NEXT.time))
    expect(t.calls).toEqual(['/api/calendar/today'])
    expect(t.box.hidden).toBe(false)
    expect(t.box.innerHTML).not.toContain('Pipeline review')
    expect(t.box.innerHTML).toContain('1:1 &lt;Gina&gt;')
    expect(t.box.innerHTML).toContain('Standup')
    expect(t.box.innerHTML).not.toContain('Calendar as of')
  })

  it('an aging snapshot says when it was read', async () => {
    const t = load({ connected: true, stale: true, asOf: '2026-11-09T14:40:00Z', next: [row('Standup', '2026-11-09T17:00:00Z')] })
    await t.run(NEXT, new Date(NEXT.time))
    expect(t.box.innerHTML).toContain('Calendar as of 14:40')
  })

  it('not connected, a failed read, or nothing more keeps it hidden', async () => {
    for (const answer of [{ connected: false, next: [] }, new Error('down'), { connected: true, stale: false, next: [row('Pipeline review', NEXT.time)] }]) {
      const t = load(answer)
      t.box.hidden = false
      await t.run(NEXT, new Date(NEXT.time))
      expect(t.box.hidden).toBe(true)
    }
  })
})
