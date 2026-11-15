// 7.0.44 shipped server/scripts/session-catch-up-mutation-gate.mjs (Q1 19:37): every gate script needs its own "!" line
// in package.json "files", and a new gate's line was forgotten. This asks npm what ships (the only authority over both
// "files" and .npmignore, as package-contents.test.ts does) and fails on any gate or test tool in it, so a new gate cannot
// ship again without someone noticing. Lead 19:3x, for the build after 7.0.44.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..')

function packedFiles(): string[] {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  })
  return (JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>)[0].files.map(f => f.path)
}

/** Gate and test tools: never for an installed server. */
export const NOT_SHIPPED = [
  /^server\/scripts\/(.*-)?mutation-gate\.mjs$/,
  /^server\/scripts\/(check-gate-anchors|gate-anchor-check)\.mjs$/,
  /\.test\.(ts|mjs|js)$/,
]

describe('the npm tarball carries no gate or test tool', () => {
  const files = packedFiles()

  it('no mutation gate, gate anchor tool or test file is packed', () => {
    expect(files.filter(f => NOT_SHIPPED.some(re => re.test(f)))).toEqual([])
  })

  it('every gate script in the repo is left out, by name (a new one fails here until its "!" line is added)', () => {
    const gates = readdirSync(resolve(REPO_ROOT, 'server', 'scripts')).filter(n => n === 'mutation-gate.mjs' || n.endsWith('-mutation-gate.mjs'))
    expect(gates.length).toBeGreaterThan(40)
    for (const g of gates) expect(files, g).not.toContain('server/scripts/' + g)
  })

  it('the patterns are not vacuous: they match the real gate names', () => {
    expect(NOT_SHIPPED.some(re => re.test('server/scripts/session-catch-up-mutation-gate.mjs'))).toBe(true)
    // Q1 20:13: the generic runner has no dash before mutation-gate.
    expect(NOT_SHIPPED.some(re => re.test('server/scripts/mutation-gate.mjs'))).toBe(true)
    expect(NOT_SHIPPED.some(re => re.test('server/scripts/check-gate-anchors.mjs'))).toBe(true)
    expect(NOT_SHIPPED.some(re => re.test('server/lib/package-no-gates.test.ts'))).toBe(true)
    expect(NOT_SHIPPED.some(re => re.test('server/scripts/hooks-cli.ts'))).toBe(false)
  })
})
