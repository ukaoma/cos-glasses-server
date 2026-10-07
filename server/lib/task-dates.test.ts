import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { TASK_DATE_LIMITS, TaskDateResolver, findGitWorkTree, isGitTimeout, lineHolds, parseBlamePorcelain, pickaxeNeedle, realDateGitRunner,
  resolveTaskDatesWithin, sourceDate, taskDateKey, type DateGitRunner, type DateSourceRow } from './task-dates.js'

// Real paths carry spaces and dots ("Ukaoma Chief Of Staff", "~/.cos-glasses"); so does every fixture here.
let base = '', repo = '', ops = ''
const C1 = '2026-03-01T10:00:00Z', C2 = '2026-04-15T12:00:00Z', C3 = '2026-05-20T08:30:00Z'
function git(args: string[], at = C1, cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } })
}
const QUILT_V1 = ['# Tasks', '## INBOX',
  '- [ ] Draft the landing page for spring — **Source:** Spring kickoff [2026-02-20]',
  '- [ ] Call the printer about the banners',
  '- [ ] Review the vendor contract renewal terms', ''].join('\n')
const QUILT_V2 = ['# Tasks', '## INBOX',
  '- [ ] Draft the landing page for spring — **Source:** Spring kickoff [2026-02-20]',
  '- [x] Call the printer about the banners',
  '- [ ] Review the vendor contract renewal terms',
  '- [ ] Plan the summer offsite agenda', ''].join('\n')
const UNCOMMITTED = '- [ ] Write the welcome email for new hires\n'

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cos dates.')))
  repo = join(base, 'MU Chief.Staff'); ops = join(repo, 'operations')
  mkdirSync(join(ops, 'quilt'), { recursive: true }); mkdirSync(join(ops, 'DNP study'), { recursive: true })
  git(['init', '-q'])
  writeFileSync(join(ops, 'quilt', 'tasks.md'), QUILT_V1)
  writeFileSync(join(ops, 'DNP study', 'tasks.md'), '## INBOX\n- [ ] Read chapter four of the methods text\n')
  git(['add', '-A']); git(['commit', '-q', '-m', 'one'], C1)
  writeFileSync(join(ops, 'quilt', 'tasks.md'), QUILT_V2)
  git(['add', '-A']); git(['commit', '-q', '-m', 'two'], C2)
  appendFileSync(join(ops, 'quilt', 'tasks.md'), UNCOMMITTED)
})
afterEach(() => { rmSync(base, { recursive: true, force: true }); vi.restoreAllMocks() })

const row = (domain: string, line_number: number, description: string, source: string | null = null): DateSourceRow =>
  ({ id: `${domain}:${line_number}`, domain, line_number, description, source })
const quiltRows = () => [
  row('quilt', 3, 'Draft the landing page for spring', 'Spring kickoff [2026-02-20]'),
  row('quilt', 4, 'Call the printer about the banners'),
  row('quilt', 5, 'Review the vendor contract renewal terms'),
  row('quilt', 6, 'Plan the summer offsite agenda'),
  row('quilt', 7, 'Write the welcome email for new hires'),
  row('DNP study', 2, 'Read chapter four of the methods text'),
]
/** The real git, with a ledger of what it was asked. */
function spyGit(inner: DateGitRunner = realDateGitRunner) {
  const calls: string[][] = []
  const run: DateGitRunner = (args, cwd, timeoutMs) => { calls.push([...args]); return inner(args, cwd, timeoutMs) }
  return { run, calls, count: (sub: string) => calls.filter(a => a[0] === sub).length }
}
const resolver = (options: ConstructorParameters<typeof TaskDateResolver>[0] = {}) =>
  new TaskDateResolver({ cacheFile: join(base, 'cache dir.d', 'created.json'), deadlineMs: 10_000, ...options })

