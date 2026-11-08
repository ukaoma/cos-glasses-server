/**
 * 7.0.4 QA: what a failed preview read is logged as: the error's code (ENOENT, EACCES, ...) or its class, never its
 * message. An fs error message carries the path, and a path never goes into a log line.
 */
export function previewErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code
  const name = (error as { name?: unknown } | null)?.name
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'unknown'
}
