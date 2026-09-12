// 6.45.3 — yesterday's finished sessions are archived at the local day rollover,
// not a day later. Executes against a scratch COS_DATA_DIR with fake time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tmp = ''
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  tmp = mkdtempSync(join(tmpdir(), 'cos-mirror-'))
  process.env.COS_DATA_DIR = tmp
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.resetModules()
  delete process.env.COS_DATA_DIR
  rmSync(tmp, { recursive: true, force: true })
})

const lateEvening = new Date(2026, 8, 11, 23, 50, 0).getTime()

describe('archive mirror at the local day rollover (6.45.3)', () => {
  it('aims the timer at thirty seconds past the next local midnight', async () => {
    vi.setSystemTime(lateEvening)
    const { msUntilNextLocalDay } = await import('./conversation.js')
    expect(msUntilNextLocalDay(lateEvening)).toBe(10 * 60_000 + 30_000)
    // Just after midnight the next rollover is tomorrow's: a day and a second away, never a same-day re-run.
    expect(msUntilNextLocalDay(new Date(2026, 8, 12, 0, 0, 29).getTime())).toBe(24 * 60 * 60_000 + 1_000)
  })

  it('files a session finished yesterday on the first read after midnight, once', async () => {
    vi.setSystemTime(lateEvening)
    const conversation = await import('./conversation.js')
    const archive = await import('./archive.js')
    await vi.advanceTimersByTimeAsync(0) // let the boot mirror settle on a store with nothing to file
    const sessionId = conversation.createSession()
    conversation.addExchange(sessionId, 'user', 'Explain it to me like I am five.', 134)
    conversation.addExchange(sessionId, 'assistant', 'The phone forgets the model because the app opens at a new address.', 134)
    expect(archive.loadArchive('2026-09-11')).toBeNull()

    vi.setSystemTime(new Date(2026, 8, 12, 0, 0, 5).getTime())
    conversation.__resetArchiveMirrorForTests()
    expect(await conversation.ensureArchiveMirrorForDay()).toBe(true)
    const day = archive.loadArchive('2026-09-11')
    expect(day).not.toBeNull()
    expect(JSON.stringify(day)).toContain('Explain it to me like I am five.')
    expect(readFileSync(join(tmp, 'archive', '2026-09-11.json'), 'utf8')).toContain(sessionId)
    // Same day again: nothing to do, and no second run.
    expect(await conversation.ensureArchiveMirrorForDay()).toBe(false)
  })

  it('never files today: a live session stays live until the day turns', async () => {
    vi.setSystemTime(lateEvening)
    const conversation = await import('./conversation.js')
    const archive = await import('./archive.js')
    await vi.advanceTimersByTimeAsync(0)
    const sessionId = conversation.createSession()
    conversation.addExchange(sessionId, 'user', 'still today', 1)
    conversation.addExchange(sessionId, 'assistant', 'yes', 1)
    conversation.__resetArchiveMirrorForTests()
    await conversation.ensureArchiveMirrorForDay()
    expect(archive.loadArchive('2026-09-11')).toBeNull()
  })

  it('the midnight timer files yesterday by itself', async () => {
    vi.setSystemTime(lateEvening)
    const conversation = await import('./conversation.js')
    const archive = await import('./archive.js')
    await vi.advanceTimersByTimeAsync(0)
    const sessionId = conversation.createSession()
    conversation.addExchange(sessionId, 'user', 'timer case', 2)
    conversation.addExchange(sessionId, 'assistant', 'ok', 2)
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 31_000)
    expect(archive.loadArchive('2026-09-11')).not.toBeNull()
  })

  it('the day routes ask for the mirror before they answer', () => {
    const sessions = readFileSync(new URL('../routes/sessions.ts', import.meta.url).pathname, 'utf8')
    const today = sessions.slice(sessions.indexOf("sessionsRouter.get('/sessions/today/all-messages'"), sessions.indexOf('const archivedMessages = getArchiveDayMessages(todayDate)'))
    expect(today).toContain('await ensureArchiveMirrorForDay()')
    const archiveRoutes = readFileSync(new URL('../routes/archive.ts', import.meta.url).pathname, 'utf8')
    const listing = archiveRoutes.slice(archiveRoutes.indexOf("archiveRouter.get('/archive',"), archiveRoutes.indexOf('refreshArchiveIndex('))
    expect(listing).toContain('await ensureArchiveMirrorForDay()')
  })
})
