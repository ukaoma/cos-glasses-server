import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Run the production media pane with queued observer delivery and deferred image IO.
// Detached entries can still be delivered after unobserve()/disconnect() in a browser.
const MEDIA = readFileSync(new URL('./panes/reader-media.js', import.meta.url), 'utf8')
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)) }
class El {
  children: El[] = []; attrs: Record<string, string> = {}; className = ''; textContent = ''; disabled = false
  parentElement: El | null = null; isConnected = true
  classList = { add() {}, remove() {} }
  constructor(public tag: string) {}
  appendChild(el: El) { el.parentElement = this; this.children.push(el); return el }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  getAttribute(k: string) { return this.attrs[k] ?? null }
  addEventListener() {}
  focus() {}
  remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this) }
  querySelectorAll(sel: string): El[] {
    const attr = /^\[([^\]]+)\]$/.exec(sel)?.[1]
    return this.children.flatMap(c => [...((attr ? attr in c.attrs : c.tag === sel) ? [c] : []), ...c.querySelectorAll(sel)])
  }
}
function fixture(defer = false) {
  const observed = new Set<El>(), calls: string[] = [], made: string[] = [], revoked: string[] = []
  const pending: ((b: Blob) => void)[] = []
  let callback: (entries: { target: El; isIntersecting: boolean }[]) => void = () => {}
  const W: any = { registerPane() {}, api(path: string) {
    calls.push(path)
    return defer ? new Promise<Blob>(resolve => pending.push(resolve)) : Promise.resolve(new Blob(['image'], { type: 'image/png' }))
  } }
  const document = { createElement: (tag: string) => new El(tag), head: new El('head'), body: new El('body'), documentElement: new El('html') }
  const window = { COSWeb: W, addEventListener() {}, IntersectionObserver: class {
    constructor(cb: typeof callback) { callback = cb }
    observe(el: El) { observed.add(el) }
    unobserve(el: El) { observed.delete(el) }
    disconnect() { observed.clear() }
  } }
  const context = vm.createContext({ window, document, Blob, Map, URL: {
    createObjectURL() { const url = 'blob:test-' + made.length; made.push(url); return url },
    revokeObjectURL(url: string) { revoked.push(url) },
  }, setTimeout() { return 0 }, clearTimeout() {} })
  vm.runInContext(MEDIA, context)
  const host = document.body.appendChild(new El('section'))
  const mount = (ch: string, count = 1) => {
    host.children.forEach(c => { c.isConnected = false }); host.children = []
    const slot = host.appendChild(new El('div'))
    slot.setAttribute('data-reader-tools', JSON.stringify({ items: Array.from({ length: count }, (_, i) => ({
      id: 'ti_' + ch.repeat(63) + String(i), tool: 'Read', index: i + 1, total: count, state: 'available',
    })) }))
    W.readerMedia.mount(host, 'claude', 'session')
    return slot.querySelectorAll('button').filter(b => b.className === 'rm-tool-thumb')
  }
  const intersect = (targets: El[]) => callback(targets.map(target => ({ target, isIntersecting: true })))
  return { W, host, mount, intersect, observed, calls, made, revoked, pending }
}

describe('removed image strip lifecycle', () => {
  it('unobserves a replaced strip and ignores an already queued intersection for it', async () => {
    const t = fixture(), old = t.mount('a')[0]
    const current = t.mount('b')[0]
    expect(t.observed.has(old), 'a removed button must no longer be observed').toBe(false)
    t.intersect([old]); await flush()
    expect(t.calls, 'a queued stale entry must not fetch removed images').toEqual([])
    t.intersect([current]); await flush()
    expect(t.calls).toHaveLength(1); expect(t.calls[0]).toContain('ti_' + 'b'.repeat(63) + '0')
    t.W.readerMedia.unmount(t.host)
    expect(t.made.filter(url => !t.revoked.includes(url)), 'every created blob remains owned and is revoked').toEqual([])
  })
  it('ignores an observer callback queued before unmount without throwing or fetching', async () => {
    const t = fixture(), old = t.mount('a')[0]
    t.W.readerMedia.unmount(t.host)
    expect(() => t.intersect([old])).not.toThrow()
    await flush(); expect(t.calls).toEqual([]); expect(t.made).toEqual([])
  })
  it('does not start a fetch if a live intersection is removed before the request microtask', async () => {
    const t = fixture(), old = t.mount('a')[0]
    t.intersect([old]); t.mount('b')
    await flush(); expect(t.calls).toEqual([]); expect(t.made).toEqual([])
  })
  it('discards an in-flight thumbnail after its strip is replaced, then permits the new strip to load', async () => {
    const t = fixture(true), old = t.mount('a')[0]
    t.intersect([old]); await flush(); expect(t.calls).toHaveLength(1)
    const current = t.mount('b')[0]
    t.pending.shift()!(new Blob(['old image'], { type: 'image/png' })); await flush()
    expect(t.made, 'an invalidated result must never create an orphan object URL').toEqual([])
    t.intersect([current]); await flush(); expect(t.calls).toHaveLength(2)
    t.pending.shift()!(new Blob(['new image'], { type: 'image/png' })); await flush(); expect(t.made).toHaveLength(1)
    t.W.readerMedia.unmount(t.host); expect(t.revoked).toEqual(t.made)
  })
  it('drops queued images after both active requests finish when their strip was removed', async () => {
    const t = fixture(true), old = t.mount('a', 3)
    t.intersect(old); await flush(); expect(t.calls).toHaveLength(2)
    t.mount('b')
    t.pending.splice(0).forEach(resolve => resolve(new Blob(['old'], { type: 'image/png' }))); await flush()
    expect(t.calls, 'the third removed image must never start').toHaveLength(2); expect(t.made).toEqual([])
  })
})
