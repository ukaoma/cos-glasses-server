import { describe, expect, it } from 'vitest'
import {
  claudeToolInputPreview,
  claudeToolResultPreviewLines,
  codexActivityPreviewLines,
  sanitizeActivityPreview,
  textPreviewLines,
} from './activity-preview.js'

describe('activity preview redaction', () => {
  it('redacts headers, assignments, flags, URLs, and provider credentials', () => {
    const cases = [
      'Authorization: Bearer abcdefghijklmnop',
      'Authorization=Basic dXNlcjpwYXNzd29yZA==',
      'OPENAI_API_KEY="plain-secret-value"',
      'COS_API_TOKEN=local-network-secret',
      'AWS_SECRET_ACCESS_KEY=hunter3',
      'DATABASE_URL=postgres://dbuser:dbpass@localhost/app',
      '{"password":"json-password-value"}',
      '{"access_token":"json-access-value"}',
      'token=plain-token-value',
      'password: hunter2',
      'curl --token github_pat_abcdefghijklmno',
      'https://miles:secret@example.com/path?access_token=abcdefghi',
      'aws=AKIAABCDEFGHIJKLMNOP',
      'jwt=eyJabcdefghijk.abcdefghijklmnop.qrstuvwxyz12',
    ]
    for (const value of cases) {
      const preview = sanitizeActivityPreview(value)
      expect(preview, value).toContain('[redacted')
      expect(preview, value).not.toMatch(/hunter[23]|plain-secret-value|local-network-secret|dbuser:dbpass|json-(?:password|access)-value|plain-token-value|abcdefghijklmnop|miles:secret|AKIAABCDEFGHIJKLMNOP/)
    }
  })

  it('suppresses 40–72 character PEM/private-key body chunks', () => {
    for (const width of [40, 48, 64, 72]) {
      const chunk = 'A'.repeat(width)
      expect(sanitizeActivityPreview(chunk), `width ${width}`).toBe('[opaque output hidden]')
    }
    expect(sanitizeActivityPreview('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw'.padEnd(64, 'A'))).toBe('[opaque output hidden]')
  })

  it('redacts cookie headers, whitespace secrets, credential flags, and bare DSNs', () => {
    const values = [
      'Set-Cookie: PHPSESSID=s3cr3tvalue123; Path=/; HttpOnly',
      'Cookie: JSESSIONID=abcDEF123456789; theme=light',
      'password="correct horse battery staple"',
      'curl --token abcdef0123456789 https://service.test',
      'psql --password hunter2',
      'curl -u admin:supersecret https://service.test',
      'export TOKEN abcdef0123456789',
      'postgres://user:password@db.internal/app',
      'mongodb+srv://admin:supersecret@cluster/db',
      'redis://:hunter2@cache.internal/0',
    ]
    for (const value of values) {
      const sanitized = sanitizeActivityPreview(value) ?? ''
      expect(sanitized, value).not.toMatch(/s3cr3tvalue123|abcDEF123456789|correct horse|abcdef0123456789|hunter2|supersecret|user:password/)
    }
  })

  it('hides an entire multiline private-key block including short fragments', () => {
    const lines = textPreviewLines([
      'safe before',
      '-----BEGIN PRIVATE KEY-----',
      'AbCdEfGhIjKlMnOpQrStUvWxYz12',
      '-----END PRIVATE KEY-----',
      'safe after',
    ].join('\n'), 5)
    expect(lines).toEqual(['safe before', '[private material hidden]', 'safe after'])
    expect(sanitizeActivityPreview('echo "-----BEGIN PRIVATE KEY-----\nShortPrivateFragment123\n-----END PRIVATE KEY-----"')).not.toContain('ShortPrivateFragment123')
  })

  it('hides opaque high-entropy material and strips terminal controls', () => {
    expect(sanitizeActivityPreview('Aa0_'.repeat(30))).toBe('[opaque output hidden]')
    const preview = sanitizeActivityPreview(`\u001b[31m${'visible output '.repeat(20)}\u001b[0m`, 40)
    expect(preview).toHaveLength(40)
    expect(preview).not.toContain('\u001b')
  })
})

describe('observable tool activity only', () => {
  it('shows Codex command, bounded output, and exit status', () => {
    expect(codexActivityPreviewLines({
      type: 'item.started',
      item: { type: 'command_execution', command: 'rg -n activity src' },
    })).toEqual([{ kind: 'input', text: '$ rg -n activity src' }])

    expect(codexActivityPreviewLines({
      type: 'item.completed',
      item: { type: 'command_execution', aggregated_output: 'one\ntwo\nthree\nfour', exit_code: 0 },
    })).toEqual([
      { kind: 'output', text: 'two' },
      { kind: 'output', text: 'three' },
      { kind: 'output', text: 'four' },
      { kind: 'output', text: 'exit 0' },
    ])
  })

  it('extracts Claude tool payloads but never assistant thinking', () => {
    expect(claudeToolInputPreview('WebSearch', '{"query":"latest GPT models"}')).toEqual({
      kind: 'input',
      text: 'Search: latest GPT models',
    })
    expect(claudeToolResultPreviewLines({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'first\nsecond' }] },
    })).toEqual([
      { kind: 'output', text: 'first' },
      { kind: 'output', text: 'second' },
    ])
    expect(claudeToolResultPreviewLines({
      type: 'assistant',
      message: { content: [{ type: 'thinking', text: 'hidden reasoning' }] },
    })).toEqual([])
  })
})
