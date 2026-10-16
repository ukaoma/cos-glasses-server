import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A tiny fake manifest: the real one pins 1.1 GB. The installer's logic is identical.
const files = { cli: Buffer.from('fake fluidaudiocli 0.17.4'), a: Buffer.from('model a bytes'), b: Buffer.from('model b bytes, a little longer') }
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
vi.mock('./parakeet-manifest.js', () => ({
  PARAKEET_CLI: { version: '0.17.4', sha256: sha(files.cli), size: files.cli.length },
  PARAKEET_MODELS: [
    { id: 'parakeet-ultra', repo: 'FluidInference/parakeet-ultra-coreml', revision: '95eaa59a39d4394f047a4dc5cce480388a60d1b6', modelVersion: 'ultra',
      files: [{ path: 'Encoder.mlmodelc/weights/weight.bin', size: files.a.length, sha256: sha(files.a) },
        { path: 'parakeet_vocab.json', size: files.b.length, sha256: sha(files.b) }] },
  ],
}))

let dir = ''
let P: typeof import('./parakeet.js')

function seedSources(root: string, opts: { corruptB?: boolean } = {}): { models: string; cli: string } {
  const models = join(root, 'src-models')
  mkdirSync(join(models, 'parakeet-ultra', 'Encoder.mlmodelc', 'weights'), { recursive: true })
  writeFileSync(join(models, 'parakeet-ultra', 'Encoder.mlmodelc', 'weights', 'weight.bin'), files.a)
  writeFileSync(join(models, 'parakeet-ultra', 'parakeet_vocab.json'), opts.corruptB ? Buffer.from('model b bytes, a little LONGER') : files.b)
  const cli = join(root, 'fluidaudiocli-copy')
  writeFileSync(cli, files.cli)
  return { models, cli }
}

const noNetwork = vi.fn(async (url: string) => { throw new Error(`network: ${url}`) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cos-parakeet-'))
  process.env.COS_DATA_DIR = join(dir, 'data')
  process.env.COS_PARAKEET_LOCAL_SOURCES = ''
  noNetwork.mockClear()
  vi.resetModules()
  P = await import('./parakeet.js')
  P.__resetParakeetForTests()
})
afterEach(() => {
  delete process.env.COS_DATA_DIR
  delete process.env.COS_PARAKEET_LOCAL_SOURCES
  rmSync(dir, { recursive: true, force: true })
})

describe('Parakeet install (pinned, hash-checked)', () => {
  it('installs from matching local copies without touching the network', async () => {
    const src = seedSources(dir)
    await P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: noNetwork })
    expect(noNetwork).not.toHaveBeenCalled()
    expect(P.parakeetInstalled(Date.now() + 10_000)).toEqual({ installed: true, bytes: files.cli.length + files.a.length + files.b.length })
    expect(P.getInstallProgress()).toMatchObject({ state: 'installed', error: null })
    expect(readdirSync(P.parakeetRoot()).filter(n => n.startsWith('.staging-'))).toEqual([])
  })

  it('downloads a file that has no matching local copy, from the pinned revision, and verifies it', async () => {
    const src = seedSources(dir, { corruptB: true })
    const urls: string[] = []
    const fetchImpl = async (url: string) => {
      urls.push(url)
      const s = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(files.b)); c.close() } })
      return { ok: true, status: 200, body: s }
    }
    await P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl })
    expect(urls).toEqual(['https://huggingface.co/FluidInference/parakeet-ultra-coreml/resolve/95eaa59a39d4394f047a4dc5cce480388a60d1b6/parakeet_vocab.json'])
    expect(P.parakeetInstalled(Date.now() + 10_000).installed).toBe(true)
  })

  it('refuses bytes that do not match the pinned hash and installs nothing', async () => {
    const src = seedSources(dir, { corruptB: true })
    const fetchImpl = async () => ({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(Buffer.from('model b bytes, a little LONGER'))); c.close() } }) })
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl })).rejects.toThrow(/does not match its pinned SHA-256/)
    expect(P.parakeetInstalled(Date.now() + 10_000).installed).toBe(false)
    expect(existsSync(join(P.parakeetRoot(), 'current'))).toBe(false)
    expect(P.getInstallProgress()).toMatchObject({ state: 'failed', error: expect.stringMatching(/pinned SHA-256/) })
  })

  it('refuses a download larger than the pinned size', async () => {
    const src = seedSources(dir, { corruptB: true })
    const fetchImpl = async () => ({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(Buffer.alloc(files.b.length + 50))); c.close() } }) })
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl })).rejects.toThrow(/larger than the pinned size/)
  })

  it('needs a CLI with the pinned hash; a different binary is never installed', async () => {
    const src = seedSources(dir)
    writeFileSync(src.cli, Buffer.from('fake fluidaudiocli 0.17.5'))
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: noNetwork, controlCliCandidates: [] })).rejects.toThrow(/speech tool Parakeet needs is not on this Mac/)
    expect(P.getInstallProgress()).toMatchObject({ state: 'failed', errorCode: 'cli_missing' })
  })

  it('reads a truncated model file as not installed', async () => {
    const src = seedSources(dir)
    await P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: noNetwork })
    writeFileSync(join(P.parakeetModelDir('parakeet-ultra'), 'parakeet_vocab.json'), 'short')
    P.resetParakeetInstallCache()
    expect(P.parakeetInstalled().installed).toBe(false)
  })
})

