import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fileMemoryOverview,
  fileTierState,
  fileTierStatus,
  hasFileMemory,
  hasFileThreads,
  readFileMemories,
  readFileMemoryById,
  readFileThreadById,
  readFileThreads,
  resolveContextFilesRoot,
} from './context-files.js'
import { MEMORY_ID_PATTERN, THREAD_ID_PATTERN } from './cos-context-browser.js'

const CONTEXT_ENV = [
  'COS_CONTEXT_DIR', 'COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR', 'COS_DATA_DIR',
] as const
const savedEnv = new Map<string, string | undefined>()

let root = ''

function note(rel: string, body: string): void {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-file-tier-'))
  // Every candidate env var is cleared, INCLUDING COS_DATA_DIR. Without this the
  // resolver's last-resort candidate is the real `~/.cos-glasses`, so whether
  // these tests pass would depend on whether the machine running them happens to
  // have a `memory/` folder there.
  for (const key of CONTEXT_ENV) { savedEnv.set(key, process.env[key]); delete process.env[key] }
  process.env.COS_DATA_DIR = join(root, 'no-data-home')
})
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value == null) delete process.env[key]; else process.env[key] = value
  }
  savedEnv.clear()
  if (root) rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// THE GUARANTEE. Miles: "I need this to be backwards compatible."
//
// This module is reachable ONLY from standaloneNoop — the branch callPython takes
// when the bridge is ABSENT. An install with a working bridge never enters this
// code, which is why compatibility is structural rather than promised. The test
// below pins that property so a future refactor cannot quietly merge the paths.
// ---------------------------------------------------------------------------
describe('the file tier cannot affect a bridge-backed install', () => {
  it('is not imported by the bridge path', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('./python-bridge.ts', import.meta.url).pathname, 'utf-8'))
    // If the file tier is ever called from callPythonDirect, this fails.
    const directFn = src.slice(src.indexOf('function callPythonDirect'))
    expect(directFn).not.toContain('context-files')
    expect(directFn).not.toContain('readFileMemories')
  })

  it('reports absent for a root with no memory or threads folder', () => {
    // A COS workspace that uses the vector tier has no memory/ folder; the file
    // tier must say "absent", never invent an empty store that looks configured.
    mkdirSync(join(root, 'operations', 'scripts'), { recursive: true })
    expect(hasFileMemory(root)).toBe(false)
    expect(hasFileThreads(root)).toBe(false)
    expect(fileTierState(root)).toBe('absent')
    expect(readFileMemories(root)).toEqual([])
  })
})

