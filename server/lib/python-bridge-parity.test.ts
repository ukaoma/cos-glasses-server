import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// QA 2026-09-06: two pins the first 6.44.5 tests could not fail.

const LEARNING_EVENTS_PY = resolve(process.cwd(), '../Ukaoma Chief Of Staff/MU-Chief-Staff/operations/scripts/learning_events.py')
const pythonEventTypes: string[] | null = existsSync(LEARNING_EVENTS_PY)
  ? (() => {
      const source = readFileSync(LEARNING_EVENTS_PY, 'utf8')
      const match = source.match(/EVENT_TYPES\s*=\s*\(([^)]*)\)/)
      return match ? [...match[1].matchAll(/"([a-z_]+)"/g)].map(m => m[1]) : null
    })()
  : null

describe('event-type parity with the COS projector', () => {
  it.runIf(pythonEventTypes !== null)('the server set is a superset of the Python EVENT_TYPES tuple (a new Python type must not vanish from the list)', async () => {
    const { LEARNING_EVENT_TYPES } = await import('./cos-context-browser.js')
    expect(pythonEventTypes!.length).toBeGreaterThanOrEqual(10)
    for (const type of pythonEventTypes!) expect(LEARNING_EVENT_TYPES.has(type), type).toBe(true)
    // The one server-only type is deliberate forward compatibility; anything else is drift.
    const serverOnly = [...LEARNING_EVENT_TYPES].filter(type => !pythonEventTypes!.includes(type))
    expect(serverOnly).toEqual(['reopened'])
  })
  it.runIf(pythonEventTypes === null)('sibling projector not reachable here; parity pin skipped', () => { expect(true).toBe(true) })
})

describe('an older bridge that prints "unknown command" to stdout', () => {
  let scripts: string
  beforeEach(() => {
    scripts = mkdtempSync(join(tmpdir(), 'cos-bridge-'))
    mkdirSync(join(scripts, 'venv/bin'), { recursive: true })
    // cos_api_bridge.py prints its unknown-command answer to STDOUT and exits 1.
    writeFileSync(join(scripts, 'venv/bin/python3'), '#!/bin/sh\nprintf \'{"error": "unknown command: %s"}\\n\' "$2"\nexit 1\n')
    chmodSync(join(scripts, 'venv/bin/python3'), 0o755)
    writeFileSync(join(scripts, 'cos_api_bridge.py'), '# stand-in\n')
    vi.resetModules()
    process.env.COS_SCRIPTS_DIR = scripts
  })
  afterEach(() => {
    delete process.env.COS_SCRIPTS_DIR
    rmSync(scripts, { recursive: true, force: true })
    vi.resetModules()
  })

  it('resolves to cos_pipeline_not_configured instead of rejecting (stdout is probed, not only stderr)', async () => {
    const bridge = await import('./python-bridge.js')
    expect(bridge.pythonBridgeAvailable()).toBe(true)
    const answer = await bridge.callPython(['graph-status'], 5_000) as { error?: { code?: string; message?: string } }
    expect(answer.error?.code).toBe('cos_pipeline_not_configured')
    expect(answer.error?.message).toContain('unknown command: graph-status')
  })
})