class FakeChild extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); pid = undefined; exitCode: number | null = null; signalCode: string | null = null
  killed: string[] = []
  kill(sig: string) { this.killed.push(sig); this.signalCode = sig; setImmediate(() => this.emit('close', null, sig)); return true }
}

describe('Parakeet install: local-only, stalls, cancel, join, crash restore', () => {
  it('a named local source that lacks a file fails plainly instead of downloading', async () => {
    const src = seedSources(dir, { corruptB: true })
    await expect(P.installParakeet({ localSources: [src.models], requireLocal: true, cliCandidates: [src.cli], fetchImpl: noNetwork }))
      .rejects.toThrow(/No copy of parakeet-ultra parakeet_vocab.json with the pinned SHA-256 was found in .*src-models.*allowDownload/)
    expect(noNetwork).not.toHaveBeenCalled()
  })

  it('reports where the bytes came from', async () => {
    const src = seedSources(dir)
    await P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: noNetwork })
    expect(P.getInstallProgress().source).toEqual({ filesLocal: 2, filesDownloaded: 0, localSources: [join(src.models, 'parakeet-ultra')] })
  })

  it('a download that stops sending bytes is abandoned with a plain error', async () => {
    const src = seedSources(dir, { corruptB: true })
    const fetchImpl = async (_u: string, init?: { signal?: AbortSignal }) => ({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason)) } }) })
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl, idleTimeoutMs: 50 })).rejects.toThrow(/stalled \(no data for 0 s\)/)
    expect(P.getInstallProgress().state).toBe('failed')
    expect(existsSync(join(P.parakeetRoot(), 'current'))).toBe(false)
  })

  it('cancel stops a running install; a second start joins the running one', async () => {
    const src = seedSources(dir, { corruptB: true })
    let started!: () => void
    const begun = new Promise<void>(r => { started = r })
    const fetchImpl = async (_u: string, init?: { signal?: AbortSignal }) => { started(); return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason)) } }) } }
    const a = P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl })
    const b = P.installParakeet({})
    expect(b).toBe(a)
    await begun
    expect(P.cancelParakeetInstall()).toBe(true)
    await expect(a).rejects.toThrow(/cancelled/)
    expect(P.parakeetInstallRunning()).toBe(false)
    expect(P.cancelParakeetInstall()).toBe(false)
  })

  it('boot puts back an install a crash left mid-swap, and removes staging leftovers', async () => {
    const src = seedSources(dir)
    await P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: noNetwork })
    const { renameSync, mkdirSync: mk } = await import('node:fs')
    renameSync(join(P.parakeetRoot(), 'current'), join(P.parakeetRoot(), '.old-1-abc'))
    mk(join(P.parakeetRoot(), '.staging-dead'))
    P.resetParakeetInstallCache()
    expect(P.parakeetInstalled().installed).toBe(false)
    expect(P.sweepParakeetStaging()).toEqual({ removed: 1, restored: true })
    expect(P.parakeetInstalled(Date.now() + 10_000).installed).toBe(true)
    expect(readdirSync(P.parakeetRoot()).filter(n => n.startsWith('.'))).toEqual([])
  })

  it('finds the pinned CLI only, and says so without hashing on every read', async () => {
    const src = seedSources(dir)
    const other = join(dir, 'other-cli'); writeFileSync(other, Buffer.from('fake fluidaudiocli 0.17.5'))
    expect(P.pinnedCliKnown([other, src.cli])).toBeNull() // unknown until checked; a check starts in the background
    expect(await P.findPinnedCli([other, src.cli])).toBe(src.cli)
    expect(P.pinnedCliKnown([other, src.cli])).toBe(true)
    expect(await P.findPinnedCli([other])).toBeNull()
    expect(P.pinnedCliKnown([other])).toBe(false)
    expect(P.pinnedCliKnown([join(dir, 'missing')])).toBe(false)
  })
})

