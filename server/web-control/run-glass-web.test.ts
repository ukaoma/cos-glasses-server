/**
 * 7.0.55: live glass on Today's Running rows (run-glass.js, A1; the lead's 09:32 ruling). The module runs as it ships, in
 * a vm with fakes for WebGL, the page, requestAnimationFrame and IntersectionObserver. Pixels are not checked here (F1
 * measures them in a browser); what is checked is every rule the lead set: progress only from a real count, beads only
 * from a later activity time and at most one a second, at most 3 rows live, one context, nothing drawn while hidden, off
 * screen or under Reduce Motion beyond one still, the frame cap, and the fallback when the glass cannot draw.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { buildWebAssetTable } from '../lib/web-control-static'
// @ts-expect-error: a plain .mjs script with no types
import { manifestFor } from '../scripts/write-web-control-manifest.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'run-glass.js'), 'utf8')
// W1's adoption (7.0.55): the three rules live in app.css (the boot style list is fixed), in the 7.0.55 block.
const APPCSS = readFileSync(join(HERE, 'app.css'), 'utf8')
const CSS = APPCSS.slice(APPCSS.indexOf('/* 7.0.55: live glass on the Running rows'), APPCSS.indexOf("/* ── 7.0.29: the folded Duo's side rail"))

type Draw = { necks: number[]; drops: number }
interface Opts { gl?: 'ok' | 'none' | 'compile'; reduced?: boolean; hidden?: boolean; noIO?: boolean; vh?: number }

function page(o: Opts = {}) {
  const draws: Draw[] = []
  let contexts = 0
  let lastNk: number[] = [0, 0, 0]
  const glListeners: Record<string, (ev: unknown) => void> = {}
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, SCISSOR_TEST: 8, COLOR_BUFFER_BIT: 9, TRIANGLE_STRIP: 10,
    createShader: () => ({}), shaderSource: () => {}, compileShader: () => {}, getShaderParameter: () => o.gl !== 'compile',
    createProgram: () => ({}), attachShader: () => {}, linkProgram: () => {}, getProgramParameter: () => true, useProgram: () => {},
    createBuffer: () => ({}), bindBuffer: () => {}, bufferData: () => {}, getAttribLocation: () => 0, enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
    getUniformLocation: (_p: unknown, n: string) => n, enable: () => {}, clearColor: () => {}, viewport: () => {}, scissor: () => {}, clear: () => {},
    uniform2f: () => {}, uniform1f: () => {}, uniformMatrix3fv: () => {}, uniform3fv: () => {}, uniform1fv: () => {},
    uniform3f: (n: string, a: number, b: number, c: number) => { if (n === 'uNk') lastNk = [a, b, c] },
    uniform4fv: (n: string, v: Float32Array) => { if (n === 'uD') draws.push({ necks: lastNk, drops: [3, 7, 11, 15].filter(i => v[i] > 0.001).length }) },
    drawArrays: () => {},
  }
  const canvas = {
    className: '', width: 0, height: 0, parentNode: null as unknown, attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { this.attrs[k] = v },
    getContext: () => { contexts++; return o.gl === 'none' ? null : gl },
    addEventListener: (t: string, f: (ev: unknown) => void) => { glListeners[t] = f },
  }
  const slots = new Map<string, { isConnected: boolean; getBoundingClientRect: () => object }>()
  const panel = {
    clientWidth: 350, clientHeight: 400, clientLeft: 1, clientTop: 1, children: [] as unknown[],
    appendChild(c: { parentNode: unknown }) { c.parentNode = panel; panel.children.push(c) },
    removeChild(c: { parentNode: unknown }) { c.parentNode = null; panel.children = panel.children.filter(x => x !== c) },
    getBoundingClientRect: () => ({ left: 16, top: 300, width: 352, height: 402 }),
    querySelector(sel: string) { const m = /data-rg-key="(.*)"\]$/.exec(sel); return m ? slots.get(m[1].replace(/\\(.)/g, '$1')) ?? null : null },
  }
  function slot(key: string, top = 340) { slots.set(key, { isConnected: true, getBoundingClientRect: () => ({ left: 100, top, width: 36, height: 20 }) }) }

  let rafId = 0
  const rafs = new Map<number, (t: number) => void>()
  let ioCb: ((es: Array<{ isIntersecting: boolean }>) => void) | null = null
  const docListeners: Record<string, () => void> = {}
  let reduced = !!o.reduced
  const mqListeners: Array<() => void> = []
  const doc = {
    hidden: !!o.hidden,
    createElement: (t: string) => { if (t !== 'canvas') throw new Error(t); return canvas },
    addEventListener: (t: string, f: () => void) => { docListeners[t] = f },
  }
  const win: Record<string, unknown> = {
    document: doc, devicePixelRatio: 3, Float32Array, Math, Object, Array, String, Error, isFinite, innerWidth: 382, innerHeight: o.vh ?? 2000,
    addEventListener: () => {},
    matchMedia: () => ({ get matches() { return reduced }, addEventListener: (_t: string, f: () => void) => mqListeners.push(f) }),
    requestAnimationFrame: (f: (t: number) => void) => { rafs.set(++rafId, f); return rafId },
    cancelAnimationFrame: (id: number) => { rafs.delete(id) },
  }
  if (!o.noIO) win.IntersectionObserver = class { constructor(cb: typeof ioCb) { ioCb = cb } observe() {} disconnect() {} }
  win.window = win
  vm.runInNewContext(SRC, win)
  const G = win.CosRunGlass as {
    mount(p: unknown, o?: { onFail?: (w: string) => void }): boolean; unmount(): void; sync(rows: unknown[]): void; wake(): void; animating(): boolean; supported(): boolean
    state(): { mounted: boolean; failed: string; frames: number; running: boolean; live: string[]; rows: Record<string, { state: string; e: number; nk: number[]; target: number; necks: number[]; bead: boolean; drops: number; beadsAt: number }> }
    LIMITS: { LIVE_MAX: number; FRAME_MS: number; BEAD_GAP_MS: number; SIZE: number; MID: number; NECK: number }
  }
  let t = 1000
  /** Run the frames the page would run for ms, one every 16 ms. */
  function run(ms: number) {
    for (let end = t + ms; t < end;) { t += 16; const fs = [...rafs.values()]; rafs.clear(); fs.forEach(f => f(t)) }
  }
  return {
    G, panel, slot, slots, draws, run,
    contexts: () => contexts, pending: () => rafs.size,
    setHidden(h: boolean) { doc.hidden = h; docListeners.visibilitychange?.() },
    setReduced(r: boolean) { reduced = r; mqListeners.forEach(f => f()) },
    io(on: boolean) { ioCb?.([{ isIntersecting: on }]) },
    loseContext() { glListeners.webglcontextlost?.({ preventDefault() {} }) },
  }
}
const work = (key: string, extra: object = {}) => ({ key, state: 'work', ...extra })

