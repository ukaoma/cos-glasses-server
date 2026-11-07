// The pet on Today (app.js "the session pet" block), run for real in a vm: its pose and caption follow the
// same counts as the Running card, the off switch hides it without asking the server, and a still pet renders.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.js'), 'utf8')
const START = APP.indexOf('  // ── the session pet (Today) ─')
const END = APP.indexOf('  // ── Today ──')
if (START < 0 || END < 0 || END < START) throw new Error('pet markers moved in app.js')
const SRC = APP.slice(START, END)

interface El { id?: string; classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean; toggle(c: string, on?: boolean): void }; innerHTML: string; style: Record<string, string>; attrs: Record<string, string>; setAttribute(k: string, v: string): void; getAttribute(k: string): string | null; querySelector(sel: string): El | null; textContent: string; addEventListener(): void; parentNode?: unknown; previousElementSibling?: unknown; firstElementChild?: unknown; insertBefore?: unknown }
function el(): El {
  const cls = new Set<string>(['hidden'])
  const kids: Record<string, El> = {}
  const e: El = {
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => (on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c) },
    get innerHTML() { return '' }, set innerHTML(_v: string) { for (const k of Object.keys(kids)) delete kids[k] },
    style: {}, attrs: {}, textContent: '',
    setAttribute(k, v) { this.attrs[k] = v }, getAttribute(k) { return this.attrs[k] ?? null },
    querySelector(sel) { return kids[sel] ?? (kids[sel] = sel === '.pet-sprite' || sel === '.pet-caption' || sel === '.pet-btn' || sel === '.pet-still' ? el() : null as unknown as El) },
    addEventListener() {},
  } as El
  return e
}

// The real splitSessionId (app.js), which the pet keys sessions and questions with.
const SPLIT = /  function splitSessionId\(provider, id\) \{[\s\S]*?\n  \}\n/.exec(APP)![0]

function harness(prefs: Record<string, unknown>, manifest: unknown, questions: unknown[] = []) {
  const box = el()
  const calls: string[] = []
  const store: Record<string, unknown> = { 'cos-web-pet': prefs }
  const deps = {
    $: (id: string) => (id === 'today-pet' ? box : null),
    api: (url: string) => { calls.push(url); return Promise.resolve(manifest) },
    esc: (s: string) => String(s),
    readStore: (k: string) => (store[k] as Record<string, unknown>) || {},
    writeStore: (k: string, v: unknown) => { store[k] = v },
    sxState: (s: { agent_state?: string; running_active?: boolean }) => (s.agent_state === 'waiting' ? 'waiting' : s.running_active || s.agent_state === 'running' ? 'running' : 'recent'),
    state: { pane: 'today', sessions: [] as unknown[] },
    document: { querySelector: () => null, hidden: false },
    window: { matchMedia: () => ({ matches: true, addEventListener() {} }), COSWeb: { sessionQuestions: { itemsFor: (sid: string) => (sid ? [] : questions) } } },
    Image: class { onload?: () => void; set src(_v: string) { setTimeout(() => this.onload?.(), 0) } },
    setTimeout, clearTimeout, Promise,
  }
  const kit = new Function('deps', 'with (deps) {\n' + SPLIT + SRC + '\nreturn { petPose: petPose, petCaption: petCaption, renderPet: renderPet };\n}')(deps)
  return { kit, box, calls, store }
}