describe('memory from plain markdown', () => {
  it('reads a bare note with no front matter at all', () => {
    // The whole point: no front matter, no naming convention, no folder scheme.
    note('memory/whatever.md', 'Decided to hold Rain POS for v25.')
    const [m] = readFileMemories(root)
    expect(m.content).toBe('Decided to hold Rain POS for v25.')
    expect(m.summary).toBe('Decided to hold Rain POS for v25.')
    expect(m.type).toBe('note')
    expect(m.reference_available).toBe(true)
  })

  it('accepts any nesting', () => {
    note('memory/2026/08/a.md', 'nested deep')
    note('memory/loose.md', 'top level')
    expect(readFileMemories(root)).toHaveLength(2)
  })

  it('accepts `memories/` as well as `memory/`', () => {
    note('memories/x.md', 'plural folder')
    expect(hasFileMemory(root)).toBe(true)
    expect(readFileMemories(root)).toHaveLength(1)
  })

  it('takes type from front matter, else the folder name, else note', () => {
    note('memory/decisions/a.md', 'folder implies type')
    note('memory/b.md', '---\ntype: correction\n---\nfront matter wins')
    note('memory/c.md', 'neither')
    const byId = Object.fromEntries(readFileMemories(root).map(m => [m.content, m.type]))
    expect(byId['folder implies type']).toBe('decisions')
    expect(byId['front matter wins']).toBe('correction')
    expect(byId['neither']).toBe('note')
  })

  it('orders newest first using the filename date when front matter has none', () => {
    note('memory/2026-08-01-old.md', 'older')
    note('memory/2026-08-09-new.md', 'newer')
    expect(readFileMemories(root).map(m => m.content)).toEqual(['newer', 'older'])
  })

  it('prefers front-matter date over the filename', () => {
    note('memory/2026-01-01-misleading.md', '---\ndate: 2026-08-09\n---\nactually recent')
    note('memory/2026-08-05-x.md', 'genuinely older')
    expect(readFileMemories(root)[0].content).toBe('actually recent')
  })

  it('uses a heading as the summary when present', () => {
    note('memory/h.md', '# Rain POS hold\n\nDetail below the heading.')
    expect(readFileMemories(root)[0].summary).toBe('Rain POS hold')
  })

  it('ignores empty files and dotfiles', () => {
    note('memory/empty.md', '   \n\n')
    note('memory/.hidden.md', 'should not appear')
    note('memory/real.md', 'real')
    expect(readFileMemories(root).map(m => m.content)).toEqual(['real'])
  })

  it('ignores non-markdown files', () => {
    note('memory/data.json', '{"not":"a note"}')
    note('memory/ok.md', 'a note')
    expect(readFileMemories(root)).toHaveLength(1)
  })

  it('resolves one memory by id, and returns null for an unknown id', () => {
    note('memory/findme.md', 'target')
    const id = readFileMemories(root)[0].id
    expect(readFileMemoryById(root, id)?.content).toBe('target')
    expect(readFileMemoryById(root, 'file_nope.md')).toBeNull()
  })

  it('namespaces ids so they can never collide with vector-store ids', () => {
    // A `mem_` id addresses Qdrant; a `file_` id addresses a file. Two stores
    // sharing an id space would make a reference ambiguous.
    note('memory/x.md', 'body')
    expect(readFileMemories(root)[0].id.startsWith('file_')).toBe(true)
    expect(readFileMemories(root)[0].id.startsWith('mem_')).toBe(false)
  })

  it('honours an explicit front-matter id, for imported notes', () => {
    note('memory/x.md', '---\nid: mem_20260809_120000_000001\n---\nimported')
    expect(readFileMemories(root)[0].id).toBe('mem_20260809_120000_000001')
  })

  it('counts a per-type overview', () => {
    note('memory/decisions/a.md', 'one')
    note('memory/decisions/b.md', 'two')
    note('memory/notes/c.md', 'three')
    const o = fileMemoryOverview(root)
    expect(o.total).toBe(3)
    expect(o.by_type).toEqual({ decisions: 2, notes: 1 })
  })
})

describe('threads from plain markdown', () => {
  it('reads a bare thread file', () => {
    note('threads/jewel360-tofu.md', '# Jewel360 TOFU\n\nPipeline is down 32%.')
    const [t] = readFileThreads(root)
    expect(t.name).toBe('Jewel360 TOFU')
    expect(t.is_manual).toBe(true)
    expect(t.manual_updates[0].content).toContain('Pipeline is down 32%')
  })

  it('falls back to the filename when there is no heading', () => {
    note('threads/hiring-backfill.md', 'no heading here')
    expect(readFileThreads(root)[0].name).toBe('hiring-backfill')
  })

  it('reads topics, stakeholders and status from front matter', () => {
    note('threads/x.md', '---\nname: Sean backfill\ntopics: hiring, content\nstakeholders: Gina\nstatus: resolved\n---\nbody')
    const [t] = readFileThreads(root)
    expect(t.name).toBe('Sean backfill')
    expect(t.topics).toEqual(['hiring', 'content'])
    expect(t.stakeholders).toEqual(['Gina'])
    expect(t.is_resolved).toBe(true)
  })

  it('reports derived fields as honestly empty rather than invented', () => {
    // Nothing computed a velocity for a file thread. Zero and '' are the truth;
    // a fabricated 'accelerating' would be worse than a blank.
    note('threads/x.md', 'body')
    const [t] = readFileThreads(root)
    expect(t.velocity).toBe('')
    expect(t.meeting_count).toBe(0)
    expect(t.meetings).toEqual([])
    expect(t.is_stale).toBe(false)
  })

  it('resolves one thread by id', () => {
    note('threads/a.md', 'body')
    const id = readFileThreads(root)[0].id
    expect(readFileThreadById(root, id)?.id).toBe(id)
    expect(readFileThreadById(root, 'file_missing.md')).toBeNull()
  })
})

