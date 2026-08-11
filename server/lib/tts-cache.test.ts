import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NOW = 1_777_900_000_000

let cacheDir: string

function writeDiskEntry(hash: string, body?: Buffer): void {
  mkdirSync(cacheDir, { recursive: true })
  const bytes = body ?? Buffer.from(`audio:${hash}`)
  writeFileSync(join(cacheDir, `${hash}.json`), JSON.stringify({
    voice: 'echo',
    format: 'mp3',
    sizeBytes: bytes.length,
    completedAt: NOW,
  }))
  if (body !== undefined) {
    writeFileSync(join(cacheDir, `${hash}.mp3`), body)
  }
}

function writeManyDiskEntries(count: number): string[] {
  const hashes: string[] = []
  for (let i = 0; i < count; i++) {
    const hash = `hash${String(i).padStart(4, '0')}`
    hashes.push(hash)
    writeDiskEntry(hash, Buffer.from(`audio-body-${i}`))
  }
  return hashes
}

async function loadCacheModule() {
  vi.resetModules()
  return import('./tts-cache.js')
}

describe('tts-cache playback invariants', () => {
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'cos-tts-cache-test-'))
    process.env.TTS_DISK_CACHE_DIR = cacheDir
    process.env.TTS_DISK_CACHE_MAX_AGE_DAYS = '0'
  })

  afterEach(() => {
    vi.resetModules()
    delete process.env.TTS_DISK_CACHE_DIR
    delete process.env.TTS_DISK_CACHE_MAX_AGE_DAYS
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('does not evict a hydrated body just because the disk index has more than 50 entries', async () => {
    const hashes = writeManyDiskEntries(60)
    const cache = await loadCacheModule()

    const hit = cache.getCached(hashes[0])

    expect(hit).not.toBeNull()
    expect(Buffer.isBuffer(hit!.bytes)).toBe(true)
    expect(hit!.bytes.toString()).toBe('audio-body-0')
  })

  it('returns a stable buffer after lazy disk hydration even when eviction runs later', async () => {
    const hashes = writeManyDiskEntries(60)
    const cache = await loadCacheModule()

    const hit = cache.getCached(hashes[1])
    const bytes = hit?.bytes
    const stats = cache.getCacheStats()

    expect(bytes).toBeInstanceOf(Buffer)
    expect(bytes!.toString()).toBe('audio-body-1')
    expect(stats.entries).toBe(60)
    expect(stats.totalBytes).toBeGreaterThanOrEqual(0)
  })

  it('waitForInFlight resolves with bytes when completion happens under disk-index pressure', async () => {
    writeManyDiskEntries(60)
    const cache = await loadCacheModule()

    cache.startEntry('live-hash', 'echo', 'mp3')
    const waiting = cache.waitForInFlight('live-hash', 1000)
    cache.appendBytes('live-hash', Buffer.from('fresh-openai-audio'))
    cache.completeEntry('live-hash')

    const served = await waiting
    expect(served).not.toBeNull()
    expect(Buffer.isBuffer(served!.bytes)).toBe(true)
    expect(served!.bytes.toString()).toBe('fresh-openai-audio')
  })

  it('treats a sidecar with a missing body as a miss so playback regenerates cleanly', async () => {
    writeDiskEntry('missing-body')
    const cache = await loadCacheModule()

    expect(cache.getCached('missing-body')).toBeNull()
  })
})
