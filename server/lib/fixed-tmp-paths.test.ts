import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLI_SESSIONS_FILE, DEFAULT_SPEAKER_TRAINING_DIR, cliSessionsFilePath, speakerTrainingDir,
} from './fixed-tmp-paths.js'
import { getCodexEngineSessionPath } from './codex-engine-sessions.js'
import { getCursorEngineSessionPath } from './cursor-engine-sessions.js'

// The fixed /tmp files the live server shares with a test run. Production keeps the literal paths;
// only an explicit env var moves them (the opt-in fenced test modes set all four per test file).
describe('fixed /tmp paths', () => {
  it('keeps the production defaults byte-identical', () => {
    expect(DEFAULT_CLI_SESSIONS_FILE).toBe('/tmp/cos-cli-sessions.json')
    expect(DEFAULT_SPEAKER_TRAINING_DIR).toBe('/tmp/cos-speaker-training')
    expect(cliSessionsFilePath({})).toBe('/tmp/cos-cli-sessions.json')
    expect(speakerTrainingDir({})).toBe('/tmp/cos-speaker-training')
  })

  it('moves a path only for a non-empty explicit override', () => {
    expect(cliSessionsFilePath({ COS_CLI_SESSIONS_FILE: '/tmp/cos-v-x/cli.json' })).toBe('/tmp/cos-v-x/cli.json')
    expect(speakerTrainingDir({ COS_SPEAKER_TRAINING_DIR: '/tmp/cos-v-x/train' })).toBe('/tmp/cos-v-x/train')
    // An empty value is "not set", never a path.
    expect(cliSessionsFilePath({ COS_CLI_SESSIONS_FILE: '' })).toBe('/tmp/cos-cli-sessions.json')
    expect(speakerTrainingDir({ COS_SPEAKER_TRAINING_DIR: '' })).toBe('/tmp/cos-speaker-training')
  })

  it('reads process.env when no env is passed', () => {
    const saved = { cli: process.env.COS_CLI_SESSIONS_FILE, train: process.env.COS_SPEAKER_TRAINING_DIR }
    try {
      process.env.COS_CLI_SESSIONS_FILE = '/tmp/cos-v-env/cli.json'
      process.env.COS_SPEAKER_TRAINING_DIR = '/tmp/cos-v-env/train'
      expect(cliSessionsFilePath()).toBe('/tmp/cos-v-env/cli.json')
      expect(speakerTrainingDir()).toBe('/tmp/cos-v-env/train')
      delete process.env.COS_CLI_SESSIONS_FILE
      delete process.env.COS_SPEAKER_TRAINING_DIR
      expect(cliSessionsFilePath()).toBe('/tmp/cos-cli-sessions.json')
      expect(speakerTrainingDir()).toBe('/tmp/cos-speaker-training')
    } finally {
      if (saved.cli === undefined) delete process.env.COS_CLI_SESSIONS_FILE; else process.env.COS_CLI_SESSIONS_FILE = saved.cli
      if (saved.train === undefined) delete process.env.COS_SPEAKER_TRAINING_DIR; else process.env.COS_SPEAKER_TRAINING_DIR = saved.train
    }
  })

  it('keeps the Codex and Cursor engine-session defaults and their existing overrides', () => {
    const saved = { codex: process.env.COS_CODEX_ENGINE_SESSIONS_FILE, cursor: process.env.COS_CURSOR_ENGINE_SESSIONS_FILE }
    try {
      delete process.env.COS_CODEX_ENGINE_SESSIONS_FILE
      delete process.env.COS_CURSOR_ENGINE_SESSIONS_FILE
      expect(getCodexEngineSessionPath()).toBe('/tmp/cos-codex-engine-sessions.json')
      expect(getCursorEngineSessionPath()).toBe('/tmp/cos-cursor-engine-sessions.json')
      process.env.COS_CODEX_ENGINE_SESSIONS_FILE = '/tmp/cos-v-env/codex.json'
      process.env.COS_CURSOR_ENGINE_SESSIONS_FILE = '/tmp/cos-v-env/cursor.json'
      expect(getCodexEngineSessionPath()).toBe('/tmp/cos-v-env/codex.json')
      expect(getCursorEngineSessionPath()).toBe('/tmp/cos-v-env/cursor.json')
    } finally {
      if (saved.codex === undefined) delete process.env.COS_CODEX_ENGINE_SESSIONS_FILE; else process.env.COS_CODEX_ENGINE_SESSIONS_FILE = saved.codex
      if (saved.cursor === undefined) delete process.env.COS_CURSOR_ENGINE_SESSIONS_FILE; else process.env.COS_CURSOR_ENGINE_SESSIONS_FILE = saved.cursor
    }
  })
})