describe('run-glass: the glass draws, or the strip stays', () => {
  it('no WebGL: mount is false, says why, and asks for nothing more', () => {
    const p = page({ gl: 'none' }); let why = ''
    expect(p.G.mount(p.panel, { onFail: w => { why = w } })).toBe(false)
    expect(p.G.state().failed).toBe('no-webgl')
    expect(p.G.supported()).toBe(false)
    expect(p.contexts()).toBe(1)
    expect(why).toBe('')               // mount's false IS the answer; onFail is for a context lost later
  })
  it('a shader that does not compile: mount is false', () => {
    const p = page({ gl: 'compile' })
    expect(p.G.mount(p.panel)).toBe(false)
    expect(p.G.state().failed).toBe('shader:compile')
  })
  it('one context for the page: unmount and mount again reuse it', () => {
    const p = page()
    expect(p.G.mount(p.panel)).toBe(true); p.G.unmount(); expect(p.G.mount(p.panel)).toBe(true)
    expect(p.contexts()).toBe(1)
    expect(p.panel.children.length).toBe(1)
  })
  it('a lost context hands back to the strip: onFail, unmounted, and it never mounts again on this page', () => {
    const p = page(); let why = ''
    p.G.mount(p.panel, { onFail: w => { why = w } }); p.slot('a'); p.G.sync([work('a')])
    p.loseContext()
    expect(why).toBe('context-lost')
    expect(p.G.state().mounted).toBe(false)
    expect(p.pending()).toBe(0)
    expect(p.G.mount(p.panel)).toBe(false)
  })
  it('the CSS: the slot is the badge line\'s height and the canvas never takes a tap', () => {
    expect(CSS).toMatch(/\.rg-slot \{[^}]*width: 36px; height: 20px;/)
    expect(CSS).toMatch(/\.rg-canvas \{[^}]*pointer-events: none;/)
    expect(CSS).toMatch(/\.run-panel \{ position: relative; \}/)
  })
})

