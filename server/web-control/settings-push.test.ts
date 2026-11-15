/** Fixture browser execution only: never evidence for physical iPhone permission or delivery. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { P2_DEFAULTS } from '../lib/drop-p2-settings.js'

const source = readFileSync(new URL('./panes/settings.js', import.meta.url), 'utf8')
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)) }
async function rig(opts: { enabled?: boolean; production?: boolean; secure?: boolean; home?: boolean; blocked?: boolean; existing?: boolean; removed?: boolean; failSave?: boolean; failStatus?: boolean; failTest?: boolean; deferInitialDevices?: boolean; dropOff?: boolean } = {}) {
  const calls: Array<{ path: string; method?: string; body?: any }> = [], listeners: Record<string, Function> = {}
  const pane = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null, addEventListener: (name: string, f: Function) => { listeners[name] = f } }
  let load: Function = () => {}, subscribeCalls = 0, unsubscribes = 0
  let pendingDevices: Promise<any> | null = null, resolveDevices: ((value: any) => void) | null = null
  const deferDevices = () => { pendingDevices = new Promise(resolve => { resolveDevices = resolve }); return (devices: any[]) => resolveDevices!({ devices }) }
  const resolveInitial = opts.deferInitialDevices ? deferDevices() : null
  const device = { id: '0123456789abcdef', label: 'Phone', production: opts.production === true, showWords: false, addedAt: '2026-11-15T00:00:00Z' }
  const subscription = { endpoint: 'https://web.push.apple.com/secret', toJSON: () => ({ endpoint: 'https://web.push.apple.com/secret', keys: { auth: 'private', p256dh: 'private' } }), unsubscribe: async () => { unsubscribes++; return true } }
  const W = {
    $: (id: string) => id === 'pane-settings' ? pane : null, esc: (s: unknown) => String(s), state: {}, skeletonRows: () => '', toast: () => {},
    parseRoute: () => ({ pane: 'settings', args: [] }), go: () => {}, registerPane: (_name: string, def: { load: Function }) => { load = def.load },
    api: async (path: string, o?: { method?: string; body?: any }) => {
      calls.push({ path, ...o })
      if (path === '/api/health') return { capabilities: { dropIt: { protocol: 1, enabled: !opts.dropOff, p2Settings: 1 } }, features: { webPush: opts.enabled !== false } }
      if (path === '/api/drops/settings/p2') return { protocol: 1, settings: P2_DEFAULTS }
      if (path === '/api/web-push/status') return { enabled: true, productionEnabled: opts.production === true }
      if (path === '/api/web-push/key') return { publicKey: 'BA' }
      if (path === '/api/web-push/devices' && o?.method === 'POST') {
        if (opts.failSave) throw new Error('refused')
        return { id: device.id }
      }
      if (path === '/api/web-push/devices') {
        if (pendingDevices) { const waiting = pendingDevices; pendingDevices = null; return waiting }
        return { devices: opts.existing && !opts.removed ? [structuredClone(device)] : [] }
      }
      if (path === '/api/web-push/subscription/status') {
        if (opts.failStatus) throw new Error('unavailable')
        return { device: opts.removed ? null : structuredClone(device) }
      }
      if (path.startsWith('/api/web-push/devices/')) return { ok: true, removed: true }
      if (path === '/api/web-push/test') { if (opts.failTest) throw new Error('cap'); return { scheduled: true, delaySeconds: 15 } }
      throw new Error('404')
    },
  }
  const context = vm.createContext({ window: { COSWeb: W, isSecureContext: opts.secure !== false, navigator: { standalone: opts.home !== false },
    Notification: { permission: opts.blocked ? 'denied' : 'default' }, atob: (s: string) => Buffer.from(s, 'base64').toString('latin1'),
    pushManager: { getSubscription: async () => opts.existing ? subscription : null, subscribe: () => { subscribeCalls++; return Promise.resolve(subscription) } } },
    document: {}, console, Promise, Number, String, isFinite })
  vm.runInContext(source, context)
  load(); await flush()
  const click = (act: string) => {
    const t = { disabled: false, getAttribute: (name: string) => name === 'data-set' ? act : name === 'data-device' ? device.id : null, closest: (sel: string) => sel === '[data-set]' ? t : null }
    listeners.click({ target: t })
  }
  return { pane, calls, click, deferDevices, resolveInitial, subscribeCalls: () => subscribeCalls, unsubscribes: () => unsubscribes }
}

describe('Settings phone pings', () => {
  it('off gate does not read subscription routes or prompt; insecure, non-Home-Screen and denied contexts cannot subscribe', async () => {
    const off = await rig({ enabled: false })
    expect(off.pane.innerHTML).not.toContain('Phone pings')
    expect(off.calls.filter(c => c.path.startsWith('/api/web-push'))).toEqual([])
    for (const opts of [{ secure: false }, { home: false }, { blocked: true }]) {
      const r = await rig(opts)
      r.click('push-test-on'); await flush()
      expect(r.subscribeCalls()).toBe(0)
      expect(r.calls.some(c => c.path === '/api/web-push/key')).toBe(false)
    }
  })
  it('proof setup stays available when autonomous COS pings are off', async () => {
    const r = await rig({ dropOff: true })
    expect(r.pane.innerHTML).toContain('Set up test pings')
    expect(r.pane.innerHTML).not.toContain('data-p2="pings.dailyCap"')
  })
  it('proof uses two taps, calls subscribe immediately on the permission tap, requests no production and schedules only an explicit bounded test', async () => {
    const r = await rig()
    expect(r.pane.innerHTML).toContain('Production pings')
    expect(r.pane.innerHTML).not.toContain('Send pings to this phone')
    expect(r.calls.some(c => c.path === '/api/web-push/key')).toBe(false)
    expect(r.subscribeCalls()).toBe(0)
    r.click('push-test-on'); await flush()
    expect(r.subscribeCalls()).toBe(0)
    expect(r.pane.innerHTML).toContain('Allow test pings on this phone')
    r.click('push-test-on')
    expect(r.subscribeCalls()).toBe(1) // before any promise continuation
    await flush()
    expect(r.calls.find(c => c.method === 'POST' && c.path === '/api/web-push/devices')?.body).toMatchObject({ production: false, showWords: false })
    expect(r.calls.some(c => c.path === '/api/web-push/test')).toBe(false)
    r.click('push-test'); await flush()
    expect(r.calls.find(c => c.path === '/api/web-push/test')?.body).toEqual({ deviceId: '0123456789abcdef', delaySeconds: 15 })
    expect(r.pane.innerHTML).toContain('Test scheduled in 15 seconds')
    r.click('push-remove'); await flush()
    expect(r.unsubscribes()).toBe(1)
    expect(r.pane.innerHTML).toContain('Device removed')
  })
  it('production enrolls only when activated, words need a separate opt-in and stopping removes server first then unsubscribes', async () => {
    const r = await rig({ production: true })
    r.click('push-on'); await flush(); r.click('push-on'); await flush()
    expect(r.calls.find(c => c.path === '/api/web-push/devices' && c.method === 'POST')?.body).toMatchObject({ production: true, showWords: false })
    expect(r.pane.innerHTML).toContain('Show the words')
    r.click('push-words'); await flush()
    expect(r.calls.find(c => c.method === 'PATCH')?.body).toEqual({ showWords: true })
    r.click('push-off'); await flush()
    expect(r.calls.some(c => c.method === 'DELETE')).toBe(true)
    expect(r.unsubscribes()).toBe(1)
  })
  it('remote removal cleans up on next open; status failure leaves the browser subscription intact', async () => {
    const r = await rig({ existing: true, removed: true })
    expect(r.unsubscribes()).toBe(1)
    const down = await rig({ existing: true, failStatus: true })
    expect(down.unsubscribes()).toBe(0)
    expect(down.pane.innerHTML).toContain('could not be checked')
  })
  it('a refused server subscription rolls back the newly created browser subscription', async () => {
    const r = await rig({ failSave: true })
    r.click('push-test-on'); await flush(); r.click('push-test-on'); await flush()
    expect(r.unsubscribes()).toBe(1)
    expect(r.pane.innerHTML).toContain('could not be saved')
  })
  it('a refused test request never claims a scheduled or delivered test', async () => {
    const r = await rig({ existing: true, failTest: true })
    r.click('push-test')
    expect(r.pane.innerHTML).toContain('Scheduling test ping')
    expect(r.pane.innerHTML).not.toContain('Test scheduled')
    await flush()
    expect(r.pane.innerHTML).toContain('could not be scheduled')
    expect(r.pane.innerHTML).not.toContain('Test scheduled')
  })
  it('an old initial snapshot cannot replace a newly subscribed phone', async () => {
    const r = await rig({ deferInitialDevices: true })
    r.click('push-test-on'); await flush(); r.click('push-test-on'); await flush()
    expect(r.pane.innerHTML).toContain('Send test ping')
    r.resolveInitial!([]); await flush()
    expect(r.pane.innerHTML).toContain('data-set="push-test"')
    expect(r.pane.innerHTML).not.toContain('data-set="push-test-on"')
  })
  it('a slow refresh cannot resurrect a removed device or roll back a words change', async () => {
    const removed = await rig({ existing: true, production: true })
    const resolveRemoved = removed.deferDevices()
    removed.click('refresh'); await flush()
    removed.click('push-remove'); await flush()
    resolveRemoved([{ id: '0123456789abcdef', label: 'stale device' }]); await flush()
    expect(removed.pane.innerHTML).not.toContain('stale device')
    expect(removed.pane.innerHTML).not.toContain('data-set="push-off"')
    const words = await rig({ existing: true, production: true })
    const resolveWords = words.deferDevices()
    words.click('refresh'); await flush()
    words.click('push-words'); await flush()
    resolveWords([]); await flush()
    expect(words.pane.innerHTML).toMatch(/aria-checked="true"[^>]*data-set="push-words"/)
  })
  it('activated settings keep the delivery procedure out of the normal product copy', async () => {
    const r = await rig({ production: true })
    expect(r.pane.innerHTML).not.toContain('Temporary delivery check')
    expect(r.pane.innerHTML).not.toContain('Production pings')
    expect(r.pane.innerHTML).toContain('Send a test notification to this phone')
  })
  it('manifest preserves one Home Screen app identity, secure relative start and existing touch icon, without a worker', () => {
    const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
    expect(manifest).toMatchObject({ id: '/control', start_url: '/control', display: 'standalone', icons: [{ src: '/control/apple-touch-icon.png' }] })
    expect(source).not.toContain('serviceWorker.register')
    expect(source).not.toContain('caches.')
    expect(readFileSync(new URL('./index.html', import.meta.url), 'utf8')).toContain('<link rel="manifest" href="/control/manifest.json">')
  })
})
