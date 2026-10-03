import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexQueueRpc, plainQueueText } from './codex-queue-control.js'

describe('Codex queue protocol boundary', () => {
  it('rejects model execution methods before starting a process', async () => {
    await expect(codexQueueRpc('turn/start', {}, '/never-run')).rejects.toThrow('queue_method_not_allowed')
    await expect(codexQueueRpc('thread/queue/start', {}, '/never-run')).rejects.toThrow('queue_method_not_allowed')
  })
  it('does not flatten attachments or structured spans into plain text', () => {
    const row = { id: 'a', clientUserMessageId: 'c', input: [{ type: 'text', text: 'text' }] }
    expect(plainQueueText(row)).toBe('text')
    expect(plainQueueText({ ...row, input: [...row.input, { type: 'image', text: '' }] })).toBeNull()
    expect(plainQueueText({ ...row, input: [{ type: 'text', text: 'x', text_elements: [{}] }] })).toBeNull()
  })
  it('initializes first, disables background jobs and only invokes the requested queue operation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-queue-rpc-'))
    const bin = join(dir, 'fake-codex')
    writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (JSON.stringify(args) !== JSON.stringify(['app-server','--disable','in_app_local_automation','--disable','memories'])) process.exit(2)
let ready = false
require('readline').createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line)
 if(r.method==='initialize') { ready=true; console.log(JSON.stringify({id:r.id,result:{}})) }
 else if(r.method==='initialized') {}
 else if(ready && r.method==='thread/queue/list') console.log(JSON.stringify({id:r.id,result:{data:[],nextCursor:null}}))
 else process.exit(3)
})
`, { mode: 0o755 })
    try { expect(await codexQueueRpc('thread/queue/list', { threadId: 'fixture' }, bin)).toEqual({ data: [], nextCursor: null }) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

it('reads native counts and distinguishes a broken database from an empty queue', async () => {
  const { nativeQueuedCounts } = await import('./codex-queue-control.js')
  const { execFileSync } = await import('node:child_process')
  const previous = process.env.CODEX_HOME
  const dir = mkdtempSync(join(tmpdir(), 'cos-native-counts-'))
  process.env.CODEX_HOME = dir
  try {
    expect(await nativeQueuedCounts()).toEqual(new Map())
    const db = join(dir, 'queue_1.sqlite')
    execFileSync('/usr/bin/sqlite3', [db, "CREATE TABLE queued_items(thread_id TEXT); INSERT INTO queued_items VALUES('one'),('one'),('two');"])
    expect(await nativeQueuedCounts()).toEqual(new Map([['one', 2], ['two', 1]]))
    execFileSync('/usr/bin/sqlite3', [db, 'DROP TABLE queued_items;'])
    expect(await nativeQueuedCounts()).toBeNull()
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
