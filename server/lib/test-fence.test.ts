import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FENCE_ROOT_PREFIX, applyFence, fenceRequested } from '../../test-support/fence.js'

// The opt-in per-fork scratch area (COS_TEST_FENCE=1, test-support/fence.ts). The default run does
// not use it; these tests prove the helper and, when a fenced run is under way, that it took hold.
describe('test fence', () => {
  it('is requested only by the exact value "1"', () => {
    expect(fenceRequested({})).toBe(false)
    expect(fenceRequested({ COS_TEST_FENCE: '0' })).toBe(false)
    expect(fenceRequested({ COS_TEST_FENCE: 'true' })).toBe(false)
    expect(fenceRequested({ COS_TEST_FENCE: '' })).toBe(false)
    expect(fenceRequested({ COS_TEST_FENCE: '1' })).toBe(true)
  })

  it('moves every COS_* value under the shared data home and nothing else', () => {
    const env: Record<string, string | undefined> = {
      COS_DATA_DIR: '/var/shared-home',
      COS_PROFILE_PATH: '/var/shared-home/.cos-profile.json',
      COS_TOKEN_AUDIT_FILE: '/var/shared-home/token-audit.jsonl',
      COS_MAINTENANCE_GATE_PATH: '/var/shared-home/maintenance/maintenance-gate.json',
      COS_UNRELATED: '/elsewhere/keep',
      COS_LOOKALIKE: '/var/shared-home-other/keep',
      COS_DIARIZER: 'embedding',
      HOME: '/Users/someone',
      TMPDIR: '/var/folders/zz/T',
    }
    const fence = applyFence(env)
    try {
      expect(env.COS_DATA_DIR).toBe(join(fence.root, 'data'))
      expect(env.COS_TOKEN_AUDIT_FILE).toBe(join(fence.root, 'data', 'token-audit.jsonl'))
      expect(env.COS_MAINTENANCE_GATE_PATH).toBe(join(fence.root, 'data', 'maintenance', 'maintenance-gate.json'))
      expect(env.COS_PROFILE_PATH).toBe(join(fence.root, 'data', '.cos-profile.json'))
      expect(env.COS_UNRELATED).toBe('/elsewhere/keep')
      // A sibling that merely starts with the same characters is not under the data home.
      expect(env.COS_LOOKALIKE).toBe('/var/shared-home-other/keep')
      expect(env.COS_DIARIZER).toBe('embedding')
      expect(env.HOME).toBe(join(fence.root, 'home'))
      expect(env.TMPDIR).toBe(join(fence.root, 'tmp'))
      // The fixed /tmp files and the two checkout-local caches each get a private path.
      for (const key of ['COS_CLI_SESSIONS_FILE', 'COS_CODEX_ENGINE_SESSIONS_FILE', 'COS_CURSOR_ENGINE_SESSIONS_FILE', 'COS_SPEAKER_TRAINING_DIR', 'COS_CURSOR_MODEL_CACHE_FILE', 'TTS_DISK_CACHE_DIR']) {
        expect(env[key], key).toMatch(new RegExp(`^${fence.root}/`))
      }
      for (const dir of [fence.dataDir, fence.homeDir, fence.tmpDir]) expect(existsSync(dir), dir).toBe(true)
    } finally {
      fence.cleanup()
    }
    expect(existsSync(fence.root)).toBe(false)
  })

  it('uses a short /tmp root so a unix socket path under TMPDIR fits', () => {
    const env: Record<string, string | undefined> = {}
    const fence = applyFence(env)
    try {
      expect(fence.root.startsWith(FENCE_ROOT_PREFIX)).toBe(true)
      expect(fence.root).toMatch(/^\/tmp\/cos-v-[A-Za-z0-9]{6}$/)
      // macOS caps a unix socket path near 104 bytes.
      expect(join(env.TMPDIR!, `occupancy-${'x'.repeat(30)}.sock`).length).toBeLessThan(104)
    } finally {
      fence.cleanup()
    }
  })

  it('gives two forks different scratch areas', () => {
    const a = applyFence({})
    const b = applyFence({})
    try {
      expect(a.root).not.toBe(b.root)
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  it('keeps installed models readable through a symlink, and cleanup never reaches the target', () => {
    const realHome = mkdtempSync(join(tmpdir(), 'fence-home-'))
    const models = join(realHome, '.cos-glasses', 'models')
    mkdirSync(models, { recursive: true })
    writeFileSync(join(models, 'model.onnx'), 'weights')
    const env: Record<string, string | undefined> = { HOME: realHome }
    const fence = applyFence(env)
    try {
      const link = join(env.HOME!, '.cos-glasses', 'models')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(link, 'model.onnx'), 'utf8')).toBe('weights')
      expect(realpathSync(link)).toBe(realpathSync(models))
    } finally {
      fence.cleanup()
    }
    expect(existsSync(fence.root)).toBe(false)
    // The scratch area is gone; the real model is not.
    expect(readFileSync(join(models, 'model.onnx'), 'utf8')).toBe('weights')
    rmSync(realHome, { recursive: true, force: true })
  })

  it('makes no models link when the real home has none', () => {
    const env: Record<string, string | undefined> = { HOME: '/nonexistent-home-for-fence-test' }
    const fence = applyFence(env)
    try {
      expect(existsSync(join(fence.homeDir, '.cos-glasses'))).toBe(false)
    } finally {
      fence.cleanup()
    }
  })

  it('leaves TMPDIR alone only when asked, and still fences the data home and HOME', () => {
    const env: Record<string, string | undefined> = { COS_DATA_DIR: '/var/shared-home', HOME: '/Users/someone', TMPDIR: '/var/folders/zz/T' }
    const fence = applyFence(env, undefined, { keepTmpdir: true })
    try {
      expect(env.TMPDIR).toBe('/var/folders/zz/T')
      expect(env.HOME).toBe(join(fence.root, 'home'))
      expect(env.COS_DATA_DIR).toBe(join(fence.root, 'data'))
    } finally {
      fence.cleanup()
    }
  })

  // Passes in both modes on purpose: the per-test-ID parity run compares statuses, so a test that is
  // skipped unfenced and passed fenced would read as a difference.
  it('took hold in this fork when the run is fenced', () => {
    if (!fenceRequested(process.env)) return
    for (const key of ['COS_DATA_DIR', 'COS_PROFILE_PATH', 'COS_CLI_SESSIONS_FILE', 'HOME', 'TMPDIR']) {
      expect(process.env[key], key).toMatch(/^\/tmp\/cos-v-[A-Za-z0-9]{6}\//)
    }
    expect(process.env.COS_TOKEN_AUDIT_FILE).toMatch(/^\/tmp\/cos-v-[A-Za-z0-9]{6}\/data\//)
    expect(process.env.COS_MAINTENANCE_GATE_PATH).toMatch(/^\/tmp\/cos-v-[A-Za-z0-9]{6}\/data\//)
  })
})
