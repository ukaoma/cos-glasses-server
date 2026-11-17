/**
 * Drop it P2: where pings land. A PingCandidate becomes one item in the pinned COS chat (InboxFeedStore), under its
 * exactly-once key. The feed store checks the key and writes in one synchronous step, so a key can be inserted once.
 *
 * - A resolution is a `followup`, threaded under its drop. Every other source is a `ping`, its own thread.
 * - Born unread, from `cos`. Nothing here leaves the Mac; the feed is the chat.
 */
import { randomBytes } from 'node:crypto'
import { DROP_LIMITS, type FeedItem, type InboxFeedStore, type DropLink } from './drop-store.js'
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
    ...(c.turnAt ? { turnAt: c.turnAt } : {}),
    ...(c.excerpt ? { excerpt: c.excerpt } : {}),
  }
}

/**
 * 7.0.53 G3 (W1's pick; the lead 20:5x): the session a Reply ready item of the new shape belongs to, or null. Only items that carry
 * `turnAt` (posted from 7.0.53 on) are grouped, so the items already in his chat are never changed.
 */
export function replyGroupOf(item: Readonly<FeedItem>): string | null {
  if (item.kind !== 'ping' || item.source !== 'cos' || item.title !== 'Reply ready' || typeof item.turnAt !== 'string') return null
  const link = item.links.find(l => l.kind === 'session')
  return link && typeof link.id === 'string' && link.id ? link.id : null
}

/**
 * Where pings land. With `list` and `update` (the real store), a new Reply ready of a session that already has a live one of the
 * new shape carries it: the new item gets `count` (one more than the live one's) and `earlier` (its excerpt first, then its
 * earlier ones, at most DROP_LIMITS.earlier), and the live one is marked `superseded` (kept, never deleted; the feed route leaves
 * it out). A live one he has answered or dismissed (state done) starts a new count. Insert first, then mark: a crash between them
 * leaves two visible items, never a lost one.
 */
export function feedSink(feed: Pick<InboxFeedStore, 'byKey' | 'insert'> & Partial<Pick<InboxFeedStore, 'list' | 'update'>>, now: () => number = () => Date.now()): PingFeedSink {
  return {
    hasKey: key => feed.byKey(key) !== undefined,
    post: c => {
      const item = toFeedItem(c, now())
      const group = feed.list && feed.update && !feed.byKey(item.key) ? replyGroupOf(item) : null
      if (!group) return feed.insert([item])[0].id
      const prev = feed.list!().filter(i => i.superseded !== true && i.state === 'live' && replyGroupOf(i) === group).pop()
      item.count = prev ? (prev.count ?? 1) + 1 : 1
      if (prev) {
        const earlier = [...(prev.excerpt ? [{ at: prev.turnAt ?? prev.createdAt, excerpt: prev.excerpt }] : []), ...(prev.earlier ?? [])].slice(0, DROP_LIMITS.earlier)
        if (earlier.length) item.earlier = earlier
      }
      const out = feed.insert([item])[0]
      if (prev && out.id === item.id) feed.update!(new Set([prev.id]), p => ({ ...p, superseded: true }))
      return out.id
    },
  }
}
