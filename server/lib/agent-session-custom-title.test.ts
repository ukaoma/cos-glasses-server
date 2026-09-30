import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { lastCustomTitle } from './agent-session-store.js'

const dir = mkdtempSync(join(tmpdir(), 'cos-custom-title-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const title = (name: string) => JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: 's' })
// ~330 KB of transcript, more than the 256 KB window read from either end.
const filler = Array.from({ length: 1500 }, (_, i) => JSON.stringify({ type: 'assistant', text: `line ${i} ${'x'.repeat(200)}` })).join('\n')

function transcript(name: string, lines: string[]): string {
  const path = join(dir, `${name}.jsonl`)
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

describe('6.58.2: a session title is found at either end of a long transcript', () => {
  it('the newest title near the end wins', async () => {
    expect(await lastCustomTitle(transcript('both', [title('Old name'), filler, title('New name')]))).toBe('New name')
  })

  it('a long transcript whose only title is near the top still has it', async () => {
    expect(await lastCustomTitle(transcript('head', [title('Get the live SBS site URL'), filler]))).toBe('Get the live SBS site URL')
  })

  it('a short transcript and an untitled one', async () => {
    expect(await lastCustomTitle(transcript('short', [title('Short'), '{"type":"user"}']))).toBe('Short')
    expect(await lastCustomTitle(transcript('none', [filler]))).toBeNull()
  })
})
