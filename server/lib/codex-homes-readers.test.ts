// Key lanes K1 P4 (plan v4 8.2): codexHomes() and every reader that finds Codex threads. Each
// reader, given a fixture profile home, finds the keyed thread; with key lanes off, or no
// profile home, each one is exactly what it was (one home, no new field). Scratch HOME,
// COS_DATA_DIR and COS_AGENT_SESSIONS_HOME; the user's ~/.codex is never named.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const scratch = vi.hoisted(() => {
  const root = `/tmp/cos-p4-readers-${process.pid}-${Date.now()}`
  process.env.COS_DATA_DIR = `${root}/data`
  process.env.COS_AGENT_SESSIONS_HOME = `${root}/home`
  process.env.CODEX_HOME = `${root}/home/.codex`
  return { root }
})

import {
  codexHomes,
  codexProfileHome,
  isProfileCodexThread,
  profileCodexHomes,
  profileIdForCodexPath,
  serverCodexHome,
} from './codex-homes.js'
import { agentSessionRoots, findAgentSessionFile, listAgentSessions } from './agent-session-store.js'
import { realNativeHeadDeps, realNativeHeadDirs, transcriptPathFor } from './native-head.js'
import { nativeQueuedCounts } from './codex-queue-control.js'
import { realOccupancyDirs } from './occupancy-probes.js'
import { codexOwnersAcrossHomes, type OccupancyProbes } from './thread-occupancy.js'
import { parseHookEnvelope, inferHookProvider } from './session-hook-events.js'
import { deliverOverCodexQueue } from './codex-live-queue.js'
import { codexGistModelsFromCache } from './lens-gist.js'
import { __resetKeyLanesForTests } from './key-lanes.js'

const ROOT = scratch.root
const HOME = join(ROOT, 'home')
const DATA = process.env.COS_DATA_DIR!
const SERVER_CODEX = join(HOME, '.codex')
const KEYED_ID = '019f2222-3333-4444-5555-666666666666'
const PLAIN_ID = '019f1111-2222-3333-4444-555555555555'
const NOW = new Date('2026-10-19T19:00:00Z')

function rollout(home: string, id: string, label: string): string {
  const day = join(home, 'sessions', '2026', '10', '19')
  mkdirSync(day, { recursive: true })
  const file = join(day, `rollout-2026-10-19T18-00-00-${id}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/repo', timestamp: '2026-10-19T18:00:00Z' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: label }] } })}\n`)
  utimesSync(file, NOW, NOW)
  writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id, thread_name: label }) + '\n')
  return file
}

function lanesOn(): void {
  process.env.COS_KEY_LANES = '1'
  __resetKeyLanesForTests()
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(DATA, { recursive: true })
  mkdirSync(SERVER_CODEX, { recursive: true })
  delete process.env.COS_KEY_LANES
  __resetKeyLanesForTests()
})
afterEach(() => {
  delete process.env.COS_KEY_LANES
  __resetKeyLanesForTests()
})

