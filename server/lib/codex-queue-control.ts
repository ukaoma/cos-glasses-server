// Queue management only. Never loads/starts a thread or starts a model turn.
// Protocol verified from the installed Codex generate-ts schema (2026-10-03).
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveProviderBinary } from './provider-binary.js'

export interface NativeQueuedSubmission { id: string; input: Array<{ type: string; text?: string; text_elements?: unknown[] }>; clientUserMessageId: string }
export interface NativeQueueControl {
  list(threadId: string): Promise<NativeQueuedSubmission[]>
  update(threadId: string, id: string, prompt: string): Promise<void>
  cancel(threadId: string, id: string): Promise<boolean>
}
const METHODS = new Set(['thread/queue/list', 'thread/queue/update', 'thread/queue/delete'])
export function codexQueueRpc(method: string, params: Record<string, unknown>, binary?: string): Promise<any> {
  if (!METHODS.has(method)) return Promise.reject(new Error('queue_method_not_allowed'))
  const resolved = binary ? { ok: true as const, path: binary } : resolveProviderBinary('codex')
  if (!resolved.ok) return Promise.reject(new Error('codex_queue_unavailable'))
  return new Promise((resolve, reject) => {
    // A separate, short-lived protocol client: automations and memories explicitly
    // disabled. No thread/start, turn/start or queue/start call is allowed here.
    const child = spawn(resolved.path, ['app-server', '--disable', 'in_app_local_automation', '--disable', 'memories'], { stdio: ['pipe', 'pipe', 'ignore'], shell: false })
    let buffer = '', done = false, initialized = false
    const finish = (error: Error | null, value?: unknown) => {
      if (done) return
      done = true; clearTimeout(timer); child.kill(); error ? reject(error) : resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('codex_queue_timeout')), 8000)
    const send = (payload: unknown) => child.stdin.write(JSON.stringify(payload) + '\n')
    child.on('error', () => finish(new Error('codex_queue_unavailable')))
    child.stdin.on('error', () => finish(new Error('codex_queue_unavailable')))
    child.on('exit', () => finish(new Error('codex_queue_closed')))
    child.stdout.on('data', data => {
      buffer += data.toString()
      if (buffer.length > 4 * 1024 * 1024) { finish(new Error('codex_queue_response_too_large')); return }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        let row: any
        try { row = JSON.parse(line) } catch { continue }
        if (row.id !== 1 && row.id !== 2) continue
        if (row.error) { finish(new Error('codex_queue_request_refused')); return }
        if (row.id === 1 && !initialized) {
          initialized = true
          send({ method: 'initialized' })
          send({ id: 2, method, params })
        } else if (row.id === 2) { finish(null, row.result); return }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cos-queue-control', version: '1' }, capabilities: { experimentalApi: true, explicitGatewayOauth: true } } })
  })
}

export function plainQueueText(row: NativeQueuedSubmission): string | null {
  // Never turn a message containing files, mentions or structured text into plain text.
  return Array.isArray(row.input) && row.input.length === 1 && row.input[0]?.type === 'text'
    && typeof row.input[0].text === 'string' && !row.input[0].text_elements?.length ? row.input[0].text : null
}
export const nativeQueueControl: NativeQueueControl = {
  async list(threadId) {
    const rows: NativeQueuedSubmission[] = []
    let cursor: string | null = null
    const seen = new Set<string>()
    do {
      const result = await codexQueueRpc('thread/queue/list', { threadId, cursor, limit: 100 })
      if (!Array.isArray(result?.data) || result.data.some((r: any) => typeof r?.id !== 'string' || !Array.isArray(r.input))) throw new Error('codex_queue_bad_response')
      rows.push(...result.data)
      cursor = result.nextCursor ?? null
      if (cursor && (seen.has(cursor) || rows.length >= 1000)) throw new Error('codex_queue_incomplete')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return rows
  },
  async update(threadId, id, prompt) {
    const current = (await this.list(threadId)).find(r => r.id === id)
    if (!current || plainQueueText(current) === null) throw new Error('queue_not_editable')
    const result = await codexQueueRpc('thread/queue/update', { threadId, queuedSubmissionId: id, input: [{ type: 'text', text: prompt, text_elements: [] }] })
    if (result?.queuedSubmission?.id !== id) throw new Error('codex_queue_bad_response')
  },
  async cancel(threadId, id) {
    const result = await codexQueueRpc('thread/queue/delete', { threadId, queuedSubmissionId: id })
    if (typeof result?.deleted !== 'boolean') throw new Error('codex_queue_bad_response')
    return result.deleted
  },
}

// One read-only aggregate per session-list request, not 80 protocol processes.
// No queue file is ever edited via SQL; mutations use Codex's own protocol above.
export async function nativeQueuedCounts(): Promise<Map<string, number> | null> {
  const db = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'queue_1.sqlite')
  if (!existsSync(db)) return new Map()
  try {
    const { stdout } = await promisify(execFile)('/usr/bin/sqlite3', ['-readonly', '-json', db, 'SELECT thread_id, count(*) AS n FROM queued_items GROUP BY thread_id'], { timeout: 2000, maxBuffer: 1024 * 1024 })
    const rows = JSON.parse(stdout || '[]')
    if (!Array.isArray(rows) || rows.some(r => typeof r.thread_id !== 'string' || !Number.isInteger(r.n))) return null
    return new Map(rows.map(r => [r.thread_id, r.n]))
  } catch { return null }
}
