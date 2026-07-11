import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { listenRequiredServers } from './listener-startup.js'

const openServers: Server[] = []

afterEach(async () => {
  await Promise.allSettled(openServers.splice(0).map(server => new Promise<void>(resolve => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })))
})

describe('required listener startup', () => {
  it('rolls back an earlier listener when a later port cannot bind', async () => {
    const occupied = createServer()
    openServers.push(occupied)
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
    const address = occupied.address()
    const occupiedPort = typeof address === 'object' && address ? address.port : 0
    const first = createServer()
    const second = createServer()
    openServers.push(first, second)
    await expect(listenRequiredServers([
      { server: first, port: 0, host: '127.0.0.1', label: 'HTTP' },
      { server: second, port: occupiedPort, host: '127.0.0.1', label: 'HTTPS' },
    ])).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(first.listening).toBe(false)
    expect(second.listening).toBe(false)
  })

  it('keeps all listeners only after every bind succeeds', async () => {
    const first = createServer()
    const second = createServer()
    openServers.push(first, second)
    await listenRequiredServers([
      { server: first, port: 0, host: '127.0.0.1', label: 'HTTP' },
      { server: second, port: 0, host: '127.0.0.1', label: 'HTTPS' },
    ])
    expect(first.listening).toBe(true)
    expect(second.listening).toBe(true)
  })
})