describe('temp and staging sweeps', () => {
  it('removes old Parakeet temp dirs only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-sweep-'))
    try {
      const { utimesSync, mkdirSync: mk } = await import('node:fs')
      mk(join(root, `${P.PARAKEET_TMP_PREFIX}old`)); mk(join(root, `${P.PARAKEET_TMP_PREFIX}new`)); mk(join(root, 'someone-else'))
      const past = new Date(Date.now() - 120_000); utimesSync(join(root, `${P.PARAKEET_TMP_PREFIX}old`), past, past)
      expect(P.sweepStaleParakeetTmp(root, 60_000)).toBe(1)
      expect(readdirSync(root).sort()).toEqual([`${P.PARAKEET_TMP_PREFIX}new`, 'someone-else'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('Parakeet runs (offline, bounded)', () => {
  async function installed() {
    const src = seedSources(dir)
    await P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: noNetwork })
  }

  it('refuses to run when not installed', async () => {
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'batch', timeoutMs: 1000 })).rejects.toMatchObject({ reason: 'not_installed' })
  })

  it('always runs under sandbox-exec with network denied, local models and a key-free environment', async () => {
    await installed()
    process.env.OPENAI_API_KEY = 'sk-should-not-leak'
    let seen: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null = null
    const spawnImpl = ((cmd: string, args: string[], o: any) => {
      seen = { cmd, args, env: o.env }
      const child = new FakeChild()
      const out = args[args.indexOf('--output-json') + 1]
      setImmediate(() => { writeFileSync(out, JSON.stringify({ text: ' hello  there ', processingTimeSeconds: 0.08, wordTimings: [{ word: 'hello', startTime: 0.1, endTime: 0.4, confidence: 0.9 }, { word: 'there', startTime: 0.5, endTime: 0.45 }] })); child.exitCode = 0; child.emit('close', 0, null) })
      return child as any
    }) as any
    const r = await P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'batch', timeoutMs: 5000, spawnImpl })
    delete process.env.OPENAI_API_KEY
    expect(seen!.cmd).toBe('/usr/bin/sandbox-exec')
    expect(seen!.args[0]).toBe('-p')
    expect(seen!.args[1]).toContain('(deny network*)')
    expect(seen!.args[1]).toContain('(deny file-write*)(allow file-write* (subpath')
    expect(seen!.args[1]).not.toContain(P.parakeetModelDir('parakeet-ultra'))
    expect(seen!.args).toContain('--local-model-dir')
    expect(seen!.args[seen!.args.indexOf('--local-model-dir') + 1]).toBe(P.parakeetModelDir('parakeet-ultra'))
    expect(seen!.args[seen!.args.indexOf('--model-version') + 1]).toBe('ultra')
    expect(seen!.env.OPENAI_API_KEY).toBeUndefined()
    expect(seen!.env.HOME).toBe(P.parakeetHome())
    expect(r.text).toBe('hello there')
    expect(r.words).toEqual([{ word: 'hello', start: 0.1, end: 0.4, probability: 0.9 }, { word: 'there', start: 0.5, end: 0.5 }])
    const input = seen!.args[seen!.args.indexOf('transcribe') + 1]
    expect(input.includes(P.PARAKEET_TMP_PREFIX)).toBe(true)
    expect(existsSync(input)).toBe(false) // the run's temp directory is gone
  })

  it('never runs without the sandbox (no proof of offline, no run)', async () => {
    await installed()
    const spawnImpl = vi.fn()
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'batch', timeoutMs: 1000, spawnImpl: spawnImpl as any, sandboxExec: join(dir, 'no-such-sandbox-exec') })).rejects.toMatchObject({ reason: 'sandbox_unavailable' })
    expect(spawnImpl).not.toHaveBeenCalled()
    process.env.COS_PARAKEET_SANDBOX_EXEC = join(dir, 'no-such-sandbox-exec') // no environment override exists
    try {
      let cmd = ''
      const spawn2 = ((c: string, args: string[]) => { cmd = c; const child = new FakeChild(); setImmediate(() => { writeFileSync(args[args.indexOf('--output-json') + 1], JSON.stringify({ text: '' })); child.emit('close', 0, null) }); return child }) as any
      await P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'batch', timeoutMs: 1000, spawnImpl: spawn2 })
      expect(cmd).toBe('/usr/bin/sandbox-exec')
    } finally { delete process.env.COS_PARAKEET_SANDBOX_EXEC }
  })

  it('the CLI is handed the padded clip, never one too short for FluidAudio', async () => {
    await installed()
    const { readFileSync: rf } = await import('node:fs')
    let size = 0
    const spawnImpl = ((_c: string, args: string[]) => {
      size = rf(args[args.indexOf('transcribe') + 1]).length
      const child = new FakeChild()
      setImmediate(() => { writeFileSync(args[args.indexOf('--output-json') + 1], JSON.stringify({ text: '' })); child.emit('close', 0, null) })
      return child
    }) as any
    const short = Buffer.from(P.warmupWav().subarray(0, 44 + 3200)); short.writeUInt32LE(3200, 40); short.writeUInt32LE(36 + 3200, 4)
    await P.transcribeParakeet(short, { model: 'parakeet-ultra', lane: 'batch', timeoutMs: 2000, spawnImpl })
    expect(size).toBe(44 + 32_000)
  })

  it('kills a run past its deadline and fails closed', async () => {
    await installed()
    const child = new FakeChild()
    const spawnImpl = (() => child) as any
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'batch', timeoutMs: 30, spawnImpl })).rejects.toMatchObject({ reason: 'timeout' })
    expect(child.killed).toContain('SIGKILL')
  })

  it('rejects a CLI that complains about an option even with exit 0, and bad clocks', async () => {
    await installed()
    const make = (stderr: string, json: unknown) => ((_c: string, args: string[]) => {
      const child = new FakeChild()
      setImmediate(() => { child.stderr.write(stderr); writeFileSync(args[args.indexOf('--output-json') + 1], JSON.stringify(json)); child.emit('close', 0, null) })
      return child
    }) as any
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'batch', timeoutMs: 2000, spawnImpl: make('Unknown option --x', { text: 'a' }) })).rejects.toMatchObject({ reason: 'cli_failed' })
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'batch', timeoutMs: 2000, spawnImpl: make('[ERROR] Batch transcription failed: invalidAudioData', { text: 'stale' }) })).rejects.toMatchObject({ reason: 'cli_failed' })
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'batch', timeoutMs: 2000, spawnImpl: make('', { text: 'a', wordTimings: [{ word: 'a', startTime: -1, endTime: 1 }] }) })).rejects.toMatchObject({ reason: 'bad_output' })
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'batch', timeoutMs: 2000, spawnImpl: make('', { nope: 1 }) })).rejects.toMatchObject({ reason: 'bad_output' })
  })

  it('a busy preview lane is a miss, never a queue', async () => {
    await installed()
    const child = new FakeChild()
    const first = P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'preview', timeoutMs: 200, spawnImpl: (() => child) as any })
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'preview', timeoutMs: 200, spawnImpl: (() => new FakeChild()) as any })).rejects.toMatchObject({ reason: 'busy' })
    await expect(first).rejects.toMatchObject({ reason: 'timeout' })
  })

  it('6.73.0: the interactive (dictation) lane runs two at once, a third is busy, and it is never queued', async () => {
    await installed()
    const a = new FakeChild(), b = new FakeChild()
    const first = P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'interactive', timeoutMs: 200, spawnImpl: (() => a) as any })
    const second = P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'interactive', timeoutMs: 200, spawnImpl: (() => b) as any })
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'interactive', timeoutMs: 200, spawnImpl: (() => new FakeChild()) as any })).rejects.toMatchObject({ reason: 'busy' })
    await expect(first).rejects.toMatchObject({ reason: 'timeout' })
    await expect(second).rejects.toMatchObject({ reason: 'timeout' })
    // The slots free up after a run ends.
    const done = ((_c: string, args: string[]) => { const child = new FakeChild(); setImmediate(() => { writeFileSync(args[args.indexOf('--output-json') + 1], JSON.stringify({ text: 'ok' })); child.emit('close', 0, null) }); return child }) as any
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-ultra', lane: 'interactive', timeoutMs: 2000, spawnImpl: done })).resolves.toMatchObject({ text: 'ok' })
  })

  it('is warm only after a warm decode fits the budget', async () => {
    await installed()
    let calls = 0
    const spawnImpl = ((_c: string, args: string[]) => {
      const child = new FakeChild(); calls++
      setImmediate(() => { writeFileSync(args[args.indexOf('--output-json') + 1], JSON.stringify({ text: '' })); child.emit('close', 0, null) })
      return child
    }) as any
    expect(P.parakeetWarmState('parakeet-ultra').state).toBe('cold')
    expect(await P.warmParakeet('parakeet-ultra', spawnImpl)).toBe(true)
    expect(calls).toBe(2)
    expect(P.parakeetWarmState('parakeet-ultra').state).toBe('warm')
  })

  it('a warm decode slower than the budget leaves the preview model not warm', async () => {
    await installed()
    const spawnImpl = ((_c: string, args: string[]) => {
      const child = new FakeChild()
      setTimeout(() => { writeFileSync(args[args.indexOf('--output-json') + 1], JSON.stringify({ text: '' })); child.emit('close', 0, null) }, P.WARM_DECODE_BUDGET_MS + 150)
      return child
    }) as any
    expect(await P.warmParakeet('parakeet-ultra', spawnImpl)).toBe(false)
    expect(P.parakeetWarmState('parakeet-ultra')).toMatchObject({ state: 'failed', error: expect.stringMatching(/warm decode took/) })
  }, 10_000)
})

