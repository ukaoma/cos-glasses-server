import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const canHook = typeof (process as { getBuiltinModule?: unknown }).getBuiltinModule === 'function'

// A Node older than 22.15 (or 23.8) has no zlib.createZstdDecompress, and `engines` is >=20.11. A named import of it would stop the
// server from booting there ("does not provide an export named"). Deleting the property from node:zlib does NOT reproduce that on a
// current Node (its ESM export names are fixed at startup, so a named import still links and reads undefined), so this serves
// `node:zlib` to a real child process through a loader hook whose export list has no zstd name at all, exactly as an old Node's
// has. The child imports the find route and the collector and reads a fake home that holds a compressed rollout.
let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'session find no zstd.')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it.runIf(canHook)('boots without zlib zstd, loads the whole find module graph, and counts the compressed file it could not read', () => {
  const home = join(dir, 'home')
  const day = join(home, '.codex', 'sessions', '2026', '10', '30')
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, 'rollout-2026-10-30T12-00-00-00000000-0000-4000-8000-000000000001.jsonl.zst'), Buffer.from('compressed bytes the server cannot read'))
  const claude = join(home, '.claude', 'projects', '-Users-test-proj')
  mkdirSync(claude, { recursive: true })
  writeFileSync(join(claude, '00000000-0000-4000-8000-000000000002.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'A typed question about the lens menu' }, timestamp: '2026-10-31T12:00:00.000Z' }) + '\n')

  const hooks = join(dir, 'no-zstd-hooks.mjs')
  writeFileSync(hooks, [
    `const real = process.getBuiltinModule('node:zlib')`,
    `const names = Object.keys(real).filter(n => !/zstd/i.test(n) && /^[A-Za-z_$][\\w$]*$/.test(n))`,
    `const body = 'const z = process.getBuiltinModule("node:zlib");\\n' + names.map(n => 'export const ' + n + ' = z.' + n + ';').join('\\n')`,
    `  + '\\nexport default new Proxy(z, { get: (t, k) => /zstd/i.test(String(k)) ? undefined : t[k], has: (t, k) => !/zstd/i.test(String(k)) && k in t, ownKeys: t => Reflect.ownKeys(t).filter(k => !/zstd/i.test(String(k))) });\\n'`,
    `export async function load(url, context, nextLoad) {`,
    `  if (url === 'node:zlib') return { format: 'module', source: body, shortCircuit: true }`,
    `  return nextLoad(url, context)`,
    `}`,
  ].join('\n'))
  const preload = join(dir, 'no-zstd-register.mjs')
  writeFileSync(preload, `import { register } from 'node:module'\nregister('./no-zstd-hooks.mjs', import.meta.url)\n`)
  const entry = join(dir, 'entry.mts')
  const root = resolve(process.cwd(), 'server')
  writeFileSync(entry, `
    import * as zlib from 'node:zlib'
    import zlibDefault from 'node:zlib'
    const route = await import(${JSON.stringify(join(root, 'routes/session-find.ts'))})
    const lib = await import(${JSON.stringify(join(root, 'lib/session-find.ts'))})
    const { SessionFindCollector, zstdDecompressor } = await import(${JSON.stringify(join(root, 'lib/session-find-collect.ts'))})
    const { agentSessionRoots } = await import(${JSON.stringify(join(root, 'lib/agent-session-store.ts'))})
    const pool = await new SessionFindCollector().collect({ roots: agentSessionRoots(${JSON.stringify(home)}), limit: 254 })
    console.log(JSON.stringify({ named: typeof (zlib as Record<string, unknown>).createZstdDecompress, onDefault: typeof (zlibDefault as unknown as Record<string, unknown>).createZstdDecompress, gzip: typeof zlib.gzipSync, decoder: zstdDecompressor(), router: typeof route.createSessionFindRouter, finder: typeof lib.SessionFinder,
      ids: pool.candidates.map((c: { session_id: string }) => c.session_id), skippedNoDecoder: pool.skippedNoDecoder, skippedUnreadable: pool.skippedUnreadable }))
  `)
  const run = spawnSync(process.execPath, ['--import', preload, '--import', 'tsx', entry], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, env: { ...process.env, COS_DATA_DIR: join(dir, 'data'), HOME: join(dir, 'home-of-child') },
  })
  const lastLine = run.stdout.trim().split('\n').pop() ?? ''
  expect(run.status, run.stderr.slice(0, 600)).toBe(0)
  expect(JSON.parse(lastLine)).toEqual({
    named: 'undefined', onDefault: 'undefined', gzip: 'function', decoder: null, router: 'function', finder: 'function',
    ids: ['00000000-0000-4000-8000-000000000002'], skippedNoDecoder: 1, skippedUnreadable: 0,
  })
}, 90_000)
