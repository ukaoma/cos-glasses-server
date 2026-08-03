import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  QUARANTINE_MANIFEST,
  RECOVERED_RECEIPT,
  countChunkWavs,
  findQuarantineDir,
  listUnsavedCaptures,
  markRecovered,
  purgeExpiredQuarantine,
  quarantineSessionAudio,
  sweepOrphanedSessionAudio,
  unsavedAudioRetentionMs,
} from './unsaved-audio-quarantine.js'

function scratch(name: string): string {
  const dir = join(tmpdir(), `cos-quarantine-${name}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeSessionDir(root: string, sessionId: string, chunkCount: number): string {
  const dir = join(root, sessionId)
  mkdirSync(dir, { recursive: true })
  for (let index = 0; index < chunkCount; index++) {
    writeFileSync(join(dir, `chunk_${String(index).padStart(4, '0')}.wav`), Buffer.alloc(100, 1))
  }
  return dir
}

describe('unsaved-audio quarantine (6.19.0 P0)', () => {
  it('moves a chunked dir into quarantine with a manifest — the source is gone, nothing deleted', () => {
    const sessionRoot = scratch('move-src')
    const quarantineRoot = scratch('move-dst')
    try {
      const source = makeSessionDir(sessionRoot, 'meeting_123', 3)
      const target = quarantineSessionAudio(source, 'test_reason', quarantineRoot)
      expect(target).not.toBeNull()
      expect(existsSync(source)).toBe(false)
      expect(countChunkWavs(target!)).toBe(3)
      const manifest = JSON.parse(readFileSync(join(target!, QUARANTINE_MANIFEST), 'utf8'))
      expect(manifest.sessionId).toBe('meeting_123')
      expect(manifest.reason).toBe('test_reason')
      expect(manifest.chunkFiles).toBe(3)
      expect(manifest.bytes).toBeGreaterThan(0)
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(quarantineRoot, { recursive: true, force: true })
    }
  })

  it('sweep: quarantines chunked orphans, deletes empty dirs, keeps live and preserved', () => {
    const sessionRoot = scratch('sweep-src')
    const quarantineRoot = scratch('sweep-dst')
    try {
      makeSessionDir(sessionRoot, 'meeting_live', 2)
      makeSessionDir(sessionRoot, 'meeting_preserved', 2)
      makeSessionDir(sessionRoot, 'meeting_orphan', 2)
      makeSessionDir(sessionRoot, 'meeting_empty', 0)

      const actions = sweepOrphanedSessionAudio(sessionRoot, {
        isLive: id => id === 'meeting_live',
        hasFreshPreservedMarker: dirPath => dirPath.endsWith('meeting_preserved'),
        reason: 'test_sweep',
        quarantineRoot,
      })

      const byDir = Object.fromEntries(actions.map(a => [a.dir, a.action]))
      expect(byDir.meeting_live).toBe('kept_live')
      expect(byDir.meeting_preserved).toBe('kept_preserved')
      expect(byDir.meeting_orphan).toBe('quarantined')
      expect(byDir.meeting_empty).toBe('deleted_empty')

      // The orphan's audio survived the sweep, in quarantine.
      expect(existsSync(join(sessionRoot, 'meeting_orphan'))).toBe(false)
      expect(findQuarantineDir('meeting_orphan', quarantineRoot)).not.toBeNull()
      expect(countChunkWavs(findQuarantineDir('meeting_orphan', quarantineRoot)!)).toBe(2)
      // Live and preserved untouched; empty removed.
      expect(existsSync(join(sessionRoot, 'meeting_live'))).toBe(true)
      expect(existsSync(join(sessionRoot, 'meeting_preserved'))).toBe(true)
      expect(existsSync(join(sessionRoot, 'meeting_empty'))).toBe(false)
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(quarantineRoot, { recursive: true, force: true })
    }
  })

  it('lists captures with age, expiry, and the recovered flag', () => {
    const sessionRoot = scratch('list-src')
    const quarantineRoot = scratch('list-dst')
    try {
      const source = makeSessionDir(sessionRoot, 'meeting_listed', 4)
      const target = quarantineSessionAudio(source, 'idle_expiry_unsaved', quarantineRoot)!
      let items = listUnsavedCaptures(quarantineRoot, 72 * 3_600_000)
      expect(items).toHaveLength(1)
      expect(items[0]!.sessionId).toBe('meeting_listed')
      expect(items[0]!.chunkFiles).toBe(4)
      expect(items[0]!.reason).toBe('idle_expiry_unsaved')
      expect(items[0]!.recovered).toBe(false)
      expect(items[0]!.expiresAt).not.toBeNull()

      markRecovered(target, '2026-08-02_recovered.md')
      items = listUnsavedCaptures(quarantineRoot, 72 * 3_600_000)
      expect(items[0]!.recovered).toBe(true)
      expect(existsSync(join(target, RECOVERED_RECEIPT))).toBe(true)
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(quarantineRoot, { recursive: true, force: true })
    }
  })

  it('purges only captures past the retention clock — retention is the sole deleter', () => {
    const sessionRoot = scratch('purge-src')
    const quarantineRoot = scratch('purge-dst')
    try {
      const freshSource = makeSessionDir(sessionRoot, 'meeting_fresh', 1)
      quarantineSessionAudio(freshSource, 'fresh', quarantineRoot)
      const oldSource = makeSessionDir(sessionRoot, 'meeting_old', 1)
      const oldTarget = quarantineSessionAudio(oldSource, 'old', quarantineRoot)!
      // Backdate the old capture's manifest beyond retention.
      const manifestPath = join(oldTarget, QUARANTINE_MANIFEST)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.quarantinedAt = new Date(Date.now() - 100 * 3_600_000).toISOString()
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)

      const purged = purgeExpiredQuarantine(quarantineRoot, 72 * 3_600_000)
      expect(purged).toHaveLength(1)
      expect(purged[0]).toContain('meeting_old')
      expect(findQuarantineDir('meeting_old', quarantineRoot)).toBeNull()
      expect(findQuarantineDir('meeting_fresh', quarantineRoot)).not.toBeNull()
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(quarantineRoot, { recursive: true, force: true })
    }
  })

  it('collision on re-quarantine gets a suffixed dir, and findQuarantineDir still resolves it', () => {
    const sessionRoot = scratch('collide-src')
    const quarantineRoot = scratch('collide-dst')
    try {
      const first = makeSessionDir(sessionRoot, 'meeting_dup', 1)
      quarantineSessionAudio(first, 'first', quarantineRoot)
      const second = makeSessionDir(sessionRoot, 'meeting_dup', 2)
      const target = quarantineSessionAudio(second, 'second', quarantineRoot)
      expect(target).not.toBeNull()
      expect(target!).toMatch(/meeting_dup\.\d+$/)
      expect(listUnsavedCaptures(quarantineRoot, 72 * 3_600_000)).toHaveLength(2)
      expect(findQuarantineDir('meeting_dup', quarantineRoot)).not.toBeNull()
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(quarantineRoot, { recursive: true, force: true })
    }
  })

  it('retention env is clamped to a sane range and defaults to 72h', () => {
    expect(unsavedAudioRetentionMs({} as NodeJS.ProcessEnv)).toBe(72 * 3_600_000)
    // An EMPTY value must mean unset (72h), never Number('')===0 → 1h clamp.
    expect(unsavedAudioRetentionMs({ COS_UNSAVED_AUDIO_RETENTION_HOURS: '' } as unknown as NodeJS.ProcessEnv))
      .toBe(72 * 3_600_000)
    expect(unsavedAudioRetentionMs({ COS_UNSAVED_AUDIO_RETENTION_HOURS: '   ' } as unknown as NodeJS.ProcessEnv))
      .toBe(72 * 3_600_000)
    expect(unsavedAudioRetentionMs({ COS_UNSAVED_AUDIO_RETENTION_HOURS: '24' } as unknown as NodeJS.ProcessEnv))
      .toBe(24 * 3_600_000)
    expect(unsavedAudioRetentionMs({ COS_UNSAVED_AUDIO_RETENTION_HOURS: '0' } as unknown as NodeJS.ProcessEnv))
      .toBe(1 * 3_600_000)
    expect(unsavedAudioRetentionMs({ COS_UNSAVED_AUDIO_RETENTION_HOURS: '99999' } as unknown as NodeJS.ProcessEnv))
      .toBe(720 * 3_600_000)
    expect(unsavedAudioRetentionMs({ COS_UNSAVED_AUDIO_RETENTION_HOURS: 'nope' } as unknown as NodeJS.ProcessEnv))
      .toBe(72 * 3_600_000)
  })
})