describe('codexHomes()', () => {
  it('is exactly the server home with key lanes off, even with profile homes on disk', () => {
    mkdirSync(codexProfileHome('gpt-key'), { recursive: true })
    expect(codexHomes(SERVER_CODEX)).toEqual([SERVER_CODEX])
    process.env.COS_KEY_LANES = '0'
    __resetKeyLanesForTests()
    expect(codexHomes(SERVER_CODEX)).toEqual([SERVER_CODEX])
  })

  it('with lanes on and no profile home, is the server home and creates nothing', () => {
    lanesOn()
    expect(codexHomes(SERVER_CODEX)).toEqual([SERVER_CODEX])
    expect(profileCodexHomes()).toEqual([])
    expect(() => execFileSync('/bin/test', ['-e', join(DATA, 'codex-homes')])).toThrow()
  })

  it('lists the server home FIRST, then each profile home by id, skipping symlinks, files and bad names', () => {
    lanesOn()
    for (const id of ['zeta', 'alpha']) mkdirSync(codexProfileHome(id), { recursive: true })
    mkdirSync(join(ROOT, 'elsewhere'), { recursive: true })
    symlinkSync(join(ROOT, 'elsewhere'), join(DATA, 'codex-homes', 'linked'))
    writeFileSync(join(DATA, 'codex-homes', 'afile'), 'x')
    mkdirSync(join(DATA, 'codex-homes', 'Bad Name'), { recursive: true })
    expect(codexHomes(SERVER_CODEX)).toEqual([SERVER_CODEX, codexProfileHome('alpha'), codexProfileHome('zeta')])
    expect(codexHomes()[0]).toBe(serverCodexHome())
  })

  it('names the profile of a path only under the real homes root', () => {
    expect(profileIdForCodexPath(join(DATA, 'codex-homes', 'gpt-key', 'sessions', 'x.jsonl'))).toBe('gpt-key')
    expect(profileIdForCodexPath('/Users/someone/codex-homes/gpt-key/sessions/x.jsonl')).toBeUndefined()
    expect(profileIdForCodexPath(join(DATA, 'codex-homes', '..', 'x'))).toBeUndefined()
    expect(profileIdForCodexPath(42)).toBeUndefined()
  })

  it('finds which profile holds a thread, and nothing with lanes off', () => {
    rollout(codexProfileHome('gpt-key'), KEYED_ID, 'keyed')
    expect(isProfileCodexThread(KEYED_ID)).toBe(false)
    lanesOn()
    expect(isProfileCodexThread(KEYED_ID)).toBe(true)
    expect(isProfileCodexThread(PLAIN_ID)).toBe(false)
    expect(isProfileCodexThread('not-a-thread')).toBe(false)
  })
})

describe('session store (agent-session-store.ts)', () => {
  it('has no new roots field with lanes off', () => {
    mkdirSync(codexProfileHome('gpt-key'), { recursive: true })
    expect('codexProfileSessions' in agentSessionRoots()).toBe(false)
  })

  it('lists and finds a keyed thread in its profile home, after the server home', async () => {
    rollout(SERVER_CODEX, PLAIN_ID, 'subscription thread')
    rollout(codexProfileHome('gpt-key'), KEYED_ID, 'keyed thread')
    const before = await listAgentSessions(agentSessionRoots(), NOW, [], 20, 'updated')
    expect(before.map(r => r.session_id)).toContain(PLAIN_ID)
    expect(before.map(r => r.session_id)).not.toContain(KEYED_ID)
    expect(await findAgentSessionFile('codex', KEYED_ID, agentSessionRoots(), NOW)).toBeNull()

    lanesOn()
    const roots = agentSessionRoots()
    expect(roots.codexProfileSessions).toEqual([join(codexProfileHome('gpt-key'), 'sessions')])
    const rows = await listAgentSessions(roots, NOW, [], 20, 'updated')
    expect(rows.map(r => r.session_id)).toEqual(expect.arrayContaining([PLAIN_ID, KEYED_ID]))
    expect(await findAgentSessionFile('codex', KEYED_ID, roots, NOW)).toContain(join('codex-homes', 'gpt-key', 'sessions'))
    expect(await findAgentSessionFile('codex', PLAIN_ID, roots, NOW)).toContain(join('.codex', 'sessions'))
  })
})

describe('native head (native-head.ts)', () => {
  it('resolves a keyed rollout only once its home is a reader home', () => {
    const file = rollout(codexProfileHome('gpt-key'), KEYED_ID, 'keyed')
    expect('codexProfileSessionsDirs' in realNativeHeadDirs()).toBe(false)
    expect(transcriptPathFor('codex', KEYED_ID, realNativeHeadDeps())).toBeNull()
    lanesOn()
    expect(transcriptPathFor('codex', KEYED_ID, realNativeHeadDeps())).toBe(file)
  })

  it('keeps the server home first', () => {
    const plain = rollout(SERVER_CODEX, PLAIN_ID, 'plain')
    rollout(codexProfileHome('gpt-key'), KEYED_ID, 'keyed')
    lanesOn()
    expect(transcriptPathFor('codex', PLAIN_ID, realNativeHeadDeps())).toBe(plain)
  })
})

