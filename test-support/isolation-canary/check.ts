import { expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../../server/lib/data-dir.js'

export async function checkConcurrentHome(id: string, peer: string): Promise<void> {
  const root = process.env.COS_VITEST_RUN_DATA_DIR!
  writeFileSync(join(DATA_DIR, `${id}.json`), '{}')
  // Only the handshake lives outside the individual home. No product data does.
  writeFileSync(join(root, `${id}.ready`), DATA_DIR)
  const deadline = Date.now() + 5000
  while (!existsSync(join(root, `${peer}.ready`))) {
    if (Date.now() > deadline) throw new Error('Isolation canary needs two concurrent workers')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(DATA_DIR).toBe(process.env.COS_DATA_DIR)
  expect(readdirSync(DATA_DIR)).toEqual([`${id}.json`])
  expect(readFileSync(join(root, `${peer}.ready`), 'utf8')).not.toBe(DATA_DIR)
}