describe('the pet on Today', () => {
  it('counts working the way the Running card does (running_active), so the caption never disagrees with it', () => {
    const { kit } = harness({}, null)
    // agent_state "running" without running_active is NOT on the Running card, so it is not working here either.
    const c = kit.petPose([{ running_active: true }, { agent_state: 'running', running: true }, { agent_state: 'waiting', running: true }])
    expect(c).toMatchObject({ working: 1, waiting: 1 })
    expect(c.pose).toBe('duel')
    expect(kit.petCaption(c)).toBe('1 running, 1 waiting on you')
    expect(kit.petPose([]).pose).toBe('idle')
    expect(kit.petPose([{ running: true }]).pose).toBe('patrol')
    expect(kit.petPose([{ agent_state: 'waiting' }]).pose).toBe('waiting')
    expect(kit.petPose([1, 2, 3, 4].map(() => ({ running_active: true }))).pose).toBe('swarm')
  })

  it('off: hides the pet and never asks the server', async () => {
    const { kit, box, calls } = harness({ pet: 'mac', show: false }, { available: true, kind: 'strips', poses: {} })
    kit.renderPet([{ running_active: true }])
    await new Promise((r) => setTimeout(r, 5))
    expect(calls).toEqual([])
    expect(box.classList.contains('hidden')).toBe(true)
  })

  it('asks for the chosen pet, and shows a still pet with its caption', async () => {
    const { kit, box, calls } = harness({ pet: 'gallery:halloween-bat', show: true }, { available: true, pet: 'gallery:halloween-bat', kind: 'still', poses: {}, still: '/api/web-pet/still?pet=gallery%3Ahalloween-bat&v=1' })
    kit.renderPet([{ running_active: true }])
    await new Promise((r) => setTimeout(r, 5))
    expect(calls).toEqual(['/api/web-pet?pet=gallery%3Ahalloween-bat'])
    expect(box.classList.contains('hidden')).toBe(false)
    expect(box.querySelector('.pet-caption')!.textContent).toBe('1 running')
  })

  it('a slow answer for a pet that was switched off in the meantime paints nothing', async () => {
    const { kit, box, store } = harness({ pet: 'mac', show: true }, { available: true, pet: 'mac', kind: 'still', poses: {}, still: '/s' })
    kit.renderPet([])
    store['cos-web-pet'] = { pet: 'mac', show: false } // switched off before the answer is handled
    await new Promise((r) => setTimeout(r, 5))
    expect(box.classList.contains('hidden')).toBe(true)
  })

  it('a stored choice that is not a valid pet falls back to the Mac pet', async () => {
    const { kit, calls } = harness({ pet: 'shipped:../../etc', show: true }, { available: false })
    kit.renderPet([])
    await new Promise((r) => setTimeout(r, 5))
    expect(calls).toEqual(['/api/web-pet?pet=mac'])
  })

  // 6.99.27 (Miles 11/07 09:29): a question waiting here shows the attention strip and leads the caption.
  it('a question waiting here: the attention strip and "1 question for you"; none: the count pose as before', async () => {
    const spec = (name: string) => ({ chunks: ['/strip/' + name + '.png'], frames: 1, frameWidth: 100, height: 160, interval: 0.1, perChunk: 1 })
    const manifest = { available: true, pet: 'mac', kind: 'strips', poses: { idle: spec('idle'), working: spec('working'), attention: spec('attention') } }
    const q = { id: 'pq_1', sessionId: 'abc', provider: 'claude', kind: 'question', questions: [{ question: 'Ship it?' }] }
    const held = harness({ pet: 'mac', show: true }, manifest, [q])
    held.kit.renderPet([{ running_active: true }])
    await new Promise((r) => setTimeout(r, 10))
    expect(held.box.querySelector('.pet-sprite')!.style.backgroundImage).toBe('url("/strip/attention.png")')
    expect(held.box.querySelector('.pet-caption')!.textContent).toBe('1 question for you, 1 running')
    const calm = harness({ pet: 'mac', show: true }, manifest)
    calm.kit.renderPet([{ running_active: true }])
    await new Promise((r) => setTimeout(r, 10))
    expect(calm.box.querySelector('.pet-sprite')!.style.backgroundImage).toBe('url("/strip/working.png")')
    expect(calm.box.querySelector('.pet-caption')!.textContent).toBe('1 running')
  })

  it('a pet without an attention strip falls back the way COS Control does: error, then waiting, then idle', async () => {
    const spec = (name: string) => ({ chunks: ['/strip/' + name + '.png'], frames: 1, frameWidth: 100, height: 160, interval: 0.1, perChunk: 1 })
    const q = { id: 'pq_1', sessionId: 'abc', provider: 'claude', kind: 'question', questions: [{ question: 'Ship it?' }] }
    const h = harness({ pet: 'mac', show: true }, { available: true, pet: 'mac', kind: 'strips', poses: { idle: spec('idle'), waiting: spec('waiting'), working: spec('working') } }, [q])
    h.kit.renderPet([{ running_active: true }])
    await new Promise((r) => setTimeout(r, 10))
    expect(h.box.querySelector('.pet-sprite')!.style.backgroundImage).toBe('url("/strip/waiting.png")')
  })

  it('a still pet says the question too', async () => {
    const q = { id: 'pq_1', sessionId: 'abc', provider: 'claude', kind: 'question', questions: [{ question: 'Ship it?' }] }
    const h = harness({ pet: 'gallery:halloween-bat', show: true }, { available: true, pet: 'gallery:halloween-bat', kind: 'still', poses: {}, still: '/s' }, [q, { ...q, id: 'pq_2', sessionId: 'def' }])
    h.kit.renderPet([])
    await new Promise((r) => setTimeout(r, 5))
    expect(h.box.querySelector('.pet-caption')!.textContent).toBe('2 questions for you')
  })
})
