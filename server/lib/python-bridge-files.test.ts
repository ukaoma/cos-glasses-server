import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// EXECUTION coverage for the seam itself.
//
// The route tests mock `python-bridge.js` wholesale, so they prove the ROUTES
// call the gate — not that the gate or the fallback do anything. Mutating
// `contextSourceAvailable` left those tests green, which by my own rule means the
// branch was unreached. This file reaches it: no COS_SCRIPTS_DIR, so the module
// evaluates with `pythonAvailable` false and every call takes the file path.
//
// COS_SCRIPTS_DIR is deleted at MODULE scope, before the dynamic import below,
// because `pythonAvailable` is captured once at import time.
delete process.env.COS_SCRIPTS_DIR

const CONTEXT_ENV = ['COS_CONTEXT_DIR', 'COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_DATA_DIR'] as const
const savedEnv = new Map<string, string | undefined>()
let root = ''

async function bridge() {
  return import('./python-bridge.js')
}

function note(rel: string, body: string): void {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-bridge-files-'))
  for (const key of CONTEXT_ENV) { savedEnv.set(key, process.env[key]); delete process.env[key] }
  // Exclusive, so the real `~/.cos-glasses` can never answer for a test.
  process.env.COS_CONTEXT_DIR = root
})

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value == null) delete process.env[key]; else process.env[key] = value
  }
  savedEnv.clear()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('contextSourceAvailable', () => {
  it('is null when there is no bridge and no notes', async () => {
    const { contextSourceAvailable } = await bridge()
    expect(contextSourceAvailable()).toBeNull()
  })

  it('is files once a note exists', async () => {
    note('memory/a.md', 'a note')
    const { contextSourceAvailable } = await bridge()
    expect(contextSourceAvailable()).toBe('files')
  })

  it('is files for a configured-but-empty store, which is a healthy state', async () => {
    // The store exists and the user is about to write into it. Reporting null
    // here would send them back to the wizard for a setup they already did.
    mkdirSync(join(root, 'memory'), { recursive: true })
    const { contextSourceAvailable } = await bridge()
    expect(contextSourceAvailable()).toBe('files')
  })

  it('re-reads the environment, so a Control settings change takes effect', async () => {
    const { contextSourceAvailable } = await bridge()
    expect(contextSourceAvailable()).toBeNull()
    note('memory/a.md', 'a note')
    expect(contextSourceAvailable()).toBe('files')
  })
})

describe('callPython serves files when no bridge exists', () => {
  it('returns memories, newest first', async () => {
    note('memory/2026-08-01-old.md', 'older')
    note('memory/2026-08-09-new.md', 'newer')
    const { callPython } = await bridge()
    const rows = await callPython(['memory', '--days', '30', '--limit', '10']) as Array<{ content: string }>
    expect(rows.map(r => r.content)).toEqual(['newer', 'older'])
  })

  it('honours --limit from the argv the routes build', async () => {
    for (let i = 0; i < 5; i++) note(`memory/n${i}.md`, `note ${i}`)
    const { callPython } = await bridge()
    expect((await callPython(['memory', '--days', '30', '--limit', '2']) as unknown[])).toHaveLength(2)
  })

  it('resolves one memory by id and reports an unknown id as not found', async () => {
    note('memory/target.md', 'the target')
    const { callPython } = await bridge()
    const [first] = await callPython(['memory']) as Array<{ id: string }>
    expect(await callPython(['memory-detail', first.id]))
      .toEqual(expect.objectContaining({ content: 'the target' }))
    expect(await callPython(['memory-detail', 'file_missing.md']))
      .toEqual({ error: 'cos_pipeline_not_configured' })
  })

  it('returns threads with an accurate resolved split', async () => {
    note('threads/open.md', '# Open thread\n\nbody')
    note('threads/done.md', '---\nstatus: resolved\n---\nbody')
    const { callPython } = await bridge()
    const data = await callPython(['threads', '--limit', '30']) as {
      threads: unknown[]; active_count: number; resolved_count: number
    }
    expect(data.threads).toHaveLength(2)
    expect(data.active_count).toBe(1)
    expect(data.resolved_count).toBe(1)
  })

  it('reports context-status as AVAILABLE with the files source', async () => {
    // The 404/Unavailable a file-backed user saw came from here: an absent bridge
    // reported `available: false`, and the companion renders that as "Memory
    // unavailable" no matter how many notes are on disk.
    note('memory/a.md', 'one')
    note('memory/b.md', 'two')
    note('threads/t.md', 'thread')
    const { callPython } = await bridge()
    const status = await callPython(['context-status']) as {
      available: boolean; protocol: number; source: string
      memory: { available: boolean; total: number }
      threads: { available: boolean; total: number; stale: number }
    }
    expect(status.available).toBe(true)
    // Strictly 1, pre-coercion — normalizeContextBrowserStatus rejects anything
    // else as an outdated bridge and blanks the whole payload.
    expect(status.protocol).toBe(1)
    expect(status.source).toBe('files')
    expect(status.memory).toEqual(expect.objectContaining({ available: true, total: 2 }))
    expect(status.threads).toEqual(expect.objectContaining({ available: true, total: 1, stale: 0 }))
  })

  it('reports memory present and threads absent independently', async () => {
    note('memory/a.md', 'one')
    const { callPython } = await bridge()
    const status = await callPython(['context-status']) as {
      memory: { available: boolean }; threads: { available: boolean; state: string }
    }
    expect(status.memory.available).toBe(true)
    expect(status.threads.available).toBe(false)
    expect(status.threads.state).toBe('absent')
  })

  it('keeps the old empty shapes when there are no notes at all', async () => {
    const { callPython } = await bridge()
    expect(await callPython(['memory'])).toEqual([])
    expect(await callPython(['threads'])).toEqual({
      threads: [], active_count: 0, stale_count: 0, resolved_count: 0,
    })
    expect(await callPython(['context-status']))
      .toEqual(expect.objectContaining({ available: false, protocol: 1 }))
    expect(await callPython(['memory-overview']))
      .toEqual(expect.objectContaining({ available: false, total: 0 }))
    // Unrelated commands are untouched by the file tier.
    expect(await callPython(['calendar'])).toEqual({ events: [] })
    expect(await callPython(['badges'])).toEqual({})
    expect(await callPython(['task-capture'])).toEqual({ error: { code: 'cos_pipeline_not_configured' } })
    expect(await callPython(['task-rows'])).toEqual({ error: { code: 'cos_pipeline_not_configured' } })
  })

  it('returns a per-type overview', async () => {
    note('memory/decisions/a.md', 'one')
    note('memory/notes/b.md', 'two')
    const { callPython } = await bridge()
    expect(await callPython(['memory-overview'])).toEqual(expect.objectContaining({
      available: true, total: 2, by_type: { decisions: 1, notes: 1 }, source: 'files',
    }))
  })
})

