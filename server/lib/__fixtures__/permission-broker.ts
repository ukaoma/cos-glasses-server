// Shared fixtures for the 6.52.0 permission broker tests (never shipped: package.json
// excludes server/lib/__fixtures__).

export const SESSION = 'a1b2c3d4-0000-4000-8000-00000000abcd'
/** A trailing space and a lens glyph: the answer must be keyed by THIS text, byte for byte. */
export const Q1 = 'Which release steps do we run? '
export const Q2 = 'Pick a color ●'
export const QUESTIONS = [
  { question: Q1, header: 'Release', multiSelect: true, options: [{ label: 'Bump', description: 'version files' }, { label: 'Tag', description: '' }, { label: 'Publish', description: 'npm' }] },
  { question: Q2, header: 'Color', multiSelect: false, options: [{ label: 'Blue', description: '' }, { label: 'Red', description: '' }] },
]
export const ASK_INPUT = { questions: QUESTIONS, metadata: { source: 'canary' } }

/** The spool envelope the hook posts, with the permission suggestions Claude sends (never returned). */
export function permissionEnvelope(toolName: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}, ts: unknown = Date.now()) {
  return {
    ts, ppid: 4242, event: 'PermissionRequest',
    payload: {
      session_id: SESSION, hook_event_name: 'PermissionRequest', cwd: '/Users/example/project', permission_mode: 'default',
      tool_name: toolName, tool_input: toolInput,
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'localSettings' }],
      ...extra,
    },
  }
}
