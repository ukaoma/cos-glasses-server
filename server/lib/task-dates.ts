/**
 * When a Work task was created and when its line last changed (6.65.0, Control 0.5.259 "Newest created" and
 * "Recent activity" orders). Read-only: nothing is ever written into tasks.md (canary C6).
 *
 * No task carries a creation time (0 of 293 on 2026-10-06), so the date is inferred, in this order:
 *   1. createdOn from the source label: the first YYYY-MM-DD in it (241 of 293 live tasks carry one, usually the
 *      meeting date). `createdFrom: 'source'`.
 *   2. Else the day the task's text first appeared in the git history of its tasks.md
 *      (`git log --reverse -S<text> -- tasks.md`, author date). `createdFrom: 'git'`. Each lookup is one git process,
 *      so they are cached on disk by (file, text hash) and bounded per request: what does not finish inside the time
 *      budget keeps running and answers on a later call.
 *   3. Else null.
 * lineChangedAt is `git blame` of the line (author time), for committed lines only: an uncommitted line is null, never
 * "now". tasks.md is auto-committed by the COS sync, so this is a coarse floor. Blame runs once per (HEAD, file mtime).
 *
 * Git runs only for a tasks.md inside a git work tree that tracks it. A public install keeps its tasks under the data
 * folder, outside any repository, so its git-derived fields are null and no git process starts.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'

export interface TaskDateFields {
  /** 'YYYY-MM-DD' or null. */
  createdOn: string | null
  createdFrom: 'source' | 'git' | null
  /** ISO time of the commit that last changed the task's line, or null (uncommitted, or no git). */
  lineChangedAt: string | null
}
export const NO_TASK_DATES: Readonly<TaskDateFields> = Object.freeze({ createdOn: null, createdFrom: null, lineChangedAt: null })

export const TASK_DATE_LIMITS = {
  /** First-seen lookups a request may start; the rest wait for a later call. */
  budgetMs: 1_500,
  gitTimeoutMs: 8_000,
  concurrency: 2,
  cacheEntries: 5_000,
  blameFiles: 32,
  needleMin: 8,
  needleMax: 200,
  /** The leading characters of a task's text that must appear on its blamed line. */
  guardChars: 40,
} as const
export const TASK_DATES_CACHE_FILE = dataPath('task-created-dates.json')

/** What a bridge row offers (task-store.ts BridgeTaskRow). */
export interface DateSourceRow { id: string; domain: string; line_number: number; source: string | null; description: string }
export type DateGitRunner = (args: readonly string[], cwd: string, timeoutMs: number) => Promise<string>

/** Homebrew's git first: `/usr/bin/git` without the developer tools opens an install dialog. */
const GIT_BIN = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'].find(path => existsSync(path)) ?? '/usr/bin/git'
export const realDateGitRunner: DateGitRunner = (args, cwd, timeoutMs) => new Promise((resolve, reject) => {
  execFile(GIT_BIN, [...args], { cwd, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => error ? reject(error) : resolve(String(stdout)))
})

export function taskDateKey(domain: string, id: string): string { return `${domain}\0${id}` }

function isCalendarDay(day: string): boolean {
  const at = new Date(`${day}T00:00:00Z`)
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === day
}

/** The first real YYYY-MM-DD in a source label. Link targets are not label text (a Work details token is base64). */
export function sourceDate(source: string | null | undefined): string | null {
  if (!source) return null
  const label = source.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  for (const match of label.matchAll(/20\d\d-\d\d-\d\d/g)) if (isCalendarDay(match[0])) return match[0]
  return null
}

export interface BlameLine { content: string; at: string | null }
/** `git blame --line-porcelain` output to line number -> content and author time (null for an uncommitted line). */
export function parseBlamePorcelain(output: string): Map<number, BlameLine> {
  const lines = new Map<number, BlameLine>()
  let current: { sha: string; line: number; time: number | null } | null = null
  for (const raw of output.split('\n')) {
    if (raw.startsWith('\t')) {
      if (current) {
        const committed = !/^0+$/.test(current.sha) && current.time !== null && Number.isFinite(current.time)
        lines.set(current.line, { content: raw.slice(1), at: committed ? new Date(current.time! * 1000).toISOString() : null })
      }
      current = null
      continue
    }
    const head = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/.exec(raw)
    if (head) { current = { sha: head[1], line: Number(head[2]), time: null }; continue }
    if (current && raw.startsWith('author-time ')) current.time = Number(raw.slice('author-time '.length))
  }
  return lines
}

/** The line still holds the task (the file can change between the board read and the blame). */
export function lineHolds(content: string, description: string): boolean {
  const probe = description.trim().slice(0, TASK_DATE_LIMITS.guardChars)
  return probe.length > 0 && content.includes(probe)
}

/** The text to find in history: the task's own words (not its checkbox, source or markers, which change later). */
export function pickaxeNeedle(description: string, content?: string): string | null {
  const text = description.trim()
  if (text.length < TASK_DATE_LIMITS.needleMin || text.includes('\0')) return null
  const full = text.slice(0, TASK_DATE_LIMITS.needleMax)
  if (!content || content.includes(full)) return full
  const head = text.slice(0, TASK_DATE_LIMITS.guardChars)
  return content.includes(head) ? head : full
}

/** The nearest folder at or above `dir` holding `.git` (a folder, or a pointer file), or null. */
export function findGitWorkTree(dir: string): string | null {
  let at = dir
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(join(at, '.git'))) return at
    const up = dirname(at)
    if (up === at) return null
    at = up
  }
  return null
}

