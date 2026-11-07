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
  if (media && media.addEventListener) media.addEventListener('change', function () { if (read() === 'system') apply('system'); });
})();
