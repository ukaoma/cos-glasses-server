import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const isolatedDataDir = vi.hoisted(() => {
  const dir = `/tmp/cos-message-ref-data-${process.pid}`
  process.env.COS_DATA_DIR = dir
  return dir
})
import { readArchiveChatNumbered, resolveFromArchiveDir } from './message-ref.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  delete process.env.COS_DATA_DIR
  rmSync(isolatedDataDir, { recursive: true, force: true })
})

describe('standalone numbered message attachment propagation', () => {
  it('merges validated refs from user and assistant exchanges', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-message-ref-'))
    roots.push(root)
    const user = {
      id: `m_${'a'.repeat(24)}`, kind: 'user_photo', mime: 'image/jpeg',
      width: 64, height: 48, createdAt: '2026-07-11T12:00:00.000Z',
    }
    const assistant = {
      id: `m_${'b'.repeat(24)}`, kind: 'generated_visual', mime: 'image/jpeg',
      width: 96, height: 64, createdAt: '2026-07-11T12:01:00.000Z', label: 'Generated image',
    }
    writeFileSync(join(root, '2026-07-11.json'), JSON.stringify({
      date: '2026-07-11',
      chats: [{ id: 1, exchanges: [
        { role: 'user', content: 'question', timestamp: 1, globalMsgNum: 900, attachments: [user] },
        { role: 'assistant', content: 'answer', timestamp: 2, globalMsgNum: 900, attachments: [assistant] },
      ] }],
    }))

    expect(resolveFromArchiveDir(root, 900)?.attachments?.map(ref => ref.id)).toEqual([user.id, assistant.id])
    expect(readArchiveChatNumbered(root, '2026-07-11', 1)[0].attachments?.map(ref => ref.id)).toEqual([user.id, assistant.id])
  })
})
