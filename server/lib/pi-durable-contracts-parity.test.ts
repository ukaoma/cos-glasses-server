// 6.78.0 (P7 S10): the server's copies of the Pi Durable wire contracts are byte-identical to
// the canonical files, and live in ONE fixture dir. The app keeps its own copies of the same
// canonical files, so two byte-identical copies mean the two repos read the same contract.
//
// The canonical dir is in the COS workspace, not in this repo. When it is not on this Mac
// (CI, another machine) the parity case is skipped and says so; the shape case always runs.
// Override the location with COS_PI_DURABLE_CONTRACTS.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FIXTURES = join(import.meta.dirname, '__fixtures__/pi-durable/contracts')
const CONTRACTS = ['interrupted-job.json', 'maintenance-parked.json', 'messages-steer.json', 'session-steer.json']
const CANONICAL = process.env.COS_PI_DURABLE_CONTRACTS
  ?? join(userInfo().homedir, 'Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff/operations/personal/wk42_2026/pi_durable_build/contracts')
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('Pi Durable contract copies', () => {
  it('one fixture dir holds every contract, and nothing else', () => {
    expect(readdirSync(FIXTURES).sort()).toEqual(CONTRACTS)
    expect(existsSync(join(import.meta.dirname, '__fixtures__/pi-durable-contracts'))).toBe(false)
    for (const name of CONTRACTS) {
      const contract = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
      expect(typeof contract._contract, name).toBe('string')
    }
  })

  it.skipIf(!existsSync(CANONICAL))('each copy is byte-identical to the canonical contract', () => {
    expect(readdirSync(CANONICAL).filter(name => name.endsWith('.json')).sort()).toEqual(CONTRACTS)
    for (const name of CONTRACTS) {
      expect(sha256(join(FIXTURES, name)), name).toBe(sha256(join(CANONICAL, name)))
    }
  })
})
