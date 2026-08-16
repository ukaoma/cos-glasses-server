import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Repo-wide hazard invariants, expressed as a test because they cannot be
// expressed as one.
//
// WHY THIS FILE EXISTS. On 2026-08-16 the Continue-Original-Agent-Thread feature
// had 2,424 passing tests and a 25-of-25 mutation score, and still shipped a bug
// that wedges the entire server — three separate times, in three separate files.
// Unit tests and mutation testing both measure coverage of guards that EXIST.
// Every serious defect found in review was an ABSENT guard, and no per-file test
// can catch the fourth file that forgets.
//
// These scan the source instead, which makes them the one kind of assertion this
// repo's rules normally forbid — a source-shape test. The exception is deliberate:
// the property is "no file anywhere does X", which is a statement about the
// codebase rather than about behavior. Each rule cost a real, reproduced defect.

const LIB = join(import.meta.dirname, '.')
const ROUTES = join(import.meta.dirname, '..', 'routes')

/**
 * Files this feature owns. Enforced STRICTLY — these must be clean.
 *
 * Scoped rather than repo-wide because the rest of the server predates the rule
 * and a 60-name allowlist would hide the signal it exists to give. The repo-wide
 * exposure is ratcheted separately below instead of being silently accepted.
 */
const FEATURE_FILES = new Set([
  'thread-occupancy.ts',
  'native-thread-id.ts',
  'occupancy-probes.ts',
  'attached-workspace.ts',
  'native-head.ts',
  'attached-provider-adapter.ts',
  'agent-session-binding-store.ts',
  'agent-session-binding-registry.ts',
  'agent-session-ownership-store.ts',
  'agent-session-bindings.ts',
])

/**
 * Pre-existing `openSync` sites without O_NONBLOCK, measured 2026-08-16.
 *
 * A COUNT, not a name allowlist: a count cannot be quietly extended one entry at a
 * time, and it fails the moment anyone adds an eleventh file. Lowering it as these
 * are fixed is the intended direction; raising it should require saying so out loud.
 *
 * NOT yet audited for reachability. The hazard needs a caller-influenced path, and
 * whether each of these has one is a separate piece of work — several are media and
 * upload paths, which is where caller-influenced names are most likely.
 */
const LEGACY_UNGUARDED_OPEN_FILES = 10

function sourceFiles(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  for (const dir of [LIB, ROUTES]) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
      const path = join(dir, name)
      if (!statSync(path).isFile()) continue
      out.push({ name, text: readFileSync(path, 'utf-8') })
    }
  }
  return out
}

/** Strip comments so a rule cannot be tripped by prose describing the rule. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
}

const unguardedOpenLines = (text: string): string[] =>
  code(text)
    .split('\n')
    .filter(line => line.includes('openSync(')
      && !line.includes('O_NONBLOCK') && !line.includes('nonBlock'))

describe('every synchronous open in this feature is non-blocking', () => {
  // COST: three reproductions of one bug. `openSync` on a FIFO with no writer
  // NEVER RETURNS, and it is a synchronous syscall on Node's single thread, so one
  // planted path stops health, meeting save and transcribe-stream too. Measured
  // >34s before a SIGKILL. An `isFile()` check cannot help — it runs after the open.
  it('no feature file omits O_NONBLOCK', () => {
    const offenders = sourceFiles()
      .filter(f => FEATURE_FILES.has(f.name))
      .flatMap(f => unguardedOpenLines(f.text).map(l => `${f.name}: ${l.trim().slice(0, 90)}`))
    expect(offenders).toEqual([])
  })

  it('no feature file omits O_NOFOLLOW', () => {
    // A symlinked `<id>.jsonl` could point at any file on disk and be parsed as a
    // session record, or for a cwd we would then spawn a provider in.
    const offenders = sourceFiles()
      .filter(f => FEATURE_FILES.has(f.name))
      .flatMap(f => code(f.text).split('\n')
        .filter(l => l.includes('openSync(') && !l.includes('O_NOFOLLOW') && !l.includes('noFollow'))
        .map(l => `${f.name}: ${l.trim().slice(0, 90)}`))
    expect(offenders).toEqual([])
  })

  it('the rest of the server does not grow MORE unguarded opens', () => {
    // Ratchet. The existing 10 are debt, not a licence: an eleventh fails here.
    const files = sourceFiles()
      .filter(f => !FEATURE_FILES.has(f.name) && unguardedOpenLines(f.text).length > 0)
      .map(f => f.name)
      .sort()
    expect(files.length).toBeLessThanOrEqual(LEGACY_UNGUARDED_OPEN_FILES)
  })
})

describe('existence checks distinguish absent from unreadable', () => {
  // COST: the durable epoch ledger silently reset to zero. `existsSync` collapses
  // ENOENT with EACCES, ELOOP, EIO and a dangling symlink, and the registry read
  // "cannot see it" as "was never written" — hydrating fresh with epochFloor 0
  // while the real floor on disk was 9, re-opening the replay window.
  //
  // `existsSync` is fine for a capability probe (does this binary exist). It is not
  // fine where the answer decides whether state is authoritative.
  const ALLOWED = new Set([
    // Binary discovery only. Absent and unreadable both mean "cannot use it", and
    // the caller falls back to PATH rather than making a trust decision.
    'occupancy-probes.ts',
    'attached-provider-adapter.ts',
  ])

  it('no feature file uses existsSync on a decision path', () => {
    const offenders = sourceFiles()
      .filter(f => FEATURE_FILES.has(f.name) && !ALLOWED.has(f.name))
      .filter(f => /\bexistsSync\s*\(/.test(code(f.text)))
      .map(f => f.name)
    expect(offenders).toEqual([])
  })
})

describe('the hazard rules are capable of failing', () => {
  // Without these, a broken matcher reports a clean repo forever — which is
  // precisely the "green because it never ran" failure the rules exist to catch.
  it('the openSync matcher flags a guardless open', () => {
    expect(unguardedOpenLines('const fd = openSync(p, fsConstants.O_RDONLY)')).toHaveLength(1)
  })

  it('the openSync matcher accepts a guarded one', () => {
    expect(unguardedOpenLines('fd = openSync(p, O_RDONLY | noFollow | nonBlock)')).toHaveLength(0)
  })

  it('the existsSync matcher flags a bare call', () => {
    expect(/\bexistsSync\s*\(/.test('if (!existsSync(path)) return fresh')).toBe(true)
  })

  it('comment stripping hides prose but not code', () => {
    const stripped = code('// openSync(x) in a comment\nconst y = openSync(z, 0)\n')
    expect(stripped).not.toContain('in a comment')
    expect(stripped).toContain('openSync(z, 0)')
  })

  it('actually finds the feature files it claims to guard', () => {
    // A path bug returning zero files would make every rule above vacuous.
    const found = sourceFiles().filter(f => FEATURE_FILES.has(f.name)).map(f => f.name)
    expect(found.sort()).toEqual([...FEATURE_FILES].sort())
    expect(sourceFiles().length).toBeGreaterThan(40)
  })
})
