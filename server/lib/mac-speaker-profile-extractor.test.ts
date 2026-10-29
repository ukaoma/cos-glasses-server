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
  it('rejects close after the absolute deadline even when its timer has not run',async()=>{
    vi.useFakeTimers();vi.setSystemTime(10000)
    try{const f=fakeChild(),p=extractQualifiedMacWindow(Buffer.alloc(960000),'/model',10,f.deps)
      f.child.stdout.emit('data',Buffer.from('[[],[],[]]'));vi.setSystemTime(10011);f.child.emit('close',0)
      expect(await p).toBeNull()
    }finally{vi.useRealTimers()}
  })
  it('refuses overlapping live/saved children until the owned child closes',async()=>{
    const first=fakeChild(),second=fakeChild()
    const pending=extractQualifiedMacWindow(Buffer.alloc(960000),'/model',1000,first.deps)
    expect(await extractQualifiedMacWindow(Buffer.alloc(960000),'/model',1000,second.deps)).toBeNull()
    expect(second.deps.spawn).not.toHaveBeenCalled()
    first.child.emit('close',1);expect(await pending).toBeNull()
    const next=extractQualifiedMacWindow(Buffer.alloc(960000),'/model',1000,second.deps)
    second.child.emit('close',1);expect(await next).toBeNull();expect(second.deps.spawn).toHaveBeenCalledTimes(1)
  })
  it('releases admission after synchronous spawn failure',async()=>{
    expect(await extractQualifiedMacWindow(Buffer.alloc(960000),'/model',1000,{modulePath:'/module',spawn:vi.fn(()=>{throw Error('spawn')})as any})).toBeNull()
    const f=fakeChild(),p=extractQualifiedMacWindow(Buffer.alloc(960000),'/model',1000,f.deps);f.child.emit('close',1);await p
    expect(f.deps.spawn).toHaveBeenCalledOnce()
  })
  it('waits for child close after bounded output overflows', async () => {
    const f = fakeChild(); let settled = false
    const promise = extractQualifiedMacWindow(Buffer.alloc(960000), '/model', 1000, f.deps).then(v => { settled = true; return v })
    f.child.stdout.emit('data', Buffer.alloc(131073)); await Promise.resolve()
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL'); expect(settled).toBe(false)
    f.child.emit('close', null); expect(await promise).toBeNull()
  })
})