describe('against a real git history', () => {
  it('createdOn from the source label first, else the first commit holding the text; lineChangedAt from blame; uncommitted is null', async () => {
    expect(base).toMatch(/ /); expect(base).toMatch(/\./)
    const r = resolver()
    const out = await r.resolve(quiltRows(), ops)
    const get = (domain: string, line: number) => out.get(taskDateKey(domain, `${domain}:${line}`))
    // The label says 2026-02-20 while git first saw the line on 2026-03-01: the label wins.
    expect(get('quilt', 3)).toEqual({ createdOn: '2026-02-20', createdFrom: 'source', lineChangedAt: '2026-03-01T10:00:00.000Z' })
    // Checked off in the second commit: created stays the first appearance, the line changed with the check.
    expect(get('quilt', 4)).toEqual({ createdOn: '2026-03-01', createdFrom: 'git', lineChangedAt: '2026-04-15T12:00:00.000Z' })
    expect(get('quilt', 5)).toEqual({ createdOn: '2026-03-01', createdFrom: 'git', lineChangedAt: '2026-03-01T10:00:00.000Z' })
    expect(get('quilt', 6)).toEqual({ createdOn: '2026-04-15', createdFrom: 'git', lineChangedAt: '2026-04-15T12:00:00.000Z' })
    // Not committed yet: no date at all, never "now".
    expect(get('quilt', 7)).toEqual({ createdOn: null, createdFrom: null, lineChangedAt: null })
    // A domain folder with a space in its name.
    expect(get('DNP study', 2)).toEqual({ createdOn: '2026-03-01', createdFrom: 'git', lineChangedAt: '2026-03-01T10:00:00.000Z' })
  })

  it('never writes into tasks.md', async () => {
    const before = readFileSync(join(ops, 'quilt', 'tasks.md'), 'utf8')
    await resolver().resolve(quiltRows(), ops)
    expect(readFileSync(join(ops, 'quilt', 'tasks.md'), 'utf8')).toBe(before)
    expect(git(['status', '--porcelain'])).toBe(' M operations/quilt/tasks.md\n')
  })

  it('keeps first-seen days on disk by (file, text): a new process asks git log nothing it already knows', async () => {
    const first = resolver()
    const before = await first.resolve(quiltRows(), ops)
    first.flush()
    const cacheFile = join(base, 'cache dir.d', 'created.json')
    expect(existsSync(cacheFile)).toBe(true)
    expect(readFileSync(cacheFile, 'utf8')).not.toContain('printer')  // keyed by a hash, not the task's words
    const spy = spyGit()
    const second = resolver({ git: spy.run })
    expect(await second.resolve(quiltRows(), ops)).toEqual(before)
    // Only the uncommitted line is unknown at this HEAD... and it is known to be absent at this HEAD, so nothing runs.
    expect(spy.count('log')).toBe(0)
  })

  it('looks an absent text up again only after HEAD moves', async () => {
    const spy = spyGit()
    const r = resolver({ git: spy.run })
    await r.resolve(quiltRows(), ops)
    const firstLogs = spy.count('log')
    expect(firstLogs).toBe(5)  // every row without a source date
    await r.resolve(quiltRows(), ops)
    expect(spy.count('log')).toBe(firstLogs)
    git(['add', '-A']); git(['commit', '-q', '-m', 'three'], C3)
    const after = await r.resolve(quiltRows(), ops)
    expect(spy.count('log')).toBe(firstLogs + 1)  // only the one that was absent
    expect(after.get(taskDateKey('quilt', 'quilt:7'))).toEqual({ createdOn: '2026-05-20', createdFrom: 'git', lineChangedAt: '2026-05-20T08:30:00.000Z' })
  })

  it('created is the FIRST commit holding the words, not a later one that added them again', async () => {
    appendFileSync(join(ops, 'quilt', 'tasks.md'), '- [ ] Review the vendor contract renewal terms\n')  // a duplicate, committed later
    git(['add', '-A']); git(['commit', '-q', '-m', 'three'], C3)
    const out = await resolver().resolve([row('quilt', 5, 'Review the vendor contract renewal terms')], ops)
    expect(out.get(taskDateKey('quilt', 'quilt:5'))).toMatchObject({ createdOn: '2026-03-01', createdFrom: 'git' })
  })

  it('blames each file once per (HEAD, mtime)', async () => {
    const spy = spyGit()
    const r = resolver({ git: spy.run })
    await r.resolve(quiltRows(), ops)
    await r.resolve(quiltRows(), ops)
    expect(spy.count('blame')).toBe(2)  // quilt and DNP study, once each
    appendFileSync(join(ops, 'quilt', 'tasks.md'), '- [ ] One more\n')
    await r.resolve(quiltRows(), ops)
    expect(spy.count('blame')).toBe(3)
  })

  it('gives no lineChangedAt when the line no longer holds the task (the file moved under the board read)', async () => {
    const out = await resolver().resolve([row('quilt', 4, 'Review the vendor contract renewal terms')], ops)
    expect(out.get(taskDateKey('quilt', 'quilt:4'))).toEqual({ createdOn: '2026-03-01', createdFrom: 'git', lineChangedAt: null })
  })

  it('a tasks.md git does not track gets nothing from git; its source date still counts', async () => {
    mkdirSync(join(ops, 'scratch'))
    writeFileSync(join(ops, 'scratch', 'tasks.md'), '## INBOX\n- [ ] Untracked idea for later — **Source:** note [2026-01-09]\n- [ ] Another untracked idea\n')
    const spy = spyGit()
    const out = await resolver({ git: spy.run }).resolve([row('scratch', 2, 'Untracked idea for later', 'note [2026-01-09]'), row('scratch', 3, 'Another untracked idea')], ops)
    expect(out.get(taskDateKey('scratch', 'scratch:2'))).toEqual({ createdOn: '2026-01-09', createdFrom: 'source', lineChangedAt: null })
    expect(out.get(taskDateKey('scratch', 'scratch:3'))).toEqual({ createdOn: null, createdFrom: null, lineChangedAt: null })
    expect(spy.count('log')).toBe(0)
  })
})