describe('queue counts (codex-queue-control.ts)', () => {
  function queueDb(home: string, rows: Array<[string, number]>): void {
    mkdirSync(home, { recursive: true })
    const sql = ['CREATE TABLE queued_items (thread_id TEXT);', ...rows.flatMap(([t, n]) => Array.from({ length: n }, () => `INSERT INTO queued_items VALUES ('${t}');`))].join('\n')
    execFileSync('/usr/bin/sqlite3', [join(home, 'queue_1.sqlite'), sql])
  }

  it('reads only the server home with lanes off, and adds profile homes with lanes on', async () => {
    queueDb(SERVER_CODEX, [[PLAIN_ID, 2]])
    queueDb(codexProfileHome('gpt-key'), [[KEYED_ID, 1]])
    expect(await nativeQueuedCounts()).toEqual(new Map([[PLAIN_ID, 2]]))
    lanesOn()
    expect(await nativeQueuedCounts()).toEqual(new Map([[PLAIN_ID, 2], [KEYED_ID, 1]]))
  })

  it('never lets an unreadable keyed home null the server answer', async () => {
    queueDb(SERVER_CODEX, [[PLAIN_ID, 1]])
    mkdirSync(codexProfileHome('gpt-key'), { recursive: true })
    writeFileSync(join(codexProfileHome('gpt-key'), 'queue_1.sqlite'), 'not a database')
    lanesOn()
    expect(await nativeQueuedCounts()).toEqual(new Map([[PLAIN_ID, 1]]))
  })
})

describe('occupancy (occupancy-probes.ts, thread-occupancy.ts)', () => {
  it('adds profile lock dirs only with lanes on and a profile home', () => {
    mkdirSync(codexProfileHome('gpt-key'), { recursive: true })
    expect('codexProfileLocksDirs' in realOccupancyDirs()).toBe(false)
    lanesOn()
    expect(realOccupancyDirs().codexProfileLocksDirs).toEqual([join(codexProfileHome('gpt-key'), 'thread-writer-locks')])
  })

  it('finds a writer in a profile home and is codexOwners exactly with none', () => {
    const serverLocks = join(SERVER_CODEX, 'thread-writer-locks')
    const keyedLocks = join(codexProfileHome('gpt-key'), 'thread-writer-locks')
    const probes = {
      dirExists: (p: string) => p === serverLocks || p === keyedLocks,
      lockHolders: (p: string) => (p.startsWith(keyedLocks) ? [4242] : []),
      cosSpawnedPids: () => new Map<number, number>(),
      processStartMs: () => null,
    } as unknown as OccupancyProbes
    const base = codexOwnersAcrossHomes(KEYED_ID, probes, { claudeSessionsDir: '/x', codexLocksDir: serverLocks, cursorChatsDir: '/y' })
    expect(base.owners).toEqual([])
    const widened = codexOwnersAcrossHomes(KEYED_ID, probes, { claudeSessionsDir: '/x', codexLocksDir: serverLocks, cursorChatsDir: '/y', codexProfileLocksDirs: [keyedLocks] })
    expect(widened.owners.map(o => o.pid)).toEqual([4242])
  })
})

