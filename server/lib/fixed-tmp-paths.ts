// Fixed /tmp files this server shares with whatever else runs on the machine, each with an env
// override. Unset, every path is the literal it has always been. The overrides exist so the opt-in
// fenced test modes (COS_TEST_FENCE=1, test-support/fence.ts) can give each test file its own copy
// instead of sharing one with the live server or a sibling test.
//
// The Codex and Cursor engine-session files already had overrides and keep their own getters
// (codex-engine-sessions.ts, cursor-engine-sessions.ts).

export const DEFAULT_CLI_SESSIONS_FILE = '/tmp/cos-cli-sessions.json'
export const DEFAULT_SPEAKER_TRAINING_DIR = '/tmp/cos-speaker-training'

/** Where claude-bridge persists CLI session ids. COS_CLI_SESSIONS_FILE moves it. */
export function cliSessionsFilePath(env: Record<string, string | undefined> = process.env): string {
  return env.COS_CLI_SESSIONS_FILE || DEFAULT_CLI_SESSIONS_FILE
}

/** Scratch directory for speaker-trainer's downloaded audio and segments. COS_SPEAKER_TRAINING_DIR moves it. */
export function speakerTrainingDir(env: Record<string, string | undefined> = process.env): string {
  return env.COS_SPEAKER_TRAINING_DIR || DEFAULT_SPEAKER_TRAINING_DIR
}
