// 7.0.7 final QA: the server sends link-card markers only to a client that asks with cards=1 (routes/agent-sessions.ts),
// so a Control Web tab opened before the update shows words, not raw [x](cos-file:N). The 7.0.7 web reader and Today's
// session sheet are the clients that draw cards; if either stopped asking, every card would quietly become plain words.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
describe('Control Web asks for link-card markers (cards=1) on every history read that draws cards', () => {
  it('the Sessions reader: both ?turns= reads in app.js', () => {
    const app = read('./app.js')
    expect(app.match(/sessionPath\(provider, id, '\?turns=' \+ SX_TURNS \+ '&cards=1'\)/g)?.length).toBe(2)
    expect(app).not.toMatch(/sessionPath\(provider, id, '\?turns=' \+ SX_TURNS\)\)/)
  })
  it("Today's session sheet: its last-reply read", () => {
    const ta = read('./panes/today-actions.js')
    expect(ta).toContain("K.path(r.provider, r.id, '?turns=6&cards=1')")
    expect(ta).not.toContain("'?turns=6')")
  })
})
