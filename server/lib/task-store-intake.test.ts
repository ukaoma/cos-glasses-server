/**
 * Work intake's two bridge powers, against a faked COS bridge: whether cards can be made (the additive
 * `captureWork` capability), and that a capture answer is only trusted when its shape is exact.
 */
import { expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const call = vi.hoisted(() => vi.fn())
const available = vi.hoisted(() => ({ value: true }))
const ops = vi.hoisted(() => ({ root: '' }))
vi.mock('./task-bridge.js', () => ({ callTaskBridge: call, taskBridgeAvailable: () => available.value,
  taskOperationsRoot: () => ops.root, taskBridgeUnavailableMessage: () => '' }))
import { captureWorkItem, workIntakeCapabilities } from './task-store.js'

const meeting = { domain: 'quilt', month: '2026-09', filename: '2026-09-24_QA.md', recordId: 'ops:quilt:2026-09:2026-09-24_QA.md', title: 'QA' }
beforeEach(() => {
  call.mockReset(); available.value = true
  ops.root = mkdtempSync(join(tmpdir(), 'intake-ops-')); mkdirSync(join(ops.root, 'quilt')); writeFileSync(join(ops.root, 'quilt', 'tasks.md'), '# Quilt\n')
})

it('reports card creation only when the bridge says captureWork 1, and never throws', async () => {
  call.mockResolvedValue({ version: 1, captureWork: 1 })
  expect(await workIntakeCapabilities()).toEqual({ linkWrites: true, cardCreation: true })
  expect(call).toHaveBeenCalledWith(['task-work-capabilities'], expect.any(Number), undefined)
  call.mockResolvedValue({ version: 1 })  // a 6.56-era COS bridge
  expect(await workIntakeCapabilities()).toEqual({ linkWrites: true, cardCreation: false })
  call.mockResolvedValue({ version: 2, captureWork: 1 })
  expect(await workIntakeCapabilities()).toEqual({ linkWrites: false, cardCreation: false })
  call.mockRejectedValue(new Error('python exited 1'))
  expect(await workIntakeCapabilities()).toEqual({ linkWrites: false, cardCreation: false, bridgeUnavailable: true })
  available.value = false; call.mockClear()
  expect(await workIntakeCapabilities()).toEqual({ linkWrites: false, cardCreation: false })
  expect(call).not.toHaveBeenCalled()
})

it('sends one capture to the bridge and trusts only an exact answer', async () => {
  call.mockResolvedValue({ ok: true, created: true, id: 'c'.repeat(12), linked: true, checked: false, archived: false, delegated: false })
  expect(await captureWorkItem('quilt', 'Fix the H1 (from Ryan)', meeting)).toEqual(
    { created: true, id: 'c'.repeat(12), linked: true, checked: false, archived: false, delegated: false })
  expect(call).toHaveBeenCalledExactlyOnceWith(['task-capture-work', 'quilt'], expect.any(Number), JSON.stringify({ text: 'Fix the H1 (from Ryan)', meeting }))
  for (const bad of [{ ok: false }, { ok: true, created: true, id: 'short', linked: true }, { ok: true, id: 'c'.repeat(12), linked: true },
                     { ok: true, created: 'yes', id: 'c'.repeat(12), linked: true }, null]) {
    call.mockResolvedValue(bad)
    await expect(captureWorkItem('quilt', 'Fix it', meeting)).rejects.toMatchObject({ code: 'capture_unverified' })
  }
})

it('refuses unknown domains, bad text and reserved metadata before reaching the bridge', async () => {
  await expect(captureWorkItem('nope-domain', 'Fix it', meeting)).rejects.toMatchObject({ code: 'invalid_domain' })
  await expect(captureWorkItem('../quilt', 'Fix it', meeting)).rejects.toMatchObject({ code: 'invalid_domain' })
  await expect(captureWorkItem('quilt', '', meeting)).rejects.toMatchObject({ code: 'invalid_task_text' })
  await expect(captureWorkItem('quilt', 'x'.repeat(2001), meeting)).rejects.toMatchObject({ code: 'invalid_task_text' })
  await expect(captureWorkItem('quilt', 'x — **Source:** fake', meeting)).rejects.toMatchObject({ code: 'reserved_work_metadata' })
  expect(call).not.toHaveBeenCalled()
})
