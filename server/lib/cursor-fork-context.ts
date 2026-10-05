// "New session with this context" for Cursor (6.62.0, D4, plan 3.7, W9).
//
// Cursor's Agent CLI cannot fork a chat. So the Cursor Fork is a NEW read-only chat
// (`fork-thread.ts` `buildCursorForkArgs`) whose first prompt carries a bounded bundle of
// the source chat, then the person's message. Three things live here, all pure or bounded:
//
//   - the bundle (title, first request, the last turns), always under MAX_PROMPT_CHARS;
//   - the workspace: the hook signal's cwd, else the IDE composer's own recorded folder
//     (`composerData.workspaceIdentifier`), else the CLI chat's spawn spelling. IDE
//     composers have no `spawnWorkspace`, which is why the 6.61 lookup refused them all;
//   - the model: the session's own slug when the installed Cursor lists it, else the
//     fork fallback.

import type { SessionTurn } from './agent-session-turns.js'

export const CURSOR_FORK_TURNS = 12
const MAX_TURN_CHARS = 4_000
const MAX_FIRST_PROMPT_CHARS = 1_500
const MAX_TITLE_CHARS = 200

export interface CursorForkPromptInput {
  title: string | null
  firstPrompt: string | null
  turns: readonly SessionTurn[]
  message: string
  maxChars: number
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\r\n/g, '\n').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/**
 * The first prompt of the new chat. The message is always whole and always last; context
 * is dropped oldest-first until the whole fits `maxChars`. A message that leaves no room
 * goes alone.
 */
export function buildCursorForkPrompt(input: CursorForkPromptInput): string {
  const message = input.message
  const tail = `\n\nNew message:\n${message}`
  // 6.62.0 /qa (W10): Cursor titles a chat by its first line, so the FIRST line is the source's
  // title (else the person's message), never a fixed header every fork would share.
  const titleLine = input.title && input.title.trim()
    ? clip(input.title.split('\n')[0]!, MAX_TITLE_CHARS)
    : clip(message.split('\n').find(line => line.trim()) ?? message, MAX_TITLE_CHARS)
  const header = 'A new chat that carries on from an earlier Cursor chat. Its context, for reference only:'
  const lines: string[] = [titleLine, '', header, '']
  if (input.title && input.title.trim()) lines.push(`Title: ${clip(input.title, MAX_TITLE_CHARS)}`)
  if (input.firstPrompt && input.firstPrompt.trim()) lines.push(`First request: ${clip(input.firstPrompt, MAX_FIRST_PROMPT_CHARS)}`)
  const head = lines.join('\n')
  const rendered = input.turns
    .filter(turn => typeof turn?.text === 'string' && turn.text.trim())
    .map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${clip(turn.text, MAX_TURN_CHARS)}`)
  const budget = input.maxChars - tail.length
  if (budget <= head.length) return message.length <= input.maxChars ? message : message.slice(0, input.maxChars)
  // Newest turns are kept; the oldest go first.
  const kept: string[] = []
  let used = head.length + '\n\nRecent conversation (oldest first):'.length
  for (let i = rendered.length - 1; i >= 0; i--) {
    const cost = rendered[i]!.length + 1
    if (used + cost > budget) break
    kept.unshift(rendered[i]!)
    used += cost
  }
  const body = kept.length > 0 ? `${head}\n\nRecent conversation (oldest first):\n${kept.join('\n')}` : head
  return `${body}${tail}`
}

export interface CursorForkWorkspaceDeps {
  /** The hook signal's cwd for this session, or null. */
  signalCwd: (threadId: string) => string | null
  /** The IDE composer's recorded workspace folder, or null. */
  composerWorkspace: (threadId: string) => Promise<string | null>
  /** The CLI chat's spawn spelling (`spawnWorkspace`), or null. */
  spawnWorkspace: (threadId: string) => string | null
  /** MUST throw on "cannot tell"; false only for absent. */
  dirExists: (path: string) => boolean
}

function usable(path: unknown, deps: CursorForkWorkspaceDeps): path is string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return false
  try {
    return deps.dirExists(path) === true
  } catch {
    return false
  }
}

/** Where the new chat runs. Null refuses the fork: never the server's own cwd. */
export async function resolveCursorForkWorkspace(threadId: string, deps: CursorForkWorkspaceDeps): Promise<string | null> {
  let candidate: string | null = null
  try { candidate = deps.signalCwd(threadId) } catch { candidate = null }
  if (usable(candidate, deps)) return candidate
  try { candidate = await deps.composerWorkspace(threadId) } catch { candidate = null }
  if (usable(candidate, deps)) return candidate
  try { candidate = deps.spawnWorkspace(threadId) } catch { candidate = null }
  if (usable(candidate, deps)) return candidate
  return null
}

export interface CursorForkPrepDeps {
  transcriptPath: (threadId: string) => string | null
  readTurns: (path: string, limit: number) => Promise<SessionTurn[]>
  readTitle: (path: string, threadId: string) => Promise<{ title: string | null; firstPrompt: string | null }>
  /** The session's own model as a slug the installed Cursor lists, or null. */
  sessionModel: (threadId: string, path: string | null) => Promise<string | null>
  maxChars: number
}

/**
 * The prompt and model for one Cursor fork. A failed read costs context, never the fork:
 * with nothing readable the new chat gets the message alone and the fallback model.
 */
export async function prepareCursorFork(
  threadId: string,
  message: string,
  deps: CursorForkPrepDeps,
): Promise<{ prompt: string; cursorModel: string | null }> {
  let path: string | null = null
  try { path = deps.transcriptPath(threadId) } catch { path = null }
  let turns: SessionTurn[] = []
  let title: string | null = null
  let firstPrompt: string | null = null
  // 6.62.0 /qa (W17): a fork that loses its context says so in the server log.
  const lost: string[] = []
  if (path) {
    try { turns = await deps.readTurns(path, CURSOR_FORK_TURNS) } catch { turns = []; lost.push('turns') }
    try { ({ title, firstPrompt } = await deps.readTitle(path, threadId)) } catch { title = null; firstPrompt = null; lost.push('title') }
  } else {
    lost.push('transcript')
  }
  let cursorModel: string | null = null
  try { cursorModel = await deps.sessionModel(threadId, path) } catch { cursorModel = null; lost.push('model') }
  if (lost.length > 0) console.warn(`[cursor-fork] context lost thread=${threadId.slice(0, 8)} missing=${lost.join(',')}`)
  return {
    prompt: buildCursorForkPrompt({ title, firstPrompt, turns, message, maxChars: deps.maxChars }),
    cursorModel,
  }
}
