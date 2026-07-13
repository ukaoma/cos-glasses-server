import { randomUUID } from 'node:crypto'

export const serverMetrics = {
  bootId: randomUUID(),
  startedAt: Date.now(),
  requestCount: 0,
}
