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
