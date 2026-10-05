// 6.62.0 (plan 3.2): the Codex session's own posture, read backwards from its rollout.
//
// Fixtures live under a temp dir whose path has a SPACE and a DOT component, like
// `~/Documents/GitHub/Ukaoma Chief Of Staff` and `~/.codex`. Nothing here reads the live
// ~/.codex.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CONTINUE_NOTE_MAX,
  POSTURE_CHUNK_BYTES,
  POSTURE_SCAN_CAP_BYTES,
  __resetCodexPostureCacheForTests,
  codexCwdTrusted,
  codexReportedModel,
  parseTurnContextLine,
  planCodexContinue,
  postureReadStats,
  readCodexSessionPosture,
  trustedCodexProjects,
  type CodexPlanDeps,
} from './codex-session-posture'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'posture '))
  mkdirSync(join(root, '.codex', 'sessions'), { recursive: true })
  __resetCodexPostureCacheForTests()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function turnContext(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: '2026-10-05T14:00:00.000Z',
    type: 'turn_context',
    payload: {
      turn_id: '01a10c5f-6cf6-76b0-a563-d2e0bcd82ebc',
      cwd: '/Users/me/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff',
      approval_policy: 'never',
      sandbox_policy: { type: 'danger-full-access' },
      model: 'gpt-6.1-sol',
      effort: 'high',
      ...over,
    },
  })
}

function filler(bytes: number): string {
  // One huge tool-output row, the shape that pushes turn_context megabytes from the end.
  const body = 'x'.repeat(Math.max(0, bytes - 80))
  return JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', output: body } })
}

function rollout(name: string, lines: string[]): string {
  const path = join(root, '.codex', 'sessions', name)
  writeFileSync(path, lines.map(line => `${line}\n`).join(''))
  return path
}

const trustedConfig = [
  'model = "gpt-6.1-sol"',
  '',
  '[projects."/Users/me/Documents/GitHub/Ukaoma Chief Of Staff"]',
  'trust_level = "trusted"',
  '',
  '[projects."/Users/me/scratch"]',
  'trust_level = "untrusted"',
  '',
  "[projects.'/Users/me/literal path']",
  'trust_level = "trusted"',
].join('\n')

function deps(over: Partial<CodexPlanDeps> = {}): CodexPlanDeps {
  return {
    fallbackSandbox: () => 'read-only',
    configText: () => trustedConfig,
    isKnownModel: model => model === 'gpt-6.1-sol' || model === 'gpt-5.6-luna',
    modelLabel: model => (model === 'gpt-6.1-sol' ? 'GPT-6.1 Sol' : null),
    ...over,
  }
}

describe('readCodexSessionPosture', () => {
  it('finds the NEWEST turn_context, past megabytes of tool output and across chunk boundaries', async () => {
    const path = rollout('rollout a.jsonl', [
      turnContext({ model: 'gpt-5.6-luna', effort: 'low', sandbox_policy: { type: 'read-only' } }),
      filler(300_000),
      turnContext(),
      // 3.3 MB of output after the newest turn_context: well past any tail read.
      filler(POSTURE_CHUNK_BYTES + 700_000),
      filler(POSTURE_CHUNK_BYTES + 600_000),
      filler(1_000),
    ])
    const posture = await readCodexSessionPosture(path)
    expect(posture).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high', sandboxType: 'danger-full-access', networkAccess: true, approvalPolicy: 'never' })
  })

  it('caches by (path, size) and re-reads only the appended bytes', async () => {
    const path = rollout('rollout b.jsonl', [turnContext({ model: 'gpt-5.6-luna' }), filler(2 * POSTURE_CHUNK_BYTES)])
    expect((await readCodexSessionPosture(path))?.model).toBe('gpt-5.6-luna')
    const coldBytes = postureReadStats.bytes
    expect(await readCodexSessionPosture(path)).toMatchObject({ model: 'gpt-5.6-luna' })
    expect(postureReadStats.bytes).toBe(coldBytes)
    appendFileSync(path, `${turnContext({ model: 'gpt-6.1-sol', sandbox_policy: { type: 'workspace-write', network_access: false } })}\n`)
    const grown = await readCodexSessionPosture(path)
    expect(grown).toMatchObject({ model: 'gpt-6.1-sol', sandboxType: 'workspace-write', networkAccess: false })
    // The second read covered the new row plus the overlap, not the whole file again.
    expect(postureReadStats.bytes - coldBytes).toBeLessThan(200_000)
    // An append with no turn_context keeps the cached posture.
    appendFileSync(path, `${filler(10_000)}\n`)
    expect((await readCodexSessionPosture(path))?.model).toBe('gpt-6.1-sol')
  })

  it('sees a row that was mid-write at the last read once it lands', async () => {
    const path = rollout('rollout c.jsonl', [turnContext({ model: 'gpt-5.6-luna' })])
    const row = turnContext({ model: 'gpt-6.1-sol' })
    appendFileSync(path, row.slice(0, 100))
    expect((await readCodexSessionPosture(path))?.model).toBe('gpt-5.6-luna')
    appendFileSync(path, `${row.slice(100)}\n`)
    expect((await readCodexSessionPosture(path))?.model).toBe('gpt-6.1-sol')
  })

  it('fails closed: no turn_context within the cap, an unreadable path, and a garbage row are all null', async () => {
    expect(await readCodexSessionPosture(rollout('none.jsonl', [filler(5_000)]))).toBeNull()
    expect(await readCodexSessionPosture(join(root, 'missing.jsonl'))).toBeNull()
    expect(await readCodexSessionPosture('relative/path.jsonl')).toBeNull()
    expect(parseTurnContextLine('{"type":"turn_context","payload":')).toBeNull()
    expect(parseTurnContextLine(turnContext({ sandbox_policy: { type: 'external-sandbox' } }))?.sandboxType).toBeNull()
    expect(POSTURE_SCAN_CAP_BYTES).toBe(64 * 1024 * 1024)
  })

  it('refuses a model value that could not be an argv model id', () => {
    expect(parseTurnContextLine(turnContext({ model: '--yolo' }))?.model).toBeNull()
    expect(parseTurnContextLine(turnContext({ effort: 'high; rm' }))?.effort).toBeNull()
  })
})

