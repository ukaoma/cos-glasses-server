// Minimal CDP driver over the Playwright-cached headless Chromium. No dependencies (Node 24 has WebSocket).
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CHROME = process.env.CHROME || '/Users/ukaoma/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/headless_shell'
const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function launch(port = 9333) {
  const dir = mkdtempSync(join(process.env.SCRATCH || tmpdir(), 'chr-'))
  const proc = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--hide-scrollbars', '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore' })
  let ver = null
  for (let i = 0; i < 50 && !ver; i++) { await sleep(150); try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() } catch {} }
  if (!ver) throw new Error('chromium did not start')
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find(t => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0
  const waiting = new Map()
  const listeners = []
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.j(new Error(m.error.message)) : w.r(m.result) }
    else if (m.method) listeners.forEach(l => l(m))
  }
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; waiting.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })) })
  const evaluate = async (expr) => {
    const out = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (out.exceptionDetails) throw new Error('page: ' + (out.exceptionDetails.exception?.description || out.exceptionDetails.text))
    return out.result.value
  }
  await send('Page.enable'); await send('Runtime.enable')
  const logs = []
  listeners.push(m => { if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' ')); if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)) })
  return {
    send, evaluate, logs,
    async viewport(width, height, scheme) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 500 })
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'no-preference' }] })
    },
    async goto(url) {
      // A fresh document every time: the same URL with a hash would otherwise be a same-document navigation.
      await send('Page.navigate', { url: 'about:blank' }); await sleep(150)
      await send('Page.navigate', { url })
      for (let i = 0; i < 60; i++) { await sleep(100); if (await evaluate('document.readyState') === 'complete') break }
    },
    async shot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      const { writeFileSync } = await import('node:fs')
      writeFileSync(path, Buffer.from(data, 'base64'))
    },
    async close() { try { ws.close() } catch {} proc.kill('SIGTERM') },
  }
}
export { sleep }
