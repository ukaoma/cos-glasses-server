// 6.62.0 (plan 3.4, canaries C9/K1): every Cursor `agent` spawn runs on a config dir of its
// own, and cleanup never follows a link into the person's real ~/.cursor.
//
// Fixtures: a fake "~/.cursor" and a fake "~/.cos-glasses" under a temp root whose path has
// a space and dot components. Never the live ~/.cursor; no `agent` binary is ever run. The
// one real child is `node`, standing in for the CLI's config rewrite.

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CURSOR_SPAWN_LINKS,
  cursorSpawnEnv,
  releaseCursorSpawnOnExit,
  removeCursorSpawnDir,
  sweepStaleCursorSpawnDirs,
} from './cursor-spawn-env'

let root = ''
let source = ''
let spawnRoot = ''
const CONFIG = JSON.stringify({ version: 1, model: { modelId: 'composer-2.5' }, selectedModel: 'composer-2.5', authInfo: { email: 'x' } })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cursor spawn '))
  source = join(root, 'home dir', '.cursor')
  spawnRoot = join(root, 'home dir', '.cos-glasses', 'cursor-cli')
  mkdirSync(join(source, 'chats', 'hash'), { recursive: true })
  writeFileSync(join(source, 'chats', 'hash', 'chat.txt'), 'the person’s chat')
  mkdirSync(join(source, 'plugins'), { recursive: true })
  mkdirSync(join(source, 'skills-cursor'), { recursive: true })
  mkdirSync(join(source, 'agents'), { recursive: true })
  mkdirSync(join(source, 'plans'), { recursive: true })
  writeFileSync(join(source, 'hooks.json'), '{"hooks":{}}')
  writeFileSync(join(source, 'mcp.json'), '{"mcpServers":{"x":{}}}')
  writeFileSync(join(source, 'cli-config.json'), CONFIG)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('cursorSpawnEnv', () => {
  it('makes a 0700 dir with a COPY of the config and links to chats, hooks, mcp, plugins and skills', () => {
    const base = { PATH: '/usr/bin', CURSOR_CONFIG_DIR: source }
    const iso = cursorSpawnEnv({ baseEnv: base, sourceDir: source, root: spawnRoot })
    expect(iso.isolated).toBe(true)
    const dir = iso.dir!
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(dir, 'cli-config.json')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(dir, 'cli-config.json'), 'utf8')).toBe(CONFIG)
    for (const name of CURSOR_SPAWN_LINKS) {
      expect(lstatSync(join(dir, name)).isSymbolicLink(), name).toBe(true)
      expect(readlinkSync(join(dir, name))).toBe(join(source, name))
    }
    // Child env only: the caller's object and the server's env are untouched.
    expect(iso.env.CURSOR_CONFIG_DIR).toBe(dir)
    expect(base.CURSOR_CONFIG_DIR).toBe(source)
    expect(process.env.CURSOR_CONFIG_DIR).not.toBe(dir)
    iso.release()
  })

  it('release removes the dir and NEVER the person’s chats behind the link; it is idempotent', () => {
    const iso = cursorSpawnEnv({ baseEnv: {}, sourceDir: source, root: spawnRoot })
    writeFileSync(join(iso.dir!, 'cli-config.json'), '{"rewritten":true}')
    iso.release()
    iso.release()
    expect(existsSync(iso.dir!)).toBe(false)
    expect(readFileSync(join(source, 'chats', 'hash', 'chat.txt'), 'utf8')).toBe('the person’s chat')
    expect(readFileSync(join(source, 'cli-config.json'), 'utf8')).toBe(CONFIG)
    expect(existsSync(join(source, 'plugins'))).toBe(true)
  })

  it('keeps the real config untouched when the child rewrites its model (C9), proven with a real child', () => {
    const iso = cursorSpawnEnv({ baseEnv: { ...process.env }, sourceDir: source, root: spawnRoot })
    const rewrite = `const f=require('path').join(process.env.CURSOR_CONFIG_DIR,'cli-config.json');require('fs').writeFileSync(f+'.tmp',JSON.stringify({selectedModel:'grok-4.7-low-fast'}));require('fs').renameSync(f+'.tmp',f)`
    const run = spawnSync(process.execPath, ['-e', rewrite], { env: iso.env })
    expect(run.status).toBe(0)
    expect(JSON.parse(readFileSync(join(iso.dir!, 'cli-config.json'), 'utf8')).selectedModel).toBe('grok-4.7-low-fast')
    expect(readFileSync(join(source, 'cli-config.json'), 'utf8')).toBe(CONFIG)
    iso.release()
  })

  it('gives concurrent spawns distinct dirs, and releasing one leaves the others whole', () => {
    const all = Array.from({ length: 16 }, () => cursorSpawnEnv({ baseEnv: {}, sourceDir: source, root: spawnRoot }))
    expect(new Set(all.map(iso => iso.dir)).size).toBe(16)
    all.slice(0, 8).forEach(iso => iso.release())
    for (const iso of all.slice(8)) {
      expect(readFileSync(join(iso.dir!, 'cli-config.json'), 'utf8')).toBe(CONFIG)
      expect(lstatSync(join(iso.dir!, 'chats')).isSymbolicLink()).toBe(true)
    }
    all.slice(8).forEach(iso => iso.release())
    expect(readdirSync(spawnRoot)).toEqual([])
  })

  it('falls back to the caller env (isolated: false) when the root cannot be made', () => {
    writeFileSync(join(root, 'a file'), 'x')
    const iso = cursorSpawnEnv({ baseEnv: { A: '1' }, sourceDir: source, root: join(root, 'a file', 'cursor-cli') })
    expect(iso).toMatchObject({ isolated: false, dir: null, env: { A: '1' } })
    expect(iso.env.CURSOR_CONFIG_DIR).toBeUndefined()
    expect(() => iso.release()).not.toThrow()
  })

  it('skips a link whose target is missing rather than leaving a dangling one', () => {
    rmSync(join(source, 'skills-cursor'), { recursive: true })
    const iso = cursorSpawnEnv({ baseEnv: {}, sourceDir: source, root: spawnRoot })
    expect(existsSync(join(iso.dir!, 'skills-cursor'))).toBe(false)
    iso.release()
  })
})

