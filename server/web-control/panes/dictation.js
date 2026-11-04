/* COS Control Web: Dictation, mirroring Control's DictationActivityPane and Dictionary pane
   (MacDictation.swift 5338-5555 and 6205+, MacDictationCore.swift 1380).
   The dictionary is the server's (GET /api/transcription-glossary and /recent; POST correction,
   correction/undo, correction/remove, vocabulary/add, vocabulary/remove), so it works here in full.
   Dictations and the fixes Learn from my edits suggests are files Control keeps on the Mac; the
   server has no route for them, so this pane says where they are instead of showing empty lists.
   Routes: #/dictation, #/dictation/dictionary. */
(function () {
  'use strict';
  var W = window.COSWeb;
  var $ = W.$, esc = W.esc, api = W.api;
  var pane = $('pane-dictation');

  var S = { glossary: null, recent: null, recentError: '', state: 'idle', error: '', q: '', busy: false };

  function toDate(v) { var d = v ? new Date(v) : null; return d && !isNaN(d.getTime()) ? d : null; }
  // Control's "when": "now" under a minute, "h:mm a" today, otherwise "MMM d".
  function when(v) {
    var d = toDate(v); if (!d) return '';
    var now = new Date();
    if (now - d < 60000) return 'now';
    var same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return same ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function sourceLabel(s) { return s === 'g2' ? 'G2' : s === 'manual' ? 'added' : s === 'dictation' || s === 'meeting' ? s : 'COS'; }
  function pair(heard, written) {
    return '<span class="cx-pair"><span class="heard">' + esc(heard) + '</span><svg class="icon" aria-hidden="true"><use href="#i-chev"/></svg><span class="written">' + esc(written) + '</span></span>';
  }

  function load(force) {
    if (S.state === 'loading' || (S.glossary && !force)) return;
    S.state = 'loading';
    render();
    Promise.all([
      api('/api/transcription-glossary'),
      api('/api/transcription-glossary/recent').then(function (d) { return d; }, function (err) { return { error: err }; })
    ]).then(function (res) {
      S.glossary = res[0] || { vocabulary: [], corrections: {} };
      S.recent = res[1] && res[1].entries ? res[1].entries : null;
      S.recentError = res[1] && res[1].error ? (res[1].error.status === 404 ? 'Update the COS server to see recent corrections here.' : (res[1].error.message || 'Recent corrections could not be read.')) : '';
      S.state = 'ready';
      render();
    }, function (err) {
      S.state = 'error';
      S.error = err.message || 'The dictionary could not be read.';
      render();
    });
  }

  function hero(title, detail, actions) {
    return '<header class="cx-hero" data-tint="dictation"><span class="cx-glyph"><svg class="icon"><use href="#i-dictation"/></svg></span>' +
      '<div class="cx-hero-text"><h1 class="cx-title">' + esc(title) + '</h1>' + (detail ? '<p class="cx-detail-line">' + esc(detail) + '</p>' : '') + '</div>' +
      '<div class="cx-actions">' + actions + '</div></header>';
  }
  function recentRows(list, limit) {
    if (S.recentError) return '<div class="cx-notice">' + esc(S.recentError) + '</div>';
    if (!list) return '<div class="cx-list">' + W.skeletonRows(3) + '</div>';
    var rows = limit ? list.slice(0, limit) : list;
    if (!rows.length) return '<div class="cx-list"><p class="cx-empty">Nothing learned yet. Use Fix a word on a dictation, or add a correction below.</p></div>';
    return '<div class="cx-list">' + rows.map(function (e) {
      return '<div class="cx-row cx-row-static"><span class="cx-row-glyph"><svg class="icon"><use href="#i-dictation"/></svg></span><span class="cx-row-body">' +
        '<span class="cx-row-title">' + pair(e.heard, e.written) + '</span>' +
        '<span class="cx-meta" style="margin-top:3px"><span class="cx-time">' + esc(sourceLabel(e.source) + ' · ' + when(e.at)) + '</span></span></span>' +
        '<button type="button" class="cx-btn quiet" data-dict="undo" data-id="' + esc(e.id) + '">Undo</button></div>';
    }).join('') + '</div>';
  }

  function renderMain() {
    var body;
    if (S.state === 'error') body = '<div class="cx-notice warn">' + esc(S.error) + '</div>';
    else body =
      '<p class="cx-strip-label" style="margin-top:16px">RECENT CORRECTIONS</p>' + recentRows(S.recent, 10) +
      '<div class="cx-notice" style="margin-top:16px"><svg class="icon" aria-hidden="true"><use href="#i-dictation"/></svg><span>Your dictations and the fixes Learn from my edits suggests are kept on your Mac, so they show in COS Control there. The dictionary is shared, so a word you add here applies to G2 meetings, Mac recordings and dictation from the next sentence.</span></div>';
    pane.innerHTML = '<div class="cx" data-tint="dictation">' +
      hero('Dictation', 'Your dictations, the corrections COS learned from your edits, and the dictionary.',
        '<button type="button" class="cx-btn quiet" data-dict="dictionary">Dictionary</button>' +
        '<button type="button" class="cx-btn quiet" data-dict="refresh"><svg class="icon"><use href="#i-refresh"/></svg>Refresh</button>') +
      body + '</div>';
  }

  function renderDictionary() {
    W.setCrumb('Dictionary');
    var g = S.glossary || { vocabulary: [], corrections: {} };
    var q = S.q.trim().toLowerCase();
    var vocab = (g.vocabulary || []).filter(function (t) { return !q || String(t).toLowerCase().indexOf(q) >= 0; });
    var corr = Object.keys(g.corrections || {}).map(function (h) { return [h, g.corrections[h]]; })
      .filter(function (p) { return !q || p[0].toLowerCase().indexOf(q) >= 0 || String(p[1]).toLowerCase().indexOf(q) >= 0; });
    var recent = (S.recent || []).filter(function (e) { return !q || String(e.heard).toLowerCase().indexOf(q) >= 0 || String(e.written).toLowerCase().indexOf(q) >= 0; });
    var shownVocab = vocab.slice(0, 60);
    pane.innerHTML = '<div class="cx" data-tint="dictation">' +
      hero('Dictionary', 'One dictionary for G2 meetings, Mac recordings and dictation. A word you add or fix applies from the next sentence.',
        '<button type="button" class="cx-btn quiet" data-dict="refresh"><svg class="icon"><use href="#i-refresh"/></svg>Refresh</button>') +
      '<div class="cx-controls"><div class="cx-search" style="max-width:420px"><input class="field" type="search" id="dict-q" placeholder="Search words and corrections" value="' + esc(S.q) + '" autocomplete="off" aria-label="Search words and corrections">' +
        (S.q ? '<button type="button" class="cx-clear" data-dict="clear">Clear</button>' : '') + '</div></div>' +
      (S.state !== 'ready' ? (S.state === 'error' ? '<div class="cx-notice warn">' + esc(S.error) + '</div>' : '<div class="cx-list">' + W.skeletonRows(4) + '</div>') :
      '<div class="cx-dict-cols"><section><h2 class="cx-col-title">Recent corrections</h2>' + (S.recent && !recent.length && q ? '<div class="cx-list"><p class="cx-empty">No recent correction matches.</p></div>' : recentRows(S.recent ? recent : null, 0)) + '</section>' +
      '<section><h2 class="cx-col-title">Vocabulary · ' + (g.vocabulary || []).length + '</h2>' +
        '<form class="cx-inline-form" data-dict-form="vocab"><input class="field" id="dict-term" type="text" placeholder="Add a word or name" maxlength="100" autocomplete="off" aria-label="Add a word or name"><button type="submit" class="cx-btn">Add</button></form>' +
        '<div class="cx-chips">' + shownVocab.map(function (t) {
          return '<span class="cx-chip">' + esc(t) + '<button type="button" data-dict="vocab-remove" data-term="' + esc(t) + '" aria-label="Remove ' + esc(t) + '">×</button></span>';
        }).join('') + (vocab.length > 60 ? '<span class="cx-chip more">+' + (vocab.length - 60) + '</span>' : '') + '</div></section></div>' +
      '<section style="margin-top:22px"><h2 class="cx-col-title">Corrections · ' + Object.keys(g.corrections || {}).length + '</h2>' +
        '<p class="cx-note" style="margin:0 2px 10px">When COS hears the word on the left, it writes the one on the right.</p>' +
        '<form class="cx-inline-form" data-dict-form="correction"><input class="field" id="dict-heard" type="text" placeholder="Heard" maxlength="100" autocomplete="off" aria-label="Heard">' +
        '<input class="field" id="dict-written" type="text" placeholder="Written" maxlength="100" autocomplete="off" aria-label="Written"><button type="submit" class="cx-btn">Add</button></form>' +
        '<div class="cx-list">' + (corr.length ? corr.map(function (p) {
          return '<div class="cx-row cx-row-static"><span class="cx-row-glyph"><svg class="icon"><use href="#i-dictation"/></svg></span><span class="cx-row-body"><span class="cx-row-title">' + pair(p[0], p[1]) + '</span></span>' +
            '<button type="button" class="cx-x" data-dict="corr-remove" data-heard="' + esc(p[0]) + '" aria-label="Remove ' + esc(p[0]) + '">×</button></div>';
        }).join('') : '<p class="cx-empty">No corrections yet.</p>') + '</div></section>') +
      '<p class="cx-note" id="dict-status" role="status"></p></div>';
  }

  function render() {
    var r = W.parseRoute();
    if (r.pane !== 'dictation') return;
    var focus = document.activeElement && document.activeElement.id === 'dict-q';
    var caret = focus ? document.activeElement.selectionStart : null;
    if (r.args[0] === 'dictionary') renderDictionary(); else renderMain();
    if (focus) { var input = $('dict-q'); if (input) { input.focus(); try { input.setSelectionRange(caret, caret); } catch (_e) {} } }
  }

  function write(path, body, done) {
    if (S.busy) return;
    S.busy = true;
    api(path, { method: 'POST', body: body }).then(function () {
      S.busy = false;
      if (done) W.toast(done);
      S.glossary = null; S.state = 'idle'; load(true);
    }, function (err) {
      S.busy = false;
      var msg = err && err.message ? err.message : 'That change was not saved.';
      var status = $('dict-status');
      if (status) { status.textContent = msg; status.style.color = 'var(--amber)'; } else W.toast(msg);
    });
  }

  pane.addEventListener('click', function (e) {
    var t = e.target.closest('[data-dict]');
    if (!t) return;
    var act = t.getAttribute('data-dict');
    if (act === 'dictionary') return W.go('dictation', ['dictionary']);
    if (act === 'refresh') { S.glossary = null; S.state = 'idle'; return load(true); }
    if (act === 'clear') { S.q = ''; return render(); }
    if (act === 'undo') return write('/api/transcription-glossary/correction/undo', { id: t.getAttribute('data-id') }, 'Undone');
    if (act === 'vocab-remove') return write('/api/transcription-glossary/vocabulary/remove', { term: t.getAttribute('data-term') }, 'Removed');
    if (act === 'corr-remove') return write('/api/transcription-glossary/correction/remove', { heard: t.getAttribute('data-heard') }, 'Removed');
  });
  pane.addEventListener('input', function (e) {
    if (e.target.id !== 'dict-q') return;
    S.q = e.target.value;
    clearTimeout(pane._t); pane._t = setTimeout(render, 120);
  });
  pane.addEventListener('submit', function (e) {
    var f = e.target.getAttribute('data-dict-form');
    if (!f) return;
    e.preventDefault();
    if (f === 'vocab') {
      var term = ($('dict-term').value || '').trim();
      if (!term) return;
      if (((S.glossary && S.glossary.vocabulary) || []).some(function (v) { return String(v).toLowerCase() === term.toLowerCase(); })) { W.toast('Already in the dictionary.'); return; }
      write('/api/transcription-glossary/vocabulary/add', { term: term }, 'Added');
    } else if (f === 'correction') {
      var heard = ($('dict-heard').value || '').trim(), written = ($('dict-written').value || '').trim();
      if (!heard || !written) return;
      write('/api/transcription-glossary/correction', { heard: heard, written: written, source: 'manual' }, 'Added');
    }
  });

  W.registerPane('dictation', {
    load: function () { load(false); render(); },
    up: function () { return null; }
  });
})();
