import { findBannedPermissionArg } from './banned-permission-args.js'

export const CODEX_EXTRA_ARGS_MAX_TOKENS = 32
export const CODEX_EXTRA_ARGS_MAX_CHARS = 2_000

const BOOLEAN_FLAGS = new Set(['--oss'])
const VALUE_FLAGS = new Set(['-c', '--config', '--model', '-m', '--local-provider'])
const ALLOWED_FLAGS = new Set(['--oss', '--local-provider', '--model', '-m', '-c', '--config'])
const ALLOWED_CONFIG_KEYS = new Set([
  'model',
  'model_provider',
  'oss_provider',
  'model_reasoning_effort',
  'service_tier',
])
const LOCAL_PROVIDER_VALUES = new Set(['ollama', 'lmstudio'])

export class CodexExtraArgsError extends Error {
  flag: string
  constructor(flag: string) {
    super(`Invalid COS_CODEX_EXTRA_ARGS (${flag}). Edit ~/.cos-glasses/.env and restart the glasses server.`)
    this.name = 'CodexExtraArgsError'
    this.flag = flag
  }
}

function extraArgsUserMessage(flag: string): string {
  return `Invalid COS_CODEX_EXTRA_ARGS (${flag}). Edit ~/.cos-glasses/.env and restart the glasses server.`
}

export function extraArgsErrorMessage(flag: string): string {
  return extraArgsUserMessage(flag)
}

function unwrapWholeValue(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0]
    const last = raw[raw.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1).trim()
    }
  }
  return raw
}

function splitUnquotedWhitespace(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const ch of raw) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (quote) throw new CodexExtraArgsError('quotes')
  if (current) tokens.push(current)
  return tokens
}

export function parseCodexExtraArgs(raw: string | undefined): string[] {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return []
  if (trimmed.length > CODEX_EXTRA_ARGS_MAX_CHARS) throw new CodexExtraArgsError('length')
  const unwrapped = unwrapWholeValue(trimmed)
  if (!unwrapped) return []
  const tokens = splitUnquotedWhitespace(unwrapped)
  if (tokens.length > CODEX_EXTRA_ARGS_MAX_TOKENS) throw new CodexExtraArgsError('length')
  return tokens
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

function fusedValueFlag(token: string): string | null {
  for (const flag of VALUE_FLAGS) {
    if (token.startsWith(`${flag}=`)) return flag
  }
  return null
}

type Walked =
  | { kind: 'boolean'; flag: string }
  | { kind: 'value'; flag: string; value: string }

function walkCodexExtraArgs(args: string[]): Walked[] {
  const walked: Walked[] = []
  let i = 0
  while (i < args.length) {
    const token = args[i]
    if (BOOLEAN_FLAGS.has(token)) {
      walked.push({ kind: 'boolean', flag: token })
      i += 1
      continue
    }
    const fused = fusedValueFlag(token)
    if (fused) {
      const value = token.slice(fused.length + 1)
      if (!value) throw new CodexExtraArgsError(fused)
      if (value.startsWith('-')) throw new CodexExtraArgsError(fused)
      walked.push({ kind: 'value', flag: fused, value })
      i += 1
      continue
    }
    if (VALUE_FLAGS.has(token)) {
      const value = args[i + 1]
      if (value === undefined) throw new CodexExtraArgsError(token)
      if (value.startsWith('-')) throw new CodexExtraArgsError(token)
      walked.push({ kind: 'value', flag: token, value })
      i += 2
      continue
    }
    throw new CodexExtraArgsError(token)
  }
  return walked
}

function configPayloads(walked: Walked[]): { key: string; value: string }[] {
  const payloads: { key: string; value: string }[] = []
  for (const step of walked) {
    if (step.kind !== 'value' || (step.flag !== '-c' && step.flag !== '--config')) continue
    const eq = step.value.indexOf('=')
    if (eq <= 0) throw new CodexExtraArgsError(`-c ${stripWrappingQuotes(step.value)}`)
    const key = stripWrappingQuotes(step.value.slice(0, eq))
    const value = step.value.slice(eq + 1)
    payloads.push({ key, value })
  }
  return payloads
}

export function extraIncludesFlag(args: string[], flags: string[]): boolean {
  for (const token of args) {
    for (const flag of flags) {
      if (token === flag || token.startsWith(`${flag}=`)) return true
    }
  }
  return false
}

export function extraIncludesConfigKey(args: string[], key: string): boolean {
  const walked = walkCodexExtraArgs(args)
  return configPayloads(walked).some(payload => payload.key === key)
}

export function assertSafeCodexExtraArgs(args: string[]): void {
  if (args.length === 0) return
  const walked = walkCodexExtraArgs(args)
  for (const step of walked) {
    if (!ALLOWED_FLAGS.has(step.flag)) throw new CodexExtraArgsError(step.flag)
  }
  const hasOss = walked.some(step => step.kind === 'boolean' && step.flag === '--oss')
  const hasLocalProvider = extraIncludesFlag(args, ['--local-provider'])
  const payloads = configPayloads(walked)
  const hasOssProvider = payloads.some(payload => payload.key === 'oss_provider')
  const hasModelProvider = payloads.some(payload => payload.key === 'model_provider')

  if (hasOss && hasModelProvider) throw new CodexExtraArgsError('-c model_provider')
  if (hasOss && !hasLocalProvider && !hasOssProvider) throw new CodexExtraArgsError('--oss')
  if ((hasLocalProvider || hasOssProvider) && !hasOss) {
    throw new CodexExtraArgsError(hasLocalProvider ? '--local-provider' : '-c oss_provider')
  }

  for (const step of walked) {
    if (step.kind !== 'value') continue
    if (step.flag === '--local-provider') {
      if (!LOCAL_PROVIDER_VALUES.has(stripWrappingQuotes(step.value))) {
        throw new CodexExtraArgsError('--local-provider')
      }
    }
  }
  for (const payload of payloads) {
    if (!ALLOWED_CONFIG_KEYS.has(payload.key)) throw new CodexExtraArgsError(`-c ${payload.key}`)
    if (payload.key === 'oss_provider' && !LOCAL_PROVIDER_VALUES.has(stripWrappingQuotes(payload.value))) {
      throw new CodexExtraArgsError('-c oss_provider')
    }
  }

  const banned = findBannedPermissionArg(args)
  if (banned !== null) throw new CodexExtraArgsError(banned)
}

export function skipsCosModel(extra: string[]): boolean {
  return extraIncludesFlag(extra, ['--model', '-m']) || extraIncludesConfigKey(extra, 'model')
}

export function skipsCosServiceTier(extra: string[]): boolean {
  return extraIncludesFlag(extra, ['--oss', '--local-provider'])
    || extraIncludesConfigKey(extra, 'model_provider')
    || extraIncludesConfigKey(extra, 'service_tier')
}

export function skipsCosReasoningEffort(extra: string[]): boolean {
  return extraIncludesConfigKey(extra, 'model_reasoning_effort')
    || extraIncludesFlag(extra, ['--oss', '--local-provider'])
    || extraIncludesConfigKey(extra, 'model_provider')
}

export function codexEngineFingerprint(extra: string[]): string {
  return extra.join('\0')
}