it('without git (a public install keeps tasks under its data folder): nulls, source dates only, and no git process', async () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'cos public.install ')))
  try {
    mkdirSync(join(plain, 'personal'))
    writeFileSync(join(plain, 'personal', 'tasks.md'), '## INBOX\n- [ ] Plain task\n- [ ] Dated — **Source:** call [2026-09-01]\n')
    const run = vi.fn(async () => { throw new Error('git must not run') })
    const out = await new TaskDateResolver({ git: run, cacheFile: join(plain, 'c.json'), findRepo: findGitWorkTree })
      .resolve([row('personal', 2, 'Plain task'), row('personal', 3, 'Dated', 'call [2026-09-01]')], plain)
    expect(out.get(taskDateKey('personal', 'personal:2'))).toEqual({ createdOn: null, createdFrom: null, lineChangedAt: null })
    expect(out.get(taskDateKey('personal', 'personal:3'))).toEqual({ createdOn: '2026-09-01', createdFrom: 'source', lineChangedAt: null })
    expect(run).not.toHaveBeenCalled()
    expect(findGitWorkTree(join(plain, 'personal'))).toBeNull()
  } finally { rmSync(plain, { recursive: true, force: true }) }
})

it('bounds first-seen lookups by a time budget per request and finishes the rest on later calls', async () => {
  const SHA = 'a'.repeat(40)
  const lines = Array.from({ length: 6 }, (_, i) => `${SHA} ${i + 1} ${i + 1} 1\nauthor x\nauthor-time 1772359200\nfilename tasks.md\n\t- [ ] Task number ${i + 1} words`).join('\n')
  let logs = 0, inFlight = 0, maxInFlight = 0
  const run: DateGitRunner = async args => {
    if (args[0] === 'rev-parse') return SHA + '\n'
    if (args[0] === 'blame') return lines
    logs++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(r => setTimeout(r, 400))
    inFlight--
    return '2026-03-01\n'
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cos budget.')))
  try {
    mkdirSync(join(dir, 'quilt')); writeFileSync(join(dir, 'quilt', 'tasks.md'), 'x')
    const r = new TaskDateResolver({ git: run, cacheFile: join(dir, 'c.json'), deadlineMs: 50, findRepo: () => dir })
    const rows = Array.from({ length: 6 }, (_, i) => row('quilt', i + 1, `Task number ${i + 1} words`))
    const started = Date.now()
    const first = await r.resolve(rows, dir)
    expect(Date.now() - started).toBeLessThan(300)  // answered at the budget (50 ms), not after the lookups (400 ms)
    expect([...first.values()].every(f => f.createdOn === null && f.lineChangedAt === '2026-03-01T10:00:00.000Z')).toBe(true)
    expect(logs).toBe(2); expect(maxInFlight).toBe(2)  // two at a time; no new lookup started after the budget
    await r.settled()
    const second = await r.resolve(rows, dir)
    expect([...second.values()].filter(f => f.createdFrom === 'git')).toHaveLength(2)  // the two that landed in the background
    await r.settled()
    const third = await r.resolve(rows, dir)
    expect([...third.values()].filter(f => f.createdFrom === 'git').length).toBeGreaterThanOrEqual(4)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

describe('pure helpers', () => {
  it('sourceDate: the first real YYYY-MM-DD of the label, ignoring link targets', () => {
    expect(sourceDate('Spring kickoff (G2) [2026-02-20] then 2026-03-01')).toBe('2026-02-20')
    expect(sourceDate('Meeting [Work details](cos-work://v1/2026-01-01aaa)')).toBeNull()
    expect(sourceDate('Bad 2026-02-30, good 2026-02-28')).toBe('2026-02-28')
    expect(sourceDate(null)).toBeNull(); expect(sourceDate('no date here')).toBeNull()
  })
  it('parseBlamePorcelain: committed lines carry the author time; an uncommitted line is null', () => {
    const zero = '0'.repeat(40), sha = 'b'.repeat(40)
    const out = parseBlamePorcelain([`${sha} 1 1 1`, 'author A', 'author-time 1772359200', 'author-tz +0000', 'summary s', 'filename tasks.md', '\t- [ ] One',
      `${zero} 2 2 1`, 'author Not Committed Yet', 'author-time 1790000000', 'filename tasks.md', '\t- [ ] Two', ''].join('\n'))
    expect(out.get(1)).toEqual({ content: '- [ ] One', at: '2026-03-01T10:00:00.000Z' })
    expect(out.get(2)).toEqual({ content: '- [ ] Two', at: null })
  })
  it('lineHolds and pickaxeNeedle use the task\'s own words', () => {
    expect(lineHolds('- [x] Call the printer about the banners', 'Call the printer about the banners')).toBe(true)
    expect(lineHolds('- [ ] Something else', 'Call the printer')).toBe(false)
    expect(pickaxeNeedle('short')).toBeNull()
    expect(pickaxeNeedle('Call the printer about the banners', '- [ ] Call the printer about the banners')).toBe('Call the printer about the banners')
    const long = 'Word '.repeat(60).trim()
    expect(pickaxeNeedle(long)).toHaveLength(200)
    // Not contiguous on the line (say a marker sits inside it): the leading words that are.
    expect(pickaxeNeedle('Ship the release notes to the partner list today', '- [ ] Ship the release notes to the partner list [stage: active] today'))
      .toBe('Ship the release notes to the partner li')
  })
})

describe('one deadline for all git work (QA S-W3)', () => {
  const SHA = 'c'.repeat(40)
  const porcelain = (n: number) => Array.from({ length: n }, (_, i) => `${SHA} ${i + 1} ${i + 1} 1\nauthor x\nauthor-time 1772359200\nfilename tasks.md\n\t- [ ] Task number ${i + 1} words`).join('\n')
  const timeout = () => Object.assign(new Error('Command failed: git'), { killed: true, signal: 'SIGTERM' })
  let dir = ''
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'cos deadline.'))); mkdirSync(join(dir, 'quilt')); writeFileSync(join(dir, 'quilt', 'tasks.md'), 'x') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const rows = (n: number, source: string | null = null) => Array.from({ length: n }, (_, i) => row('quilt', i + 1, `Task number ${i + 1} words`, source))

  it('the deadline is derived from the phone\'s 4 s timeout and leaves most of it for the board read', () => {
    expect(TASK_DATE_LIMITS.deadlineMs).toBe(1_500)
    expect(TASK_DATE_LIMITS.deadlineMs + TASK_DATE_LIMITS.answerSlackMs).toBeLessThanOrEqual(4_000 / 2)
  })

  for (const stuck of ['rev-parse', 'blame'] as const) {
    it(`a ${stuck} that hangs cannot hold the read past the deadline; source dates still come back, git fields are null`, async () => {
      let release!: () => void
      const gate = new Promise<void>(r => { release = r })
      const run: DateGitRunner = async args => {
        if (args[0] === stuck) await gate
        if (args[0] === 'rev-parse') return SHA + '\n'
        if (args[0] === 'blame') return porcelain(3)
        return '2026-03-01\n'
      }
      const r = new TaskDateResolver({ git: run, cacheFile: join(dir, 'c.json'), deadlineMs: 80, findRepo: () => dir })
      const started = Date.now()
      const out = await r.resolve(rows(3, 'Kickoff [2026-02-20]'), dir)
      expect(Date.now() - started).toBeLessThan(400)
      expect([...out.values()]).toEqual(Array(3).fill({ createdOn: '2026-02-20', createdFrom: 'source', lineChangedAt: null }))
      release(); await r.settled()
      const later = await r.resolve(rows(3, 'Kickoff [2026-02-20]'), dir)
      expect([...later.values()].every(f => f.lineChangedAt === '2026-03-01T10:00:00.000Z')).toBe(true)  // the work kept running and landed
    })
  }

  it('a resolver that never answers is cut off from outside: every row gets null dates at the deadline', async () => {
    const never = { resolve: () => new Promise<Map<string, any>>(() => {}) }
    const started = Date.now()
    const out = await resolveTaskDatesWithin(never, rows(2), dir, 60)
    expect(Date.now() - started).toBeLessThan(60 + TASK_DATE_LIMITS.answerSlackMs + 250)
    expect(out.size).toBe(0)
  })

  it('a git log that times out is never cached as "not in history": it rests, then is tried again', async () => {
    let clock = 1_000_000, logs = 0, fail = true
    const run: DateGitRunner = async args => {
      if (args[0] === 'rev-parse') return SHA + '\n'
      if (args[0] === 'blame') return porcelain(1)
      logs++
      if (fail) throw timeout()
      return '2026-03-01\n'
    }
    const cacheFile = join(dir, 'c.json')
    const r = new TaskDateResolver({ git: run, cacheFile, deadlineMs: 5_000, now: () => clock, findRepo: () => dir })
    expect((await r.resolve(rows(1), dir)).get(taskDateKey('quilt', 'quilt:1'))).toMatchObject({ createdOn: null })
    await r.settled(); r.flush()
    expect(existsSync(cacheFile) ? Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8')).created) : []).toEqual([])
    await r.resolve(rows(1), dir)
    expect(logs).toBe(1)  // resting: not retried yet
    fail = false
    clock += TASK_DATE_LIMITS.lookupBackoffMs
    expect((await r.resolve(rows(1), dir)).get(taskDateKey('quilt', 'quilt:1'))).toMatchObject({ createdOn: '2026-03-01', createdFrom: 'git' })
    expect(logs).toBe(2)
    expect(isGitTimeout(timeout())).toBe(true); expect(isGitTimeout(new Error('exit 128'))).toBe(false)
  })

  it('a blame that times out is not kept as "untracked": the file rests, then is blamed again', async () => {
    let clock = 1_000_000, blames = 0, fail = true
    const run: DateGitRunner = async args => {
      if (args[0] === 'rev-parse') return SHA + '\n'
      if (args[0] === 'blame') { blames++; if (fail) throw timeout(); return porcelain(1) }
      return '2026-03-01\n'
    }
    const r = new TaskDateResolver({ git: run, cacheFile: join(dir, 'c.json'), deadlineMs: 5_000, now: () => clock, findRepo: () => dir })
    expect((await r.resolve(rows(1), dir)).get(taskDateKey('quilt', 'quilt:1'))?.lineChangedAt).toBeNull()
    await r.resolve(rows(1), dir)
    expect(blames).toBe(1)
    fail = false
    clock += TASK_DATE_LIMITS.fileBackoffMs
    expect((await r.resolve(rows(1), dir)).get(taskDateKey('quilt', 'quilt:1'))?.lineChangedAt).toBe('2026-03-01T10:00:00.000Z')
    expect(blames).toBe(2)
  })

  it('keeps at most 5,000 first-seen days on disk, dropping the oldest', async () => {
    const cacheFile = join(dir, 'c.json')
    const seeded = Object.fromEntries(Array.from({ length: TASK_DATE_LIMITS.cacheEntries }, (_, i) => [`seed${i}`, { d: '2026-01-01' }]))
    writeFileSync(cacheFile, JSON.stringify({ version: 1, created: seeded }))
    const run: DateGitRunner = async args => args[0] === 'rev-parse' ? SHA + '\n' : args[0] === 'blame' ? porcelain(2) : '2026-03-01\n'
    const r = new TaskDateResolver({ git: run, cacheFile, deadlineMs: 5_000, findRepo: () => dir })
    await r.resolve(rows(2), dir); await r.settled(); r.flush()
    const keys = Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8')).created)
    expect(keys).toHaveLength(TASK_DATE_LIMITS.cacheEntries)
    expect(keys).not.toContain('seed0'); expect(keys).not.toContain('seed1'); expect(keys).toContain('seed2')
  })
})