describe('hook events (session-hook-events.ts)', () => {
  const env = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ ts: 1760900000000, ppid: 77, event: 'SessionStart', ...extra, payload: { session_id: KEYED_ID, ...payload } })

  it('marks a keyed Codex transcript as codex and carries its profile', () => {
    const transcript = join(codexProfileHome('gpt-key'), 'sessions', '2026', '10', '19', `rollout-x-${KEYED_ID}.jsonl`)
    expect(inferHookProvider(undefined, { transcript_path: transcript })).toBe('codex')
    const parsed = parseHookEnvelope(env({ transcript_path: transcript }))
    expect(parsed.ok && parsed.envelope.provider).toBe('codex')
    expect(parsed.ok && parsed.envelope.keyProfile).toBe('gpt-key')
  })

  it('takes a stamped keyProfile, and refuses a malformed one', () => {
    const ok = parseHookEnvelope(env({}, { keyProfile: 'sonnet-key' }))
    expect(ok.ok && ok.envelope.keyProfile).toBe('sonnet-key')
    const bad = parseHookEnvelope(env({}, { keyProfile: '../etc' }))
    expect(bad.ok && 'keyProfile' in bad.envelope).toBe(false)
  })

  it('canary R7: an unstamped Claude hook event of a keyed CLI session reads its profile from keyed-sessions.json, only with lanes on', async () => {
    const keyed = await import('./keyed-sessions.js')
    const CLAUDE_KEYED = 'c9b975ab-1111-4222-8333-444444444444'
    keyed.recordKeyedSession({ id: CLAUDE_KEYED, engine: 'claude', profileId: 'sonnet-key', cosSessionId: 'cos-1' })
    const claudeEnv = (sid: string) => JSON.stringify({ ts: 1760900000000, ppid: 77, event: 'PreToolUse', payload: { session_id: sid, transcript_path: `/Users/x/.claude/projects/p/${sid}.jsonl` } })
    const off = parseHookEnvelope(claudeEnv(CLAUDE_KEYED.toUpperCase()))
    expect(off.ok && 'keyProfile' in off.envelope).toBe(false)
    lanesOn()
    const on = parseHookEnvelope(claudeEnv(CLAUDE_KEYED.toUpperCase()))
    expect(on.ok && on.envelope.keyProfile).toBe('sonnet-key')
    expect(on.ok && on.envelope.provider).toBe('claude')
    const other = parseHookEnvelope(claudeEnv('d0000000-1111-4222-8333-444444444444'))
    expect(other.ok && 'keyProfile' in other.envelope).toBe(false)
    keyed.__resetKeyedSessionsForTests()
  })

  it('canary rerun R8: a keyed Codex hook row in session-hook-events.jsonl carries keyProfile from the keyed-thread record, and a lanes-off row is unchanged', async () => {
    const keyed = await import('./keyed-sessions.js')
    const { registerCodexKeyedThreadRecorder, recordKeyedCodexThread } = await import('./codex-profile-home.js')
    const { SessionHookLedger } = await import('./session-hook-ledger.js')
    // The same seam the wiring registers: a Codex thread lands in keyed-sessions.json like a Claude session.
    registerCodexKeyedThreadRecorder(t => keyed.recordKeyedSession({ id: t.id, engine: 'codex', profileId: t.profileId, cosSessionId: t.cosSessionId }))
    recordKeyedCodexThread({ id: KEYED_ID, engine: 'codex', profileId: 'gpt-key', cosSessionId: 'cos-c' })
    // The installed hook script stamps nothing, and a Codex payload's transcript path need not sit in the profile home.
    const codexEnv = JSON.stringify({ ts: 1760900000000, ppid: 77, event: 'SessionStart', provider: 'codex', payload: { session_id: KEYED_ID, transcript_path: null } })
    const path = join(DATA, 'session-hook-events.jsonl')
    const rows = () => readFileSync(path, 'utf-8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)

    const off = parseHookEnvelope(codexEnv)
    expect(off.ok).toBe(true)
    if (!off.ok) return
    new SessionHookLedger(path).append('k-off', off.envelope)
    expect(Object.keys(rows()[0]).sort()).toEqual(['event', 'key', 'payload', 'ppid', 'provider', 'session_id', 'stamped', 'ts'])
    // Lanes off, even an envelope that carries a profile writes the row it always did.
    new SessionHookLedger(path).append('k-off-2', { ...off.envelope, keyProfile: 'gpt-key' })
    expect(rows()[1]).toEqual({ ...rows()[0], key: 'k-off-2' })

    lanesOn()
    const on = parseHookEnvelope(codexEnv)
    expect(on.ok && on.envelope.keyProfile).toBe('gpt-key')
    if (!on.ok) return
    const ledger = new SessionHookLedger(path)
    ledger.append('k-on', on.envelope)
    expect(rows()[2].keyProfile).toBe('gpt-key')
    expect(rows()[2].provider).toBe('codex')
    // A boot replay keeps it.
    const replayed: Array<string | undefined> = []
    ledger.replay(0, env => { replayed.push(env.keyProfile) })
    expect(replayed).toEqual([undefined, undefined, 'gpt-key'])
    // A Codex thread nobody recorded gets no profile.
    const plain = parseHookEnvelope(codexEnv.replace(KEYED_ID, PLAIN_ID))
    expect(plain.ok && 'keyProfile' in plain.envelope).toBe(false)
    registerCodexKeyedThreadRecorder(null)
    keyed.__resetKeyedSessionsForTests()
  })

  it('adds no field to a Lane A envelope', () => {
    const parsed = parseHookEnvelope(env({ transcript_path: '/Users/x/.claude/projects/p/a.jsonl' }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(Object.keys(parsed.envelope).sort()).toEqual(['event', 'payload', 'ppid', 'provider', 'sessionId', 'ts'])
  })
})

describe('live queue (codex-live-queue.ts)', () => {
  const deps = (isKeyed?: (id: string) => boolean) => ({
    resolveBinary: () => '/opt/codex',
    run: vi.fn(async () => ({ code: 0, stdout: `Queued message q-1 for thread ${KEYED_ID}.\n`, stderr: '', timedOut: false, spawnError: null })),
    now: () => 0,
    ...(isKeyed ? { isKeyedThread: isKeyed } : {}),
  })
  const req = { provider: 'codex', sessionId: KEYED_ID, prompt: 'steer this', enabled: true, foreignHolder: true }

  it('never queues a keyed profile thread into the Codex app', async () => {
    rollout(codexProfileHome('gpt-key'), KEYED_ID, 'keyed')
    lanesOn()
    const d = deps()
    const result = await deliverOverCodexQueue(req, d)
    expect(result.reason).toBe('keyed_session')
    expect(d.run).not.toHaveBeenCalled()
  })

  it('delivers exactly as before for a thread that is not keyed', async () => {
    const d = deps()
    const result = await deliverOverCodexQueue(req, d)
    expect(result).toMatchObject({ ok: true, reason: 'delivered', queuedId: 'q-1' })
    expect(d.run).toHaveBeenCalledTimes(1)
  })
})

describe('readers that stay on the server home', () => {
  it('lens gist models come from the server home only, never a profile home', () => {
    mkdirSync(codexProfileHome('gpt-key'), { recursive: true })
    writeFileSync(join(codexProfileHome('gpt-key'), 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5.4-mini' }] }))
    lanesOn()
    expect(codexGistModelsFromCache()).toEqual([])
    // The same file in the server home IS read, so the empty answer above is not a filter artefact.
    writeFileSync(join(SERVER_CODEX, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5.4-mini' }] }))
    expect(codexGistModelsFromCache()).toEqual(['gpt-5.4-mini'])
  })
})

describe('names, pinned ids, search and subagents across Codex homes (P11)', () => {
  const embedTexts = async () => ({ reason: 'no embeddings in this test' })

  it('a keyed thread has its own name and is found by search only with lanes on; the server home wins a clash', async () => {
    const { loadCodexThreadNamesAll, loadCodexThreadNames } = await import('./agent-session-store.js')
    const { searchAgentSessions } = await import('./agent-session-search.js')
    rollout(SERVER_CODEX, PLAIN_ID, 'subscription thread')
    rollout(codexProfileHome('gpt-key'), KEYED_ID, 'zebracorn keyed thread')
    // Lanes off: exactly the server home's names, and the keyed thread is not searchable.
    expect(await loadCodexThreadNamesAll(agentSessionRoots())).toEqual(await loadCodexThreadNames(join(SERVER_CODEX, 'sessions')))
    const off = await searchAgentSessions({ query: 'zebracorn', roots: agentSessionRoots(), embedTexts: embedTexts as never, now: NOW })
    expect(off.hits.map(h => h.session_id)).not.toContain(KEYED_ID)
    lanesOn()
    const names = await loadCodexThreadNamesAll(agentSessionRoots())
    expect(names.get(KEYED_ID)).toBe('zebracorn keyed thread')
    expect(names.get(PLAIN_ID)).toBe('subscription thread')
    const on = await searchAgentSessions({ query: 'zebracorn', roots: agentSessionRoots(), embedTexts: embedTexts as never, now: NOW })
    expect(on.hits.map(h => h.session_id)).toContain(KEYED_ID)
    // A clash: the server home's name is kept.
    writeFileSync(join(codexProfileHome('gpt-key'), 'session_index.jsonl'), JSON.stringify({ id: PLAIN_ID, thread_name: 'impostor' }) + '\n')
    expect((await loadCodexThreadNamesAll(agentSessionRoots())).get(PLAIN_ID)).toBe('subscription thread')
  })

  it('pinned ids are the union across homes with lanes on, the server set with lanes off', async () => {
    const { loadCodexPinnedIdsAll } = await import('./agent-session-store.js')
    mkdirSync(join(SERVER_CODEX, 'sessions'), { recursive: true })
    mkdirSync(join(codexProfileHome('gpt-key'), 'sessions'), { recursive: true })
    writeFileSync(join(SERVER_CODEX, '.codex-global-state.json'), JSON.stringify({ 'pinned-thread-ids': [PLAIN_ID] }))
    writeFileSync(join(codexProfileHome('gpt-key'), '.codex-global-state.json'), JSON.stringify({ 'pinned-thread-ids': [KEYED_ID] }))
    expect([...await loadCodexPinnedIdsAll(agentSessionRoots())]).toEqual([PLAIN_ID])
    lanesOn()
    expect([...await loadCodexPinnedIdsAll(agentSessionRoots())].sort()).toEqual([PLAIN_ID, KEYED_ID].sort())
  })

  it('subagents of a keyed thread are read in its profile home; with one root it is one server call', async () => {
    const { readCodexSubagentsAcross } = await import('./codex-subagent-activity.js')
    const CHILD = '019f9999-aaaa-bbbb-cccc-dddddddddddd'
    const profileHome = codexProfileHome('gpt-key')
    rollout(profileHome, KEYED_ID, 'keyed parent')
    const childFile = rollout(profileHome, CHILD, 'child')
    const db = join(profileHome, 'state_5.sqlite')
    execFileSync('/usr/bin/sqlite3', [db, `CREATE TABLE threads(id TEXT,rollout_path TEXT,archived INT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT); INSERT INTO threads VALUES('${CHILD}','${childFile}',1); INSERT INTO thread_spawn_edges VALUES('${KEYED_ID}','${CHILD}','open');`])
    const serverRoot = join(SERVER_CODEX, 'sessions')
    const profileRoot = join(profileHome, 'sessions')
    // One root: the server home answers (it has no state db, so nothing).
    expect((await readCodexSubagentsAcross([KEYED_ID], [serverRoot])).get(KEYED_ID)).toBeUndefined()
    // Two roots, routed to the keyed thread's home: its child is counted.
    const across = await readCodexSubagentsAcross([KEYED_ID, PLAIN_ID], [serverRoot, profileRoot], NOW.getTime(), id => id === KEYED_ID ? profileRoot : undefined)
    expect(across.get(KEYED_ID)).toMatchObject({ total: 1, completed: 1 })
    expect(across.has(PLAIN_ID)).toBe(false)
  })
})
