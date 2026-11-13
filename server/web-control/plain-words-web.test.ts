/**
 * 7.0.33 A8 (Anand round 2, slide 19): words meant for the system never reach the screen. app.js plainMessage turns an
 * answer that is only a machine code into plain words that say what to do; a sentence passes through as it is.
 * Runs the shipped functions, cut from app.js.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const i = APP.indexOf('  var NOT_SET_UP = '), j = APP.indexOf('  function api(path, opts) {')
// eslint-disable-next-line no-new-func
const k = new Function(APP.slice(i, j) + '\nreturn { plainMessage, notSetUp };')()

describe('plainMessage', () => {
  it('the code Anand saw on Memories becomes a plain sentence', () => {
    const t = k.plainMessage('cos_pipeline_not_configured')
    expect(t).not.toMatch(/_/)
    expect(t).toContain('not set up on this Mac')
    expect(k.notSetUp('cos_pipeline_not_configured')).toBe(true)
  })
  it('every listed code has words with no underscore; an unlisted code still gets a plain sentence', () => {
    for (const c of ['pipeline_missing', 'bridge_missing', 'task_runtime_unavailable', 'unknown_command', 'bridge_error', 'some_new_code']) {
      const t = k.plainMessage(c)
      expect(t, c).not.toMatch(/[a-z]_[a-z]/)
      expect(t.length, c).toBeGreaterThan(30)
    }
  })
  it('Q1: bridge_missing is a broken setup, not "not set up", and says what to fix', () => {
    const t = k.plainMessage('bridge_missing')
    expect(t).not.toContain('Nothing is broken')
    expect(t).toContain('COS_SCRIPTS_DIR')
    expect(k.notSetUp('bridge_missing')).toBe(false)
  })
  it('Q1: when trying again does not help, the line says what to do next', () => {
    for (const c of ['bridge_error', 'some_new_code']) expect(k.plainMessage(c), c).toContain('restart COS from the COS Control menu on your Mac')
  })
  it('a sentence from the server passes through untouched, a code inside a sentence too', () => {
    expect(k.plainMessage('Work is busy. Try again.')).toBe('Work is busy. Try again.')
    expect(k.plainMessage('The server answered 500.')).toBe('The server answered 500.')
    expect(k.plainMessage('Failed: cos_pipeline_not_configured')).toBe('Failed: cos_pipeline_not_configured')
  })
  it('api() and the Memories bridge both use it', () => {
    expect(APP).toContain("var err = new Error((typeof plainMessage === 'function' ? plainMessage : String)(")
    expect(readFileSync(join(HERE, 'panes/memories.js'), 'utf8')).toContain('W.plainMessage ? W.plainMessage(raw) : raw')
  })
  it('the Sessions hooks line says it in plain words, then what to do', () => {
    expect(APP).not.toContain('Claude Code hooks are not installed')
    expect(APP).toContain("'COS cannot yet tell when a Claude Code session is working or waiting on you.'")
    expect(APP).toContain("'In COS Control on your Mac, choose ' + (st === 'missing' ? 'Install hooks' : 'Reinstall hooks') + '.'")
  })
})
