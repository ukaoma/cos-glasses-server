// Safe, bounded activity previews for the live job monitor. This module only
// surfaces observable tool actions/results; it never exposes model reasoning.

export interface ActivityPreviewLine {
  kind: 'input' | 'output'
  text: string
}

const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g
const PRIVATE_MATERIAL_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CREDENTIALS?)-----[\s\S]*?(?:-----END [A-Z0-9 ]*(?:PRIVATE KEY|CREDENTIALS?)-----|$)/gi

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Cookie headers are credential containers; partial parsing is unsafe.
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, '$1[redacted]'],
  // Authorization and proxy-authorization headers, including Basic credentials.
  [/\b((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic|digest)\s+[^\s,;"']+/gi, '$1[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  // Structured assignments and JSON/env values. Key names are intentionally
  // broad; a false-positive here is safer than putting a credential on a lens.
  [/\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|refresh[_-]?token|session[_-]?token|token|credential|auth(?:orization)?|password|passwd|pwd|secret|client[_-]?secret|private[_-]?key|database[_-]?url|connection[_-]?string|dsn|session(?:[_-]?id)?|cookie|phpsessid|jsessionid|sid)(?:[_-][a-z0-9]+)*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi, '$1[redacted]'],
  // Shell/env whitespace assignments such as `export TOKEN value`.
  [/\b((?:export|set|env)\s+(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|token|credential|auth|password|passwd|pwd|secret|client[_-]?secret|private[_-]?key|database[_-]?url|connection[_-]?string|dsn|session(?:[_-]?id)?|cookie)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
  // Command-line flags commonly used for credentials.
  [/(\s--?(?:api-key|token|access-token|refresh-token|password|passwd|secret|client-secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
  [/(\s(?:-u|--user)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
  // URL userinfo and secret-bearing query parameters.
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi, '$1[redacted]@'],
  [/([?&](?:api[_-]?key|access[_-]?token|token|auth|password|secret)=)[^&#\s]+/gi, '$1[redacted]'],
  // Common provider token formats.
  [/\b(?:sk-(?:proj-|live-|test-)?|sk_(?:live|test)_|sess-|pat-|gh[pousr]_|github_pat_|glpat-|npm_|pypi-|shpat_|xox[baprs]-)[A-Za-z0-9._-]{8,}\b/gi, '[redacted-token]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-aws-key]'],
  [/\bAIza[A-Za-z0-9_-]{30,}\b/g, '[redacted-google-key]'],
  // JWTs and PEM material.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]'],
  [/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CREDENTIALS?)-----/gi, '[redacted-private-material]'],
  [/-----END [A-Z0-9 ]*(?:PRIVATE KEY|CREDENTIALS?)-----/gi, '[redacted-private-material]'],
]

function looksOpaqueSecret(text: string): boolean {
  const compact = text.replace(/\s/g, '')
  if (compact.length < 40) return false
  if (!/^[A-Za-z0-9+/=_:.-]+$/.test(compact)) return false

  // PEM bodies are conventionally wrapped into 64-character base64 lines,
  // but exporters commonly use widths from 40–72. Suppress every standalone
  // base64/hex chunk in that range, including low-variety padding lines.
  if (!/\s/.test(text) && /^(?:[A-Za-z0-9+/]{40,}={0,2}|[A-Fa-f0-9]{40,})$/.test(compact)) return true

  // Ordinary prose rarely has this mix without spaces. Requiring several
  // character classes avoids hiding long paths or repeated divider lines.
  let classes = 0
  if (/[a-z]/.test(compact)) classes++
  if (/[A-Z]/.test(compact)) classes++
  if (/\d/.test(compact)) classes++
  if (/[+/=_:.-]/.test(compact)) classes++
  return classes >= 3
}

export function sanitizeActivityPreview(raw: unknown, max = 180): string | null {
  if (typeof raw !== 'string') return null
  let text = raw.replace(ANSI_RE, '').replace(PRIVATE_MATERIAL_BLOCK_RE, '[private material hidden]')
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement)
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return null
  if (looksOpaqueSecret(text)) return '[opaque output hidden]'
  const safeMax = Number.isFinite(max) && max >= 8 ? Math.floor(max) : 180
  return text.length > safeMax ? `${text.slice(0, safeMax - 1)}…` : text
}

export function textPreviewLines(raw: unknown, maxLines = 3): string[] {
  if (typeof raw !== 'string') return []
  const safeMaxLines = Number.isFinite(maxLines) && maxLines > 0 ? Math.min(Math.floor(maxLines), 5) : 3
  const lines = raw.replace(PRIVATE_MATERIAL_BLOCK_RE, '[private material hidden]').replace(/\r\n?/g, '\n').split('\n')
    .map(line => sanitizeActivityPreview(line))
    .filter((line): line is string => !!line)
  return lines.slice(-safeMaxLines)
}

function resultText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.flatMap((part) => {
      if (typeof part === 'string') return [part]
      if (typeof part?.text === 'string') return [part.text]
      if (typeof part?.content === 'string') return [part.content]
      return []
    })
    return parts.length ? parts.join('\n') : null
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return resultText(record.content) ?? resultText(record.text) ?? resultText(record.output)
  }
  return null
}

/** Extract observable Codex tool activity from `codex exec --json` events. */
export function codexActivityPreviewLines(event: any): ActivityPreviewLine[] {
  const eventType = String(event?.type ?? '')
  const item = event?.item ?? event?.payload ?? {}
  const itemType = String(item?.type ?? '')
  const lines: ActivityPreviewLine[] = []

  if (/command_execution|command|shell|exec/i.test(itemType)) {
    if (/started/i.test(eventType)) {
      const command = sanitizeActivityPreview(item.command ?? item.input)
      if (command) lines.push({ kind: 'input', text: `$ ${command}` })
    }
    const output = item.aggregated_output ?? item.output ?? item.stdout ?? item.stderr
    for (const text of textPreviewLines(output)) lines.push({ kind: 'output', text })
    if (/completed/i.test(eventType) && Number.isInteger(item.exit_code)) {
      lines.push({ kind: 'output', text: `exit ${item.exit_code}` })
    }
    return lines
  }

  if (/file_change|patch/i.test(itemType)) {
    const changes = Array.isArray(item.changes) ? item.changes : []
    for (const change of changes.slice(-3)) {
      const path = sanitizeActivityPreview(change?.path ?? change?.file)
      if (path) lines.push({ kind: 'output', text: `${change?.kind ?? 'updated'} ${path}` })
    }
    return lines
  }

  if (/web_search/i.test(itemType)) {
    const query = sanitizeActivityPreview(item.query)
    if (query) lines.push({ kind: 'input', text: `Search: ${query}` })
    return lines
  }

  if (/mcp_tool_call|tool_call|tool/i.test(itemType)) {
    const name = sanitizeActivityPreview([item.server, item.tool ?? item.name].filter(Boolean).join('.'))
    if (name && /started/i.test(eventType)) lines.push({ kind: 'input', text: name })
    const text = resultText(item.result ?? item.output)
    for (const preview of textPreviewLines(text)) lines.push({ kind: 'output', text: preview })
  }

  return lines
}

/** Extract text from Claude tool_result events, never assistant reasoning. */
export function claudeToolResultPreviewLines(event: any): ActivityPreviewLine[] {
  if (event?.type !== 'user') return []
  const content = event?.message?.content ?? event?.content
  if (!Array.isArray(content)) return []
  const lines: ActivityPreviewLine[] = []
  for (const block of content) {
    if (block?.type !== 'tool_result') continue
    const text = resultText(block.content)
    for (const preview of textPreviewLines(text)) lines.push({ kind: 'output', text: preview })
  }
  return lines.slice(-3)
}

/** Turn completed Claude tool input JSON into one allowlisted useful line. */
export function claudeToolInputPreview(name: string, rawJson: string): ActivityPreviewLine | null {
  let input: Record<string, unknown> = {}
  try { input = JSON.parse(rawJson || '{}') } catch { return null }
  const candidate = input.query ?? input.url ?? input.file_path ?? input.path ?? input.command
  const preview = sanitizeActivityPreview(candidate)
  if (!preview) return null
  const label = name === 'WebSearch' ? 'Search'
    : name === 'WebFetch' ? 'Read'
      : name === 'Read' ? 'File'
        : name
  return { kind: 'input', text: `${label}: ${preview}` }
}