// Learning / knowledge commands (COS Control Memories, Phase 0.3).
//
// The file tier ends in `default: return {}`, and an empty object reads as
// SUCCESS to a route. So every learning command must carry an explicit case
// that says the pipeline is not configured, in the STRING form the memory
// routes read. Two pins: (1) EXECUTION — each listed name answers with the
// string-form error and an unlisted name still falls to `{}`; (2) PARITY —
// when the Python bridge is reachable on this machine, its `_LEARNING_COMMANDS`
// frozenset literal equals LEARNING_COMMANDS, so the two lists cannot drift
// silently in either direction.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function pythonBridgeSource(): string | null {
  const candidates = [
    process.env.COS_SCRIPTS_DIR ? resolve(process.env.COS_SCRIPTS_DIR, 'cos_api_bridge.py') : null,
    // sibling checkout on Miles's Macs; vitest runs from the repo root
    resolve(process.cwd(), '../Ukaoma Chief Of Staff/MU-Chief-Staff/operations/scripts/cos_api_bridge.py'),
  ].filter((p): p is string => !!p)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
  }
  return null
}

describe('learning commands in the file tier', () => {
  it('every LEARNING_COMMANDS name answers with the string-form not-configured error', async () => {
    const { callPython, LEARNING_COMMANDS } = await bridge()
    expect(LEARNING_COMMANDS.length).toBeGreaterThanOrEqual(9)
    for (const name of LEARNING_COMMANDS) {
      expect(await callPython([name]), name).toEqual({ error: 'cos_pipeline_not_configured' })
    }
  })

  it('an unlisted command still falls to the empty-object default, which is why the pin exists', async () => {
    const { callPython } = await bridge()
    expect(await callPython(['graph-nope'])).toEqual({})
  })

  it('never uses the object-form error for a learning command', async () => {
    const { callPython, LEARNING_COMMANDS } = await bridge()
    for (const name of LEARNING_COMMANDS) {
      const result = await callPython([name]) as { error: unknown }
      expect(typeof result.error, name).toBe('string')
    }
  })

  const source = pythonBridgeSource()
  it.runIf(source !== null)('matches the Python bridge _LEARNING_COMMANDS frozenset literal (parity pin)', async () => {
    const { LEARNING_COMMANDS } = await bridge()
    const match = /_LEARNING_COMMANDS\s*=\s*frozenset\(\{([^}]*)\}\)/.exec(source!)
    expect(match, 'frozenset literal not found in cos_api_bridge.py').not.toBeNull()
    const names = new Set(Array.from(match![1].matchAll(/'([a-z][a-z0-9-]*)'/g), m => m[1]))
    expect(names).toEqual(new Set(LEARNING_COMMANDS))
  })
  it.runIf(source === null)('parity pin skipped: cos_api_bridge.py not reachable on this machine (set COS_SCRIPTS_DIR)', () => {
    // Not a pass: the parity pin could not run here. Set COS_SCRIPTS_DIR to run it.
    expect(source).toBeNull()
  })
})
