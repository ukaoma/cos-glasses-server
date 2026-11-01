import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The qualification tooling (scripts/qualify-parallel.mjs, scripts/serial-set.mjs) is plain ESM with no
// types, so it is exercised through `node -e` and read back as JSON. Nothing here runs a test suite.
const ROOT = resolve(import.meta.dirname, '..', '..')
const QUALIFY = join(ROOT, 'scripts', 'qualify-parallel.mjs')
const SERIAL = join(ROOT, 'scripts', 'serial-set.mjs')

function inNode<T>(script: string): T {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: ROOT })
  return JSON.parse(out) as T
}

describe('qualify-parallel: known flakes', () => {
  const ids = (tests: Record<string, string>) => ({ mode: 'x', tests })

  it('moves a known flake aside, keeps it listed, and leaves real differences counted', () => {
    const result = inNode<{ onlyA: string[]; onlyB: string[]; differ: unknown[]; flaky: Array<{ id: string; kind: string; reason: string }> }>(`
      import { diffIds } from ${JSON.stringify(QUALIFY)}
      const a = { tests: { 'f.test.ts :: flaky one': 'passed', 'f.test.ts :: real one': 'passed', 'f.test.ts :: gone': 'passed' } }
      const b = { tests: { 'f.test.ts :: flaky one': 'failed', 'f.test.ts :: real one': 'failed', 'f.test.ts :: new': 'passed' } }
      console.log(JSON.stringify(diffIds(a, b, new Map([['f.test.ts :: flaky one', 'why'], ['f.test.ts :: new', 'also why']]))))
    `)
    expect(result.differ).toEqual([{ id: 'f.test.ts :: real one', a: 'passed', b: 'failed' }])
    expect(result.onlyA).toEqual(['f.test.ts :: gone'])
    expect(result.onlyB).toEqual([])
    expect(result.flaky.map(f => [f.id, f.kind, f.reason]).sort()).toEqual([
      ['f.test.ts :: flaky one', 'differ', 'why'],
      ['f.test.ts :: new', 'only-b', 'also why'],
    ])
  })

  it('counts every difference when the flake list is empty (nothing is hidden by default)', () => {
    const result = inNode<{ differ: unknown[]; flaky: unknown[] }>(`
      import { diffIds } from ${JSON.stringify(QUALIFY)}
      console.log(JSON.stringify(diffIds({ tests: { 'a :: t': 'passed' } }, { tests: { 'a :: t': 'failed' } })))
    `)
    expect(result.differ).toHaveLength(1)
    expect(result.flaky).toEqual([])
  })

  it.each([
    [{ vitestStatus: 0, clean: true, realFailures: 0, flakeFailures: 0 }, 0],
    [{ vitestStatus: 1, clean: true, realFailures: 0, flakeFailures: 1 }, 3],
    [{ vitestStatus: 1, clean: true, realFailures: 1, flakeFailures: 1 }, 1],
    // A crash: non-zero exit and not one failed test in the report. Never a flake.
    [{ vitestStatus: 1, clean: true, realFailures: 0, flakeFailures: 0 }, 1],
    // A test write or a missing report fails even when every test passed.
    [{ vitestStatus: 0, clean: false, realFailures: 0, flakeFailures: 0 }, 1],
    [{ vitestStatus: 1, clean: false, realFailures: 0, flakeFailures: 1 }, 1],
  ])('exit code for %j is %i', (input, code) => {
    const got = inNode<number>(`import { exitCodeFor } from ${JSON.stringify(QUALIFY)}; console.log(exitCodeFor(${JSON.stringify(input)}))`)
    expect(got).toBe(code)
  })

  it('the committed list is well formed: every entry names an existing test file and carries evidence', () => {
    const flakes = inNode<Array<[string, string]>>(`import { readKnownFlakes } from ${JSON.stringify(QUALIFY)}; console.log(JSON.stringify([...readKnownFlakes()]))`)
    expect(flakes.length).toBeGreaterThan(0)
    for (const [id, reason] of flakes) {
      const [file, title] = id.split(' :: ')
      expect(existsSync(join(ROOT, file!)), `${file} must exist`).toBe(true)
      expect(title, id).toBeTruthy()
      expect(reason.length, `${id} needs a reason and evidence`).toBeGreaterThan(40)
    }
  })

  it('npm test never reads the flake list', () => {
    // The list is for qualification only. Nothing under server/ or the test config may mention it.
    const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
    expect(config).not.toContain('known-flakes')
    expect(readFileSync(join(ROOT, 'package.json'), 'utf8')).not.toContain('known-flakes')
  })
})

describe('serial-set: reviewed clearances expire when the file changes', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })

  it('records a hash that moves with the file, and refuses a file that is not a test', () => {
    dir = mkdtempSync(join(tmpdir(), 'serial-set-'))
    mkdirSync(join(dir, 'server', 'lib'), { recursive: true })
    mkdirSync(join(dir, 'shared'), { recursive: true })
    writeFileSync(join(dir, 'server', 'lib', 'a.test.ts'), "it('x', () => {})\n")
    const reviewedPath = join(dir, 'reviewed.txt')
    const result = inNode<{ before: Array<{ file: string; hash: string; reason: string }>; after: Array<{ hash: string }>; threw: boolean }>(`
      import { recordReview, readReviewed } from ${JSON.stringify(SERIAL)}
      import { writeFileSync } from 'node:fs'
      recordReview('server/lib/a.test.ts', 'reads nothing shared', ${JSON.stringify(dir)}, ${JSON.stringify(reviewedPath)})
      const before = readReviewed(${JSON.stringify(reviewedPath)})
      writeFileSync(${JSON.stringify(join(dir, 'server', 'lib', 'a.test.ts'))}, "it('x', () => { /* now spawns */ })\\n")
      recordReview('server/lib/a.test.ts', 'read again', ${JSON.stringify(dir)}, ${JSON.stringify(reviewedPath)})
      const after = readReviewed(${JSON.stringify(reviewedPath)})
      let threw = false
      try { recordReview('server/lib/missing.test.ts', 'x', ${JSON.stringify(dir)}, ${JSON.stringify(reviewedPath)}) } catch { threw = true }
      console.log(JSON.stringify({ before, after, threw }))
    `)
    expect(result.before).toHaveLength(1)
    expect(result.before[0]).toMatchObject({ file: 'server/lib/a.test.ts', reason: 'reads nothing shared' })
    expect(result.before[0]!.hash).toMatch(/^[0-9a-f]{12}$/)
    // Refreshing replaces the entry (one line per file) and the hash follows the new content.
    expect(result.after).toHaveLength(1)
    expect(result.after[0]!.hash).not.toBe(result.before[0]!.hash)
    expect(result.threw).toBe(true)
  })

  it('every committed clearance has a reason and no clearance is also serial', () => {
    const reviewed = inNode<Array<{ file: string; reason: string }>>(`import { readReviewed } from ${JSON.stringify(SERIAL)}; console.log(JSON.stringify(readReviewed()))`)
    const serial = new Set(readFileSync(join(ROOT, 'test-support', 'serial-set.txt'), 'utf8').split('\n').map(l => l.replace(/#.*$/, '').trim()).filter(Boolean))
    expect(reviewed.length).toBeGreaterThan(0)
    for (const r of reviewed) {
      expect(r.reason.length, r.file).toBeGreaterThan(30)
      expect(serial.has(r.file), `${r.file} is cleared and serial`).toBe(false)
    }
  })
})