describe('run-glass: progress is never invented', () => {
  it('bonds fuse at real thirds of a real done and total', () => {
    const p = page(); p.G.mount(p.panel); const N = p.G.LIMITS.NECK
    const necks = (done: number, total: number) => { p.G.sync([work('a', { done, total })]); return p.G.state().rows.a.necks }
    expect(necks(0, 3)).toEqual([0, 0, 0])
    expect(necks(1, 3)).toEqual([N, 0, 0])
    expect(necks(2, 3)).toEqual([N, N, 0])
    expect(necks(3, 3)).toEqual([N, N, N])
    expect(p.G.state().rows.a.target).toBeCloseTo(0.9, 6)
    p.G.sync([work('a', { done: 1, total: 2 })])
    expect(p.G.state().rows.a.necks[0]).toBe(N); expect(p.G.state().rows.a.necks[1]).toBeCloseTo(N / 2, 6)
  })
  it('no real count: one mid pose and no bond fuses (no total, a zero total, a done with no total)', () => {
    const p = page(); p.G.mount(p.panel)
    for (const extra of [{}, { done: 2, total: 0 }, { done: 2 }, { total: 4 }, { done: Number.NaN, total: 3 }]) {
      p.G.sync([work('a', extra)])
      expect(p.G.state().rows.a.target, JSON.stringify(extra)).toBe(p.G.LIMITS.MID)
      expect(p.G.state().rows.a.necks, JSON.stringify(extra)).toEqual([0, 0, 0])
    }
  })
  it('done: the full mark, every bond fused, whatever the count said', () => {
    const p = page(); p.G.mount(p.panel)
    p.G.sync([{ key: 'a', state: 'done' }])
    expect(p.G.state().rows.a.necks).toEqual([p.G.LIMITS.NECK, p.G.LIMITS.NECK, p.G.LIMITS.NECK])
    expect(p.G.state().rows.a.target).toBeCloseTo(0.9, 6)
  })
})

describe('run-glass: beads only from real activity, at most one a second', () => {
  it('the first sight of a row is not activity; a later time is', () => {
    const p = page(); p.G.mount(p.panel); p.slot('a')
    p.G.sync([work('a', { activityAt: 5000 })]); expect(p.G.state().rows.a.bead).toBe(false)
    p.G.sync([work('a', { activityAt: 5000 })]); expect(p.G.state().rows.a.bead).toBe(false)
    p.G.sync([work('a', { activityAt: 4000 })]); expect(p.G.state().rows.a.bead).toBe(false)   // older is not news
    p.G.sync([work('a', { activityAt: 6000 })]); expect(p.G.state().rows.a.bead).toBe(true)
    p.run(40)
    expect(p.G.state().rows.a.drops).toBe(1)
  })
  it('no activity time, no beads: running ten seconds of frames drops nothing (never a timer)', () => {
    const p = page(); p.G.mount(p.panel); p.slot('a')
    p.G.sync([work('a')]); p.run(10000)
    expect(p.draws.some(d => d.drops > 0)).toBe(false)
    expect(p.G.state().rows.a.beadsAt).toBeLessThan(0)
  })
  it('a burst of activity is one bead a second, not one per frame', () => {
    const p = page(); p.G.mount(p.panel); p.slot('a')
    p.G.sync([work('a', { activityAt: 1 })])
    for (let i = 2; i < 12; i++) { p.G.sync([work('a', { activityAt: i })]); p.run(50) }   // ten events inside half a second
    const first = p.G.state().rows.a.beadsAt
    expect(first).toBeGreaterThanOrEqual(0)
    expect(p.G.state().rows.a.bead).toBe(true)                    // the other nine wait as ONE bead, not nine
    p.run(700)                                                    // past the one-second gap
    const second = p.G.state().rows.a.beadsAt
    expect(second - first).toBeGreaterThanOrEqual(p.G.LIMITS.BEAD_GAP_MS)
    expect(p.G.state().rows.a.bead).toBe(false)
    p.run(3000)                                                   // no new activity: no third bead
    expect(p.G.state().rows.a.beadsAt).toBe(second)
  })
  it('a waiting row takes no bead', () => {
    const p = page(); p.G.mount(p.panel); p.slot('a')
    p.G.sync([{ key: 'a', state: 'wait', activityAt: 1 }]); p.G.sync([{ key: 'a', state: 'wait', activityAt: 2 }])
    expect(p.G.state().rows.a.bead).toBe(false)
  })
})

