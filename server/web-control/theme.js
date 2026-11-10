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
    list.forEach(function (src) {
      var el = document.createElement('script');
      el.src = src; el.async = false;
      el.onload = el.onerror = function () { if (--left === 0) settle(); };
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