describe('tier state distinguishes healthy-empty from absent', () => {
  it('absent when no folder exists', () => {
    expect(fileTierState(root)).toBe('absent')
  })

  it('empty when the folder exists but holds nothing readable', () => {
    mkdirSync(join(root, 'memory'), { recursive: true })
    expect(fileTierState(root)).toBe('empty')
  })

  it('ready when at least one note is readable', () => {
    note('memory/a.md', 'something')
    expect(fileTierState(root)).toBe('ready')
  })

  it('absent for a null or nonexistent root', () => {
    expect(fileTierState(null)).toBe('absent')
    expect(fileTierState(join(root, 'nope'))).toBe('absent')
  })
})

describe('bounds', () => {
  it('caps the number of returned records', () => {
    for (let i = 0; i < 60; i++) note(`memory/n${String(i).padStart(3, '0')}.md`, `note ${i}`)
    expect(readFileMemories(root, 30)).toHaveLength(30)
  })

  it('truncates a very long body', () => {
    note('memory/big.md', 'x'.repeat(80_000))
    expect(readFileMemories(root)[0].content.length).toBeLessThanOrEqual(32_000)
  })
})

describe('ids survive the transport that carries them', () => {
  it('produces memory ids the API pattern accepts', () => {
    // The pattern is the gate on /api/memory/:id AND the filter inside
    // normalizeMemoryList. An id it rejects means a 400 on fetch and a silent
    // drop from the list — a 200 response containing nothing.
    note('memory/2026-08-09_decisions/rain-pos.hold.md', 'body')
    const [m] = readFileMemories(root)
    expect(MEMORY_ID_PATTERN.test(m.id), m.id).toBe(true)
  })

  it('produces thread ids the API pattern accepts', () => {
    note('threads/sean.backfill-2026.md', 'body')
    const [t] = readFileThreads(root)
    expect(THREAD_ID_PATTERN.test(t.id), t.id).toBe(true)
  })

  it('keeps a very deep path inside the length limit without colliding', () => {
    // cleanContextText truncates at 128 and the pattern allows 120 after the
    // prefix, so a long path must be shortened here. Truncation ALONE would map
    // two different notes to one id and resolve the wrong file.
    const deep = 'memory/' + Array.from({ length: 12 }, (_, i) => `level-${i}-with-a-long-name`).join('/')
    note(`${deep}/alpha.md`, 'alpha')
    note(`${deep}/beta.md`, 'beta')
    const ids = readFileMemories(root).map(m => m.id)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) {
      expect(id.length, id).toBeLessThanOrEqual(126)
      expect(MEMORY_ID_PATTERN.test(id), id).toBe(true)
    }
    // And each id still resolves to its OWN note.
    const resolved = ids.map(id => readFileMemoryById(root, id)?.content).sort()
    expect(resolved).toEqual(['alpha', 'beta'])
  })

  it('distinguishes two notes whose paths differ only in the part that gets cut', () => {
    // The case above passes even WITHOUT the hash, because the two filenames
    // differ inside the surviving tail — a mutation removing the hash survived
    // it, which means that branch was never actually exercised.
    //
    // Here the last 88 characters are IDENTICAL and only the head differs, so
    // plain truncation maps both notes to one id and readFileMemoryById hands
    // back whichever it walks into first.
    const tail = `${'d'.repeat(45)}/${'e'.repeat(45)}/note.md`
    note(`memory/alpha/${tail}`, 'from alpha')
    note(`memory/beta/${tail}`, 'from beta')
    const ids = readFileMemories(root).map(m => m.id)
    expect(ids[0].length).toBeGreaterThan(100)
    expect(new Set(ids).size, `collided: ${ids.join(' vs ')}`).toBe(2)
    expect(ids.map(id => readFileMemoryById(root, id)?.content).sort())
      .toEqual(['from alpha', 'from beta'])
  })
})