describe('short clips', () => {
  it('pads a clip under a second with silence, and leaves longer or foreign audio alone', () => {
    const short = P.warmupWav().subarray(0, 44 + 3200) // 0.1 s, header still says 8 s
    const fixed = Buffer.from(short); fixed.writeUInt32LE(3200, 40); fixed.writeUInt32LE(36 + 3200, 4)
    const padded = P.padShortWav(fixed)
    expect(padded.length).toBe(44 + 32_000)
    expect(padded.readUInt32LE(40)).toBe(32_000)
    expect(padded.subarray(44, 44 + 3200).equals(fixed.subarray(44))).toBe(true)
    expect(padded.subarray(44 + 3200).every(b => b === 0)).toBe(true)
    const long = P.warmupWav()
    expect(P.padShortWav(long)).toBe(long)
    const notWav = Buffer.from('not a wav at all')
    expect(P.padShortWav(notWav)).toBe(notWav)
  })
})

describe.runIf(process.platform === 'darwin')('the sandbox profile, enforced by the OS', () => {
  it('denies a network connection and writes outside the run directory and the model cache', async () => {
    const { createServer } = await import('node:http')
    const { spawnSync, execFile } = await import('node:child_process')
    const run = (cmd: string, args: string[]) => new Promise<{ status: number; stdout: string }>(res => execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => res({ status: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout })))
    const srv = createServer((_q, r) => r.end('ok'))
    await new Promise<void>(res => srv.listen(0, '127.0.0.1', () => res()))
    const port = (srv.address() as any).port
    const work = mkdtempSync(join(tmpdir(), 'cos-parakeet-sbx-')), home = mkdtempSync(join(tmpdir(), 'cos-parakeet-home-')), outside = mkdtempSync('/private/tmp/cos-parakeet-out-')
    try {
      const profile = P.parakeetSandboxProfile(work, home, null)
      expect(P.parakeetSandboxProfile(work, home, '/private/var/folders/xx/T/')).toContain('(subpath "/private/var/folders/xx/T/")')
      // execFile, not spawnSync: the local server must keep answering while curl runs.
      const curl = (sandboxed: boolean) => sandboxed
        ? run('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/curl', '-s', '-m', '3', `http://127.0.0.1:${port}/`])
        : run('/usr/bin/curl', ['-s', '-m', '3', `http://127.0.0.1:${port}/`])
      expect((await curl(false)).stdout).toBe('ok') // the control: the request works unsandboxed
      const denied = await curl(true)
      expect(denied.status).not.toBe(0)
      expect(denied.stdout).toBe('')
      const touch = (path: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/touch', path]).status
      expect(touch(join(work, 'ok'))).toBe(0)
      expect(touch(join(home, 'ok'))).toBe(0)
      expect(touch(join(outside, 'nope'))).not.toBe(0)
      expect(existsSync(join(outside, 'nope'))).toBe(false)
    } finally {
      srv.close()
      for (const d of [work, home, outside]) rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('6.74.0: install from COS Control signed CLI, disk precheck, error codes', () => {
  const COS_TEAM = 'NV3X46LLCR'
  const signedBytes = Buffer.from('fluidaudiocli 0.17.4 built and signed by COS Control')
  /** codesign and version probes for a Developer ID build; `team` and `bad` vary the verdict. */
  const trustDeps = (over: { team?: string; bad?: Set<string> } = {}) => ({
    display: vi.fn(async (p: string) => ({ code: 0, output: `Identifier=com.gotcos.control.fluidaudiocli\nInfo.plist entries=2\nTeamIdentifier=${over.team ?? COS_TEAM}\n${over.bad?.has(p) ? 'Signature=adhoc\n' : ''}` })),
    verify: vi.fn(async () => ({ code: 0, output: '' })),
    embeddedPlist: vi.fn(() => '<key>CFBundleIdentifier</key><string>com.gotcos.control.fluidaudiocli</string><key>CFBundleShortVersionString</key><string>0.17.4</string>'),
    sha256: async (p: string) => sha(readFileSync(p)),
  })
  function control(): string {
    const p = join(dir, 'COS Control.app', 'Contents', 'Helpers', 'fluidaudiocli')
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, signedBytes)
    return p
  }
  const plenty = () => 50e9

  it('installs the signed CLI (no SHA pin can match it), records its own hash, and runs only those bytes', async () => {
    const src = seedSources(dir)
    const helper = control()
    await P.installParakeet({ localSources: [src.models], cliCandidates: [], controlCliCandidates: [helper], trustDeps: trustDeps(), fetchImpl: noNetwork, freeBytes: plenty })
    const receipt = JSON.parse(readFileSync(join(P.parakeetRoot(), 'current', 'install.json'), 'utf8'))
    expect(receipt.cli).toEqual({ version: '0.17.4', sha256: sha(signedBytes), size: signedBytes.length, trust: 'developer-id', teamId: COS_TEAM })
    expect(P.parakeetInstalled(Date.now() + 10_000).installed).toBe(true)
    expect(P.installedCliTrust()).toBe('developer-id')
    expect(await P.installedCliIntact()).toBe(true)
    // Tampered after install: same size, other bytes. Parakeet refuses to run it.
    writeFileSync(P.parakeetCliPath(), Buffer.alloc(signedBytes.length, 7))
    P.resetParakeetInstallCache()
    expect(await P.installedCliIntact()).toBe(false)
  })

  it('a 6.73 receipt (pinned CLI, no trust field) still reads as installed', async () => {
    const src = seedSources(dir)
    await P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: noNetwork, freeBytes: plenty })
    const path = join(P.parakeetRoot(), 'current', 'install.json')
    const receipt = JSON.parse(readFileSync(path, 'utf8'))
    expect(receipt.cli.trust).toBe('sha256')
    writeFileSync(path, JSON.stringify({ ...receipt, cli: { version: '0.17.4', sha256: receipt.cli.sha256 } }))
    P.resetParakeetInstallCache()
    expect(P.parakeetInstalled(Date.now() + 10_000).installed).toBe(true)
    expect(await P.installedCliIntact()).toBe(true)
  })

  it('a developer-id receipt naming another team is not installed', async () => {
    const src = seedSources(dir)
    await P.installParakeet({ localSources: [src.models], cliCandidates: [], controlCliCandidates: [control()], trustDeps: trustDeps(), fetchImpl: noNetwork, freeBytes: plenty })
    const path = join(P.parakeetRoot(), 'current', 'install.json')
    const receipt = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...receipt, cli: { ...receipt.cli, teamId: 'ABCDE12345' } }))
    P.resetParakeetInstallCache()
    expect(P.parakeetInstalled(Date.now() + 10_000).installed).toBe(false)
    expect(await P.installedCliIntact()).toBe(false)
  })

  it('refuses a CLI from another team, and says the tool did not pass its check', async () => {
    const src = seedSources(dir)
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [], controlCliCandidates: [control()], trustDeps: trustDeps({ team: 'ABCDE12345' }), fetchImpl: noNetwork, freeBytes: plenty }))
      .rejects.toMatchObject({ code: 'cli_untrusted', message: expect.stringMatching(/did not pass its check \(wrong_team\)/) })
    expect(P.getInstallProgress()).toMatchObject({ state: 'failed', errorCode: 'cli_untrusted' })
    expect(existsSync(join(P.parakeetRoot(), 'current'))).toBe(false)
  })

  it('refuses an unsigned CLI at the Control path', async () => {
    const src = seedSources(dir)
    const helper = control()
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [], controlCliCandidates: [helper], trustDeps: trustDeps({ bad: new Set([helper]) }), fetchImpl: noNetwork, freeBytes: plenty }))
      .rejects.toMatchObject({ code: 'cli_untrusted', message: expect.stringMatching(/\(unsigned\)/) })
  })

  it('proves the copy too: a copy that fails its own check is never installed', async () => {
    const src = seedSources(dir)
    const helper = control()
    const d = trustDeps()
    d.display.mockImplementation(async (p: string) => ({ code: 0, output: `Identifier=com.gotcos.control.fluidaudiocli\nInfo.plist entries=2\nTeamIdentifier=${COS_TEAM}\n${p.includes('.staging-') ? 'Signature=adhoc\n' : ''}` }))
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [], controlCliCandidates: [helper], trustDeps: d, fetchImpl: noNetwork, freeBytes: plenty }))
      .rejects.toMatchObject({ code: 'cli_untrusted', message: expect.stringMatching(/changed while it was being copied/) })
  })

  it('the SHA-256 pinned hand copy still wins over the Control build', async () => {
    const src = seedSources(dir)
    const d = trustDeps()
    await P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], controlCliCandidates: [control()], trustDeps: d, fetchImpl: noNetwork, freeBytes: plenty })
    expect(P.installedCliTrust()).toBe('sha256')
    expect(d.display).not.toHaveBeenCalled()
  })

  it('needs 1.5 GB free before anything is written; a full disk installs nothing', async () => {
    const src = seedSources(dir)
    const free = vi.fn(() => 1_499_999_999)
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: noNetwork, freeBytes: free }))
      .rejects.toMatchObject({ code: 'insufficient_disk', message: expect.stringMatching(/needs 1\.5 GB free.*Whisper keeps working/) })
    expect(free).toHaveBeenCalledWith(P.parakeetRoot())
    expect(P.getInstallProgress()).toMatchObject({ state: 'failed', errorCode: 'insufficient_disk' })
    expect(existsSync(P.parakeetRoot())).toBe(false)
    expect(P.parakeetDiskCheck(() => 1_500_000_000)).toEqual({ ok: true, freeBytes: 1_500_000_000, requiredBytes: 1_500_000_000 })
    expect(P.parakeetDiskCheck(() => null).ok).toBe(true)
    expect(P.freeBytesAt(join(dir, 'does', 'not', 'exist'))).toBeGreaterThan(0)
  })

  it('cancel mid-download keeps the existing install and says cancelled', async () => {
    const src = seedSources(dir)
    await P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: noNetwork, freeBytes: plenty })
    const before = readFileSync(join(P.parakeetRoot(), 'current', 'install.json'), 'utf8')
    // Reinstall from a source that lacks a file, so it downloads, and cancel during it.
    rmSync(join(P.parakeetRoot(), 'current', 'install.json'))
    P.resetParakeetInstallCache()
    writeFileSync(join(P.parakeetRoot(), 'current', 'install.json'), before)
    const broken = seedSources(join(dir, 'b'), { corruptB: true })
    let started!: () => void
    const begun = new Promise<void>(r => { started = r })
    const fetchImpl = async (_u: string, init?: { signal?: AbortSignal }) => { started(); return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason)) } }) } }
    process.env.COS_PARAKEET_LOCAL_SOURCES = ''
    const run = P.installParakeet({ localSources: [broken.models], cliCandidates: [src.cli], fetchImpl, freeBytes: plenty })
    await begun
    expect(P.cancelParakeetInstall()).toBe(true)
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    expect(P.getInstallProgress()).toMatchObject({ state: 'failed', errorCode: 'cancelled', error: 'The install was cancelled.' })
    expect(readFileSync(join(P.parakeetRoot(), 'current', 'install.json'), 'utf8')).toBe(before)
    expect(readdirSync(P.parakeetRoot()).filter(n => n.startsWith('.staging-'))).toEqual([])
  })

  it('error codes: sha_mismatch, stalled, download_failed', async () => {
    const src = seedSources(dir, { corruptB: true })
    const bad = async () => ({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(Buffer.from('model b bytes, a little LONGER'))); c.close() } }) })
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: bad, freeBytes: plenty })).rejects.toMatchObject({ code: 'sha_mismatch' })
    const stall = async (_u: string, init?: { signal?: AbortSignal }) => ({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason)) } }) })
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: stall, idleTimeoutMs: 30, freeBytes: plenty })).rejects.toMatchObject({ code: 'stalled' })
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: noNetwork, freeBytes: plenty })).rejects.toMatchObject({ code: 'download_failed' })
    const http = async () => ({ ok: false, status: 404, body: null })
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: http, freeBytes: plenty })).rejects.toMatchObject({ code: 'download_failed' })
    expect(P.getInstallProgress().errorCode).toBe('download_failed')
  })
})