interface FileState { file: string; dir: string; head: string; lines: Map<number, BlameLine> }
/** `d`: the day, or null when history has no such text yet; then `h` is the HEAD it was looked up at. */
interface CreatedEntry { d: string | null; h?: string }
interface PickaxeJob { key: string; needle: string; state: FileState }

export interface TaskDateResolverOptions {
  git?: DateGitRunner
  cacheFile?: string
  budgetMs?: number
  now?: () => number
  findRepo?: (dir: string) => string | null
}

export class TaskDateResolver {
  private readonly git: DateGitRunner
  private readonly cacheFile: string
  private readonly budgetMs: number
  private readonly now: () => number
  private readonly findRepo: (dir: string) => string | null
  private blame = new Map<string, { key: string; lines: Promise<Map<number, BlameLine> | null> }>()
  private created: Map<string, CreatedEntry> | null = null
  private pending = new Map<string, Promise<void>>()
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: TaskDateResolverOptions = {}) {
    this.git = options.git ?? realDateGitRunner
    this.cacheFile = options.cacheFile ?? TASK_DATES_CACHE_FILE
    this.budgetMs = options.budgetMs ?? TASK_DATE_LIMITS.budgetMs
    this.now = options.now ?? Date.now
    this.findRepo = options.findRepo ?? findGitWorkTree
  }

  /** Date fields for every row, keyed by taskDateKey(domain, id). Never throws; an unknown is null. */
  async resolve(rows: readonly DateSourceRow[], root: string): Promise<Map<string, TaskDateFields>> {
    const started = this.now()
    const out = new Map<string, TaskDateFields>()
    const states = new Map<string, FileState | null>()
    await Promise.all([...new Set(rows.map(row => row.domain))].map(async domain => {
      states.set(domain, await this.fileState(join(root, domain, 'tasks.md')).catch(() => null))
    }))
    const jobs = new Map<string, PickaxeJob>()
    const waiting: Array<{ fields: TaskDateFields; key: string }> = []
    for (const row of rows) {
      const fields: TaskDateFields = { ...NO_TASK_DATES }
      out.set(taskDateKey(row.domain, row.id), fields)
      const fromSource = sourceDate(row.source)
      if (fromSource) { fields.createdOn = fromSource; fields.createdFrom = 'source' }
      const state = states.get(row.domain)
      if (!state) continue
      const line = state.lines.get(row.line_number)
      if (line && lineHolds(line.content, row.description)) fields.lineChangedAt = line.at
      if (fromSource) continue
      const needle = pickaxeNeedle(row.description, line?.content)
      if (!needle) continue
      const key = createHash('sha256').update(state.file + '\0' + needle).digest('hex').slice(0, 32)
      const known = this.lookup(key, state.head)
      if (known === undefined) { jobs.set(key, { key, needle, state }); waiting.push({ fields, key }) }
      else if (known) { fields.createdOn = known; fields.createdFrom = 'git' }
    }
    if (jobs.size) {
      await this.runWithin([...jobs.values()], started + this.budgetMs)
      for (const { fields, key } of waiting) {
        const day = this.created?.get(key)?.d
        if (day) { fields.createdOn = day; fields.createdFrom = 'git' }
      }
    }
    return out
  }

  /** Write the first-seen cache now (it is otherwise written shortly after a lookup lands). */
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (!this.dirty || !this.created) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true, mode: 0o700 })
      durableAtomicWriteFileSync(this.cacheFile, JSON.stringify({ version: 1, created: Object.fromEntries(this.created) }) + '\n', { mode: 0o600 })
    } catch (e) { console.warn('[task-dates] cache not saved:', e instanceof Error ? e.message : e) }
  }

  /** Lookups still running in the background (tests). */
  async settled(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending.values()]) }

  private async fileState(file: string): Promise<FileState | null> {
    const dir = dirname(file)
    if (!this.findRepo(dir)) return null
    let stat: ReturnType<typeof statSync>
    try { stat = statSync(file) } catch { return null }
    if (!stat.isFile()) return null
    const head = (await this.git(['rev-parse', '--verify', '-q', 'HEAD'], dir, TASK_DATE_LIMITS.gitTimeoutMs)).trim()
    if (!/^[0-9a-f]{40,64}$/.test(head)) return null
    const key = `${head}|${stat.mtimeMs}|${stat.size}`
    let entry = this.blame.get(file)
    if (!entry || entry.key !== key) {
      // An untracked file fails blame: then nothing about it comes from git.
      entry = { key, lines: this.git(['blame', '--line-porcelain', '--', basename(file)], dir, TASK_DATE_LIMITS.gitTimeoutMs)
        .then(parseBlamePorcelain, () => null) }
      this.blame.delete(file)
      this.blame.set(file, entry)
      while (this.blame.size > TASK_DATE_LIMITS.blameFiles) this.blame.delete(this.blame.keys().next().value!)
    }
    const lines = await entry.lines
    return lines ? { file, dir, head, lines } : null
  }

  /** The cached day, null when history had no such text at this HEAD, or undefined when it must be looked up. */
  private lookup(key: string, head: string): string | null | undefined {
    const entry = this.cache().get(key)
    if (!entry) return undefined
    if (entry.d) return entry.d
    return entry.h === head ? null : undefined
  }

  /** Start lookups until the deadline, then answer with what landed. Lookups already started keep running. */
  private async runWithin(jobs: PickaxeJob[], deadline: number): Promise<void> {
    let next = 0
    const worker = async () => {
      while (next < jobs.length && this.now() < deadline) await this.pickaxe(jobs[next++])
    }
    const all = Promise.all(Array.from({ length: Math.min(TASK_DATE_LIMITS.concurrency, jobs.length) }, worker))
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - this.now())) })
    try { await Promise.race([all, budget]) } finally { clearTimeout(timer) }
  }

  private pickaxe(job: PickaxeJob): Promise<void> {
    const running = this.pending.get(job.key)
    if (running) return running
    const work = this.git(['log', '--reverse', '--format=%ad', '--date=short', `-S${job.needle}`, '--', basename(job.state.file)],
      job.state.dir, TASK_DATE_LIMITS.gitTimeoutMs)
      .then(out => out.split('\n').map(line => line.trim()).find(line => /^\d{4}-\d{2}-\d{2}$/.test(line)) ?? null, () => null)
      .then(day => this.remember(job.key, day ? { d: day } : { d: null, h: job.state.head }))
      .finally(() => this.pending.delete(job.key))
    this.pending.set(job.key, work)
    return work
  }

  private cache(): Map<string, CreatedEntry> {
    if (this.created) return this.created
    this.created = new Map()
    try {
      const parsed = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as { version?: unknown; created?: Record<string, unknown> }
      if (parsed?.version === 1 && parsed.created && typeof parsed.created === 'object') {
        for (const [key, raw] of Object.entries(parsed.created)) {
          const entry = raw as Partial<CreatedEntry>
          if (typeof entry?.d === 'string' && isCalendarDay(entry.d)) this.created.set(key, { d: entry.d })
          else if (entry?.d === null && typeof entry.h === 'string') this.created.set(key, { d: null, h: entry.h })
        }
      }
    } catch { /* missing or unreadable: start empty */ }
    return this.created
  }

  private remember(key: string, entry: CreatedEntry): void {
    const cache = this.cache()
    cache.delete(key)
    cache.set(key, entry)
    while (cache.size > TASK_DATE_LIMITS.cacheEntries) cache.delete(cache.keys().next().value!)
    this.dirty = true
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 250)
      this.flushTimer.unref?.()
    }
  }
}

let shared: TaskDateResolver | null = null
export function sharedTaskDateResolver(): TaskDateResolver { return shared ??= new TaskDateResolver() }
