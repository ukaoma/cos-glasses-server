/* 7.0.35 A (W1_blank_open_scope.md): count the opens that never finish. First thing on every open: if the open before
   this one left its mark (cos_open_try), it never showed the page, so it is counted as lost (cos_open_lost: how many,
   and the time and the stage of the last). Then this open writes its own mark, moved on as it gets further: html (this
   script ran), css (the stylesheets settled), js (the scripts settled before the stylesheets), scripts (both settled).
   app.js's firstPaintDone takes the mark away and sends one numbers-only 'open-lost' row for what was counted. It cannot
   see an open where the page never arrived or this script never ran. */
(function () {
  var KEY = 'cos_open_try', LOST = 'cos_open_lost';
  try {
    var prev = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (prev && typeof prev.t === 'number') {
      var lost = JSON.parse(localStorage.getItem(LOST) || 'null') || { n: 0 };
      lost.n = (Number(lost.n) || 0) + 1; lost.t = prev.t; lost.stage = String(prev.stage || 'html');
      localStorage.setItem(LOST, JSON.stringify(lost));
    }
    localStorage.setItem(KEY, JSON.stringify({ t: Date.now(), stage: 'html' }));
  } catch (_e) { /* no storage: nothing counted */ }
  // Try again (the slow-load card) opens the page at a fresh ?r= address; take it out of the address again, keeping the
  // rest of it and the history entry's own state.
  try {
    if (/[?&]r=\d{1,15}(&|$)/.test(location.search) && window.history && history.replaceState) {
      var u = new URL(location.href); u.searchParams.delete('r');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    }
  } catch (_e) { /* the address keeps r; nothing reads it */ }
  window.CosOpen = {
    stage: function (stage) { try { var v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v) { v.stage = stage; localStorage.setItem(KEY, JSON.stringify(v)); } } catch (_e) {} },
    // The page showed: this open is not lost. Returns what was counted before it (or null), and forgets it.
    done: function () { try { localStorage.removeItem(KEY); var l = JSON.parse(localStorage.getItem(LOST) || 'null'); localStorage.removeItem(LOST); return l; } catch (_e) { return null; } }
  };
})();

