// The real thing, end to end: the TypeScript timeline, the real fluidaudiocli under the real
// sandbox with network denied, the real pinned models, and the port's gates, on a real meeting.
// Off by default (skipped). It needs the private parity bundle and about 20 s of Neural Engine:
//
//   COS_SPEAKER_SHADOW_E2E=1 COS_SPEAKER_SHADOW_PARITY_DIR=~/cos-release-candidates/server-6.95.0-speaker-shadow/parity \
//     npx vitest run server/lib/speaker-shadow-e2e.test.ts
//
// <name>-e2e.json names the research copies it reads (read only). It writes only to a temp dir.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runShadowJob } from './speaker-shadow-worker.js'
import { round3View } from './__fixtures__/speaker-shadow/round3-view.js'

const dir = process.env.COS_SPEAKER_SHADOW_PARITY_DIR?.trim()
const configs = process.env.COS_SPEAKER_SHADOW_E2E === '1' && dir && existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('-e2e.json')) : []

describe.skipIf(!configs.length)('speaker shadow end to end with the real CLI (private fixtures)', () => {
  for (const name of configs) {
    it(`reproduces round 3 on ${name.replace(/-e2e\.json$/, '')}`, async () => {
      const cfg = JSON.parse(readFileSync(join(dir!, name), 'utf8'))
      const manifest = JSON.parse(readFileSync(cfg.manifest, 'utf8'))
      const labels = JSON.parse(readFileSync(cfg.labels, 'utf8'))
      const placed = new Map<number, any>(manifest.rawSources.map((x: any) => [x.rawChunkIndex, x]))
      // The saved sidecar's labels and clocks (elapsed = startSample / 16 places each original where the canary did).
      const chunkEntries = labels.entries.map((e: any) => {
        const x = placed.get(e.chunkIndex)
        return { chunkIndex: e.chunkIndex, chunk: { text: '', speaker: e.speaker, elapsed: x.startSample / 16, similarity: 0, ...(x.sidecarAudioSHA256 ? { audioSha256: x.sidecarAudioSHA256 } : {}), segments: e.segments } }
      })
      // Created here, not at import: a file whose tests are all skipped never runs afterAll.
      const work = mkdtempSync(join(tmpdir(), 'speaker-shadow-e2e-'))
      try {
        const sidecarPath = join(work, 'meeting.g2-chunks.json')
        writeFileSync(sidecarPath, JSON.stringify({ sessionId: manifest.sessionId, sourceType: 'mac_system_audio', finalizationState: 'complete', chunkEntries }))
        const tmpRoot = join(work, 'tmp')
        mkdirSync(tmpRoot)
        const outcome = await runShadowJob({
          sessionId: manifest.sessionId, sidecarPath, audioDir: cfg.audioDir, expectedLabelsHash: null,
          cliPath: cfg.cliPath, cliSha256: cfg.cliSha256, sandboxExec: '/usr/bin/sandbox-exec', modelsDir: cfg.modelsDir,
          // A persistent HOME in the private bundle keeps CoreML warm: a cold one leaves empty OS temp dirs.
          homeDir: cfg.homeDir ?? join(work, 'home'), tmpRoot, cliTimeoutMs: 175_000,
        })
        expect(outcome.status).toBe('proposed')
        if (outcome.status !== 'proposed') return
        expect(outcome.facts.timelinePCMSHA256).toBe(cfg.timelinePCMSHA256)
        expect(outcome.facts.timelineWAVSHA256).toBe(cfg.timelineWAVSHA256)
        expect(round3View(outcome.proposals)).toEqual(round3View(JSON.parse(readFileSync(cfg.expected, 'utf8'))))
        expect(readdirSync(tmpRoot)).toEqual([])
      } finally { rmSync(work, { recursive: true, force: true }) }
    }, 240_000)
  }
})
