// 6.99.14: the harness behind the CHANGELOG numbers. Start node mock.mjs <web-control dir> <port> 150 (HISTORY_DELAY_MS=1500
// for scenario D), then node measure.mjs <port> <width> <height> 20. CHROME= overrides the headless Chromium path.
// node measure.mjs <mockPort> <width> <height> [N]
// Two scenarios on the live meeting view, N appended transcript lines each (one per poll):
//  A following: the reader is at the newest line. Measures how far the page around the transcript moves
//    (the title and the Ask panel, in CSS px, summed over updates) and the layout-shift total.
//  B reading: the reader scrolled up into the middle. Measures the drift of the first visible line (CSS px, summed)
//    and the layout-shift total.
import { launch, sleep } from './cdp.mjs'
const [port, width, height, N] = [process.argv[2] || 4517, Number(process.argv[3] || 390), Number(process.argv[4] || 844), Number(process.argv[5] || 20)]
const SID = 'meeting_1762349349000_g2demo'
const URL = `http://127.0.0.1:${port}/control/#/meetings/live/${SID}`
const OBS = `(() => { window.__cls = 0; window.__shifts = 0; try { new PerformanceObserver(l => { for (const e of l.getEntries()) { if (!e.hadRecentInput) { window.__cls += e.value; window.__shifts++ } } }).observe({ type: 'layout-shift', buffered: true }) } catch (e) {} })()`
const append = n => fetch(`http://127.0.0.1:${port}/__mock/append?n=${n}`, { method: 'POST' })
const browser = await launch(9300 + Math.floor(Math.random() * 500))
try {
  await browser.viewport(width, height, 'light')
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: OBS })
  const probe = `(() => {
    const t = document.querySelector('.mt-dtitle'), side = document.querySelector('.mt-side-panel');
    const box = document.getElementById('mt-turns');
    const last = box && box.lastElementChild, lr = last && last.getBoundingClientRect();
    return { title: t ? t.getBoundingClientRect().top : null, side: side ? side.getBoundingClientRect().top : null, y: scrollY,
      newestShowing: !!(lr && lr.bottom <= Math.min(innerHeight, (getComputedStyle(box).overflowY !== 'visible' ? box.getBoundingClientRect().bottom : innerHeight)) + 2 && lr.bottom > 0),
      turns: box ? box.children.length : 0, cls: window.__cls, shifts: window.__shifts };
  })()`
  // A: following
  await browser.goto(URL); await sleep(3500)
  await browser.evaluate(`window.__cls = 0; window.__shifts = 0`)
  let prev = await browser.evaluate(probe), moved = 0, sideMoved = 0, scrolled = 0
  const start = prev
  for (let k = 0; k < N; k++) {
    await append(1); await sleep(1700)
    const now = await browser.evaluate(probe)
    moved += Math.abs(now.title - prev.title); sideMoved += Math.abs((now.side ?? 0) - (prev.side ?? 0)); scrolled += Math.abs(now.y - prev.y)
    prev = now
  }
  console.log(JSON.stringify({ scenario: 'A following', width, height, N, turnsBefore: start.turns, turnsAfter: prev.turns, titleDriftPx: Math.round(moved), askPanelDriftPx: Math.round(sideMoved), pageScrollPx: Math.round(scrolled), newestLineShowing: prev.newestShowing, layoutShift: +prev.cls.toFixed(4), shiftEntries: prev.shifts }))
  // B: reading in the middle
  await browser.goto(URL); await sleep(3500)
  const pick = await browser.evaluate(`(() => {
    const box = document.getElementById('mt-turns'), kids = [...box.children], mid = kids[Math.floor(kids.length / 2)];
    const inner = getComputedStyle(box).overflowY !== 'visible' && box.scrollHeight > box.clientHeight + 4;
    if (inner) box.scrollTop = mid.offsetTop - box.offsetTop - 40; else window.scrollTo(0, mid.getBoundingClientRect().top + scrollY - 160);
    return { id: mid.getAttribute('data-turn'), inner };
  })()`)
  await sleep(900)
  await browser.evaluate(`window.__cls = 0; window.__shifts = 0`)
  const line = `(() => { const n = document.querySelector('[data-turn="${pick.id}"]'); return n ? n.getBoundingClientRect().top : null })()`
  let p0 = await browser.evaluate(line), drift = 0, first = p0
  for (let k = 0; k < N; k++) {
    await append(1); await sleep(1700)
    const p1 = await browser.evaluate(line); drift += Math.abs(p1 - p0); p0 = p1
  }
  const tail = await browser.evaluate(probe)
  console.log(JSON.stringify({ scenario: 'B reading', width, height, N, innerScroller: pick.inner, firstVisibleLineDriftPx: Math.round(drift), netDriftPx: Math.round(p0 - first), layoutShift: +tail.cls.toFixed(4), shiftEntries: tail.shifts }))
  // C: turns ABOVE the reader are rewritten (the speaker pass sends a full snapshot with longer text).
  await browser.goto(URL); await sleep(3500)
  const pickC = await browser.evaluate(`(() => {
    const box = document.getElementById('mt-turns'), kids = [...box.children], mid = kids[Math.floor(kids.length * 0.6)];
    const inner = getComputedStyle(box).overflowY !== 'visible' && box.scrollHeight > box.clientHeight + 4;
    if (inner) box.scrollTop = mid.offsetTop - box.offsetTop - 40; else window.scrollTo(0, mid.getBoundingClientRect().top + scrollY - 160);
    return { id: mid.getAttribute('data-turn') };
  })()`)
  await sleep(900)
  await browser.evaluate(`window.__cls = 0; window.__shifts = 0`)
  const lineC = `(() => { const n = document.querySelector('[data-turn="${pickC.id}"]'); return n ? n.getBoundingClientRect().top : null })()`
  const c0 = await browser.evaluate(lineC)
  await fetch(`http://127.0.0.1:${port}/__mock/rewrite?upto=40`, { method: 'POST' }); await sleep(2500)
  const c1 = await browser.evaluate(lineC), tc = await browser.evaluate(probe)
  console.log(JSON.stringify({ scenario: 'C rewrite above reader', width, firstVisibleLineDriftPx: Math.round(c1 - c0), layoutShift: +tc.cls.toFixed(4) }))
  // D: a file is already on the meeting and the Ask history answers late (run the mock with HISTORY_DELAY_MS=1500).
  await fetch(`http://127.0.0.1:${port}/__mock/addfile`, { method: 'POST' })
  await browser.goto(URL); await sleep(500)
  const boxTop = `(() => { const b = document.getElementById('mt-turns'); return b ? b.getBoundingClientRect().top + scrollY : null })()`
  const d0 = await browser.evaluate(boxTop); await sleep(3000)
  const d1 = await browser.evaluate(boxTop), td = await browser.evaluate(probe)
  console.log(JSON.stringify({ scenario: 'D files load late', width, transcriptTopMovedPx: Math.round(d1 - d0), layoutShift: +td.cls.toFixed(4), shiftEntries: td.shifts }))
  const errs = browser.logs.filter(l => /^(error|EXC)/.test(l)); if (errs.length) console.log('console errors:', errs.slice(0, 5))
} finally { await browser.close() }
