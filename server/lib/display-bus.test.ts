import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetDisplayBusForTests,
  emitDisplay,
  onDisplay,
  replayDisplayEvents,
} from './display-bus.js'
import { serverMetrics } from './server-metrics.js'

beforeEach(() => __resetDisplayBusForTests())

describe('display bus publish identity', () => {
  it('assigns one id at publish time regardless of subscriber count', () => {
    const first: number[] = []
    const second: number[] = []
    const offA = onDisplay(event => first.push(event.eventId))
    const offB = onDisplay(event => second.push(event.eventId))

    const published = emitDisplay({ type: 'done', data: { text: 'hello' } })

    expect(published.eventId).toBe(1)
    expect(first).toEqual([1])
    expect(second).toEqual([1])
    expect(replayDisplayEvents(serverMetrics.bootId, 0).events.map(event => event.eventId)).toEqual([1])
    offA()
    offB()
  })

  it('reports a typed gap when a client cursor belongs to another boot', () => {
    emitDisplay({ type: 'start', data: {} })
    expect(replayDisplayEvents('old-boot', 1)).toMatchObject({
      gap: true,
      reason: 'boot_changed',
    })
  })

  it('does not duplicate buffered records when two subscribers are attached', () => {
    const offA = onDisplay(() => {})
    const offB = onDisplay(() => {})
    emitDisplay({ type: 'chunk', data: { text: 'a' } })
    emitDisplay({ type: 'done', data: { text: 'b' } })
    expect(replayDisplayEvents(serverMetrics.bootId, 0).events).toHaveLength(2)
    offA()
    offB()
  })
})
