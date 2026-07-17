// Display bus — server-side pub/sub for broadcasting query responses
// to all connected glasses clients (SSE display-stream subscribers)

import { EventEmitter } from 'node:events'
import { serverMetrics } from './server-metrics.js'

const bus = new EventEmitter()
bus.setMaxListeners(20) // Multiple glasses clients

export interface DisplayEvent {
  type: 'chunk' | 'done' | 'error' | 'tool_status' | 'start' | 'session_restore' | 'transcript_chunk' | 'prompt_transcript' | 'recording_start' | 'recording_stop' | 'coaching_nudge'
  data: Record<string, unknown>
}

export interface PublishedDisplayEvent extends DisplayEvent {
  bootId: string
  eventId: number
  publishedAt: string
}

export interface DisplayReplayResult {
  events: PublishedDisplayEvent[]
  gap: boolean
  reason?: 'boot_changed' | 'cursor_ahead' | 'buffer_overflow'
  oldestEventId: number
  latestEventId: number
}

const REPLAY_BUFFER_SIZE = 200
let eventId = 0
const replayBuffer: PublishedDisplayEvent[] = []

export function emitDisplay(event: DisplayEvent): PublishedDisplayEvent {
  const published: PublishedDisplayEvent = {
    ...event,
    bootId: serverMetrics.bootId,
    eventId: ++eventId,
    publishedAt: new Date().toISOString(),
  }
  replayBuffer.push(published)
  if (replayBuffer.length > REPLAY_BUFFER_SIZE) replayBuffer.shift()
  bus.emit('display', published)
  return published
}

export function onDisplay(listener: (event: PublishedDisplayEvent) => void): () => void {
  bus.on('display', listener)
  return () => { bus.off('display', listener) }
}

export function getDisplayWatermark(): { bootId: string; eventId: number } {
  return { bootId: serverMetrics.bootId, eventId }
}

export function replayDisplayEvents(bootId: string | null, afterEventId: number): DisplayReplayResult {
  const oldestEventId = replayBuffer[0]?.eventId ?? eventId + 1
  const latestEventId = eventId
  if (bootId && bootId !== serverMetrics.bootId) {
    return { events: [], gap: true, reason: 'boot_changed', oldestEventId, latestEventId }
  }
  if (afterEventId > latestEventId) {
    return { events: [], gap: true, reason: 'cursor_ahead', oldestEventId, latestEventId }
  }
  if (afterEventId > 0 && afterEventId < oldestEventId - 1) {
    return { events: [], gap: true, reason: 'buffer_overflow', oldestEventId, latestEventId }
  }
  return {
    events: replayBuffer.filter(item => item.eventId > afterEventId),
    gap: false,
    oldestEventId,
    latestEventId,
  }
}

export function __resetDisplayBusForTests(): void {
  eventId = 0
  replayBuffer.splice(0)
  bus.removeAllListeners('display')
}