/* Runs before first paint so the page never flashes the wrong theme. Choice: system | light | dark. */
(function () {
  var KEY = 'cos_web_theme';
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function read() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch (_e) { return 'system'; } }
  function resolve(choice) { return choice === 'system' ? (media && media.matches ? 'dark' : 'light') : choice; }
  function apply(choice) {
    var mode = resolve(choice);
    document.documentElement.setAttribute('data-theme', mode);
    return mode;
  }
  window.CosTheme = {
    choice: read,
    mode: function () { return resolve(read()); },
    set: function (choice) {
      try { if (choice === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch (_e) {}
      return apply(choice);
    },
    apply: function () { return apply(read()); }
  };
  apply(read());
  // 7.0.19: the first paint (index.html #first-paint) shows only when this script ran, so with JavaScript off the page
  // never shows a mark that nothing would take away. app.js removes the class when the sign-in card or the app shows.
  document.documentElement.classList.add('fp-wait');
  // 7.0.35 C: this script ran, so index.html's script-free fallback line (.fp-lost) stays away.
  document.documentElement.classList.add('cos-js');
  if (media && media.addEventListener) media.addEventListener('change', function () { if (read() === 'system') apply('system'); });
})();

/* 7.0.29 (Miles 21:42): "for shorter screens like the duo we should use the side rail when it's folded"; tall phones keep
   the top menu. The test is the SCREEN's shape, never the window's: a screen whose short side is under 600 and whose long
   side is under 1.6 times its short side is short (html.short-screen). app.css draws the side rail only with this class
   AND a page under 600 px wide on a touch screen. Missing or odd numbers give no class: no rail, the layout as before.
   MEASURED: his phone's own device reports (2026-11-10 and 11-11) give screen.width 466 and screen.height 678 in rows laid
   out 449, 548 and 1119 px wide at visualViewport.scale 0.85, and the canary (11-11 21:56) read screen.width 466 in a
   Safari tab, folded, at scale 1. 678 / 466 is 1.46. Every iPhone's published screen is 1.78 (SE, 8 Plus) or 2.16 and up.
   ASSUMED, not measured: which of those rows were the Home Screen app and which a tab, that other zoom settings report
   the same, and that folding or opening never changes the numbers. So this one function runs at load (before the first
   paint, so the rail never moves the page on load) and again on every resize and orientation change, and the page's
   device report and a 'rail' report on each change carry screen.width and screen.height, so his phone settles it. */
(function () {
  function shortScreen() {
    var de = document.documentElement, on = false;
    try {
      var s = window.screen, a = s ? Number(s.width) : 0, b = s ? Number(s.height) : 0;
      if (a > 0 && b > 0 && isFinite(a) && isFinite(b)) { var lo = Math.min(a, b), hi = Math.max(a, b); on = lo < 600 && hi / lo < 1.6; }
    } catch (_e) { on = false; }
    try { if (de && de.classList) { if (on) de.classList.add('short-screen'); else de.classList.remove('short-screen'); } } catch (_e) { /* no class: no rail */ }
    return on;
  }
  window.CosShortScreen = shortScreen;
  shortScreen();
  if (typeof window.addEventListener === 'function') { window.addEventListener('resize', shortScreen); window.addEventListener('orientationchange', shortScreen); }
})();

/* The app's scripts (index.html #boot-scripts), loaded one frame after the page is drawn so the first paint never waits
   for them. Same files, same order (async=false keeps insertion order), and app.js's boot runs only once every one of
   them has run, as when they were in the page: window.CosBoot.after(boot). The frame wait has a 50 ms fallback, because
   a page opened in the background gets no animation frames. A script that fails to load counts as settled, as a failed
   <script> tag did.
   7.0.35 B (W1_blank_open_scope.md): the stylesheets (index.html #boot-styles) are added here, as media="print" so they
   never hold the first paint, and each turns on the moment it arrives. Boot also waits for them, loaded or failed, so
   the app never shows unstyled under the cover; a failed one is asked for again by the restyle check below.
   7.0.35 C: a file that stalls fires neither load nor error, so "nothing waits forever" did not hold. Past
   DEADLINE_MS with boot not run, one card under the mark says COS is taking longer than usual, with Try again. Only his tap
   reloads. If the files then arrive, boot runs and the card goes. The deadline is three of the restyle check's asks
   (STEPS, which that check reads from here): by then the page has asked the Mac for a failed file three times. */
(function () {
  var STEPS = [1000, 2000, 4000, 8000], DEADLINE_MS = STEPS[0] + STEPS[1] + STEPS[2];
  window.CosLoad = { STEPS: STEPS, DEADLINE_MS: DEADLINE_MS };
  var waiting = [], settled = false, scriptsDone = false, sheetsLeft = -1, deadline = null;
  function stage() { if (window.CosOpen) window.CosOpen.stage(scriptsDone && sheetsLeft === 0 ? 'scripts' : sheetsLeft === 0 ? 'css' : scriptsDone ? 'js' : 'html'); }
  function settle() {
    settled = true; clearTimeout(deadline);
    var card = document.getElementById('cos-slow-card'); if (card && card.parentNode) card.parentNode.removeChild(card);
    var fns = waiting; waiting = []; fns.forEach(function (fn) { try { fn(); } catch (_e) { setTimeout(function () { throw _e; }, 0); } });
  }
  function maybeSettle() { stage(); if (!settled && scriptsDone && sheetsLeft === 0) settle(); }
  window.CosBoot = { after: function (fn) { if (typeof fn !== 'function') return; if (settled) fn(); else waiting.push(fn); } };
  function slowCard() {
    if (settled || document.getElementById('cos-slow-card') || !document.body) return;
    var card = document.createElement('div');
    card.id = 'cos-slow-card'; card.setAttribute('role', 'status');
    card.style.cssText = 'position:fixed;left:16px;right:16px;top:calc(50% + 44px);z-index:71;max-width:360px;margin:0 auto;padding:16px;' +
      'border-radius:14px;border:1px solid var(--panel-border, #e3d9c6);background:var(--panel, #ffffff);color:var(--ink, #1f1712);text-align:center;' +
      'font:400 16px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;pointer-events:auto;';
    var p = document.createElement('p'); p.style.cssText = 'margin:0 0 12px;';
    p.textContent = 'COS is taking longer than usual to load. Your Mac may be asleep, or this device may be off Tailscale or on a slow connection.';
    var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Try again';
    btn.style.cssText = 'min-height:44px;padding:0 18px;border-radius:10px;border:0;background:var(--accent, #89662d);color:var(--on-accent, #ffffff);font:inherit;font-weight:600;cursor:pointer;';
    // A fresh address, not location.reload(): measured 7.0.35, a reload asked the server again for all ten stylesheets,
    // the six already here (cached as immutable) included, and the app took 20 s after the tap; a normal load of a new
    // address takes them from the cache. Every other part of the address stays (a sign-in link keeps its code).
    btn.addEventListener('click', function () { tryAgain(); });
    card.appendChild(p); card.appendChild(btn);
    document.body.appendChild(card);
  }
  function tryAgain() {
    try { var u = new URL(location.href); u.searchParams.set('r', String(Date.now())); location.replace(u.pathname + u.search + u.hash); } catch (_e) { location.reload(); }
  }
  window.CosLoad.tryAgain = tryAgain;
  deadline = setTimeout(function show() { if (settled) return; if (document.body) slowCard(); else deadline = setTimeout(show, 100); }, DEADLINE_MS);
  // The stylesheets, now: they are in the head, before this script, so the list is there already.
  (function sheets() {
    var list = [];
    try { list = JSON.parse((document.getElementById('boot-styles') || {}).textContent || '[]'); } catch (_e) { list = []; }
    list = Array.isArray(list) ? list.filter(function (u) { return typeof u === 'string' && u.indexOf('/control/') === 0; }) : [];
    sheetsLeft = list.length;
    if (!sheetsLeft) { maybeSettle(); return; }
    var head = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
    list.forEach(function (href) {
      var el = document.createElement('link');
      el.rel = 'stylesheet'; el.href = href; el.media = 'print';
      var once = false, done = function (ok) { if (once) return; once = true; if (ok) el.media = 'all'; sheetsLeft--; if (sheetsLeft === 0) maybeSettle(); };
      el.onload = function () { done(true); };
      el.onerror = function () { done(false); };
      head.appendChild(el);
    });
  })();
  function load() {
    var list = [];
    try { list = JSON.parse((document.getElementById('boot-scripts') || {}).textContent || '[]'); } catch (_e) { list = []; }
    list = Array.isArray(list) ? list.filter(function (u) { return typeof u === 'string' && u.indexOf('/control/') === 0; }) : [];
    var left = list.length;
    if (!left) { scriptsDone = true; maybeSettle(); return; }
    // 7.0.28: after a reload that the restyle check below made because a script had failed, ask for every script with a
    // fresh query, so none comes from the browser's memory of the failed request (WebKit kept the failure across the
    // reload). Read once.
    var bust = '';
    try { bust = sessionStorage.getItem('cos_web_bust') || ''; sessionStorage.removeItem('cos_web_bust'); } catch (_e) { bust = ''; }
    list.forEach(function (src) {
      var el = document.createElement('script');
      el.src = /^\d{1,15}$/.test(bust) ? src + (src.indexOf('?') >= 0 ? '&' : '?') + 'r=' + bust : src; el.async = false;
      el.onload = function () { if (--left === 0) { scriptsDone = true; maybeSettle(); } };
      el.onerror = function () { if (window.CosRestyle) window.CosRestyle.scriptFailed(src); if (--left === 0) { scriptsDone = true; maybeSettle(); } };
      document.body.appendChild(el);
    });
  }
  function afterFrame() {
    var done = false, go = function () { if (done) return; done = true; setTimeout(load, 0); };
    if (window.requestAnimationFrame) window.requestAnimationFrame(go);
    setTimeout(go, 50);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', afterFrame); else afterFrame();
})();

/* 7.0.28 (Miles 19:28, "Connect this browser" with no styling): the page's own files must not stay missing. When the
   phone opens the page before it can reach the Mac (the tunnel still coming up, or the page drawn from the browser's
   copy), the HTML draws but a stylesheet or a script can fail, and nothing asked for it again. index.html's inline
   critical CSS keeps the sign-in card right meanwhile; this brings the rest back. While anything failed, it asks the
   Mac for the failed file after 1, 2, 4 and 8 s, then every 30 s, only while the page is in front. When the Mac
   answers: a failed script reloads the page (app.js cannot be re-run in place); failed stylesheets are asked for again
   in place. A file that keeps failing never loops: at most 2 reloads in 5 minutes. What happened is kept for app.js's numbers-only 'restyle' row (window.CosRestyle.last, and sessionStorage
   across the reload).
   7.0.29 (Q1 FIX 1 and 2, the lead's R1 and R2): the page never reloads by itself over his words. While any text box
   holds words, focus is in a text box, or a send is in flight (app.js's window.CosBusy; when app.js is the script that
   failed, the boxes alone), it shows one line with a Reload button instead, and only his tap reloads. The cap fails
   closed: if the reload count cannot be read, or does not read back after writing (storage blocked), it gives up and
   shows the same line rather than reloading. */
(function () {
  // 7.0.35: the asking steps live with the loader above (CosLoad.STEPS), whose slow-load deadline is made of them.
  var STEPS = (window.CosLoad && window.CosLoad.STEPS) || [1000, 2000, 4000, 8000], SETTLED_MS = 30000, KEY = 'cos_web_restyle', RELOADS_KEY = 'cos_web_restyle_reloads';
  var RELOAD_MAX = 2, RELOAD_WINDOW_MS = 5 * 60000;
  var R = { scripts: [], sheets: 0, tries: 0, t0: 0, timer: null, done: false, last: null };
  // Every real browser has these; a harness that runs this file without them gets no restyle check, not a throw that
  // would stop the theme and the loader above from being tested.
  if (typeof window.addEventListener !== 'function' || typeof document.querySelectorAll !== 'function' || typeof document.addEventListener !== 'function') return;
  function missing() {
    return [].filter.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) {
      // A sheet that failed to load throws on read in WebKit (SecurityError); count it as missing.
      try { return !l.sheet || !l.sheet.cssRules || l.sheet.cssRules.length === 0; } catch (_e) { return true; }
    });
  }
  function bust(href) { return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'r=' + Date.now(); }
  function record(how) {
    R.last = { how: how, sheets: R.sheets, scripts: R.scripts.length, tries: R.tries, ms: R.t0 ? Date.now() - R.t0 : 0 };
    try { window.dispatchEvent(new CustomEvent('cos-restyle', { detail: R.last })); } catch (_e) {}
  }
  // What would be lost by a reload: words in a text box he can see, focus in one, or a send on its way (app.js).
  function busy() {
    var out = { words: false, focus: false, sending: false };
    try {
      [].forEach.call(document.querySelectorAll('textarea, input, [contenteditable]'), function (el) {
        if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return;   // app.js's hidden measuring copy
        if (el.tagName === 'INPUT' && !/^(|text|search|email|url|tel|password|number)$/i.test(el.getAttribute('type') || '')) return;
        var v = el.isContentEditable ? el.textContent : el.value;
        if (v && String(v).trim()) out.words = true;
      });
      var a = document.activeElement;
      out.focus = !!(a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(|text|search|email|url|tel|password|number)$/i.test(a.getAttribute('type') || '')) || a.isContentEditable));
    } catch (_e) {}
    try { out.sending = typeof window.CosBusy === 'function' && !!window.CosBusy(); } catch (_e) {}
    out.any = out.words || out.focus || out.sending;
    return out;
  }
  // The one line, in place of a reload. Inline styles with the theme's own colours where they exist, so it reads right
  // on a page whose stylesheet failed too. At the top: a fixed bar near the bottom fights the phone browser's own bar.
  // On the folded Duo it stops at the side rail (--rail-w is set only while that rail shows).
  function offer(b) {
    try { offerLine(b); } catch (_e) { /* no line, and still no reload by itself */ }
  }
  function offerLine(b) {
    var line = document.getElementById('cos-reload-line');
    if (!line) {
      line = document.createElement('div');
      line.id = 'cos-reload-line'; line.setAttribute('role', 'status');
      line.style.cssText = 'position:fixed;left:12px;right:calc(12px + var(--rail-w, 0px));top:calc(env(safe-area-inset-top, 0px) + 8px);z-index:90;display:flex;align-items:center;gap:12px;' +
        'padding:10px 10px 10px 14px;border-radius:12px;border:1px solid var(--panel-border, #a08a66);background:var(--panel, #ffffff);color:var(--ink, #1f1712);' +
        'font:400 15px/1.4 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;max-width:560px;margin:0 auto;';
      var p = document.createElement('p'); p.style.cssText = 'margin:0;flex:1 1 auto;min-width:0;'; p.id = 'cos-reload-words';
      var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Reload';
      btn.style.cssText = 'flex:none;min-height:44px;padding:0 16px;border-radius:10px;border:0;background:var(--accent, #89662d);color:var(--on-accent, #ffffff);font-family:inherit;font-size:15px;font-weight:600;line-height:1;';
      btn.addEventListener('click', function () { reloadNow(); });
      line.appendChild(p); line.appendChild(btn);
      (document.body || document.documentElement).appendChild(line);
    }
    var words = document.getElementById('cos-reload-words');
    if (words) words.textContent = 'Part of this page did not load.' + (b && b.words ? ' Send or copy what you have typed first. A reload clears it.' : '');
  }
  function reloadNow() {
    try { sessionStorage.setItem(KEY, JSON.stringify(R.last)); sessionStorage.setItem('cos_web_bust', String(Date.now())); } catch (_e) {}
    location.reload();
  }
  function recover() {
    if (R.scripts.length) {
      // Never by itself over his words (R1): the line, and only his tap reloads.
      var b = busy();
      if (b.any) { R.done = true; record('offered'); offer(b); return; }
      // At most 2 reloads in 5 minutes: a file that keeps failing must never become a reload loop. Fails closed (R2): a
      // count that cannot be read, or that does not read back after writing, means no reload by itself.
      var recent = null, back = null;
      try { recent = JSON.parse(sessionStorage.getItem(RELOADS_KEY) || '[]').filter(function (t) { return Date.now() - t < RELOAD_WINDOW_MS; }); } catch (_e) { recent = null; }
      if (!recent || recent.length >= RELOAD_MAX) { R.done = true; record('gave-up'); offer(b); return; }
      var now = Date.now();
      try { recent.push(now); sessionStorage.setItem(RELOADS_KEY, JSON.stringify(recent)); back = JSON.parse(sessionStorage.getItem(RELOADS_KEY) || 'null'); } catch (_e) { back = null; }
      if (!back || back.length !== recent.length || back[back.length - 1] !== now) { R.done = true; record('gave-up'); offer(b); return; }
      record('reload');
      reloadNow();
      return;
    }
    var gone = missing();
    gone.forEach(function (old) {
      var el = document.createElement('link');
      el.rel = 'stylesheet'; el.href = bust(old.getAttribute('href') || old.href);
      el.onload = function () { if (old.parentNode) old.parentNode.removeChild(old); };
      old.parentNode.insertBefore(el, old.nextSibling);
    });
    R.done = true; record('sheets');
  }
  function schedule() {
    if (R.timer || R.done || document.hidden) return;
    var ms = R.tries < STEPS.length ? STEPS[R.tries] : SETTLED_MS;
    R.timer = setTimeout(check, ms);
  }
  function check() {
    R.timer = null;
    if (R.done || document.hidden) return;
    R.tries++;
    // Ask for the file that failed (a script first): it answering is what matters, and a file that is not there (404)
    // never counts as the Mac being back.
    var gone = missing(), url = R.scripts[0] || (gone[0] && (gone[0].getAttribute('href') || gone[0].href)) || '/control/app.css';
    var probe = window.fetch ? window.fetch(bust(url), { cache: 'no-store', credentials: 'same-origin' }) : Promise.reject(new Error('no fetch'));
    probe.then(function (r) { if (r && r.ok) recover(); else schedule(); }, function () { schedule(); });
  }
  function start() {
    if (R.done || R.t0) return;
    R.sheets = missing().length;
    if (!R.sheets && !R.scripts.length) return;
    R.t0 = Date.now();
    schedule();
  }
  window.CosRestyle = {
    scriptFailed: function (src) { if (R.scripts.indexOf(src) < 0) R.scripts.push(src); if (R.t0) schedule(); else start(); },
    get last() { return R.last; },
    // After a reload that this caused: what the page that reloaded had seen, read once.
    takeSaved: function () { try { var v = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); return v ? JSON.parse(v) : null; } catch (_e) { return null; } }
  };
  document.addEventListener('visibilitychange', function () { if (!document.hidden && R.t0 && !R.done && !R.timer) check(); });
  // Every <link> in the head has finished (loaded or failed) by the time the page's load event fires.
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
})();