describe('the root resolver', () => {
  function withMemory(dir: string): string {
    mkdirSync(join(dir, 'memory'), { recursive: true })
    writeFileSync(join(dir, 'memory', 'a.md'), 'note')
    return dir
  }

  it('finds nothing when no candidate holds notes', () => {
    expect(resolveContextFilesRoot()).toBeNull()
  })

  it('uses COS_OPERATIONS_DIR when it holds a memory folder', () => {
    const ops = withMemory(join(root, 'ops'))
    process.env.COS_OPERATIONS_DIR = ops
    expect(resolveContextFilesRoot()).toBe(ops)
  })

  it('accepts the PARENT of a direct meetings library', () => {
    // COS_MEETINGS_ROOT points at `.../personal/meetings` while notes sit beside
    // it at `.../personal/memory`.
    const domain = withMemory(join(root, 'personal'))
    mkdirSync(join(domain, 'meetings', '2026-08'), { recursive: true })
    process.env.COS_MEETINGS_ROOT = join(domain, 'meetings')
    expect(resolveContextFilesRoot()).toBe(domain)
  })

  it('accepts the parent of COS_SCRIPTS_DIR', () => {
    const repo = withMemory(join(root, 'repo'))
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    process.env.COS_SCRIPTS_DIR = join(repo, 'scripts')
    expect(resolveContextFilesRoot()).toBe(repo)
  })

  it('falls back to the data home, so zero configuration works', () => {
    const home = withMemory(join(root, 'data-home'))
    process.env.COS_DATA_DIR = home
    expect(resolveContextFilesRoot()).toBe(home)
  })

  it('resolves ~/.cos-glasses/memory with NO environment set at all', () => {
    // The README says `mkdir ~/.cos-glasses/memory` is a complete setup. Every
    // other test here substitutes COS_DATA_DIR for the home directory, and that
    // substitute cannot exercise the `homedir()` branch the claim rests on — so
    // the documented path had no coverage. HOME is redirected instead, which is
    // what os.homedir() reads on POSIX.
    const savedHome = process.env.HOME
    try {
      delete process.env.COS_DATA_DIR
      process.env.HOME = join(root, 'fake-home')
      const dataHome = withMemory(join(root, 'fake-home', '.cos-glasses'))
      expect(resolveContextFilesRoot()).toBe(dataHome)
    } finally {
      if (savedHome == null) delete process.env.HOME; else process.env.HOME = savedHome
    }
  })

  it('treats an explicit COS_CONTEXT_DIR as exclusive, even when empty', () => {
    // Falling through from an empty explicit root to the data home would serve a
    // user notes from a folder they did not choose.
    withMemory(join(root, 'data-home'))
    process.env.COS_DATA_DIR = join(root, 'data-home')
    process.env.COS_CONTEXT_DIR = join(root, 'chosen-but-empty')
    mkdirSync(join(root, 'chosen-but-empty'), { recursive: true })
    expect(resolveContextFilesRoot()).toBeNull()
  })

  it('prefers an explicit COS_CONTEXT_DIR over every other candidate', () => {
    withMemory(join(root, 'ops'))
    process.env.COS_OPERATIONS_DIR = join(root, 'ops')
    const chosen = withMemory(join(root, 'chosen'))
    process.env.COS_CONTEXT_DIR = chosen
    expect(resolveContextFilesRoot()).toBe(chosen)
  })
})

describe('status counts stay cheap and honest', () => {
  it('counts memory files and splits threads by resolved status', () => {
    note('memory/a.md', 'one')
    note('memory/nested/b.md', 'two')
    note('threads/open.md', '---\nstatus: active\n---\nbody')
    note('threads/done.md', '---\nstatus: resolved\n---\nbody')
    const status = fileTierStatus(root)
    expect(status.memory).toEqual({ present: true, total: 2 })
    expect(status.threads).toEqual({ present: true, total: 2, active: 1, resolved: 1 })
  })

  it('does not count a zero-byte file', () => {
    note('memory/real.md', 'content')
    note('memory/blank.md', '')
    expect(fileTierStatus(root).memory.total).toBe(1)
  })

  it('reports absent stores as not present rather than erroring', () => {
    expect(fileTierStatus(root)).toEqual({
      memory: { present: false, total: 0 },
      threads: { present: false, total: 0, active: 0, resolved: 0 },
    })
    expect(fileTierStatus(null).memory.present).toBe(false)
  })
})
