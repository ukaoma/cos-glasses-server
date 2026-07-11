import type { Server } from 'node:net'

export interface RequiredListener { server: Server; port: number; host: string; label: string }

function listenOne({ server, port, host, label }: RequiredListener): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { server.off('error', onError); server.off('listening', onListening) }
    const onError = (error: NodeJS.ErrnoException) => { cleanup(); error.message = `${label} listener failed on ${host}:${port}: ${error.message}`; reject(error) }
    const onListening = () => { cleanup(); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

async function closeOne(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>(resolve => server.close(() => resolve()))
}

export async function listenRequiredServers(listeners: RequiredListener[]): Promise<void> {
  const started: Server[] = []
  try {
    for (const listener of listeners) { await listenOne(listener); started.push(listener.server) }
  } catch (error) {
    await Promise.allSettled(started.map(closeOne))
    throw error
  }
}
