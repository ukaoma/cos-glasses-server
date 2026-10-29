import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pcm16ToWav } from './nemotron-segments.js'

const roots: string[] = []
afterEach(() => {
  vi.doUnmock('node:fs/promises')
  vi.resetModules()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const vector = [1, ...Array(191).fill(0)]

describe('Mac live publication final caller-side CAS, without native inference', () => {
  for (const changed of ['profile', 'model', 'previously absent ledger'] as const) {
    it(`rejects ${changed} mutation after the adapter's final content checks`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'mac-live-adversarial-')))
      roots.push(root)
      const audioDir = join(root, 'audio')
      mkdirSync(audioDir)
      const modelPath = join(root, 'model.onnx'), profilesPath = join(root, 'profiles.json'), ledgerPath = join(root, 'ledger.jsonl')
      writeFileSync(modelPath, 'fake-model-no-native')
      writeFileSync(profilesPath, JSON.stringify({ profiles: [{ name: 'Avery Example', embeddings: [vector] }] }))
      const chunksIndexed = Array.from({ length: 10 }, (_, i) => {
        const pcm = Buffer.alloc(192000)
        for (let at = 0; at < pcm.length; at += 2) pcm.writeInt16LE(i + 1, at)
        const wav = pcm16ToWav(pcm, 16000)
        writeFileSync(join(audioDir, `chunk_${String(i).padStart(4, '0')}.wav`), wav)
        return { i, c: { speaker: 'Voice 1', text: `Unchanged words ${i}`, elapsed: i * 6000, audioDurationMs: 6000,
          audioSha256: sha(wav), similarity: 0, speakerPolicy: 'high-confidence', segments: [{ speaker: 'Voice 1', text: `Unchanged words ${i}`, startSec: 0, endSec: 6, similarity: 0 }] } }
      })
      let armed = false, firstRawOpens = 0, mutationExecuted = false
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
          const handle = await actual.open(...args)
          if (armed && String(args[0]) === join(audioDir, 'chunk_0000.wav') && ++firstRawOpens === 2) {
            // Second pass: raw0 is first read for planning, then checked again
            // AFTER final model/profile/history content verification. Mutate at
            // its close so the returned raw bytes remain entirely unchanged.
            const close = handle.close.bind(handle)
            handle.close = async () => {
              await close()
              mutationExecuted = true
              if (changed === 'profile') writeFileSync(profilesPath, readFileSync(profilesPath, 'utf8').replace('Avery Example', 'Blake Example'))
              else if (changed === 'model') writeFileSync(modelPath, 'fake-model-CHANGED!!')
              else writeFileSync(ledgerPath, '{"phase":"confirmed"}\n')
            }
          }
          return handle
        } }
      })
      const live = await import('./mac-speaker-live.js')
      const assertBindings = (live as unknown as { assertMacSpeakerLivePublicationBindings?: (bindings: unknown) => void }).assertMacSpeakerLivePublicationBindings
      expect(typeof assertBindings).toBe('function')
      const input = { captureId: 'mac_11111111-1111-4111-8111-111111111111', generation: 'adversarial', audioDir, ledgerPath, chunksIndexed, voiceHighWater: 1 }
      const extract = vi.fn(async () => [vector, vector, vector])
      const deps = { runtime: async () => ({ modelPath, profilesPath }), extract }
      const first = await live.runMacSpeakerLivePass(input, deps)
      expect(first.state?.evidence, first.reason).toHaveLength(1)
      expect(() => assertBindings!((first as any).fileBindings)).not.toThrow()
      armed = true
      const outcome = await live.runMacSpeakerLivePass({ ...input, state: first.state }, deps)
      expect(mutationExecuted).toBe(true)
      expect(extract).toHaveBeenCalledTimes(2)
      // Withholding inside the adapter is also safe. If it returns a qualified
      // candidate, the synchronous caller fence MUST reject publication.
      if (outcome.state?.projections.length) {
        expect(() => assertBindings!((outcome as any).fileBindings)).toThrow()
      } else expect(outcome.completeEligibleSnapshot).toBe(false)
    })
  }
})
