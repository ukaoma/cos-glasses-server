// One definition of "what is a native thread id", shared by every module that
// touches one.
//
// This exists because two modules written in the same session already disagreed.
// The occupancy detector accepted any non-empty string and the binding store
// required a UUID, so a truncated id sailed through occupancy — which reports
// "no owner found" — and came back attachable while a desktop process held the
// thread. QA verified that end to end. A single exported regex is the only way
// the two stay aligned.
//
// DELIBERATELY STRICTER THAN BOTH EXISTING REPO VALIDATORS:
//   agent-session-store.ts  isSafeSessionId  -> hex + hyphen, any length >= 8
//   query-job-types.ts      SAFE_ID_RE       -> also allows . _ : @ and /
// A native thread id becomes a mutex key and a filesystem path component, so
// `/` and `.` are disqualifying, and the 8-character display form
// (`ClaudePeer.id` is `sessionId.slice(0, 8)`) must never validate.

export const NATIVE_THREAD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isValidNativeThreadId(value: unknown): value is string {
  return typeof value === 'string' && NATIVE_THREAD_ID_RE.test(value)
}
