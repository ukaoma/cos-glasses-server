// Message-number reservations that are not exchanges yet.
//
// The phone mints its own #NNN from the `max` that /api/message-counter
// reports, and a durable job carries the number it was minted with until its
// terminal projection writes the exchange into the session. Between admission
// and projection the number existed nowhere the counter looked, so a second
// producer could mint it again: a running morning brief holds its number for
// minutes while the phone's counter, which only re-syncs at boot, still sits
// below it. (The double "#74" seen on 2026-09-01 turned out to be the phone
// showing ONE exchange twice, a display-bus placeholder plus the hydrated
// row, fixed in companion 6.9.445. The window this closes is real all the
// same: the same night's ledger shows the brief holding #74 for 6m35s.)
//
// Every holder of a not-yet-projected number registers a source here. The
// counter route and the brief's own reservation read the union. Sources
// register themselves rather than being imported, because the morning-brief
// runtime already imports the counter route (a direct import would cycle).

import { exchangeBelongsToEra } from './message-era.js'

export interface MessageReservation {
  globalMsgNum: number
  messageEra?: string
  /** Diagnostic owner label, e.g. `job:<id>` or `brief:<day>`. Never a prompt. */
  owner: string
}

export type MessageReservationSource = () => readonly MessageReservation[]

const sources = new Set<MessageReservationSource>()

export function registerMessageReservationSource(source: MessageReservationSource): () => void {
  sources.add(source)
  return () => { sources.delete(source) }
}

/** Every live reservation in `era`. A source that throws contributes nothing;
 * the counter must never fail because one holder is mid-shutdown. */
export function reservedGlobalMsgNums(era: string): MessageReservation[] {
  const out: MessageReservation[] = []
  for (const source of sources) {
    let items: readonly MessageReservation[]
    try { items = source() } catch { continue }
    for (const item of items) {
      if (!Number.isSafeInteger(item.globalMsgNum) || item.globalMsgNum <= 0) continue
      if (!exchangeBelongsToEra(item, era)) continue
      out.push(item)
    }
  }
  return out
}

export function maxReservedGlobalMsgNum(era: string): number {
  let max = 0
  for (const item of reservedGlobalMsgNums(era)) if (item.globalMsgNum > max) max = item.globalMsgNum
  return max
}

/** Test-only. */
export function resetMessageReservationSourcesForTests(): void {
  sources.clear()
}
