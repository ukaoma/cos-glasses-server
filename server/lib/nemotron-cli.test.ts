import { EventEmitter } from 'node:events'
import { existsSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { NemotronRunError, nemotronArgs, parseNemotronOutput, runNemotronCli } from './nemotron-cli.js'
import { activityOf, predsBytes } from './__fixtures__/nemotron-helpers.js'

type Behaviour = 'ok' | 'exit1' | 'hang' | 'error' | 'short'

function fakeSpawn(behaviour: Behaviour, frames = 601) {
  const calls: Array<{ command: string; args: string[] }> = []
  const killed: string[] = []
  const spawnImpl = (command: string, args: string[]) => {
    calls.push({ command, args })
    const child = new EventEmitter() as ChildProcess & EventEmitter
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    Object.assign(child, { stdout, stderr, pid: undefined, kill: (signal: string) => { killed.push(signal); setImmediate(() => child.emit('close', null, signal)); return true } })
    const preds = args[args.indexOf('--dump-preds') + 1]
    setImmediate(() => {
      if (behaviour === 'error') { child.emit('error', new Error('spawn ENOENT')); return }
      if (behaviour === 'hang') return
      if (behaviour === 'exit1') { stdout.write('Error: modelLoadFailed("Missing learnable_sil_emb.bin")\n'); child.emit('close', 1, null); return }
      const a = activityOf(frames / 100, [[0, 0, frames / 100]])
      const bytes = predsBytes({ frames, probs: a.probs.subarray(0, frames * 8) })
      writeFileSync(preds, behaviour === 'short' ? bytes.subarray(0, 64) : bytes)
      stdout.write(`Model loaded in 0.11s (variant: fast32)\nProcessed 6.0s in 0.06s (RTFx 102.9x), ${frames} x 10ms frames\nDetected 1 speakers, 1 segments\n`)
      child.emit('close', 0, null)
    })
    return child
  }
  return { spawnImpl, calls, killed }
}

const base = { cli: '/bin/fluidaudiocli', modelsDir: '/models', wavPath: '/chunk.wav', timeoutMs: 1500 }

describe('one Nemotron CLI run', () => {
  it('always passes the local models (never the download path) and the Neural Engine', () => {
    const args = nemotronArgs('/c.wav', '/m', '/p.f32', 'ane')
    expect(args).toEqual(['nemotron3-diarize', '/c.wav', '--models', '/m', '--variant', 'fast32', '--compute-units', 'ane', '--threshold', '0.5', '--dump-preds', '/p.f32'])
  })

  it('reads the raw 10 ms probabilities and the model load time', async () => {
    const fake = fakeSpawn('ok')
    const run = await runNemotronCli({ ...base, spawnImpl: fake.spawnImpl as never })
    expect(run.frames).toBe(601)
    expect(run.probs.length).toBe(601 * 8)
    expect(run.probs[0]).toBeCloseTo(0.9)
    expect(run.loadSec).toBe(0.11)
    expect(fake.calls[0].args).toContain('--models')
    // The private temp dir holding the preds is gone afterwards.
    const preds = fake.calls[0].args[fake.calls[0].args.indexOf('--dump-preds') + 1]
    expect(existsSync(preds)).toBe(false)
  })

  it('fallback on failure: a non-zero exit is cli_failed with the CLI tail', async () => {
    const fake = fakeSpawn('exit1')
    await expect(runNemotronCli({ ...base, spawnImpl: fake.spawnImpl as never })).rejects.toMatchObject({ reason: 'cli_failed' })
  })

  it('fallback on timeout: SIGKILL at the budget and a timeout reason', async () => {
    const fake = fakeSpawn('hang')
    const started = Date.now()
    await expect(runNemotronCli({ ...base, timeoutMs: 50, spawnImpl: fake.spawnImpl as never })).rejects.toMatchObject({ reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(fake.killed).toEqual(['SIGKILL'])
  })

  it('a spawn error (missing binary) is spawn_failed', async () => {
    const fake = fakeSpawn('error')
    await expect(runNemotronCli({ ...base, spawnImpl: fake.spawnImpl as never })).rejects.toMatchObject({ reason: 'spawn_failed' })
  })

  it('preds that do not match the frame count are bad_output, never a partial matrix', async () => {
    const fake = fakeSpawn('short')
    await expect(runNemotronCli({ ...base, spawnImpl: fake.spawnImpl as never })).rejects.toMatchObject({ reason: 'bad_output' })
    expect(() => parseNemotronOutput('nothing useful', Buffer.alloc(0))).toThrow(NemotronRunError)
  })
})

it('the real spawn path is used when no spawnImpl is given (a missing binary fails cleanly)', async () => {
  await expect(runNemotronCli({ ...base, cli: '/no/such/fluidaudiocli-binary' })).rejects.toMatchObject({ reason: 'spawn_failed' })
})
