// S1 (2026-11-09): the opt-in disk I/O meter counts by folded path and changes nothing else.
import { afterEach, describe, expect, it, vi } from 'vitest'
import fsDefault from 'node:fs'
import fsPromisesDefault from 'node:fs/promises'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, appendFileSync, writeSync } from 'node:fs'
import { writeFile as writeFileAsync, readFile as readFileAsync } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { diskIoMeterRequested, diskIoSnapshot, foldPath, installDiskIoMeter, reportDiskIo, uninstallDiskIoMeter } from './disk-io-meter.js'

const dirs: string[] = []
afterEach(() => {
  uninstallDiskIoMeter()
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('disk I/O meter (S1)', () => {
  it('is off unless COS_DISK_IO_METER=1', () => {
    expect(diskIoMeterRequested({})).toBe(false)
    expect(diskIoMeterRequested({ COS_DISK_IO_METER: 'true' })).toBe(false)
    expect(diskIoMeterRequested({ COS_DISK_IO_METER: '1' })).toBe(true)
    expect(diskIoSnapshot()).toBeNull()
  })

  it('counts writes and reads through bindings imported BEFORE it was installed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'cos-disk-io-')); dirs.push(dir)
    expect(installDiskIoMeter({ reportEveryMs: 0 })).toBe(true)
    expect(installDiskIoMeter({ reportEveryMs: 0 })).toBe(false) // idempotent
    const journal = join(dir, 'journal.json')
    writeFileSync(`${journal}.tmp`, 'x'.repeat(1000))  // an atomic write's temp file folds into the target
    writeFileSync(journal, 'y'.repeat(500))
    appendFileSync(join(dir, 'ledger.jsonl'), 'z'.repeat(100))
    const fd = openSync(join(dir, 'raw.bin'), 'w')
    writeSync(fd, Buffer.alloc(64))
    closeSync(fd)
    await writeFileAsync(join(dir, 'async.json'), 'a'.repeat(10))
    expect(readFileSync(journal, 'utf8')).toBe('y'.repeat(500)) // results pass through untouched
    expect(await readFileAsync(journal, 'utf8')).toBe('y'.repeat(500))
    const snap = diskIoSnapshot()!
    const byPath = Object.fromEntries(snap.topWrites.map(r => [r.path, r]))
    expect(byPath[foldPath(journal)]).toEqual({ path: foldPath(journal), bytes: 1500, ops: 2 })
    expect(byPath[foldPath(join(dir, 'ledger.jsonl'))].bytes).toBe(100)
    expect(byPath[foldPath(join(dir, 'raw.bin'))].bytes).toBe(64)
    expect(byPath[foldPath(join(dir, 'async.json'))].bytes).toBe(10)
    expect(snap.wroteBytes).toBe(1674)
    expect(snap.readBytes).toBe(1000)
  })

  it('errors pass through unchanged and are not counted', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    installDiskIoMeter({ reportEveryMs: 0 })
    expect(() => writeFileSync('/nonexistent-dir-cos/x.json', 'data')).toThrow(/ENOENT/)
    expect(diskIoSnapshot()!.wroteBytes).toBe(0)
  })

  it('uninstall restores the originals', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'cos-disk-io-')); dirs.push(dir)
    const originals = [fsDefault.writeFileSync, fsDefault.appendFileSync, fsDefault.writeSync, fsDefault.openSync,
      fsDefault.closeSync, fsDefault.readFileSync, fsDefault.readSync, fsPromisesDefault.writeFile, fsPromisesDefault.readFile]
    installDiskIoMeter({ reportEveryMs: 0 })
    expect(fsDefault.writeFileSync).not.toBe(originals[0])
    uninstallDiskIoMeter()
    expect([fsDefault.writeFileSync, fsDefault.appendFileSync, fsDefault.writeSync, fsDefault.openSync,
      fsDefault.closeSync, fsDefault.readFileSync, fsDefault.readSync, fsPromisesDefault.writeFile, fsPromisesDefault.readFile]).toEqual(originals)
    expect(writeFileSync).toBe(originals[0]) // the ESM named binding is restored too
    writeFileSync(join(dir, 'after.json'), 'q')
    expect(diskIoSnapshot()).toBeNull()
  })

  it('folds ids, hashes and temp suffixes so one store is one row', () => {
    const home = homedir()
    expect(foldPath(`${home}/.cos-glasses/data/active-sessions/meeting_1793835552487_18zrgs.json`)).toBe('~/.cos-glasses/data/active-sessions/meeting_*.json')
    expect(foldPath(`${home}/.cos-glasses/data/.reviews.json.4242.a1b2c3d4e5f6.tmp`)).toBe('~/.cos-glasses/data/.reviews.json')
    expect(foldPath('/tmp/cos-whisper-hq-3f2a9c1d.wav')).toBe('/tmp/cos-whisper-hq-*.wav')
  })

  it('reports one line and starts a new window', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'cos-disk-io-')); dirs.push(dir)
    installDiskIoMeter({ reportEveryMs: 0 })
    writeFileSync(join(dir, 'a.json'), 'x'.repeat(2_000_000))
    const lines: string[] = []
    const report = reportDiskIo(line => lines.push(line))!
    expect(report.wroteBytes).toBe(2_000_000)
    expect(lines[0]).toMatch(/^\[disk-io\] \d+ min: wrote 2\.0 MB in 1 writes, read 0\.0 MB in 0 reads; top writes: .*a\.json 2\.0 MB \(1\)/)
    expect(diskIoSnapshot()!.wroteBytes).toBe(0)
    log.mockRestore()
  })
})
