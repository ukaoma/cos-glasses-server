import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  encodeCursorWorkspaceSlug,
  resolveCursorAgentSession,
  spawnWorkspace,
  transcriptFoldersFor,
  cursorTranscriptPath,
} from './cursor-agent-store.js'

const ID = '8ec6f311-739f-4e52-986a-58b996001109'
const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

let homes: string[] = []

function home(): { chats: string; projects: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-cursor-store-'))
  homes.push(root)
  const chats = join(root, '.cursor', 'chats')
  const projects = join(root, '.cursor', 'projects')
  mkdirSync(chats, { recursive: true })
  mkdirSync(projects, { recursive: true })
  return { chats, projects, root }
}

afterEach(() => {
  for (const root of homes.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

function writeMeta(chatsDir: string, cwd: string, over: Record<string, unknown> = {}): string {
  const dir = join(chatsDir, HASH, ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    hasConversation: true,
    cwd,
    createdAtMs: 1,
    ...over,
  }))
  return dir
}

function writeJsonl(projectsDir: string, folder: string): string {
  const file = join(projectsDir, folder, 'agent-transcripts', ID, `${ID}.jsonl`)
  mkdirSync(join(projectsDir, folder, 'agent-transcripts', ID), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })}\n`)
  return file
}

describe('encodeCursorWorkspaceSlug', () => {
  it('strips the leading slash and replaces slashes and spaces', () => {
    expect(encodeCursorWorkspaceSlug('/tmp/cos-agent-continue-v4')).toBe('tmp-cos-agent-continue-v4')
    expect(encodeCursorWorkspaceSlug('/private/tmp/cos-agent-continue-v4')).toBe('private-tmp-cos-agent-continue-v4')
    expect(encodeCursorWorkspaceSlug('/Users/ukaoma/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff'))
      .toBe('Users-ukaoma-Documents-GitHub-Ukaoma-Chief-Of-Staff-MU-Chief-Staff')
  })

  it('collapses underscores and dots the way Cursor Agent actually names folders', () => {
    expect(encodeCursorWorkspaceSlug(
      '/Users/ukaoma/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff/operations/personal/wk30_2026/phase0_cursor_fixtures/resume_workspace',
    )).toBe('Users-ukaoma-Documents-GitHub-Ukaoma-Chief-Of-Staff-MU-Chief-Staff-operations-personal-wk30-2026-phase0-cursor-fixtures-resume-workspace')
    expect(encodeCursorWorkspaceSlug('/tmp/Claude-Feature-Tab-01.module')).toBe('tmp-Claude-Feature-Tab-01-module')
  })
})

describe('resolveCursorAgentSession', () => {
  it('returns the one chats dir with a real conversation', () => {
    const { chats, root } = home()
    const cwd = join(root, 'workspace')
    mkdirSync(cwd, { recursive: true })
    writeMeta(chats, cwd)
    const session = resolveCursorAgentSession(ID, chats)
    expect(session).toMatchObject({ cwd, hasConversation: true })
    expect(session?.dir.endsWith(`/${HASH}/${ID}`)).toBe(true)
  })

  it('refuses a stub with hasConversation false', () => {
    const { chats, root } = home()
    const cwd = join(root, 'workspace')
    mkdirSync(cwd, { recursive: true })
    writeMeta(chats, cwd, { hasConversation: false })
    expect(resolveCursorAgentSession(ID, chats)).toBeNull()
  })

  it('refuses an invalid id before walking', () => {
    const { chats } = home()
    expect(resolveCursorAgentSession('nonsense', chats)).toBeNull()
  })

  it('refuses when the same id sits under two hashes', () => {
    const { chats, root } = home()
    const cwd = join(root, 'workspace')
    mkdirSync(cwd, { recursive: true })
    writeMeta(chats, cwd)
    const other = join(chats, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ID)
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'meta.json'), JSON.stringify({ hasConversation: true, cwd }))
    expect(resolveCursorAgentSession(ID, chats)).toBeNull()
  })
})

describe('spawnWorkspace uses the jsonl slug, never realpath cwd', () => {
  it('returns the /tmp spelling when that folder already exists', () => {
    const { chats, projects } = home()
    const workspace = join('/tmp', `cos-cursor-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    homes.push(workspace)
    writeMeta(chats, workspace)
    writeJsonl(projects, encodeCursorWorkspaceSlug(workspace))
    expect(spawnWorkspace(ID, { cursorChatsDir: chats, cursorProjectsDir: projects })).toBe(workspace)
  })

  it('matches Cursor\'s observed slug when the cwd has underscores and dots', () => {
    // Literal folder name Cursor Agent actually writes. Must not be
    // encodeCursorWorkspaceSlug(cwd) — that would pass a wrong encoder.
    const { chats, projects } = home()
    const stamp = `${process.pid}-${Date.now()}`
    const workspace = join('/tmp', `cos_cursor.ws_${stamp}`)
    mkdirSync(workspace, { recursive: true })
    homes.push(workspace)
    writeMeta(chats, workspace)
    writeJsonl(projects, `tmp-cos-cursor-ws-${stamp}`)
    expect(spawnWorkspace(ID, { cursorChatsDir: chats, cursorProjectsDir: projects })).toBe(workspace)
  })

  it('refuses when both tmp and private-tmp folders exist for the same id', () => {
    const { chats, projects } = home()
    const workspace = join('/tmp', `cos-cursor-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    homes.push(workspace)
    writeMeta(chats, workspace)
    writeJsonl(projects, encodeCursorWorkspaceSlug(workspace))
    writeJsonl(projects, `private-${encodeCursorWorkspaceSlug(workspace)}`)
    expect(spawnWorkspace(ID, { cursorChatsDir: chats, cursorProjectsDir: projects })).toBeNull()
  })

  it('skips empty-window so a real folder plus empty-window still resolves', () => {
    const { chats, projects } = home()
    const workspace = join('/tmp', `cos-cursor-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    homes.push(workspace)
    writeMeta(chats, workspace)
    const slug = encodeCursorWorkspaceSlug(workspace)
    writeJsonl(projects, slug)
    writeJsonl(projects, 'empty-window')
    expect(transcriptFoldersFor(ID, projects)).toEqual([slug])
    expect(spawnWorkspace(ID, { cursorChatsDir: chats, cursorProjectsDir: projects })).toBe(workspace)
  })
})

describe('cursorTranscriptPath stays on jsonl', () => {
  it('returns the one agent-transcripts jsonl', () => {
    const { projects } = home()
    const slug = 'tmp-cos-cursor-ws'
    const file = writeJsonl(projects, slug)
    expect(cursorTranscriptPath(ID, projects)).toBe(file)
  })
})
