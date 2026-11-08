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

export interface ListenerPlanEntry { label: 'HTTPS' | 'HTTPS signer' | 'HTTP'; port: number; tls: boolean }

/**
 * Which listeners this boot REQUIRES (every one goes through listenRequiredServers, so a port another
 * process holds fails the boot closed). 6.99.31: the phone key's signer origin (https, its own
 * port, review B2/W2) is added only with COS_WEB_KEY_AUTHORITY on and only beside HTTPS. Flag off:
 * exactly the 6.99.29 set.
 */
export function listenerPlan(opts: { httpsAvailable: boolean; webKeyAuthority: boolean; httpPort: number; httpsPort: number; signerPort: number }): ListenerPlanEntry[] {
  const plan: ListenerPlanEntry[] = []
  if (opts.httpsAvailable) {
    plan.push({ label: 'HTTPS', port: opts.httpsPort, tls: true })
    if (opts.webKeyAuthority) plan.push({ label: 'HTTPS signer', port: opts.signerPort, tls: true })
  }
  plan.push({ label: 'HTTP', port: opts.httpPort, tls: false })
  return plan
}