describe('Codex trust, read-only from config.toml', () => {
  it('lists trusted projects in basic and literal strings, and nothing untrusted', () => {
    expect(trustedCodexProjects(trustedConfig)).toEqual([
      '/Users/me/Documents/GitHub/Ukaoma Chief Of Staff',
      '/Users/me/literal path',
    ])
  })

  it('covers the folder and what is under it, by whole path segments only', () => {
    expect(codexCwdTrusted('/Users/me/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff', trustedConfig)).toBe(true)
    expect(codexCwdTrusted('/Users/me/Documents/GitHub/Ukaoma Chief Of Staff', trustedConfig)).toBe(true)
    expect(codexCwdTrusted('/Users/me/Documents/GitHub/Ukaoma Chief Of Staff 2', trustedConfig)).toBe(false)
    expect(codexCwdTrusted('/Users/me/scratch', trustedConfig)).toBe(false)
    expect(codexCwdTrusted('/Users/me/Documents/GitHub/Ukaoma Chief Of Staff', null)).toBe(false)
  })
})

describe('planCodexContinue', () => {
  const cwd = '/Users/me/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff'
  const posture = parseTurnContextLine(turnContext())!

  it('passes danger-full-access only with the session posture AND a trusted cwd', () => {
    expect(planCodexContinue(posture, cwd, deps())).toMatchObject({
      sandbox: 'danger-full-access', model: 'gpt-6.1-sol', effort: 'high', source: 'session',
      note: "This Codex session's full access, gpt-6.1-sol high.",
    })
    const untrusted = planCodexContinue(posture, '/Users/me/scratch/repo', deps())
    expect(untrusted).toMatchObject({ sandbox: 'workspace-write', networkAccess: true, note: 'Workspace write: Codex has not trusted this folder.' })
    const noConfig = planCodexContinue(posture, cwd, deps({ configText: () => null }))
    expect(noConfig.sandbox).toBe('workspace-write')
    const throwing = planCodexContinue(posture, cwd, deps({ configText: () => { throw new Error('EACCES') } }))
    expect(throwing.sandbox).toBe('workspace-write')
  })

  it('fails closed to the 6.61 sandbox with an honest note when there is no posture', () => {
    expect(planCodexContinue(null, cwd, deps())).toEqual({
      provider: 'codex', sandbox: 'read-only', model: null, effort: null, networkAccess: null,
      source: 'fallback', note: 'Read-only: session settings unreadable.',
    })
    expect(planCodexContinue(null, cwd, deps({ fallbackSandbox: () => 'workspace-write' })).sandbox).toBe('workspace-write')
    const unknownSandbox = parseTurnContextLine(turnContext({ sandbox_policy: { type: 'external-sandbox' } }))
    expect(planCodexContinue(unknownSandbox, cwd, deps()).source).toBe('fallback')
  })

  it('omits -m for a model the app-server does not list, and says so', () => {
    const astra = parseTurnContextLine(turnContext({ model: 'gpt-6-astra' }))!
    const plan = planCodexContinue(astra, cwd, deps())
    expect(plan.model).toBeNull()
    expect(plan.effort).toBe('high')
    expect(plan.note).toContain('Codex default model')
  })

  it('keeps read-only and workspace-write as the session ran', () => {
    const ro = planCodexContinue(parseTurnContextLine(turnContext({ sandbox_policy: { type: 'read-only' } })), cwd, deps())
    expect(ro.sandbox).toBe('read-only')
    const ww = planCodexContinue(parseTurnContextLine(turnContext({ sandbox_policy: { type: 'workspace-write', network_access: false } })), cwd, deps())
    expect(ww).toMatchObject({ sandbox: 'workspace-write', networkAccess: false })
  })

  it('keeps every note within the 60-character lens budget, even for long model names', () => {
    const long = parseTurnContextLine(turnContext({ model: 'gpt-6.1-sol', effort: 'xhigh' }))!
    const labels = ['GPT-6.1 Sol', 'GPT-6.1 Sol Codex Max Preview Long Name', null]
    for (const label of labels) {
      for (const sandbox of ['danger-full-access', 'workspace-write', 'read-only']) {
        const p = { ...long, sandboxType: sandbox as any }
        for (const configText of [trustedConfig, null]) {
          const note = planCodexContinue(p, cwd, deps({ modelLabel: () => label, configText: () => configText })).note
          expect(note.length, note).toBeLessThan(CONTINUE_NOTE_MAX + 1)
        }
      }
    }
    expect(planCodexContinue(null, cwd, deps()).note.length).toBeLessThan(61)
  })

  it('formats reported_model as <model> <effort>', () => {
    expect(codexReportedModel(posture)).toBe('gpt-6.1-sol high')
    expect(codexReportedModel(null)).toBeNull()
  })
})