describe('run-glass: what moves, and when', () => {
  it('at most 3 rows live, the first working ones in display order', () => {
    const p = page(); p.G.mount(p.panel)
    const keys = ['a', 'b', 'c', 'd', 'e']; keys.forEach((k, i) => p.slot(k, 320 + i * 100))
    p.G.sync([{ key: 'w', state: 'wait' }, ...keys.map(k => work(k))])
    expect(p.G.state().live).toEqual(['a', 'b', 'c'])
    expect(p.G.LIMITS.LIVE_MAX).toBe(3)
  })
  it('about 30 frames a second, never every display frame', () => {
    const p = page(); p.G.mount(p.panel); p.slot('a'); p.G.sync([work('a')])
    const f0 = p.G.state().frames; p.run(1000)
    const n = p.G.state().frames - f0
    expect(n).toBeGreaterThanOrEqual(20); expect(n).toBeLessThanOrEqual(32)
  })
  it('hidden page: no frame is asked for and none is drawn; visible again, it resumes', () => {
    const p = page(); p.G.mount(p.panel); p.slot('a'); p.G.sync([work('a')])
    p.setHidden(true); const f = p.G.state().frames
    expect(p.pending()).toBe(0); p.run(2000); expect(p.G.state().frames).toBe(f)
    p.setHidden(false); expect(p.pending()).toBe(1)
  })
  it('panel off screen: no frames; back on screen: it resumes', () => {
    const p = page(); p.G.mount(p.panel); p.slot('a'); p.G.sync([work('a')])
    p.io(false); const f = p.G.state().frames
    p.run(2000); expect(p.G.state().frames).toBe(f); expect(p.pending()).toBe(0)
    p.io(true); expect(p.pending()).toBe(1)
  })
  it('Reduce Motion: one still frame, no loop, and a new still only when something changed', () => {
    const p = page({ reduced: true }); p.G.mount(p.panel); p.slot('a')
    const f0 = p.G.state().frames
    p.G.sync([work('a', { done: 1, total: 3 })]); expect(p.G.state().frames).toBe(f0 + 1)
    expect(p.pending()).toBe(0); p.run(3000); expect(p.G.state().frames).toBe(f0 + 1)
    p.G.sync([work('a', { done: 1, total: 3, activityAt: 9 })]); expect(p.G.state().frames).toBe(f0 + 1)   // activity alone draws nothing
    p.G.sync([work('a', { done: 2, total: 3 })]); expect(p.G.state().frames).toBe(f0 + 2)
    expect(p.draws[p.draws.length - 1].necks).toEqual([p.G.LIMITS.NECK, p.G.LIMITS.NECK, 0])
  })
  it('Reduce Motion: a row that moves inside the panel (same size, same state) gets its still redrawn where it now is (Codex 11:3x)', () => {
    const p = page({ reduced: true }); p.G.mount(p.panel); p.slot('a', 340)
    p.G.sync([work('a', { done: 1, total: 3 })]); const f0 = p.G.state().frames
    p.G.wake(); expect(p.G.state().frames).toBe(f0)          // nothing moved: no new still
    p.slot('a', 420); p.G.wake(); expect(p.G.state().frames).toBe(f0 + 1)   // the row moved down 80 px
    p.G.wake(); expect(p.G.state().frames).toBe(f0 + 1)
  })
  it('only the panel\'s edge on screen, every slot below the window: nothing moves, and the rail is not told to rest (Codex 11:5x)', () => {
    const p = page({ vh: 557 }); p.G.mount(p.panel); p.slot('a', 700); p.slot('b', 760)
    p.G.sync([work('a'), work('b')])
    expect(p.G.animating()).toBe(false); expect(p.pending()).toBe(0); expect(p.G.state().live).toEqual([])
  })
  it('a slot scrolled back into the window starts again on the page\'s wake, and only it is live', () => {
    const p = page({ vh: 557 }); p.G.mount(p.panel); p.slot('a', 700); p.slot('b', 760)
    p.G.sync([work('a'), work('b')]); expect(p.pending()).toBe(0)
    p.slot('a', 400); p.G.wake()
    expect(p.G.animating()).toBe(true); expect(p.pending()).toBe(1); expect(p.G.state().live).toEqual(['a'])
  })
  it('turning Reduce Motion on mid-loop stops the loop', () => {
    const p = page(); p.G.mount(p.panel); p.slot('a'); p.G.sync([work('a')]); p.run(200)
    p.setReduced(true); p.run(50); expect(p.pending()).toBe(0)
  })
  it('waiting only: nothing moves, one still', () => {
    const p = page(); p.G.mount(p.panel); p.slot('a')
    p.G.sync([{ key: 'a', state: 'wait' }])
    expect(p.pending()).toBe(0); expect(p.G.state().live).toEqual([])
  })
  it('done settles, then the loop stops on its own', () => {
    const p = page(); p.G.mount(p.panel); p.slot('a'); p.G.sync([work('a', { done: 1, total: 3 })]); p.run(500)
    p.G.sync([{ key: 'a', state: 'done' }]); expect(p.pending()).toBe(1)
    p.run(6000)
    expect(p.pending()).toBe(0)
    expect(p.G.state().rows.a.nk.every(v => Math.abs(v - p.G.LIMITS.NECK) < 0.005)).toBe(true)
  })
  it('a row that left the list is forgotten', () => {
    const p = page(); p.G.mount(p.panel); p.slot('a'); p.G.sync([work('a')]); p.G.sync([])
    expect(p.G.state().rows).toEqual({}); expect(p.pending()).toBe(0)
  })
  it('animating(): only while a live working row with a slot moves on screen', () => {
    const p = page(); p.G.mount(p.panel)
    p.G.sync([work('a')]); expect(p.G.animating()).toBe(false)          // no slot on the page
    p.slot('a'); expect(p.G.animating()).toBe(true)
    p.setHidden(true); expect(p.G.animating()).toBe(false); p.setHidden(false)
    p.io(false); expect(p.G.animating()).toBe(false); p.io(true)
    p.setReduced(true); expect(p.G.animating()).toBe(false); p.setReduced(false)
    p.G.sync([{ key: 'a', state: 'wait' }]); expect(p.G.animating()).toBe(false)
    p.G.unmount(); expect(p.G.animating()).toBe(false)
  })
  it('no IntersectionObserver: it still draws (taken as on screen)', () => {
    const p = page({ noIO: true }); p.G.mount(p.panel); p.slot('a'); p.G.sync([work('a')])
    expect(p.pending()).toBe(1)
  })
})

describe('run-glass: shipped', () => {
  it('the server serves the script, hashed, and the page names it in the lazy list (so its reference is stamped)', () => {
    const table = buildWebAssetTable(HERE)
    expect(table.get('/run-glass.js')!.type).toMatch(/javascript/)
    expect(table.get('/index.html')!.body.toString('utf8')).toContain('"runGlass": "/control/run-glass.js?v=' + table.get('/run-glass.js')!.hash + '"')
    expect(table.has('/run-glass.css')).toBe(false)   // folded into app.css
  })
  it('the pack manifest (integrity mode) lists the script', () => {
    const files = manifestFor(HERE).files as Record<string, string>
    expect(files['/run-glass.js']).toBe(createHash('sha256').update(readFileSync(join(HERE, 'run-glass.js'))).digest('hex'))
  })
})
