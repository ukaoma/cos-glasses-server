// Bounded read-only clock diagnostics. File dates and timestamps are not alignment proof.
import { open, readdir, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

export interface ShadowPairSource {
  status: 'time_only' | 'ambiguous' | 'unpaired'
  reason: string
  sessionId?: string
  sourceSha256?: string
  g2?: { startTime: number; chunks: Array<{ speaker: string; elapsed: number; audioDurationMs: number }> }
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
function bounds(value: Record<string, unknown>, durationOverride?: number): [number, number] | null {
  if (!finite(value.startTime) || !Array.isArray(value.chunks)) return null
  const duration = durationOverride ?? value.durationMs
  if (!finite(duration) || duration <= 0 || duration > 4 * 3600_000) return null
  return [value.startTime, value.startTime + duration]
}
const day = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
/** Only the current recording directory is searched; absent cross-month pairs remain unpaired. */
export async function findShadowPairSource(sidecarPath: string, mac: Record<string, unknown>, durationMs?: number): Promise<ShadowPairSource> {
  const target = bounds(mac, durationMs)
  if (!target) return { status: 'unpaired', reason: 'invalid Mac clock or duration' }
  const dir = dirname(sidecarPath)
  // Official sidecars use this Mac's local calendar-day prefix. Include a four-hour
  // lookback for a G2 capture that started before this Mac capture (maximum call length).
  const days = new Set([day(target[0] - 4 * 3600_000), day(target[0]), day(target[1])])
  const all = await readdir(dir)
  const names = all.filter(n => n.endsWith('.g2-chunks.json') && n !== basename(sidecarPath))
    .filter(n => { const prefix = n.match(/^(\d{4}-\d{2}-\d{2})_/); return !prefix || days.has(prefix[1]) }).sort()
  if (names.length > 256) return { status: 'ambiguous', reason: 'day-window discovery file limit exceeded; no pair selected' }
  let bytes = 0, estimated = false
  const candidates: ShadowPairSource[] = []
  for (const name of names) {
    const path = join(dir, name)
    let raw: string, value: Record<string, unknown>
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'ambiguous', reason: 'unreadable day-window candidate; no pair selected' }
      if (stat.size > 16 * 1024 * 1024 || bytes + stat.size > 128 * 1024 * 1024) return { status: 'ambiguous', reason: 'day-window discovery byte limit exceeded; no pair selected' }
      const parts: Buffer[] = []
      let size = 0
      // A candidate can change between lstat and open. Never wait on a FIFO/device
      // substituted in that interval; verify the actual descriptor before reading.
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        if (!(await handle.stat()).isFile()) throw new Error('candidate is no longer a regular file')
        const buffer = Buffer.alloc(64 * 1024)
        while (true) {
          const { bytesRead } = await handle.read(buffer)
          if (!bytesRead) break
          size += bytesRead
          if (size > 16 * 1024 * 1024 || bytes + size > 128 * 1024 * 1024) throw new Error('candidate grew beyond byte budget')
          parts.push(Buffer.from(buffer.subarray(0, bytesRead)))
        }
      } finally { await handle.close() }
      raw = Buffer.concat(parts).toString('utf8')
      bytes += size
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024 || bytes > 128 * 1024 * 1024) return { status: 'ambiguous', reason: 'day-window discovery changed beyond byte limit; no pair selected' }
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid sidecar')
      value = parsed as Record<string, unknown>
      if (typeof value.sessionId !== 'string') throw new Error('missing source identity')
    } catch { return { status: 'ambiguous', reason: 'unreadable or malformed day-window candidate; no pair selected' } }
    if (typeof value.sessionId !== 'string' || !value.sessionId.startsWith('meeting_') || value.finalizationState !== 'complete') continue
    const span = bounds(value)
    if (!span) return { status: 'ambiguous', reason: 'complete G2 candidate lacks valid clock/duration; no pair selected' }
    const overlap = Math.max(0, Math.min(target[1], span[1]) - Math.max(target[0], span[0]))
    const macDuration = target[1] - target[0], g2Duration = span[1] - span[0]
    if (overlap / Math.max(macDuration, g2Duration) < .5 || Math.min(macDuration, g2Duration) / Math.max(macDuration, g2Duration) < .5) continue
    const chunks: NonNullable<ShadowPairSource['g2']>['chunks'] = []
    for (const item of value.chunks as unknown[]) {
      if (!item || typeof item !== 'object') return { status: 'ambiguous', reason: 'invalid G2 chunk; no pair selected' }
      const row = item as Record<string, unknown>
      if (typeof row.speaker !== 'string' || !finite(row.elapsed) || row.elapsed < 0) return { status: 'ambiguous', reason: 'invalid G2 timing or label; no pair selected' }
      const exactDuration = row.audioDurationMs ?? row.durationMs
      if (exactDuration !== undefined && (!finite(exactDuration) || exactDuration <= 0 || (row.audioDurationMs !== undefined && row.durationMs !== undefined && row.audioDurationMs !== row.durationMs))) return { status: 'ambiguous', reason: 'invalid G2 duration; no pair selected' }
      // Historical G2 sidecars lack chunk durations: disclose the fixed-window
      // approximation. This function can NEVER qualify alignment or transfer a name.
      const duration = exactDuration === undefined ? 6000 : exactDuration as number
      estimated ||= exactDuration === undefined
      chunks.push({ speaker: row.speaker, elapsed: row.elapsed, audioDurationMs: duration })
    }
    candidates.push({ status: 'time_only', reason: '', sessionId: value.sessionId, sourceSha256: createHash('sha256').update(raw).digest('hex'), g2: { startTime: span[0], chunks } })
  }
  const scope = `Day-window scan: ${names.length} files, ${bytes} bytes, current directory only.`
  return candidates.length === 1 ? { ...candidates[0], reason: `Clock overlap only; text offset/drift alignment has not been qualified. G2 names are estimates.${estimated ? ' G2 chunk durations use an approximate 6-second window where absent.' : ''} ${scope}` }
    : { status: candidates.length ? 'ambiguous' : 'unpaired', reason: `${candidates.length ? `${candidates.length} overlapping G2 candidates; no pair chosen` : 'no complete overlapping G2 capture'}. ${scope}` }
}
