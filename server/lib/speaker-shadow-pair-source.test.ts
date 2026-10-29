import { it, expect, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findShadowPairSource } from './speaker-shadow-pair-source.js'
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat) }
})

it('refuses a regular-file-to-FIFO replacement without waiting for a writer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadow-pair-race-'))
  const candidate = join(dir, 'race.g2-chunks.json')
  const regular = join(dir, 'regular.json')
  try {
    await writeFile(regular, '{}')
    const staleStat = await fs.lstat(regular)
    execFileSync('mkfifo', [candidate])
    // Simulate lstat observing the regular file immediately before replacement.
    vi.mocked(fs.lstat).mockResolvedValueOnce(staleStat)
    try {
      const result = await findShadowPairSource(join(dir, 'mac.json'), { startTime: 100000, durationMs: 12000, chunks: [] })
      expect(result).toMatchObject({ status: 'ambiguous', reason: expect.stringContaining('unreadable') })
    } finally { vi.mocked(fs.lstat).mockClear() }
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 2000)
it('discovers only one complete G2 pair, hashes evidence, and refuses ambiguous pairs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadow-pair-'))
  const mac = { startTime: 100000, durationMs: 12000, chunks: [{ elapsed: 0, audioDurationMs: 6000 }, { elapsed: 6000, audioDurationMs: 6000 }] }
  try {
    expect((await findShadowPairSource(join(dir, 'mac.json'), mac)).status).toBe('unpaired')
    const g2 = { ...mac, sessionId: 'meeting_1', finalizationState: 'complete', chunks: mac.chunks.map(c => ({ ...c, speaker: 'Person' })) }
    await writeFile(join(dir, 'a.g2-chunks.json'), JSON.stringify(g2))
    const paired = await findShadowPairSource(join(dir, 'mac.json'), mac)
    expect(paired.status).toBe('time_only'); expect(paired.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
    await writeFile(join(dir, 'b.g2-chunks.json'), JSON.stringify({ ...g2, sessionId: 'meeting_2' }))
    expect((await findShadowPairSource(join(dir, 'mac.json'), mac)).status).toBe('ambiguous')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('does not choose a remaining pair after an unreadable candidate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadow-pair-'))
  const mac = { startTime: 100000, durationMs: 12000, chunks: [] }
  try {
    await writeFile(join(dir, 'a.g2-chunks.json'), JSON.stringify({ ...mac, sessionId: 'meeting_1', finalizationState: 'complete' }))
    await writeFile(join(dir, 'b.g2-chunks.json'), '{bad')
    expect(await findShadowPairSource(join(dir, 'mac.json'), mac)).toMatchObject({ status: 'ambiguous', reason: expect.stringContaining('malformed') })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('scopes official dated files to the call window, excludes its own large sidecar, and discloses approximate durations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadow-pair-'))
  const startTime = new Date(2026, 9, 29, 10).getTime()
  const mac = { startTime, durationMs: 12000, chunks: [] }
  const path = join(dir, '2026-10-29_mac.g2-chunks.json')
  try {
    await writeFile(path, 'x'.repeat(17 * 1024 * 1024))
    await writeFile(join(dir, '2026-10-01_old.g2-chunks.json'), '{bad')
    await writeFile(join(dir, '2026-10-29_g2.g2-chunks.json'), JSON.stringify({ ...mac, sessionId: 'meeting_1', finalizationState: 'complete', chunks: [{ elapsed: 0, speaker: 'Avery' }] }))
    const pair = await findShadowPairSource(path, mac)
    expect(pair).toMatchObject({ status: 'time_only', g2: { chunks: [{ elapsed: 0, speaker: 'Avery', audioDurationMs: 6000 }] } })
    expect(pair.reason).toContain('approximate 6-second')
    expect(pair.reason).toContain('1 files')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('keeps active and non-overlapping captures unpaired and refuses corrupt G2 clocks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadow-pair-'))
  const mac = { startTime: 100000, durationMs: 12000, chunks: [] }
  const path = join(dir, 'g2.g2-chunks.json')
  try {
    const g2 = { ...mac, sessionId: 'meeting_1', finalizationState: 'recording' }
    await writeFile(path, JSON.stringify(g2))
    expect((await findShadowPairSource(join(dir, 'mac.json'), mac)).status).toBe('unpaired')
    await writeFile(path, JSON.stringify({ ...g2, finalizationState: 'complete', startTime: 200000 }))
    expect((await findShadowPairSource(join(dir, 'mac.json'), mac)).status).toBe('unpaired')
    await writeFile(path, JSON.stringify({ ...g2, finalizationState: 'complete', durationMs: null }))
    expect((await findShadowPairSource(join(dir, 'mac.json'), mac)).status).toBe('ambiguous')
    expect((await findShadowPairSource(join(dir, 'mac.json'), { ...mac, durationMs: -1 })).status).toBe('unpaired')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
