// 6.97.0: the rollout watermark against scratch rollouts only. Nothing here reads the real sessions tree.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetCodexRolloutPathsForTest, codexRolloutSize, installCodexRolloutProbe } from './codex-rollout-watermark.js'
import { CodexRunUsage, registerCodexRolloutProbe, _resetCodexThreadTotalsForTest } from './provider-usage.js'
import type { NativeHeadDeps } from './native-head.js'

const THREAD = '01a19304-1111-7222-8333-444455556666'
let root = ''
const deps = (): NativeHeadDeps => ({
  dirs: { claudeProjectsDir: join(root, 'none'), codexSessionsDir: root, cursorProjectsDir: join(root, 'none') },
  dirExists: path => existsSync(path) && statSync(path).isDirectory(),
  readDir: path => readdirSync(path),
  fileExists: path => existsSync(path) && statSync(path).isFile(),
  readTail: () => null,
})
function rollout(): string {
  const day = join(root, '2026', '10', '31')
  mkdirSync(day, { recursive: true })
  const path = join(day, `rollout-2026-10-31T12-00-00-${THREAD}.jsonl`)
  writeFileSync(path, '{"type":"session_meta"}\n')
  return path
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cos-rollout-')); _resetCodexRolloutPathsForTest(); _resetCodexThreadTotalsForTest() })
afterEach(() => { rmSync(root, { recursive: true, force: true }); registerCodexRolloutProbe(null) })

describe('codexRolloutSize', () => {
  it('is the bytes on disk, and moves when anything writes', () => {
    const path = rollout()
    const before = codexRolloutSize(THREAD, deps())
    expect(before).toBe(statSync(path).size)
    appendFileSync(path, '{"type":"event_msg"}\n')
    expect(codexRolloutSize(THREAD, deps())).toBeGreaterThan(before!)
  })
  it('is null, not 0, for a thread with no rollout or an invalid id', () => {
    expect(codexRolloutSize(THREAD, deps())).toBeNull()
    expect(codexRolloutSize('not a thread id', deps())).toBeNull()
  })
  it('a rollout that moved or was compressed reads as unknown, not as unchanged', () => {
    const path = rollout()
    expect(codexRolloutSize(THREAD, deps())).not.toBeNull()
    renameSync(path, `${path}.zst`)
    expect(codexRolloutSize(THREAD, deps())).toBeNull()
  })
  it('never reads what the rollout says', () => {
    const path = rollout()
    writeFileSync(path, 'SECRET WORDS')
    expect(JSON.stringify(codexRolloutSize(THREAD, deps()))).toBe(String('SECRET WORDS'.length))
    expect(readFileSync(path, 'utf8')).toBe('SECRET WORDS')
  })
})

describe('installCodexRolloutProbe', () => {
  it('makes the probe every new run uses the real one', () => {
    const before = new CodexRunUsage()
    expect((before as any).probe).toBeNull()
    installCodexRolloutProbe()
    expect(typeof (new CodexRunUsage() as any).probe).toBe('function')
  })
  it('is called at boot: without this the bridge can never prove a resumed turn', () => {
    const boot = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
    expect(boot.match(/^\s+installCodexRolloutProbe\(\)$/m)).not.toBeNull()
  })
})