describe('releaseCursorSpawnOnExit', () => {
  it('releases on close, and on error only for a child that never started', () => {
    const started = Object.assign(new EventEmitter(), { pid: 4242 })
    const a = cursorSpawnEnv({ baseEnv: {}, sourceDir: source, root: spawnRoot })
    releaseCursorSpawnOnExit(started, a)
    started.emit('error', new Error('kill failed'))
    expect(existsSync(a.dir!)).toBe(true)
    started.emit('close', 0)
    expect(existsSync(a.dir!)).toBe(false)

    const never = Object.assign(new EventEmitter(), { pid: undefined as number | undefined })
    const b = cursorSpawnEnv({ baseEnv: {}, sourceDir: source, root: spawnRoot })
    releaseCursorSpawnOnExit(never, b)
    never.emit('error', new Error('ENOENT'))
    expect(existsSync(b.dir!)).toBe(false)
  })
})

describe('sweepStaleCursorSpawnDirs', () => {
  it('removes only old spawn-* dirs, without following their links', () => {
    const old = cursorSpawnEnv({ baseEnv: {}, sourceDir: source, root: spawnRoot })
    const fresh = cursorSpawnEnv({ baseEnv: {}, sourceDir: source, root: spawnRoot })
    mkdirSync(join(spawnRoot, 'not-ours'))
    const past = new Date(Date.now() - 7 * 60 * 60_000)
    utimesSync(old.dir!, past, past)
    expect(sweepStaleCursorSpawnDirs(spawnRoot, Date.now())).toBe(1)
    expect(existsSync(old.dir!)).toBe(false)
    expect(existsSync(fresh.dir!)).toBe(true)
    expect(existsSync(join(spawnRoot, 'not-ours'))).toBe(true)
    expect(readFileSync(join(source, 'chats', 'hash', 'chat.txt'), 'utf8')).toBe('the person’s chat')
    removeCursorSpawnDir(fresh.dir!)
  })
})

