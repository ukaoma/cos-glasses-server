export type CliProvider = 'claude' | 'codex'

const AUTH_CODE = /^(?:401|403|unauthori[sz]ed|forbidden|authentication_error|authorization_error|invalid_api_key|not_authenticated)$/i
// Match whole, terminal-looking provider failures only. Natural assistant
// answers such as "Please sign in to the customer portal, then..." must not
// be reinterpreted as failures merely because their first words mention auth.
const AUTH_FAILURE_PREFIX = /^(?:\s*(?:api\s+|http\s+|request\s+)?error(?:\[[^\]]+\])?\s*:\s*.{0,180}\b(?:401|403|unauthori[sz]ed|forbidden|authentication\s+(?:failed|required)|login\s+required|not\s+(?:logged|signed)\s+in)\b.*|\s*(?:http\s+)?(?:401|403)(?:\s+(?:unauthori[sz]ed|forbidden))?(?:\s*[:.\-]\s*.*)?|\s*(?:unauthori[sz]ed|forbidden)(?:\s*[:.\-]\s*.*)?|\s*(?:authentication|authorization)\s+(?:failed|required|error|missing|denied)(?:\s*[:.\-]\s*.*)?|\s*(?:login|sign[ -]?in)\s+(?:required|failed)(?:\s*[:.\-]\s*.*)?|\s*(?:you(?:'re| are)\s+)?not\s+(?:logged|signed)\s+in(?:\s*[:.\-]\s*.*)?|\s*please\s+run\s+(?:[`'"]?(?:claude|codex)[`'"]?\s+)?(?:[`'"]?\/?login[`'"]?|[`'"]?auth(?:enticate)?[`'"]?)\b.*)\s*$/i

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

function structuredAuthFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.status === 401 || record.status === 403 || record.statusCode === 401 || record.statusCode === 403) return true
  for (const key of ['code', 'type']) {
    if (typeof record[key] === 'string' && AUTH_CODE.test(record[key])) return true
  }
  if (typeof record.error === 'string') {
    return AUTH_CODE.test(record.error.trim()) || AUTH_FAILURE_PREFIX.test(record.error)
  }
  return structuredAuthFailure(record.error)
}

function looksLikeTerminalAuthFailure(value: unknown): boolean {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return structuredAuthFailure(value)
  }
  if (typeof value !== 'string') return false
  const text = stripAnsi(value).trim()
  if (!text || text.length > 2_000) return false
  if (AUTH_FAILURE_PREFIX.test(text.replace(/\s+/g, ' '))) return true
  if (!(text.startsWith('{') && text.endsWith('}'))) return false
  try {
    return structuredAuthFailure(JSON.parse(text))
  } catch {
    return false
  }
}

/**
 * Some CLI versions report authentication failures as successful process
 * output and exit 0. Detect only terminal, machine-shaped auth messages and
 * return a canonical error that cannot echo credentials or provider output.
 */
export function terminalProviderAuthFailure(
  provider: CliProvider,
  ...terminalValues: unknown[]
): string | null {
  return terminalValues.some(looksLikeTerminalAuthFailure)
    ? `${provider}-bridge: authentication required.`
    : null
}
