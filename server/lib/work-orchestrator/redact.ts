/**
 * 6.83.0: what a pick-up note may carry. Session logs hold secrets and customer identifiers; a note goes to the planner
 * (and from there into a prompt), so both are removed here, before the note leaves the orchestrator.
 *
 * Secrets: the server's shared `redactSecrets` patterns, plus `name=value` secrets and credential file paths (canary C2).
 * Customer identifiers (canary C2, N1 named a merchant's proposal slug with its fees): email addresses, phone numbers,
 * the path and query of any URL (the host stays, so "bottlepos.com" still says where), money amounts, and long numeric
 * ids (order, account, ticket and HubSpot ids). The replacements say what was there, never what it was.
 */
import { homedir } from 'node:os'
import { redactSecrets } from '../lens-gist-engines.js'

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function homeRes(home: string): Array<[RegExp, string]> {
  const h = `(?:~|${escape(home)})`
  return [
    [new RegExp(`${h}/\\.(?:codex/auth\\.json|ssh/[\\w.\\-]+|aws/credentials|npmrc|netrc|config/gh/hosts\\.yml)`, 'g'), '[credential path]'],
    [new RegExp(`${h}/\\.cos-glasses/[\\w.\\-/]*(?:token|key|secret)[\\w.\\-]*`, 'gi'), '[credential path]'],
    // A path to an env file, or a bare `.env` token. `process.env` is code, not a file, and stays.
    [new RegExp(`(?<![\\w])${h}?(?:/[\\w\\-.]+)*/\\.env(?:\\.[\\w-]+)?\\b|(?<![\\w.])\\.env(?:\\.[\\w-]+)?\\b`, 'g'), '[env file]'],
  ]
}

const SECRET_ASSIGN = /\b(token|api[_-]?key|secret|password|passwd|x-cos-token|client[_-]?secret)\b(["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-./+=]{12,}/gi
const CUSTOMER: Array<[RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  // A URL keeps its scheme and host; its path, query and fragment can name a customer (slugs, ids, proposals).
  [/\b(https?:\/\/[A-Za-z0-9.-]+(?::\d+)?)(?:[/?#][^\s)\]"'<>]*)/g, '$1/[path]'],
  [/(?<![\w.])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g, '[phone]'],
  [/(?:[$£€]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|million|thousand))?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|dollars)\b)/gi, '[amount]'],
  [/\b\d{6,}\b/g, '[id]'],
]

export function redactNote(text: string, home = homedir()): string {
  let out = redactSecrets(text)
  out = out.replace(SECRET_ASSIGN, '$1=[secret]')
  for (const [re, to] of homeRes(home)) out = out.replace(re, to)
  for (const [re, to] of CUSTOMER) out = out.replace(re, to)
  return home.length > 1 ? out.split(home).join('~') : out
}
