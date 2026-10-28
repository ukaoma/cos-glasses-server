import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { extractQualifiedMacWindow } from './mac-speaker-profile-extractor.js'
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true) })
  const spawn = vi.fn(() => child) as any
  return { child, deps: { spawn, modulePath: '/synthetic/module.cjs' } }
}
describe('qualified extraction retains ownership until native close', () => {
  it('waits for child close after a timeout kill', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeChild(); let settled = false
      const promise = extractQualifiedMacWindow(Buffer.alloc(960000), '/model', 10, f.deps).then(v => { settled = true; return v })
      await vi.advanceTimersByTimeAsync(11)
      expect(f.child.kill).toHaveBeenCalledWith('SIGKILL'); expect(settled).toBe(false)
      f.child.emit('close', null)
      expect(await promise).toBeNull(); expect(settled).toBe(true)
    } finally { vi.useRealTimers() }
  })
  it('waits for child close after bounded output overflows', async () => {
    const f = fakeChild(); let settled = false
    const promise = extractQualifiedMacWindow(Buffer.alloc(960000), '/model', 1000, f.deps).then(v => { settled = true; return v })
    f.child.stdout.emit('data', Buffer.alloc(131073)); await Promise.resolve()
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL'); expect(settled).toBe(false)
    f.child.emit('close', null); expect(await promise).toBeNull()
  })
})
