// A fake fluidaudiocli for the speaker shadow tests, plus a sandbox-exec stand-in.
//
// The fake reads the real CLI's argument shape (`process <wav> --mode offline --output <p>
// --overlapping-segments --export-embeddings <q>`), records that it ran, and then does what
// its mode says. Its outputs are the synthetic meeting's FluidAudio files.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { syntheticEmbeddings, syntheticNative } from './synthetic-meeting.js'

export type FakeCliMode = 'success' | 'crash' | 'hang' | 'unknown_option' | 'bad_json' | 'slow' | 'memory' | 'probe'

const SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path'), net = require('node:net')
const [mode, fixtures, marker] = process.argv.slice(2, 5)
const args = process.argv.slice(5)
fs.appendFileSync(marker, JSON.stringify({ pid: process.pid, args, home: process.env.HOME, tmpdir: process.env.TMPDIR, envKeys: Object.keys(process.env).sort() }) + '\n')
const after = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }
const output = after('--output'), emb = after('--export-embeddings')
const succeed = () => {
  fs.copyFileSync(path.join(fixtures, 'native.json'), output)
  fs.copyFileSync(path.join(fixtures, 'embeddings.json'), emb)
  process.exit(0)
}
if (args[0] !== 'process' || after('--mode') !== 'offline' || !args.includes('--overlapping-segments') || !output || !emb) {
  process.stderr.write('Error: Unknown option layout\n'); process.exit(64)
}
if (mode === 'success') succeed()
else if (mode === 'crash') { process.stderr.write('Diarization failed: model load\nFluidAudio error: boom\n'); process.exit(1) }
else if (mode === 'hang') setInterval(() => {}, 1000)
else if (mode === 'unknown_option') { process.stderr.write("Error: Unknown option '--export-embeddings'\n"); process.exit(64) }
else if (mode === 'bad_json') { fs.writeFileSync(output, 'not json'); fs.writeFileSync(emb, '[]'); process.exit(0) }
else if (mode === 'slow') setTimeout(succeed, 4000)
else if (mode === 'memory') { const keep = []; for (let i = 0; i < 12; i++) { const b = Buffer.alloc(64 * 1024 * 1024, 1); keep.push(b) } globalThis.keep = keep; setInterval(() => {}, 1000) }
else if (mode === 'probe') {
  // What the sandbox allows: a network connect, and a write next to the meeting audio.
  const result = {}
  const target = fs.readFileSync(path.join(fixtures, 'probe-target.txt'), 'utf8')
  try { fs.writeFileSync(path.join(target, 'written-by-cli.txt'), 'x'); result.audioWrite = 'allowed' } catch (e) { result.audioWrite = e.code }
  try { fs.writeFileSync(path.join(path.dirname(output), 'probe.txt'), 'x'); result.workWrite = 'allowed' } catch (e) { result.workWrite = e.code }
  const s = net.connect({ host: '1.1.1.1', port: 443 })
  const done = v => { result.network = v; fs.appendFileSync(marker, JSON.stringify({ probe: result }) + '\n'); try { s.destroy() } catch {} ; succeed() }
  s.once('connect', () => done('connected'))
  s.once('error', e => done(e.code || 'error'))
  setTimeout(() => done('timeout'), 3000)
}
`

export interface FakeCli { path: string; marker: string; fixtures: string }

/** Writes the fake CLI (a shell wrapper around node) and its fixture outputs under dir. */
export function writeFakeCli(dir: string, mode: FakeCliMode): FakeCli {
  mkdirSync(dir, { recursive: true })
  const fixtures = join(dir, 'fixtures')
  mkdirSync(fixtures, { recursive: true })
  writeFileSync(join(fixtures, 'native.json'), JSON.stringify(syntheticNative()))
  writeFileSync(join(fixtures, 'embeddings.json'), JSON.stringify(syntheticEmbeddings()))
  const script = join(dir, 'fake-cli.cjs')
  writeFileSync(script, SCRIPT)
  const marker = join(dir, 'cli-runs.jsonl')
  const path = join(dir, `fluidaudiocli-${mode}`)
  // Like the real binary's help text, the file names the flags it supports (the worker checks).
  writeFileSync(path, `#!/bin/sh\n# usage: process <wav> --mode <streaming|offline> --overlapping-segments --export-embeddings <file>\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${mode} ${JSON.stringify(fixtures)} ${JSON.stringify(marker)} "$@"\n`)
  chmodSync(path, 0o755)
  return { path, marker, fixtures }
}

/** sandbox-exec stand-in: drops `-p <profile>` and runs the rest. */
export function writePassthroughSandbox(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'sandbox-passthrough')
  writeFileSync(path, '#!/bin/sh\nif [ "$1" = "-p" ]; then shift 2; fi\nexec "$@"\n')
  chmodSync(path, 0o755)
  return path
}
