import { describe, expect, it } from 'vitest'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dropItCapability, dropItEnabled, dropItSource, writeDropItSetting } from './drop-settings.js'
import { decisionSettingsRevision, decisionSettingsView, DECISION_WORKFLOWS, patchDecisionSettings, resolveDecisionSelection } from './decision-settings.js'

const file = () => join(mkdtempSync(join(tmpdir(), 'drop-settings-')), 'drop-it-settings.json')

describe('Drop it switch', () => {
  it('is off with no environment value and no file', () => {
    expect(dropItEnabled({}, file())).toBe(false)
  })
  it('the settings file turns it on and off', () => {
    const f = file()
    writeDropItSetting(true, f)
    expect(dropItEnabled({}, f)).toBe(true)
    writeDropItSetting(false, f)
    expect(dropItEnabled({}, f)).toBe(false)
  })
  it('COS_DROP_IT wins over the file either way', () => {
    const f = file(); writeDropItSetting(true, f)
    expect(dropItEnabled({ COS_DROP_IT: '0' }, f)).toBe(false)
    expect(dropItEnabled({ COS_DROP_IT: 'on' }, file())).toBe(true)
    expect(dropItEnabled({ COS_DROP_IT: '' }, f)).toBe(true)
    expect(dropItSource({ COS_DROP_IT: '1' })).toBe('env')
    expect(dropItSource({})).toBe('settings')
  })
  it('a malformed file or a symlink reads as off', () => {
    const f = file(); writeFileSync(f, '{"enabled":"yes"}')
    expect(dropItEnabled({}, f)).toBe(false)
    const target = file(); writeDropItSetting(true, target)
    const link = file(); symlinkSync(target, link)
    expect(dropItEnabled({}, link)).toBe(false)
  })
  it('advertises a protocol and the switch, nothing else', () => {
    expect(Object.keys(dropItCapability({ COS_DROP_IT: '0' })).sort()).toEqual(['enabled', 'protocol', 'source'])
  })
})

describe('decision use case drop', () => {
  it('is a workflow, and existing settings keep their revision', () => {
    expect(DECISION_WORKFLOWS).toContain('drop')
    // Pinned against 6.99.4's formula: sha256 of [provider, session, completion, search].
    const settings = { schema: 1 as const, provider: 'subq' as const, overrides: { search: 'jev' as const } }
    const old = createHash('sha256').update(JSON.stringify(['subq', null, null, 'jev'])).digest('hex')
    expect(decisionSettingsRevision(settings)).toBe(old)
    expect(decisionSettingsRevision({ ...settings, overrides: { ...settings.overrides, drop: 'jev' } })).not.toBe(old)
  })
  it('can be selected per use case and defaults to Jev', () => {
    expect(resolveDecisionSelection('drop', {}, { schema: 1, overrides: {} })).toEqual({ provider: 'jev', source: 'default' })
    expect(resolveDecisionSelection('drop', { COS_DECISION_PROVIDER_DROP: 'subq' }, { schema: 1, overrides: {} }).provider).toBe('subq')
    const base = { schema: 1 as const, overrides: {} }
    const next = patchDecisionSettings(base, { overrides: { drop: 'subq' }, expectedRevision: decisionSettingsRevision(base) })
    expect(next.overrides.drop).toBe('subq')
    expect(decisionSettingsView(next, { jev: true, subq: false }, {}).effective).toMatchObject({ drop: 'subq', session: 'jev' })
  })
})
