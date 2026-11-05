// node render.mjs <port> <width> <height> <scheme> <out.png> [addFile]
import { launch, sleep } from './cdp.mjs'
const [port, w, h, scheme, out, add] = process.argv.slice(2)
const SID = 'meeting_1762349349000_g2demo'
const b = await launch(9800 + Math.floor(Math.random() * 150))
try {
  await b.viewport(Number(w), Number(h), scheme)
  await b.goto(`http://127.0.0.1:${port}/control/#/meetings/live/${SID}`)
  await sleep(3500)
  if (add === '1') {
    const r = await b.evaluate(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['Q4 price list: Starter is 59 a month.'], 'Q4 pricing.pdf', { type: 'application/pdf' }));
      const ta = document.querySelector('.mt-lmain');
      ta.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      ta.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`)
    console.log('drop prevented', r)
    await sleep(1500)
  }
  if (add === 'open') { await b.evaluate(`(() => { const h = document.querySelector('[data-mt="files-toggle"]'); if (h && h.getAttribute('aria-expanded') !== 'true') h.click(); })()`); await sleep(400) }
  await b.shot(out)
  const errs = b.logs.filter(l => /^(error|EXC)/.test(l)); if (errs.length) console.log(errs.slice(0, 8).join('\n'))
} finally { await b.close() }
