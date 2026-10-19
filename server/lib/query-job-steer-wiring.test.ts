// 6.78.0 Messages steer composition, on the source: query-job-runtime.ts and routes/health.ts
// cannot be imported here (their graphs reach claude-bridge.ts and whisper-local). Each wired
// behaviour is executed elsewhere: the coordinator's steer options in
// query-job-steer-coordinator.test.ts, the bridge's port in claude-bridge-steer.test.ts, the
// capability's shape in routes/query-jobs-steer.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const runtime = readFileSync(new URL('./query-job-runtime.ts', import.meta.url), 'utf8')
const health = readFileSync(new URL('../routes/health.ts', import.meta.url), 'utf8')

describe('Messages steer wiring (6.78.0)', () => {
  it('the runner hands the coordinator\'s port to the bridge, and only when there is one', () => {
    expect(runtime).toContain('const runner: QueryJobRunner = async ({ jobId, turnId, request, signal, callbacks, steer }) => {')
    expect(runtime).toContain('      ...(steer ? { steer } : {}),\n')
  })

  it('the coordinator gets the switch, the model-router provider rule and the CLI probe', () => {
    const options = runtime.slice(runtime.indexOf('export const queryJobCoordinator = new QueryJobCoordinator('))
    const steer = options.slice(options.indexOf('  steer: {'), options.indexOf('\n})'))
    expect(steer).toContain('enabled: () => messagesSteerEnabled(),')
    // Key lanes K1 (P6): the same rule behind the explicit profile guard; with no profile the
    // verdict is providerOfModel(resolveRunModel(...)) (key-lanes-p6-steer.test.ts executes it).
    expect(steer).toContain('provider: request => steerProviderForJob(request),')
    const job = runtime.slice(runtime.indexOf('export function steerProviderForJob('), runtime.indexOf('\nfunction providerFor('))
    expect(job).toContain('getSessionModel(request.sessionId),\n    process.env.COS_G2_DEFAULT_MODEL,')
    expect(job).toContain("if (verdict.kind === 'profile_session') return profileSteerProvider(verdict.profileId)")
    expect(steer).toContain('cliSupported: () => claudeSupportsSteer(),')
  })

  it('/api/models advertises durableQueryJobs.steer only through the capability helper', () => {
    const models = health.slice(health.indexOf('durableQueryJobs: {\n        enabled: durableJobs.enabled,'))
    expect(models.slice(0, 900)).toContain('...steerCapabilityField(durableJobs.enabled),')
    expect(health).toContain('const steer = messagesSteerCapability({ jobsEnabled, cliSupported: claudeSteerSupportKnown() })')
  })
})
