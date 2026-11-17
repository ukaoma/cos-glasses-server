/* COS Control Web: the plan ruler at the top of Sessions > Usage (7.0.41, U1; Miles 2026-11-14 12:16, "Collapsed, tap to
   open"; drawn to lanes/U1_plan_usage_mock/round2 tap-*). One line when closed: the tool closest to its plan limit, with
   its ruler, and the rest in quiet words. Open: each tool's week as a ruler, and the labelled estimate.
   Styles: the end of panes/sessions.css. Data: GET /api/usage/plan[?refresh=1] (routes/work-orchestrator.ts, plan-pane.ts).
   The server writes every word, so
   the Mac app says the same. This file only draws.
   Rules: a failed, paused, missing or ended reading draws no ruler (never 0%); while reading, numbers are hidden; a
   refresh never changes the height (rows and the estimate block have fixed heights); opening moves the page only on a
   tap; the open state is remembered on this device. */
(function () {
  'use strict';
  var W = window.COSWeb;
  var esc = W.esc, api = W.api;
  var KEY = 'cos.usage.planOpen';
  var S = { pane: null, loading: false, error: '', open: readOpen(), el: null };

  function readOpen() { try { return typeof localStorage === 'object' && localStorage ? localStorage.getItem(KEY) === '1' : false; } catch (e) { return false; } }
  function saveOpen(v) { try { if (typeof localStorage === 'object' && localStorage) { if (v) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } } catch (e) { /* this page still remembers */ } }

  function element() {
    if (S.el) return S.el;
    var el = document.createElement('section');
    el.className = 'up'; el.id = 'usage-plan'; el.setAttribute('aria-label', 'Plan use');
    el.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!t || !el.contains(t)) return;
      if (t.classList.contains('up-toggle')) { S.open = !S.open; saveOpen(S.open); paint(true); }
      else if (t.classList.contains('up-refresh')) read(true);
    });
    S.el = el;
    return el;
  }

  function clock(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  // 7.0.54: a read time names its day when it is not today ("Read yesterday 10:50 PM"), so an old pane cannot pass as new.
  function readWhen(iso, nowMs) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var n = new Date(nowMs), key = function (x) { return x.getFullYear() * 10000 + x.getMonth() * 100 + x.getDate(); };
    var days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (key(d) === key(n)) return clock(iso);
    if (days === 1) return 'yesterday ' + clock(iso);
    return d.toLocaleDateString('en-US', days < 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' }) + ' ' + clock(iso);
  }
  // 7.0.54: a line whose pause or limit has ended since the pane was read is not shown as current (Control showed
  // "Paused until 11:50 PM" at 6:55 the next morning). Its words say the pause is over; Refresh reads it again.
  function current(line, nowMs) {
    if (!line || !line.until || isNaN(Date.parse(line.until)) || Date.parse(line.until) > nowMs) return line;
    var o = {}; for (var k in line) o[k] = line[k];
    o.state = 'not_read'; o.usedPct = null; o.gonePct = null; o.estimate = null;
    o.short = 'Pause over'; o.shortLong = 'Pause over. Refresh to read';
    o.long = 'The pause ended at ' + readWhen(line.until, nowMs) + '. Refresh to read it again.';
    o.quiet = line.name + ': pause over';
    return o;
  }
  // The closed row's quiet words, rebuilt from the guarded lines when one of them has expired (else the server's words).
  function others(p) {
    var now = Date.now(), lines = p.lines || [];
    if (!lines.some(function (l) { return current(l, now) !== l; })) return p.others;
    var rest = lines.filter(function (l) { return l.provider !== p.closest; }).map(function (l) { return current(l, now).quiet; });
    return rest.length ? rest.join('. ') + '.' : '';
  }
  var COLOR = { claude: 'var(--u-gold)', claude_desktop: 'var(--u-gold)', codex: 'var(--u-codex)', cursor: 'var(--u-cursor)' };
  function colorOf(provider) { return COLOR[provider] || 'var(--sub)'; } // an unknown row is drawn, never colourless

  // The short ruler in the closed row and the long one in an open row. No ruler at all when usedPct is null.
  function ruler(line, long) {
    if (line.usedPct === null || line.usedPct === undefined) return '';
    var fill = line.state === 'limit' ? 'var(--up-warn)' : line.state === 'older' ? 'var(--sub)' : colorOf(line.provider);
    var now = line.gonePct === null || line.gonePct === undefined ? '' : '<span class="up-now" style="left:' + Number(line.gonePct) + '%"></span>';
    return '<span class="' + (long ? 'up-track' : 'up-mini') + '" aria-hidden="true"><span class="up-rail"></span><span class="up-fill" style="width:' +
      Math.max(0, Math.min(100, Number(line.usedPct))) + '%;background:' + fill + '"></span>' + now + '</span>';
  }
  function who(line) { return '<span class="up-who"><i class="up-dot" style="background:' + colorOf(line.provider) + '"></i>' + esc(line.name) + '</span>'; }
  function wordsClass(line) { return line.state === 'failed' || line.state === 'not_read' || line.state === 'limit' ? 'up-warn' : line.state === 'fresh' ? '' : 'up-quietw'; }

  function headHtml() {
    var p = S.pane, lead = '', fresh = '';
    if (S.loading) lead = '<span class="up-quietw">Reading…</span>';
    else if (!p) lead = '<span class="up-warn">' + esc(S.error || 'Plan use was not read.') + '</span>';
    else {
      var top = current(p.closest && p.lines.filter(function (l) { return l.provider === p.closest; })[0], Date.now());
      lead = (top ? '<span class="up-seg">' + who(top) + ruler(top, false) + '<span class="up-what ' + wordsClass(top) + '"><span class="up-what-l">' + esc(top.shortLong) + '</span><span class="up-what-s">' + esc(top.short) + '</span></span></span>' : '') +
        (others(p) ? '<span class="up-quietw up-others">' + esc(others(p)) + '</span>' : '');
    }
    if (p && p.readAt && !S.loading) fresh = 'Read ' + esc(readWhen(p.readAt, Date.now())) + '. ';
    return '<div class="up-head"><button class="up-toggle" type="button" aria-expanded="' + (S.open ? 'true' : 'false') + '" aria-controls="usage-plan-rows">' +
      '<span class="up-chev" aria-hidden="true">›</span>Plan use</button>' + '<span class="up-lead">' + lead + '</span>' +
      '<span class="up-fresh">' + fresh + '<button class="up-refresh" type="button"' + (S.loading ? ' disabled' : '') + '>Refresh</button></span></div>';
  }
  function rowsHtml() {
    var p = S.pane;
    var lines = p && !S.loading ? p.lines.map(function (l) { return current(l, Date.now()); }) : (S.pane && S.pane.lines && S.pane.lines.length ? S.pane.lines.map(function (l) { return l.provider; }) : ['claude', 'claude_desktop', 'codex', 'cursor']).map(function (id) { return { provider: id, name: { claude: 'Claude CLI', claude_desktop: 'Claude Desktop', codex: 'Codex', cursor: 'Cursor' }[id] || id, usedPct: null, windowWords: '', long: S.loading ? 'Reading…' : 'Not read.', state: 'not_read', estimate: null }; });
    var rows = lines.map(function (l) {
      return '<div class="up-lane"><div class="up-lname">' + who(l) + (l.windowWords ? '<small>' + esc(l.windowWords) + '</small>' : '') + '</div>' +
        ruler(l, true) +
        '<div class="up-lwords ' + wordsClass(l) + (l.usedPct === null || l.usedPct === undefined ? ' up-span' : '') + '">' + esc(l.long) + '</div></div>';
    }).join('');
    var est = lines.filter(function (l) { return l.estimate; }).map(function (l) { return '<p><b>Estimate:</b> ' + esc(l.estimate.text) + ' ' + esc(l.estimate.arithmetic) + '</p>'; }).join('');
    if (!est) est = '<p class="up-quietw">No estimate: ' + (S.loading ? 'reading.' : 'no plan is far enough into its week to project.') + '</p>';
    return '<div class="up-rows" id="usage-plan-rows" role="region" aria-label="Plan use by tool">' + rows + '<div class="up-est">' + est + '</div></div>';
  }
  function paint(keepFocus) {
    var el = element();
    var focused = keepFocus || (document.activeElement && el.contains(document.activeElement) ? document.activeElement.className : '');
    el.classList.toggle('up-open', S.open);
    el.innerHTML = headHtml() + (S.open ? rowsHtml() : '');
    if (focused) { var b = el.querySelector(keepFocus === true ? '.up-toggle' : '.' + String(focused).split(' ')[0]); if (b) b.focus(); }
  }
  // Opening Usage reads only a reading over 10 minutes old (the server's rule); Refresh one over 2.
  function read(refresh) {
    if (S.loading) return Promise.resolve();
    S.loading = true; paint();
    return api('/api/usage/plan' + (refresh ? '?refresh=1' : ''), { timeoutMs: 40000 }).then(function (d) {
      S.pane = d && Array.isArray(d.lines) ? d : null; S.error = S.pane ? '' : 'Plan use was not read.';
    }, function () { S.pane = null; S.error = 'Plan use could not be read. Refresh to try again.'; })
      .then(function () { S.loading = false; paint(); });
  }
  // The Usage view's box repaints its own content; the ruler is kept as one element and put back at its top.
  function mount(box, visible) {
    var el = element();
    if (!visible) { if (el.parentNode) el.parentNode.removeChild(el); return; }
    if (box.firstChild !== el) box.insertBefore(el, box.firstChild);
    if (!el.innerHTML) paint();
  }

  W.registerPane('planRuler', { open: read, mount: mount, _state: S, _paint: paint });
})();
