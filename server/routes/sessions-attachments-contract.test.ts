import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./sessions.ts', import.meta.url), 'utf8')

describe('session attachment projection contract', () => {
  it('recovers legacy refs by exact session and message identity', () => {
    expect(source).toContain('activeMessageEra: activeEra.era')
    expect(source).toContain('activeEraStartedAt: activeEra.startedAt')
    expect(source).toMatch(/turnAttachments\(m\.sessionId, globalMsgNum, m\.messageEra, activeEra, m\.attachments\)/)
    expect(source).toMatch(/turnAttachments\(session\.id, globalMsgNum, messageEra, activeEra, ex\.attachments, next\.attachments\)/)
  })

  it('fails open to text history when optional media lookup is unavailable', () => {
    expect(source).toContain('media association lookup unavailable; serving text-only history')
    expect(source).toMatch(/catch \(error\)[\s\S]*return mergeMediaAttachmentRefs\(\.\.\.sources, associated\)/)
  })

  it('cannot leak rejected raw archive attachment values through object spread', () => {
    expect(source).toContain('const { attachments: _rawAttachments, ...message } = m')
    expect(source).toMatch(/return \{\s*\.\.\.message,\s*source: 'archive' as const,/)
  })
})
