import { beforeEach, describe, expect, it, vi } from 'vitest'

const py = vi.hoisted(() => ({ source: 'bridge' as 'bridge' | 'files' | null, answers: [] as unknown[], calls: [] as Array<{ args: string[]; input?: string }> }))
const task = vi.hoisted(() => ({ calls: [] as Array<{ args: string[]; input?: string }>, answers: [] as unknown[] }))
vi.mock('./python-bridge.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./python-bridge.js')>()),
  contextSourceAvailable: () => py.source,
  callPython: vi.fn(async (args: string[], _t?: number, input?: string) => { py.calls.push({ args, input }); return py.answers.shift() }),
}))
vi.mock('./task-bridge.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./task-bridge.js')>()),
  taskBridgeAvailable: () => true,
  callTaskBridge: vi.fn(async (args: string[], _t?: number, input?: string) => { task.calls.push({ args, input }); return task.answers.shift() }),
}))
vi.mock('./domains.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./domains.js')>()),
  taskDomainNames: () => ['work', 'personal'],
}))

const { bridgeErrorCode, createBridgeDropWriters, DropDestinationError, within } = await import('./drop-destinations.js')
const ID = '3f0c9a52-1b2d-4c8e-9f10-2a3b4c5d6e7f'

beforeEach(() => { py.source = 'bridge'; py.answers = []; py.calls = []; task.calls = []; task.answers = [] })

describe('bridge answers', () => {
  it('reads both error shapes, and an unknown verb as missing', () => {
    expect(bridgeErrorCode({ ok: true })).toBeNull()
    expect(bridgeErrorCode({ error: { code: 'task_file_locked' } })).toBe('task_file_locked')
    expect(bridgeErrorCode({ error: 'unknown command: thread-source' })).toBe('unknown_command')
    expect(bridgeErrorCode(null)).toBe('empty_answer')
  })
})

describe('new card', () => {
  it('captures through task-capture-drop and answers the id', async () => {
    task.answers.push({ ok: true, id: 'abcdefabcdef', workIdentity: 'abcdefabcdef', created: true })
    expect(await createBridgeDropWriters().captureCard('work', '  Draft   the email ', ID)).toEqual({ id: 'abcdefabcdef', workIdentity: 'abcdefabcdef', created: true })
    expect(task.calls[0].args).toEqual(['task-capture-drop', 'work'])
    expect(JSON.parse(task.calls[0].input!)).toEqual({ text: 'Draft the email', dropId: ID })
  })
  it('a bridge without the verb is destination_unavailable', async () => {
    task.answers.push({ error: { code: 'cos_pipeline_not_configured' } })
    await expect(createBridgeDropWriters().captureCard('work', 'Draft', ID)).rejects.toMatchObject({ code: 'destination_unavailable' })
  })
  it('an answer it cannot verify is destination_failed', async () => {
    task.answers.push({ ok: true, id: 'not-an-id', created: true })
    await expect(createBridgeDropWriters().captureCard('work', 'Draft', ID)).rejects.toMatchObject({ code: 'destination_failed' })
  })
  it('an unknown domain never reaches the bridge', async () => {
    await expect(createBridgeDropWriters().captureCard('nope', 'Draft', ID)).rejects.toBeInstanceOf(DropDestinationError)
    expect(task.calls).toHaveLength(0)
  })
  it('archive answers archived, touched or gone', async () => {
    task.answers.push({ ok: true, result: 'touched' })
    expect(await createBridgeDropWriters().archiveCard('work', 'abcdefabcdef', ID, 'Draft')).toBe('touched')
    expect(task.calls[0].args).toEqual(['task-archive-drop', 'work', 'abcdefabcdef'])
    task.answers.push({ ok: true, result: 'deleted' })
    await expect(createBridgeDropWriters().archiveCard('work', 'abcdefabcdef', ID, 'Draft')).rejects.toMatchObject({ code: 'destination_failed' })
  })
})

describe('memory and thread', () => {
  it('memory capture goes into To review with the filing number; Undo goes through memory-uncapture', async () => {
    py.answers.push({ ok: true, id: 'mem-123', created: true }, { ok: true, result: 'touched' }, { ok: true, result: 'removed' })
    const w = createBridgeDropWriters()
    expect(await w.captureMemory('the alarm code changed', ID, '2')).toEqual({ id: 'mem-123', created: true })
    expect(py.calls[0]).toEqual({ args: ['memory-capture'], input: JSON.stringify({ text: 'the alarm code changed', dropId: ID, attempt: '2' }) })
    expect(await w.pruneMemory('mem-123', ID)).toBe('touched')
    expect(py.calls[1]).toEqual({ args: ['memory-uncapture', '--id', 'mem-123'], input: JSON.stringify({ dropId: ID }) })
    await expect(w.pruneMemory('mem-123', ID)).rejects.toMatchObject({ code: 'destination_failed' })
  })
  it('a memory the contract refuses is memory_too_short, not a failure to retry', async () => {
    py.answers.push({ error: { code: 'memory_rejected' } })
    await expect(createBridgeDropWriters().captureMemory('coffee', ID, '1')).rejects.toMatchObject({ code: 'memory_too_short' })
  })
  it('thread source and unsource by id', async () => {
    py.answers.push({ ok: true, sourceId: 'drop-3f0c9a52', created: false }, { ok: true, result: 'removed' })
    const w = createBridgeDropWriters()
    expect(await w.sourceThread('thread-1', 'a note', ID)).toEqual({ sourceId: 'drop-3f0c9a52', created: false })
    expect(py.calls[0].args).toEqual(['thread-source', '--id', 'thread-1'])
    expect(await w.unsourceThread('thread-1', 'drop-3f0c9a52', ID)).toBe('removed')
    expect(py.calls[1].args).toEqual(['thread-unsource', '--id', 'thread-1', '--source-id', 'drop-3f0c9a52'])
  })
  it('without the Python bridge (file tier or nothing) these are missing, and nothing is called', async () => {
    for (const source of ['files', null] as const) {
      py.source = source
      await expect(createBridgeDropWriters().captureMemory('x', ID, '1')).rejects.toMatchObject({ code: 'destination_unavailable' })
      await expect(createBridgeDropWriters().sourceThread('thread-1', 'x', ID)).rejects.toMatchObject({ code: 'destination_unavailable' })
    }
    expect(py.calls).toHaveLength(0)
  })
  it('an older bridge (unknown command) is missing, a refusal is a failure', async () => {
    py.answers.push({ error: 'unknown command: memory-capture' }, { error: { code: 'invalid_text' } })
    await expect(createBridgeDropWriters().captureMemory('x', ID, '1')).rejects.toMatchObject({ code: 'destination_unavailable' })
    await expect(createBridgeDropWriters().captureMemory('x', ID, '1')).rejects.toMatchObject({ code: 'destination_failed' })
  })
})

describe('bounded candidate reads', () => {
  it('a slow or failing part answers null, a fast one its value', async () => {
    expect(await within(20, async () => 'ok')).toBe('ok')
    expect(await within(20, () => new Promise(r => setTimeout(() => r('late'), 200)))).toBeNull()
    expect(await within(20, async () => { throw new Error('x') })).toBeNull()
  })
})
