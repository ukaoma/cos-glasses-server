/**
 * Drop it P2: where pings land. A PingCandidate becomes one item in the pinned COS chat (InboxFeedStore), under its
 * exactly-once key. The feed store checks the key and writes in one synchronous step, so a key can be inserted once.
 *
 * - A resolution is a `followup`, threaded under its drop. Every other source is a `ping`, its own thread.
 * - Born unread, from `cos`. Nothing here leaves the Mac; the feed is the chat.
 */
import { randomBytes } from 'node:crypto'
import type { FeedItem, InboxFeedStore, DropLink } from './drop-store.js'
import type { PingFeedSink } from './ping-engine.js'
import type { PingCandidate } from './ping-sources.js'
import { clip } from './ping-sources.js'

const feedId = () => `fi_${randomBytes(16).toString('hex')}`

export function toFeedItem(c: PingCandidate, nowMs: number): FeedItem {
  const id = feedId()
  return {
    id, kind: c.source === 'resolution' ? 'followup' : 'ping', threadId: c.threadId ?? id,
    createdAt: new Date(nowMs).toISOString(), readAt: null, source: 'cos',
    ...(c.title ? { title: clip(c.title, 200) } : {}),
    line: c.line.slice(0, 2_000), links: c.links.slice(0, 12) as DropLink[], actions: c.actions.slice(0, 6), state: 'live', key: c.key,
    // Counts toward "waiting on you" (drop-service isWaiting) until dismissed, answered or done.
    ...(c.needsReply === true ? { needsReply: true } : {}),
  }
}

export function feedSink(feed: Pick<InboxFeedStore, 'byKey' | 'insert'>, now: () => number = () => Date.now()): PingFeedSink {
  return {
    hasKey: key => feed.byKey(key) !== undefined,
    post: c => feed.insert([toFeedItem(c, now())])[0].id,
  }
}
