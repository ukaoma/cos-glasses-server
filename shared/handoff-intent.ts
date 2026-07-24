export const HANDOFF_CODE_LENGTH = 8
export const HANDOFF_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/

const CODE_CHARS = /[0-9A-Z]/g

function normalizeVoiceCommand(text: string): string {
  return text
    .trim()
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface HandoffPickupIntent {
  kind: 'latest' | 'code'
  code?: string
  followup: string
}

export interface HandoffCreateIntent {
  target: 'desktop' | 'g2' | 'codex' | 'claude'
}

export function normalizeHandoffCode(input: string): string | null {
  const raw = input
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .match(CODE_CHARS)
    ?.join('') ?? ''
  if (raw.length !== HANDOFF_CODE_LENGTH) return null
  if (!HANDOFF_CODE_PATTERN.test(raw)) return null
  return raw
}

export function parseHandoffPickupIntent(text: string): HandoffPickupIntent | null {
  const trimmed = normalizeVoiceCommand(text)
  if (!trimmed) return null

  const latest = trimmed.match(/^(?:pick\s*up|pickup|resume|continue)\s+(?:where\s+i\s+left\s+off|latest|last\s+handoff|my\s+handoff)(?:\s+(.*))?$/i)
  if (latest) {
    return {
      kind: 'latest',
      followup: (latest[1] ?? '').replace(/^(?:and|then|:)\s+/i, '').trim(),
    }
  }

  const coded = trimmed.match(/^(?:pick\s*up|pickup|resume|continue)(?:\s+(handoff|code))?\s+(.+)$/i)
  if (!coded) return null
  const explicitCodeWord = !!coded[1]
  const rest = coded[2] ?? ''
  let candidate = ''
  let consumed = 0
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (/[0-9A-Z]/i.test(ch)) {
      candidate += ch
      if (candidate.length === HANDOFF_CODE_LENGTH) {
        consumed = i + 1
        break
      }
    } else if (candidate.length > 0 && !/[\s-]/.test(ch)) {
      break
    }
  }
  const rawCandidate = rest.slice(0, consumed).trim()
  const isDisplayedBareCode = rawCandidate === rawCandidate.toUpperCase()
    && rawCandidate.replace(/[\s-]/g, '').length === HANDOFF_CODE_LENGTH
  if (!explicitCodeWord && !/\d/.test(candidate) && !isDisplayedBareCode) return null
  const code = normalizeHandoffCode(candidate)
  if (!code) return null

  return {
    kind: 'code',
    code,
    followup: rest.slice(consumed).trim().replace(/^(?:and|then|:)\s+/i, '').trim(),
  }
}

export function parseHandoffCreateIntent(text: string): HandoffCreateIntent | null {
  const match = normalizeVoiceCommand(text).match(/^(?:handoff|hand[-\s]+off|pass|send)\s+(?:this|this\s+work|current\s+work|current\s+chat|current\s+message)(?:\s+(?:to|over\s+to)(?:\s+my)?\s+(desktop|g2|codex|claude(?:\s+code)?|mac|laptop))?$/i)
  if (!match) return null
  const rawTarget = match[1]?.toLowerCase()
  const target = rawTarget?.startsWith('claude')
    ? 'claude'
    : rawTarget === 'mac' || rawTarget === 'laptop'
      ? 'desktop'
      : (rawTarget ?? 'desktop') as HandoffCreateIntent['target']
  return { target }
}