// ---------------------------------------------------------------------------
// The census: every `agent` spawn imports the helper or is listed exempt.
// ---------------------------------------------------------------------------

const REPO = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')

/** Files allowed to spawn the Cursor CLI without the helper, and why. */
const EXEMPT: Record<string, string> = {
  // A STRICTER per-spawn profile of its own: no MCP, no hooks, no inherited permissions.
  'server/lib/dictation-clean.ts': 'own stricter isolated profile',
}

/** The spawn sites plan 3.4 names, verified by grep at build time (6.62.0). */
const EXPECTED = [
  'bin/cli.cjs',
  'server/lib/attached-provider-adapter.ts',
  'server/lib/cursor-bridge.ts',
  'server/lib/cursor-model-catalog.ts',
  'server/lib/fork-thread.ts',
  'server/lib/health-static-probes.ts',
  'server/lib/lens-gist-engines.ts',
  'server/lib/lens-gist.ts',
  'server/lib/live-cues-cursor.ts',
  'server/lib/provider-proof.ts',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'data' || name.startsWith('.')) continue
    const path = join(dir, name)
    const st = lstatSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (/\.(ts|cjs|mjs)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path)
  }
  return out
}

/** Resolves the Cursor binary (or any provider binary by variable) AND starts a process. */
const RESOLVES_CURSOR = /resolveAgentBinary\(|resolveProviderBinary\([^)]*cursor|resolveProviderBinary\((?:request\.)?provider\)|resolveCursorAgentBinary\(|resolveProviderBinary\(cursor/

/**
 * Calls in the census files whose binary is NOT the Cursor CLI, or whose env is a parameter
 * checked at the caller, by file and first argument, each with its reason.
 */
const NOT_THE_CURSOR_CLI: Array<[file: string, head: string, why: string]> = [
  ['bin/cli.cjs', 'execFileSync(command', 'claude/codex --version probe (getCliVersion)'],
  ['bin/cli.cjs', 'execFileSync(binary', 'env is the parameter cursorCliState hands over: isolation.env (asserted below)'],
  ['bin/cli.cjs', 'spawn( process.execPath', 'the server itself under node'],
  ['server/lib/health-static-probes.ts', 'execute(PYTHON_BIN', 'python --version'],
  ['server/lib/health-static-probes.ts', 'execute(resolved.path', 'codex --version'],
  ['server/lib/provider-proof.ts', 'spawn(command', 'spawnPiped body: env is its parameter, isolated at the cursor caller (asserted below)'],
]

/** Every call of a spawn-family function, with its balanced argument text. Definitions skipped. */
function spawnCalls(text: string): string[] {
  const out: string[] = []
  const CALL = /(^|[^.\w])(spawn|nodeSpawn|execFile|execFileSync|spawnSync|runProcess|runBounded|execute|spawnPiped)\(/g
  let match: RegExpExecArray | null
  while ((match = CALL.exec(text)) !== null) {
    const start = match.index + match[1]!.length
    if (/function\s+$/.test(text.slice(Math.max(0, start - 20), start))) continue
    let depth = 0
    let i = start + match[2]!.length
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')' && --depth === 0) break
    }
    out.push(text.slice(start, i + 1))
  }
  return out
}
const SPAWNS = /\b(spawn|execFile|execFileSync|spawnSync|nodeSpawn)\(|runProcess\(|runBounded\(/

describe('the Cursor spawn census', () => {
  const files = [...walk(join(REPO, 'server')), ...walk(join(REPO, 'bin'))]
    .map(path => relative(REPO, path))
    .filter(path => !path.startsWith('server/scripts/'))

  it('finds every file that resolves the Cursor binary and spawns; nothing new appears unreviewed', () => {
    const found = files.filter(path => {
      const text = readFileSync(join(REPO, path), 'utf8')
      return RESOLVES_CURSOR.test(text) && SPAWNS.test(text)
    }).sort()
    // Every named site is still found: a refactor that hides one from this grep fails here.
    for (const path of EXPECTED) expect(found, path).toContain(path)
    expect(found.filter(path => !EXPECTED.includes(path) && !(path in EXEMPT))).toEqual([])
  })

  // 6.62.0 /qa (W14): per spawn CALL, not per file. A file that imports the helper and also
  // has a second, unwrapped spawn of the Cursor binary used to pass.
  it('every spawn CALL in those files passes the isolation env, or is named here as not the Cursor CLI', () => {
    const calls: string[] = []
    for (const path of EXPECTED) {
      for (const call of spawnCalls(readFileSync(join(REPO, path), 'utf8'))) {
        if (/^\w+\(\s*['"`]/.test(call)) continue // a literal binary: '/bin/ps', 'claude', 'ffmpeg'
        const head = call.slice(0, call.indexOf(',') > 0 ? call.indexOf(',') : call.length).replace(/\s+/g, ' ')
        const reviewed = NOT_THE_CURSOR_CLI.find(([file, prefix]) => file === path && head === prefix)
        if (reviewed) continue
        calls.push(`${path}: ${call.replace(/\s+/g, ' ').slice(0, 100)}`)
        expect(/\bisolation\.env\b|cursorIsolation:\s*(true|provider === 'cursor')/.test(call), `${path} spawns without isolation: ${head}`).toBe(true)
      }
    }
    // The pass-through wrappers are checked at THEIR caller, which must hand over isolation.
    expect(readFileSync(join(REPO, 'bin/cli.cjs'), 'utf8')).toContain('cursorCliStateWith(binary, isolation.env)')
    const proof = spawnCalls(readFileSync(join(REPO, 'server/lib/provider-proof.ts'), 'utf8')).filter(call => call.startsWith('spawnPiped('))
    expect(proof).toHaveLength(1)
    expect(proof[0]).toContain('isolation ? isolation.env : env')
    // Each of the ten sites contributed at least one checked call.
    expect(new Set(calls.map(line => line.split(':')[0])).size).toBeGreaterThanOrEqual(8)
  })

  it('keeps the CommonJS launcher’s link list identical to the helper’s', () => {
    const cli = readFileSync(join(REPO, 'bin', 'cli.cjs'), 'utf8')
    const match = /const CURSOR_SPAWN_LINKS = (\[[^\]]*\])/.exec(cli)
    expect(match).not.toBeNull()
    expect(JSON.parse(match![1]!.replace(/'/g, '"'))).toEqual([...CURSOR_SPAWN_LINKS])
  })
})

describe('6.62.0 /qa (W6): Continue and fork REFUSE when the Cursor isolation cannot be made', () => {
  it('the real Continue and fork spawns throw the isolation code before any process starts', async () => {
    const { realAttachedTurnDeps } = await import('./attached-provider-adapter')
    const { realForkDeps } = await import('./fork-thread')
    const { isCursorIsolationUnavailable, cursorSpawnStats } = await import('./cursor-spawn-env')
    writeFileSync(join(root, 'a file'), 'x')
    const previous = process.env.COS_CURSOR_SPAWN_ROOT
    process.env.COS_CURSOR_SPAWN_ROOT = join(root, 'a file', 'cursor-cli')
    const failedBefore = cursorSpawnStats.failed
    try {
      const request = { provider: 'cursor' as const, binaryPath: join(root, 'no such agent'), args: ['-p'], cwd: root, env: {} }
      let thrown: unknown = null
      try { realAttachedTurnDeps(() => ({ attachable: true, reason: null })).spawn(request) } catch (error) { thrown = error }
      expect(isCursorIsolationUnavailable(thrown)).toBe(true)
      thrown = null
      try { realForkDeps().spawn(request) } catch (error) { thrown = error }
      expect(isCursorIsolationUnavailable(thrown)).toBe(true)
      expect(cursorSpawnStats.failed).toBe(failedBefore + 2)
    } finally {
      if (previous === undefined) delete process.env.COS_CURSOR_SPAWN_ROOT
      else process.env.COS_CURSOR_SPAWN_ROOT = previous
    }
  })
})
