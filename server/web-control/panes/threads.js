/* COS Control Web: Threads, the same pane as Control's (ActivityWindow.swift contextList(kind: "thread")
   4841-4897, sectionHeader 5065-5123, contextRow 5007-5034; ContextDetailPane in Views.swift 6112-6189;
   Models.swift thread() and threadBody() 620-690). Read only, as in Control.
   Data: GET /api/threads?limit=50, /api/threads/:id, /api/threads/search?q=&limit=20, /api/context/status.
   Routes: #/threads, #/threads/<id>. */
(function () {
  'use strict';
  var W = window.COSWeb;
  var $ = W.$, esc = W.esc, api = W.api;
  var pane = $('pane-threads');

  var S = { rows: null, state: 'idle', error: '', status: null, q: '', hits: null, searching: false, ranFor: '', semantic: null, details: {} };

  function trimmed(v) { var s = typeof v === 'string' ? v.trim() : ''; return s || null; }
  function subtitle(t) {
    var meetings = Number(t.meeting_count) || 0;
    var topics = Array.isArray(t.topics) ? t.topics.filter(function (x) { return typeof x === 'string'; }) : [];
    return [meetings > 0 ? meetings + ' meeting' + (meetings === 1 ? '' : 's') : null,
      topics.length ? topics.slice(0, 3).join(', ') : null,
      t.is_resolved === true ? 'resolved' : null].filter(Boolean).join(' · ');
  }
  // threadBody: notes, then facts, then Stakeholders / Meetings / Milestones / Sources.
  function body(t) {
    var sections = [];
    var notes = (t.manual_updates || []).map(function (u) { return trimmed(u && u.content); }).filter(Boolean);
    if (notes.length) sections.push(notes.join('\n\n'));
    var facts = [];
    var topics = (t.topics || []).filter(function (x) { return typeof x === 'string'; });
    if (trimmed(t.target_date)) facts.push('Target: ' + trimmed(t.target_date));
    if (trimmed(t.serves_goal)) facts.push('Goal: ' + trimmed(t.serves_goal));
    var first = trimmed(t.first_seen), last = trimmed(t.last_seen);
    if (first || last) facts.push('Seen: ' + (first || '?') + ' to ' + (last || '?'));
    if (topics.length) facts.push('Topics: ' + topics.join(', '));
    if (facts.length) sections.push(facts.join('\n'));
    function section(title, items, total) {
      if (!items.length) return;
      var count = total > items.length ? items.length + ' of ' + total : String(items.length);
      sections.push(title + ' (' + count + ')\n' + items.map(function (i) { return '- ' + i; }).join('\n'));
    }
    function strings(key) { return (t[key] || []).map(function (x) { return trimmed(x); }).filter(Boolean); }
    section('Stakeholders', strings('stakeholders'));
    var meetings = (t.meetings || []).map(function (m) {
      var name = trimmed(m && m.name); if (!name) return null;
      var date = trimmed(m.date); return date ? date + ' ' + name : name;
    }).filter(Boolean);
    section('Meetings', meetings, Number(t.meeting_count) || 0);
    section('Milestones', strings('milestones'));
    section('Sources', strings('sources'));
    return sections.join('\n\n');
  }
  function copyFormat(t) {
    var text = body(t) || t.name || '';
    return 'Thread ' + t.id + ' (' + subtitle(t) + ')\n\n"""\n' + text + '\n"""';
  }
  function matchLabel(m) { return m === 'both' ? 'Keyword + meaning' : m === 'semantic' || m === 'meaning' ? 'Meaning' : 'Keyword'; }

  function load(force) {
    if (S.state === 'loading' || (S.rows && !force)) return;
    S.state = 'loading';
    render();
    Promise.all([
      api('/api/threads?limit=50'),
      api('/api/context/status').then(function (d) { return d; }, function () { return null; })
    ]).then(function (res) {
      S.rows = (res[0] && res[0].threads) || [];
      S.status = res[1] && res[1].threads ? res[1].threads : null;
      S.state = 'ready';
      render();
    }, function (err) {
      S.state = 'error';
      S.error = err && err.status === 404 ? 'Update the server to search threads from this panel.' : (err.message || 'Threads could not be loaded.');
      render();
    });
  }
  function search() {
    var q = S.q.trim();
    if (q.length < 2) { S.hits = null; S.ranFor = ''; render(); return; }
    S.searching = true;
    render();
    api('/api/threads/search?q=' + encodeURIComponent(q) + '&limit=20').then(function (d) {
      if (S.q.trim() !== q) return;
      S.searching = false; S.ranFor = q;
      S.hits = (d && d.hits) || [];
      S.semantic = d ? d.semanticAvailable === true : null;
      render();
    }, function (err) {
      S.searching = false; S.ranFor = q; S.hits = [];
      S.error = err.message || 'The lookup failed.';
      render();
    });
  }

  function hero() {
    var q = S.q.trim();
    var active = S.status && S.status.available ? Number(S.status.active) || 0 : null;
    var detail;
    if (q.length >= 2) detail = S.searching ? 'Looking up…' : 'Lookup across stored threads';
    else if (S.rows && active != null) detail = S.rows.length + ' shown · ' + active + ' active';
    else detail = 'Follow work that develops across meetings and time.';
    var stats = S.status && S.status.available
      ? '<div class="cx-stats"><span class="cx-stat"><b>' + (Number(S.status.total) || 0).toLocaleString() + '</b><span>TRACKED</span></span>' +
        '<span class="cx-stat"><b>' + (S.rows ? S.rows.length : 0).toLocaleString() + '</b><span>SHOWN</span></span></div>'
      : '';
    return '<header class="cx-hero" data-tint="threads"><span class="cx-glyph"><svg class="icon"><use href="#i-threads"/></svg></span>' +
      '<div class="cx-hero-text"><h1 class="cx-title">Review threads</h1><p class="cx-detail-line">' + esc(detail) + '</p></div>' +
      '<div class="cx-actions"><button type="button" class="cx-btn quiet" data-th="refresh"><svg class="icon"><use href="#i-refresh"/></svg>Refresh</button></div>' +
      stats + '</header>';
  }
  function searchBar() {
    var q = S.q.trim();
    var note = q.length >= 2 && S.ranFor === q && S.semantic === false ? '<p class="cx-note" style="margin:-4px 2px 10px">Keyword only. Threads have no meaning index.</p>' : '';
    return '<div class="cx-controls"><form class="cx-search" data-th-form role="search" style="max-width:420px">' +
      '<input class="field" type="search" id="th-q" placeholder="Search topics, ideas…" value="' + esc(S.q) + '" autocomplete="off" aria-label="Search topics, ideas">' +
      (S.q ? '<button type="button" class="cx-clear" data-th="clear">Clear</button>' : '') + '</form></div>' + note;
  }
  function row(t) {
    return '<button type="button" class="cx-row" data-th="open" data-id="' + esc(t.id) + '">' +
      '<span class="cx-row-glyph"><svg class="icon"><use href="#i-threads"/></svg></span><span class="cx-row-body">' +
      '<span class="cx-row-title strong">' + esc(t.name || '(untitled)') + '</span>' +
      (subtitle(t) ? '<span class="cx-row-sub">' + esc(subtitle(t)) + '</span>' : '') +
      '<span class="cx-id">' + esc(t.id) + '</span></span><span class="chev"></span></button>';
  }
  function hitRow(h) {
    return '<button type="button" class="cx-row" data-th="open" data-id="' + esc(h.id) + '">' +
      '<span class="cx-row-glyph"><svg class="icon"><use href="#i-threads"/></svg></span><span class="cx-row-body">' +
      '<span class="cx-row-title strong">' + esc(h.title || h.name || '(untitled)') + '</span>' +
      (h.snippet ? '<span class="cx-row-sub">' + esc(h.snippet) + '</span>' : '') +
      '<span class="cx-meta" style="margin-top:4px"><span class="cx-id" style="margin:0">' + esc(h.id) + '</span><span class="cx-cap">' + esc(matchLabel(h.match)) + '</span></span>' +
      '</span><span class="chev"></span></button>';
  }
  function list() {
    var q = S.q.trim();
    if (q.length >= 2 && S.ranFor === q) {
      if (!S.hits.length) return '<div class="cx-list"><p class="cx-empty">No threads match that lookup.</p></div>';
      return '<div class="cx-list">' + S.hits.map(hitRow).join('') + '</div>';
    }
    if (S.state === 'error') return '<div class="cx-notice warn">' + esc(S.error) + '</div>';
    if (!S.rows) return '<p class="cx-note">Loading threads…</p>';
    if (!S.rows.length) return '<div class="cx-list"><p class="cx-empty">No threads yet. Threads are markdown files in threads/, or tracked automatically with a bridge.</p></div>';
    return '<div class="cx-list">' + S.rows.map(row).join('') + '</div>';
  }
  function renderList() {
    var focus = document.activeElement && document.activeElement.id === 'th-q';
    var caret = focus ? document.activeElement.selectionStart : null;
    pane.innerHTML = '<div class="cx" data-tint="threads">' + hero() + searchBar() + list() + '</div>';
    if (focus) { var input = $('th-q'); if (input) { input.focus(); try { input.setSelectionRange(caret, caret); } catch (_e) {} } }
  }
  function renderDetail(id) {
    var cached = S.details[id] || (S.rows || []).filter(function (t) { return t.id === id; })[0];
    if (cached) W.setCrumb(cached.name || id);
    pane.innerHTML = '<div class="cx">' + W.skeletonRows(4) + '</div>';
    api('/api/threads/' + encodeURIComponent(id)).then(function (t) {
      var rt = W.parseRoute(); if (rt.pane !== 'threads' || rt.args[0] !== id) return;
      t = t && t.thread ? t.thread : t;
      S.details[id] = t;
      W.setCrumb(t.name || id);
      var text = body(t);
      pane.innerHTML = '<div class="cx" data-tint="threads"><div class="cx-detail-head"><div style="min-width:0">' +
        '<h2 class="cx-detail-title" style="font:500 22px/1.2 var(--display)">' + esc(t.name || '(untitled)') + '</h2>' +
        (subtitle(t) ? '<p class="cx-detail-meta">' + esc(subtitle(t)) + '</p>' : '') +
        '<p class="cx-id" style="user-select:all">' + esc(t.id) + '</p></div>' +
        '<div class="cx-actions"><button type="button" class="cx-btn primary" data-th="copy">Copy as Context</button></div></div>' +
        '<div class="cx-card"><div class="cx-card-body md">' + (text ? W.md(text) : '<p style="color:var(--sub)">(no stored body)</p>') + '</div></div></div>';
    }, function (err) {
      var r = W.parseRoute(); if (r.pane !== 'threads' || r.args[0] !== id) return;
      pane.innerHTML = '<div class="cx"><div class="cx-notice warn">' + esc(err && err.status === 404 ? 'That thread is no longer stored.' : (err.message || 'The thread could not be read.')) + '</div>' +
        (err && err.status === 404 ? '' : '<button type="button" class="cx-btn quiet" data-th="retry">Try again</button>') + '</div>';
    });
  }
  function render() { var a = W.parseRoute(); if (a.pane === 'threads' && !a.args.length) renderList(); }

  pane.addEventListener('click', function (e) {
    var t = e.target.closest('[data-th]');
    if (!t) return;
    var act = t.getAttribute('data-th');
    if (act === 'refresh') { S.rows = null; S.state = 'idle'; load(true); if (S.q.trim().length >= 2) search(); return; }
    if (act === 'clear') { S.q = ''; S.hits = null; S.ranFor = ''; return renderList(); }
    if (act === 'open') return W.go('threads', [t.getAttribute('data-id')]);
    if (act === 'retry') { var cur = W.parseRoute().args[0]; if (cur) renderDetail(cur); return; }
    if (act === 'copy') {
      var id = W.parseRoute().args[0], th = S.details[id];
      if (th) W.copyText(copyFormat(th)).then(function () { W.toast('Copied as grounded context'); }, function (err) { W.toast(err.message); });
    }
  });
  pane.addEventListener('input', function (e) {
    if (e.target.id !== 'th-q') return;
    S.q = e.target.value;
    clearTimeout(pane._t);
    if (S.q.trim().length < 2) { S.hits = null; S.ranFor = ''; renderList(); return; }
    pane._t = setTimeout(search, 350);
  });
  pane.addEventListener('submit', function (e) { if (e.target.matches('[data-th-form]')) { e.preventDefault(); clearTimeout(pane._t); search(); } });

  W.registerPane('threads', {
    load: function (args) {
      if (args && args.length) renderDetail(args[0]);
      else { load(false); renderList(); }
    }
  });
})();
