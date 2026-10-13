import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
      files: [{ path: 'Encoder.mlmodelc/weights/weight.bin', size: files.a.length, sha256: sha(files.a) }] },
    { id: 'parakeet-v2', repo: 'FluidInference/parakeet-tdt-0.6b-v2-coreml', revision: 'ee09c569f73759e6d44c9bd16766f477b2b36d39', modelVersion: 'v2',
      files: [{ path: 'parakeet_vocab.json', size: files.b.length, sha256: sha(files.b) }] },
  ],
}))

let dir = ''
let P: typeof import('./parakeet.js')

function seedSources(root: string, opts: { corruptB?: boolean } = {}): { models: string; cli: string } {
  const models = join(root, 'src-models')
  mkdirSync(join(models, 'parakeet-ultra', 'Encoder.mlmodelc', 'weights'), { recursive: true })
  writeFileSync(join(models, 'parakeet-ultra', 'Encoder.mlmodelc', 'weights', 'weight.bin'), files.a)
  mkdirSync(join(models, 'parakeet-tdt-0.6b-v2'), { recursive: true })
  writeFileSync(join(models, 'parakeet-tdt-0.6b-v2', 'parakeet_vocab.json'), opts.corruptB ? Buffer.from('model b bytes, a little LONGER') : files.b)
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
    expect(urls).toEqual(['https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v2-coreml/resolve/ee09c569f73759e6d44c9bd16766f477b2b36d39/parakeet_vocab.json'])
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
    await expect(P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: noNetwork })).rejects.toThrow(/FluidAudio CLI 0.17.4 is not on this Mac/)
  })

  it('reads a truncated model file as not installed', async () => {
    const src = seedSources(dir)
    await P.installParakeet({ localSources: [src.models], cliCandidates: [src.cli], fetchImpl: noNetwork })
    writeFileSync(join(P.parakeetModelDir('parakeet-v2'), 'parakeet_vocab.json'), 'short')
    P.resetParakeetInstallCache()
    expect(P.parakeetInstalled().installed).toBe(false)
  })
})

class FakeChild extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); pid = undefined; exitCode: number | null = null; signalCode: string | null = null
  killed: string[] = []
  kill(sig: string) { this.killed.push(sig); this.signalCode = sig; setImmediate(() => this.emit('close', null, sig)); return true }
}

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
    expect(seen!.args[1]).toContain('(deny file-write* (subpath')
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
    process.env.COS_PARAKEET_SANDBOX_EXEC = join(dir, 'no-such-sandbox-exec')
    const spawnImpl = vi.fn()
    try {
      await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-v2', lane: 'batch', timeoutMs: 1000, spawnImpl: spawnImpl as any })).rejects.toMatchObject({ reason: 'sandbox_unavailable' })
      expect(spawnImpl).not.toHaveBeenCalled()
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
    await P.transcribeParakeet(short, { model: 'parakeet-v2', lane: 'batch', timeoutMs: 2000, spawnImpl })
    expect(size).toBe(44 + 32_000)
  })

  it('kills a run past its deadline and fails closed', async () => {
    await installed()
    const child = new FakeChild()
    const spawnImpl = (() => child) as any
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-v2', lane: 'batch', timeoutMs: 30, spawnImpl })).rejects.toMatchObject({ reason: 'timeout' })
    expect(child.killed).toContain('SIGKILL')
  })

  it('rejects a CLI that complains about an option even with exit 0, and bad clocks', async () => {
    await installed()
    const make = (stderr: string, json: unknown) => ((_c: string, args: string[]) => {
      const child = new FakeChild()
      setImmediate(() => { child.stderr.write(stderr); writeFileSync(args[args.indexOf('--output-json') + 1], JSON.stringify(json)); child.emit('close', 0, null) })
      return child
    }) as any
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-v2', lane: 'batch', timeoutMs: 2000, spawnImpl: make('Unknown option --x', { text: 'a' }) })).rejects.toMatchObject({ reason: 'cli_failed' })
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-v2', lane: 'batch', timeoutMs: 2000, spawnImpl: make('[ERROR] Batch transcription failed: invalidAudioData', { text: 'stale' }) })).rejects.toMatchObject({ reason: 'cli_failed' })
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-v2', lane: 'batch', timeoutMs: 2000, spawnImpl: make('', { text: 'a', wordTimings: [{ word: 'a', startTime: -1, endTime: 1 }] }) })).rejects.toMatchObject({ reason: 'bad_output' })
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-v2', lane: 'batch', timeoutMs: 2000, spawnImpl: make('', { nope: 1 }) })).rejects.toMatchObject({ reason: 'bad_output' })
  })

  it('a busy preview lane is a miss, never a queue', async () => {
    await installed()
    const child = new FakeChild()
    const first = P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-v2', lane: 'preview', timeoutMs: 200, spawnImpl: (() => child) as any })
    await expect(P.transcribeParakeet(P.warmupWav(), { model: 'parakeet-v2', lane: 'preview', timeoutMs: 200, spawnImpl: (() => new FakeChild()) as any })).rejects.toMatchObject({ reason: 'busy' })
    await expect(first).rejects.toMatchObject({ reason: 'timeout' })
  })

  it('is warm only after a warm decode fits the budget', async () => {
    await installed()
    let calls = 0
    const spawnImpl = ((_c: string, args: string[]) => {
      const child = new FakeChild(); calls++
      setImmediate(() => { writeFileSync(args[args.indexOf('--output-json') + 1], JSON.stringify({ text: '' })); child.emit('close', 0, null) })
      return child
    }) as any
    expect(P.parakeetWarmState('parakeet-v2').state).toBe('cold')
    expect(await P.warmParakeet('parakeet-v2', spawnImpl)).toBe(true)
    expect(calls).toBe(2)
    expect(P.parakeetWarmState('parakeet-v2').state).toBe('warm')
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
    const short = P.warmupWav().subarray(0, 44 + 3200) // 0.1 s, header still says 2 s
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
