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
  if (media && media.addEventListener) media.addEventListener('change', function () { if (read() === 'system') apply('system'); });
})();

/* 7.0.29 (Miles 21:42): "for shorter screens like the duo we should use the side rail when it's folded"; tall phones keep
   the top menu. The test is the SCREEN's shape, never the window's: screen.width and screen.height are points that no
   zoom, keyboard, browser bar or Home Screen mode changes (the Duo reports 466 by 678 at 85 and 100 percent, folded and
   open, and its web view is 449 by 797 or 382 by 678 inside that). A screen whose long side is under 1.6 times its short
   side is short: the Duo is 1.46; every iPhone is 1.78 (SE, 8 Plus) or 2.16 and taller, in a Safari tab or not. app.css
   draws the side rail only with this class AND a page under 600 px wide on a touch screen. Missing or odd numbers add
   no class: no rail, the layout as before. Runs before the first paint, so the rail never moves the page on load. */
(function () {
  try {
    var s = window.screen, a = s ? Number(s.width) : 0, b = s ? Number(s.height) : 0;
    if (!(a > 0 && b > 0 && isFinite(a) && isFinite(b))) return;
    var lo = Math.min(a, b), hi = Math.max(a, b);
    if (lo < 600 && hi / lo < 1.6) document.documentElement.classList.add('short-screen');
  } catch (_e) { /* no class: no rail */ }
})();

/* The app's scripts (index.html #boot-scripts), loaded one frame after the page is drawn so the first paint never waits
   for them. Same files, same order (async=false keeps insertion order), and app.js's boot runs only once every one of
   them has run, as when they were in the page: window.CosBoot.after(boot). The frame wait has a 50 ms fallback, because
   a page opened in the background gets no animation frames. A script that fails to load counts as settled, as a failed
   <script> tag did; nothing waits for it forever. */
(function () {
  var waiting = [], settled = false;
  function settle() { settled = true; var fns = waiting; waiting = []; fns.forEach(function (fn) { try { fn(); } catch (_e) { setTimeout(function () { throw _e; }, 0); } }); }
  window.CosBoot = { after: function (fn) { if (typeof fn !== 'function') return; if (settled) fn(); else waiting.push(fn); } };
  function load() {
    var list = [];
    try { list = JSON.parse((document.getElementById('boot-scripts') || {}).textContent || '[]'); } catch (_e) { list = []; }
    list = Array.isArray(list) ? list.filter(function (u) { return typeof u === 'string' && u.indexOf('/control/') === 0; }) : [];
    var left = list.length;
    if (!left) { settle(); return; }
    // 7.0.28: after a reload that the restyle check below made because a script had failed, ask for every script with a
    // fresh query, so none comes from the browser's memory of the failed request (WebKit kept the failure across the
    // reload). Read once.
    var bust = '';
    try { bust = sessionStorage.getItem('cos_web_bust') || ''; sessionStorage.removeItem('cos_web_bust'); } catch (_e) { bust = ''; }
    list.forEach(function (src) {
      var el = document.createElement('script');
      el.src = /^\d{1,15}$/.test(bust) ? src + (src.indexOf('?') >= 0 ? '&' : '?') + 'r=' + bust : src; el.async = false;
      el.onload = function () { if (--left === 0) settle(); };
      el.onerror = function () { if (window.CosRestyle) window.CosRestyle.scriptFailed(src); if (--left === 0) settle(); };
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
   across the reload). */
(function () {
  var STEPS = [1000, 2000, 4000, 8000], SETTLED_MS = 30000, KEY = 'cos_web_restyle', RELOADS_KEY = 'cos_web_restyle_reloads';
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
  function recover() {
    if (R.scripts.length) {
      // At most 2 reloads in 5 minutes: a file that keeps failing must never become a reload loop.
      var recent = [];
      try { recent = JSON.parse(sessionStorage.getItem(RELOADS_KEY) || '[]').filter(function (t) { return Date.now() - t < RELOAD_WINDOW_MS; }); } catch (_e) { recent = []; }
      if (recent.length >= RELOAD_MAX) { R.done = true; record('gave-up'); return; }
      try { recent.push(Date.now()); sessionStorage.setItem(RELOADS_KEY, JSON.stringify(recent)); } catch (_e) {}
      record('reload');
      try { sessionStorage.setItem(KEY, JSON.stringify(R.last)); sessionStorage.setItem('cos_web_bust', String(Date.now())); } catch (_e) {}
      location.reload();
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
