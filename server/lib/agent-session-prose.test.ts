import { describe, it, expect } from 'vitest'
import { proseSnippet, latestAssistantReply, LATEST_REPLY_MAX } from './agent-session-store.js'

describe('a reply keeps its structure, a row keeps its one line', () => {
  const reply = [
    '## 1. Liquor — Bottle POS',
    '',
    '### Garg the Gratified',
    '- Square is now validated.',
    '- Native EBT.',
    '',
    'What changes: the pitch should reduce fear.',
  ].join('\n')

  it('preserves the line structure of a reply', () => {
    // THE DEFECT, from a real G2 screenshot: every newline became a space and the
    // lens showed one unreadable paragraph. The client cannot restore structure the
    // server already flattened, so this is the assertion that matters.
    const out = latestAssistantReply(reply)
    expect(out.split('\n').length).toBeGreaterThan(4)
    expect(out).toContain('## 1. Liquor')
    expect(out).toContain('- Native EBT.')
    expect(out).not.toMatch(/Bottle POS +###/)
  })

  it('still collapses a LIST ROW to one line', () => {
    // Two fields, two jobs. A row that grew a newline would break the listicle.
    expect(proseSnippet(reply)).not.toContain('\n')
  })

  it('collapses spaces and tabs but never newlines', () => {
    const out = latestAssistantReply('a  \t b\nc   d')
    expect(out).toBe('a b\nc d')
  })

  it('caps blank runs at one, so a reply cannot waste reader pages', () => {
    expect(latestAssistantReply('a\n\n\n\n\nb')).toBe('a\n\nb')
  })

  it('leaves no trailing space before a break, which renders as a hanging indent', () => {
    expect(latestAssistantReply('a   \nb')).toBe('a\nb')
  })

  it('keeps a placeholder that only LOOKS like a tag', () => {
    // `read <file>` rendered as `read ,` on the lens. Any technical reply can carry
    // <path>, <PORT>, <name>; deleting every angle-bracket pair ate them silently.
    const out = latestAssistantReply('run read <file> then bash <cmd> on <PORT>')
    expect(out).toContain('<file>')
    expect(out).toContain('<cmd>')
    expect(out).toContain('<PORT>')
  })

  it('still strips real HTML and the harness wrapper blocks', () => {
    const out = latestAssistantReply('<div><p>hello</p></div> <cos-alarms>noise</cos-alarms> tail')
    expect(out).not.toContain('<div>')
    expect(out).not.toContain('<p>')
    expect(out).not.toContain('<cos-alarms>')
    expect(out).toContain('hello')
    expect(out).toContain('tail')
  })

  it('strips an HTML tag carrying attributes, not just a bare one', () => {
    const out = latestAssistantReply('<a href="http://x">link</a> and <img src="y" />')
    expect(out).not.toContain('href')
    expect(out).not.toContain('<img')
    expect(out).toContain('link')
  })

  it('marks a truncated reply as truncated, and respects the cap', () => {
    const out = latestAssistantReply('x'.repeat(LATEST_REPLY_MAX + 500))
    expect(out.length).toBe(LATEST_REPLY_MAX)
    expect(out.endsWith('…')).toBe(true)
  })
})
