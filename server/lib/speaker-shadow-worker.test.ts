// One shadow run, in process, against a fake fluidaudiocli. Importing server modules runs
// them, so the data dir is a scratch dir set before any import.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'speaker-shadow-worker-'))
process.env.COS_DATA_DIR = join(scratch, 'data')

const { runShadowJob, SHADOW_TMP_PREFIX } = await import('./speaker-shadow-worker.js')
const { SHADOW_MODEL_ENTRIES, SHADOW_REVISION_MARKER } = await import('./speaker-shadow-models.js')
const { syntheticMeeting } = await import('./__fixtures__/speaker-shadow/synthetic-meeting.js')
const { writeFakeCli, writePassthroughSandbox } = await import('./__fixtures__/speaker-shadow/fake-cli.js')
type FakeCliMode = import('./__fixtures__/speaker-shadow/fake-cli.js').FakeCliMode
type ShadowJob = import('./speaker-shadow-worker.js').ShadowJob

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const okModels = async (dir: string) => ({ ok: true as const, dir, bytes: 0 })
let caseNo = 0

function setup(mode: FakeCliMode, options: { audioRoot?: string } = {}) {
  const root = join(scratch, `case-${++caseNo}`)
  const cli = writeFakeCli(join(root, 'cli'), mode)
  const meeting = syntheticMeeting()
  const audioDir = join(options.audioRoot ?? join(root, 'meeting-audio'), meeting.sessionId)
  writeFileSync(join(cli.fixtures, 'probe-target.txt'), audioDir)
  mkdirSync(audioDir, { recursive: true })
  for (const [idx, wav] of meeting.wavs) writeFileSync(join(audioDir, `chunk_${String(idx).padStart(4, '0')}.wav`), wav)
  const sidecarPath = join(root, 'recordings', 'meeting.g2-chunks.json')
  mkdirSync(join(root, 'recordings'), { recursive: true })
  writeFileSync(sidecarPath, JSON.stringify(meeting.sidecar))
  const modelsDir = join(root, 'models', 'speaker-diarization')
  mkdirSync(modelsDir, { recursive: true })
  const tmpRoot = join(root, 'tmp')
  mkdirSync(tmpRoot)
  const job: ShadowJob = {
    sessionId: meeting.sessionId, sidecarPath, audioDir, expectedLabelsHash: null,
    cliPath: cli.path, cliSha256: sha(cli.path), sandboxExec: writePassthroughSandbox(join(root, 'bin')),
    modelsDir, homeDir: join(root, 'home'), tmpRoot, cliTimeoutMs: 20_000,
  }
  const cliRuns = () => existsSync(cli.marker) ? readFileSync(cli.marker, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  return { root, cli, job, meeting, cliRuns, tmpRoot }
}

describe('speaker shadow worker: one run', () => {
  it('proposes merges from the CLI output and removes its temp dir', async () => {
    const t = setup('success')
    const outcome = await runShadowJob(t.job, { verifyModels: okModels })
    expect(outcome.status).toBe('proposed')
    if (outcome.status !== 'proposed') return
    expect(outcome.proposals.accepted.map(a => [a.cluster, a.keepLabel, a.merge])).toEqual([
      ['S1', 'Voice 1', ['Voice 2', 'Voice 13']], ['S2', 'Voice 3', ['Voice 10']], ['S4', 'Voice 11', ['Voice 12']],
    ])
    expect(outcome.facts.originals).toBe(34)
    expect(outcome.facts.verifiedAgainstSidecar).toBe(34)
    expect(outcome.facts.unhashedOriginals).toBe(0)
    expect(outcome.facts.minutes).toBe(5.7)
    expect(outcome.facts.tool.flags).toEqual(['--mode', 'offline', '--overlapping-segments', '--export-embeddings'])
    expect(readdirSync(t.tmpRoot)).toEqual([])
    // The CLI got the private HOME and only the documented variables, never the server's.
    const [run] = t.cliRuns()
    expect(run.home).toBe(t.job.homeDir)
    expect(run.envKeys.filter((k: string) => !['HOME', 'CFFIXED_USER_HOME', 'TMPDIR', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING'].includes(k))).toEqual([])
    expect(run.args).toEqual(['process', expect.stringMatching(/timeline\.wav$/), '--mode', 'offline', '--output', expect.stringMatching(/native\.json$/), '--overlapping-segments', '--export-embeddings', expect.stringMatching(/embeddings\.json$/)])
    // The private HOME's model folder: links to the verified entries plus the revision marker.
    const folder = join(t.job.homeDir, 'Library', 'Application Support', 'FluidAudio', 'Models', 'speaker-diarization')
    for (const entry of SHADOW_MODEL_ENTRIES) expect(readlinkSync(join(folder, entry))).toBe(join(t.job.modelsDir, entry))
    expect(readFileSync(join(folder, '.fluidaudio-revision'), 'utf8')).toBe(SHADOW_REVISION_MARKER.content)
  })

  it('a crashing CLI is a failure with its stderr tail', async () => {
    const t = setup('crash')
    const outcome = await runShadowJob(t.job, { verifyModels: okModels })
    expect(outcome).toMatchObject({ status: 'failed', reason: 'cli_failed' })
    expect(outcome.status === 'failed' && outcome.detail).toMatch(/exit 1: .*boom/)
    expect(readdirSync(t.tmpRoot)).toEqual([])
  })

  it('a hung CLI is killed at its deadline', async () => {
    const t = setup('hang')
    const outcome = await runShadowJob({ ...t.job, cliTimeoutMs: 1_500 }, { verifyModels: okModels })
    expect(outcome).toMatchObject({ status: 'failed', reason: 'cli_timeout' })
    const pid = t.cliRuns()[0].pid
    expect(() => process.kill(pid, 0)).toThrow()
    expect(readdirSync(t.tmpRoot)).toEqual([])
  }, 15_000)

  it('a CLI that rejects an option is reported as unsupported', async () => {
    const t = setup('unknown_option')
    expect(await runShadowJob(t.job, { verifyModels: okModels })).toMatchObject({ status: 'failed', reason: 'cli_unsupported' })
  })

  it('unreadable CLI output is a failure, never a partial record', async () => {
    const t = setup('bad_json')
    expect(await runShadowJob(t.job, { verifyModels: okModels })).toMatchObject({ status: 'failed', reason: 'bad_cli_output' })
  })

  it('missing models skip the run before the CLI is touched (the real verifier)', async () => {
    const t = setup('success')
    expect(await runShadowJob(t.job)).toMatchObject({ status: 'skipped', reason: 'models_missing' })
    expect(t.cliRuns()).toEqual([])
  })

  it('labels that changed after finalize skip the run (a correction already landed)', async () => {
    const t = setup('success')
    expect(await runShadowJob({ ...t.job, expectedLabelsHash: '0'.repeat(64) }, { verifyModels: okModels })).toMatchObject({ status: 'skipped', reason: 'labels_changed' })
    expect(t.cliRuns()).toEqual([])
  })

  it('a meeting that is not finalized is skipped', async () => {
    const t = setup('success')
    writeFileSync(t.job.sidecarPath, JSON.stringify({ ...t.meeting.sidecar, finalizationState: 'ops_pending' }))
    expect(await runShadowJob(t.job, { verifyModels: okModels })).toMatchObject({ status: 'skipped', reason: 'not_finalized' })
  })

  it('an original that no longer matches its sidecar hash is skipped', async () => {
    const t = setup('success')
    const wav = join(t.job.audioDir, 'chunk_0003.wav')
    const bytes = readFileSync(wav); bytes[100] ^= 0xff; writeFileSync(wav, bytes)
    expect(await runShadowJob(t.job, { verifyModels: okModels })).toMatchObject({ status: 'skipped', reason: 'audio_drift' })
    expect(t.cliRuns()).toEqual([])
  })

  it('a missing original is skipped with the count', async () => {
    const t = setup('success')
    unlinkSync(join(t.job.audioDir, 'chunk_0007.wav'))
    expect(await runShadowJob(t.job, { verifyModels: okModels })).toMatchObject({ status: 'skipped', reason: 'audio_missing', detail: '1 original chunk WAVs missing' })
  })

  it('a CLI that changed since the scheduler verified it is not run', async () => {
    const t = setup('success')
    expect(await runShadowJob({ ...t.job, cliSha256: 'f'.repeat(64) }, { verifyModels: okModels })).toMatchObject({ status: 'skipped', reason: 'cli_changed' })
    expect(t.cliRuns()).toEqual([])
  })

  it('no sandbox-exec, no run', async () => {
    const t = setup('success')
    expect(await runShadowJob({ ...t.job, sandboxExec: join(t.root, 'no-such-sandbox-exec') }, { verifyModels: okModels })).toMatchObject({ status: 'failed', reason: 'sandbox_unavailable' })
    expect(t.cliRuns()).toEqual([])
  })

  it.skipIf(!existsSync('/usr/bin/sandbox-exec'))('under the real sandbox the CLI has no network and cannot write next to the meeting audio', async () => {
    // The meeting audio must sit OUTSIDE the per-user temp dir (os.tmpdir() is inside it, and the
    // profile lets the CLI write there for MPSGraph), as <data>/meeting-audio does in production.
    const audioRoot = mkdtempSync('/tmp/speaker-shadow-probe-')
    try {
      const t = setup('probe', { audioRoot })
      const outcome = await runShadowJob({ ...t.job, sandboxExec: '/usr/bin/sandbox-exec' }, { verifyModels: okModels })
      expect(outcome.status).toBe('proposed')
      const probe = t.cliRuns().find(r => r.probe)?.probe
      expect(probe.network).not.toBe('connected')
      expect(probe.audioWrite).toBe('EPERM')
      expect(probe.workWrite).toBe('allowed')
      expect(existsSync(join(t.job.audioDir, 'written-by-cli.txt'))).toBe(false)
    } finally { rmSync(audioRoot, { recursive: true, force: true }) }
  }, 20_000)

  it('names its temp dir with the prefix the boot sweep removes', () => {
    expect(SHADOW_TMP_PREFIX).toBe('cos-speaker-shadow-')
    expect(lstatSync(scratch).isDirectory()).toBe(true)
  })
})
