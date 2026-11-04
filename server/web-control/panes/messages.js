/* COS Control Web: Messages, the same pane as Control's (ActivityWindow.swift messagesList 3205-3317,
   archiveBody 3091-3203, messageDetail 5827, day 5469, chat 5611).
   Recent is the server's rolling window of the newest turns (GET /api/sessions/today/all-messages),
   newest first. Archive is the day list, its search, a day's chats and one chat's transcript.
   Routes: #/messages, #/messages/archive, #/messages/m/<no>, #/messages/m/<no>/a/<attachment>,
   #/messages/day/<date>, #/messages/day/<date>/<chat index>. */
(function () {
  'use strict';
  var W = window.COSWeb;
  var $ = W.$, esc = W.esc, api = W.api;
  var pane = $('pane-messages');

  var S = {
    view: 'recent',          // recent | archive
    q: '',                   // the shared search text
    recent: null,            // turns, newest first
    recentDate: '',
    recentState: 'idle',     // idle | loading | ready | error
    recentError: '',
    days: null,              // archive index rows
    daysState: 'idle',
    archiveRan: '',          // the query the archive search last ran for
    archiveHits: null,
    archiveMeta: '',
    archiveBusy: false,
    dayCache: {},            // date -> full day
    onlyMatches: true
  };

  // ── helpers ───────────────────────────────────────────
  function toDate(v) {
    if (v == null || v === '') return null;
    var n = typeof v === 'number' ? v : (/^\d+$/.test(String(v)) ? Number(v) : NaN);
    var d = !isNaN(n) ? new Date(n > 1e10 ? n : n * 1000) : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function shortTime(d) { return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  // Control's row time: "Today 7:15 PM", "Yesterday 7:03 AM", "Oct 30, 7:03 AM", "Oct 30, 2025, 7:03 AM".
  function timeLabel(v) {
    var d = toDate(v);
    if (!d) return '';
    var now = new Date();
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, now)) return 'Today ' + shortTime(d);
    if (sameDay(d, y)) return 'Yesterday ' + shortTime(d);
    var opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts) + ', ' + shortTime(d);
  }
  function stripMd(text) {
    return String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+\.\s+/gm, '')
      .replace(/\*\*|__|\*|_/g, '').replace(/\s+/g, ' ').trim();
  }
  function headline(q) {
    var s = String(q || '').replace(/\s+/g, ' ').trim();
    if (!s) return '(empty query)';
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  }
  function modelOf(t) { var m = String(t.modelPreference || ''); return /^[A-Za-z0-9._:-]{1,64}$/.test(m) ? m : ''; }
  function originTag(t) { return t.origin === 'routine' ? 'ROUTINE' : t.origin === 'task' ? 'TASK' : ''; }
  function originTitle(t) {
    var id = t.originId ? ' (' + t.originId + ')' : '';
    return t.origin === 'routine' ? 'Produced by a scheduled routine on your Mac' + id : t.origin === 'task' ? 'Produced by an agent working a task on your Mac' + id : '';
  }
  function numOf(t) { return t.no != null ? t.no : t.globalMsgNum; }
  function keyOf(t, i) { var n = numOf(t); return n != null ? String(n) : 'i' + i; }
  function atts(t) { return Array.isArray(t.attachments) ? t.attachments.slice(0, 5) : []; }
  function attKind(a) {
    var m = String(a.mime || '');
    if (/^image\//.test(m)) return 'image';
    if (/^video\//.test(m)) return 'video';
    return 'file';
  }
  function attIcon(kinds) {
    var uniq = kinds.filter(function (k, i) { return kinds.indexOf(k) === i; });
    if (uniq.length > 1) return 'clip';
    return uniq[0] === 'image' ? 'photo' : uniq[0] === 'video' ? 'video' : 'doc';
  }
  function attTitle(list) {
    var kinds = list.map(attKind);
    var uniq = kinds.filter(function (k, i) { return kinds.indexOf(k) === i; });
    var n = list.length;
    if (uniq.length > 1) return n + ' attachments';
    return n + ' ' + (uniq[0] === 'image' ? W.plural(n, 'image', 'images') : uniq[0] === 'video' ? W.plural(n, 'video', 'videos') : W.plural(n, 'file', 'files'));
  }
  function isUserAtt(a) { return /^user_/.test(String(a.kind || '')); }
  function stripLabel(list, user) {
    var kinds = list.map(attKind);
    var allImages = kinds.every(function (k) { return k === 'image'; });
    if (user) return allImages ? (list.length === 1 ? 'YOUR IMAGE' : 'YOUR IMAGES') : 'YOUR ATTACHMENTS';
    return allImages ? (list.length === 1 ? 'ANSWER IMAGE' : 'ANSWER IMAGES') : 'FROM COS';
  }
  function mediaUrl(a, variant) { return '/api/media/' + encodeURIComponent(a.id) + '/content?variant=' + variant; }
  function sizeLabel(bytes) {
    var b = Number(bytes) || 0;
    if (!b) return '';
    return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  }
  function durLabel(ms) {
    var s = Math.round((Number(ms) || 0) / 1000);
    if (!s) return '';
    return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : s + 's';
  }
  function matches(t, q) {
    var n = q.toLowerCase();
    return String(t.query || '').toLowerCase().indexOf(n) >= 0 || String(t.text || '').toLowerCase().indexOf(n) >= 0;
  }
  // Highlight a search term in text already in the DOM (after Markdown), never in the HTML string.
  function highlightIn(el, q) {
    if (!el || !q || q.length < 2) return;
    var needle = q.toLowerCase();
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      var text = node.nodeValue, lower = text.toLowerCase(), at = lower.indexOf(needle);
      if (at < 0) return;
      var frag = document.createDocumentFragment(), from = 0;
      while (at >= 0) {
        frag.appendChild(document.createTextNode(text.slice(from, at)));
        var mark = document.createElement('mark'); mark.className = 'cx-mark'; mark.textContent = text.slice(at, at + needle.length);
        frag.appendChild(mark);
        from = at + needle.length; at = lower.indexOf(needle, from);
      }
      frag.appendChild(document.createTextNode(text.slice(from)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  // ── archive topic and matches (helper archiveChatTopic / archiveChatMatches) ──
  var STOP = ('alright okay right well hey please thanks yeah yes no want need like just going gonna let lets make made give given take look looking looked know think thing things that this these those there here then than with from into onto over about after before through have has had been was were are is am be being and but for the you your yours our ours their can could would should will shall may might must what when where which who whom why how all any some one two get got put run ran see saw say said tell told ask asked come came back also very really quick quickly actually basically kind sort little bit more most much many now today tomorrow yesterday still even only out off down again because does did doing done not dont cant wont its his her him she they them were weve ive ill lot way able undefined inside against recently using around something anything everything someone another however though while since until during without within across between maybe perhaps probably definitely essentially literally obviously honestly sure fine nice great better best worse worst first last next other others same different whole full part instead rather already always never sometimes often').split(' ');
  var STOPSET = {}; STOP.forEach(function (w) { STOPSET[w] = 1; });
  function chatTopic(exchanges) {
    var counts = {}, order = {}, seen = 0;
    exchanges.forEach(function (ex) {
      if (ex.role !== 'user' || typeof ex.content !== 'string') return;
      ex.content.toLowerCase().split(/[^\p{L}-]+/u).forEach(function (raw) {
        var w = raw.replace(/^-+|-+$/g, '');
        if (w.length < 4 || STOPSET[w]) return;
        counts[w] = (counts[w] || 0) + 1;
        if (order[w] == null) order[w] = seen++;
      });
    });
    return Object.keys(counts).sort(function (a, b) { return counts[a] !== counts[b] ? counts[b] - counts[a] : order[a] - order[b]; }).slice(0, 4).join(' · ');
  }
  function editDistance(a, b, limit) {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i; var best = cur[0];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        best = Math.min(best, cur[j]);
      }
      if (best > limit) return limit + 1;
      prev = cur.slice();
    }
    return prev[b.length];
  }
  function fuzzy(hay, needle) {
    if (hay.indexOf(needle) >= 0) return true;
    if (needle.length < 5) return false;
    var allowed = needle.length >= 8 ? 2 : 1;
    var words = hay.split(/[^\p{L}]+/u);
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (Math.abs(w.length - needle.length) > allowed) continue;
      if (editDistance(w, needle, allowed) <= allowed) return true;
    }
    return false;
  }
  function chatMatches(exchanges, q) {
    var needle = q.toLowerCase(), count = 0, snippet = '', fuzzyOnly = false;
    if (!needle) return { count: 0, snippet: '' };
    exchanges.forEach(function (ex) {
      if (typeof ex.content !== 'string') return;
      var content = ex.content, hay = content.toLowerCase();
      if (hay.indexOf(needle) < 0 && fuzzy(hay, needle)) {
        fuzzyOnly = true; count += 1;
        if (!snippet) snippet = content.slice(0, 150);
        return;
      }
      var at = hay.indexOf(needle);
      while (at >= 0) {
        count += 1;
        if (!snippet) {
          var lo = Math.max(0, at - 60), hi = Math.min(hay.length, at + needle.length + 90);
          snippet = (lo > 0 ? '…' : '') + content.slice(lo, hi).trim() + (hi < hay.length ? '…' : '');
        }
        at = hay.indexOf(needle, at + needle.length);
      }
    });
    return { count: count, snippet: snippet };
  }
  function cleanSnippet(raw) {
    var text = String(raw || '');
    var marker = text.lastIndexOf('"content": "');
    if (marker >= 0) text = text.slice(marker + 12);
    ['"sessionId":', '"exchanges":', '"role":', '"user",', '"assistant",', '"timestamp":', '"content":', '[ {', '} ]', '{', '}', '[', ']'].forEach(function (junk) { text = text.split(junk).join(' '); });
    text = text.split('\\n').join(' ').replace(/ {2,}/g, ' ');
    return text.replace(/^[ "',:]+|[ "',:]+$/g, '');
  }

  // ── data ──────────────────────────────────────────────
  function loadRecent(force) {
    if (S.recentState === 'loading') return;
    if (S.recent && !force) return;
    S.recentState = 'loading';
    render();
    api('/api/sessions/today/all-messages?limit=30').then(function (d) {
      var list = (d && d.messages) || [];
      S.recentAt = Date.now();
      S.recent = list.slice().reverse();
      S.recentDate = (d && d.date) || '';
      S.recentState = 'ready';
      render();
    }, function (err) {
      S.recentState = 'error';
      S.recentError = err && err.status === 401 ? 'signed-out' : 'failed';
      render();
    });
  }
  function loadDays(force) {
    if (S.daysState === 'loading' || (S.days && !force)) return;
    S.daysState = 'loading';
    render();
    api('/api/archive').then(function (d) {
      S.days = (d && d.archives) || [];
      S.daysState = 'ready';
      render();
    }, function (err) {
      S.daysState = err && err.status === 404 ? 'absent' : 'error';
      render();
    });
  }
  function runArchiveSearch() {
    var q = S.q.trim();
    if (q.length < 2) return;
    S.archiveBusy = true;
    render();
    api('/api/archive/search?q=' + encodeURIComponent(q)).then(function (d) {
      S.archiveBusy = false;
      S.archiveRan = q;
      var hits = (d && d.hits) || [];
      S.archiveHits = hits;
      var scanned = Number(d && d.scannedDays) || 0;
      S.archiveMeta = hits.length
        ? hits.length + ' ' + W.plural(hits.length, 'day', 'days') + (d.truncated ? '+' : '') + ' · scanned ' + scanned + ' · ' + (Number(d.elapsedMs) || 0) + ' ms'
        : 'No matches in ' + scanned + ' ' + W.plural(scanned, 'day', 'days') + '.';
      render();
    }, function (err) {
      S.archiveBusy = false;
      S.archiveRan = q;
      S.archiveHits = [];
      S.archiveMeta = err && err.status === 404 ? 'Update the COS server to browse the archive.' : (err.message || 'The archive search failed.');
      render();
    });
  }
  var dayLoading = {};
  function loadDay(date) {
    if (S.dayCache[date]) return Promise.resolve(S.dayCache[date]);
    if (dayLoading[date]) return dayLoading[date];
    dayLoading[date] = api('/api/archive/' + encodeURIComponent(date)).then(function (d) {
      // A day can be megabytes: keep the three most recent opened days only.
      S.dayCache[date] = d;
      var keys = Object.keys(S.dayCache); if (keys.length > 3) delete S.dayCache[keys[0]];
      return d;
    })
      .finally(function () { delete dayLoading[date]; });
    return dayLoading[date];
  }

  // ── list view ─────────────────────────────────────────
  function heroHtml() {
    var detail;
    if (S.recentState === 'loading' && !S.recent) detail = 'Loading…';
    else if (S.recentState === 'error') detail = S.recentError === 'signed-out' ? 'Signed out' : 'Could not load messages';
    else if (S.recent && S.recent.length) detail = 'Newest first · ' + S.recent.length + ' ' + W.plural(S.recent.length, 'turn', 'turns');
    else if (S.recent) detail = 'No turns today';
    else detail = 'Refresh to load';
    return '<header class="cx-hero" data-tint="messages">' +
      '<span class="cx-glyph"><svg class="icon"><use href="#i-messages"/></svg></span>' +
      '<div class="cx-hero-text"><h1 class="cx-title">Recent messages</h1><p class="cx-detail-line">' + esc(detail) + '</p></div>' +
      '<div class="cx-actions">' +
        '<button type="button" class="cx-btn quiet" data-msg="handoff"' + (S.recent && S.recent.length ? '' : ' disabled') + '>Copy handoff</button>' +
        '<button type="button" class="cx-btn quiet" data-msg="refresh"><svg class="icon"><use href="#i-refresh"/></svg>Refresh</button>' +
      '</div></header>';
  }
  function controlsHtml() {
    return '<div class="cx-controls">' +
      '<div class="cx-switch" role="group" aria-label="Message view"><span class="cx-switch-label">Message view</span>' +
        '<button type="button" data-msg="view" data-view="recent" aria-pressed="' + (S.view === 'recent') + '">Recent</button>' +
        '<button type="button" data-msg="view" data-view="archive" aria-pressed="' + (S.view === 'archive') + '">Archive</button>' +
      '</div>' +
      '<form class="cx-search" data-msg-form="search" role="search">' +
        '<input class="field" type="search" id="msg-q" placeholder="Search recent and archive" value="' + esc(S.q) + '" enterkeyhint="search" autocomplete="off" aria-label="Search recent and archive">' +
        (S.archiveBusy ? '<span class="cx-time">…</span>' : '') +
        (S.q ? '<button type="button" class="cx-clear" data-msg="clear">Clear</button>' : '') +
      '</form></div>';
  }
  function crossingHtml() {
    var q = S.q.trim();
    if (q.length < 2) return '';
    var recentN = (S.recent || []).filter(function (t) { return matches(t, q); }).length;
    var arch = S.archiveBusy ? '…' : S.archiveRan !== q ? 'press return' : (S.archiveHits.length === 1 ? '1 day' : S.archiveHits.length + ' days');
    var recentSide = 'Recent ' + recentN, archSide = 'Archive ' + arch;
    return '<p class="cx-cross">' + (S.view === 'recent'
      ? '<span>' + esc(recentSide) + '</span><span>·</span><button type="button" class="door" data-msg="view" data-view="archive">' + esc(archSide) + '</button>'
      : '<button type="button" class="door" data-msg="view" data-view="recent">' + esc(recentSide) + '</button><span>·</span><span>' + esc(archSide) + '</span>') + '</p>';
  }
  function recentRowHtml(t, i) {
    var a = atts(t);
    var kinds = a.map(attKind);
    var n = numOf(t);
    var tag = originTag(t);
    var model = modelOf(t);
    return '<button type="button" class="cx-row" data-msg="open" data-key="' + esc(keyOf(t, i)) + '">' +
      '<span class="cx-row-glyph"><svg class="icon"><use href="#i-messages"/></svg>' +
        (a.length ? '<span class="cx-badge-icon"><svg class="icon"><use href="#i-' + attIcon(kinds) + '"/></svg></span>' : '') + '</span>' +
      '<span class="cx-row-body">' +
        '<span class="cx-meta"><span class="cx-num">' + (n != null ? 'Message #' + esc(n) : 'Message') + '</span>' +
          '<span class="cx-time">' + esc(timeLabel(t.timestamp)) + '</span>' +
          (tag ? '<span class="cx-tag" title="' + esc(originTitle(t)) + '">' + tag + '</span>' : '') +
          (model ? '<span class="cx-model">' + esc(model) + '</span>' : '') +
          (a.length ? '<span class="cx-att" title="' + esc(attTitle(a)) + '"><svg class="icon"><use href="#i-' + attIcon(kinds) + '"/></svg>' + a.length + '</span>' : '') +
        '</span>' +
        '<span class="cx-row-title">' + esc(headline(t.query)) + '</span>' +
        '<span class="cx-row-sub">' + esc(stripMd(t.text)) + '</span>' +
      '</span><span class="chev"></span></button>';
  }
  function recentBody() {
    if (S.recentState === 'loading' && !S.recent) return '<div class="cx-list">' + W.skeletonRows(5) + '</div>';
    if (S.recentState === 'error') {
      return '<div class="cx-list"><p class="cx-empty">' + (S.recentError === 'signed-out'
        ? 'This browser is signed out. Connect it again.'
        : 'Messages could not be loaded. Check that the Mac is awake, then refresh.') + '</p></div>';
    }
    var list = S.recent || [];
    var q = S.q.trim();
    var shown = q.length >= 2 ? list.filter(function (t) { return matches(t, q); }) : list;
    if (!list.length) return '<div class="cx-list"><p class="cx-empty">No glasses messages have landed today.</p></div>';
    if (!shown.length) {
      var days = S.archiveRan === q && S.archiveHits ? S.archiveHits.length : 0;
      return '<div class="cx-list"><p class="cx-empty">No recent message contains “' + esc(q) + '”' +
        (days ? ', but ' + days + ' archived ' + W.plural(days, 'day', 'days') + ' ' + (days === 1 ? 'does' : 'do') + '.' : '. The archive goes back further.') + '</p></div>';
    }
    return '<div class="cx-list">' + shown.map(function (t) { return recentRowHtml(t, list.indexOf(t)); }).join('') + '</div>' +
      '<p class="cx-note">ROUTINE and TASK mark a run your Mac started.</p>';
  }
  function archiveBody() {
    var q = S.q.trim();
    if (S.daysState === 'absent') return '<div class="cx-notice"><svg class="icon"><use href="#i-refresh"/></svg><span>Update the COS server to browse the archive.</span></div>';
    if (S.daysState === 'error') return '<div class="cx-notice warn"><span>The archive could not be read. Refresh to try again.</span></div>';
    if (S.archiveBusy) return '<p class="cx-note">Reading the archive…</p>';
    if (q.length >= 2 && S.archiveRan === q) {
      var hits = S.archiveHits || [];
      var meta = '<p class="cx-note" style="margin:0 2px 10px">' + esc(S.archiveMeta) + '</p>';
      if (!hits.length) return meta + '<div class="cx-list"><p class="cx-empty">No archived day matched that search.</p></div>';
      return meta + '<div class="cx-list">' + hits.map(function (h) {
        var snips = (h.snippets || []).slice(0, 2).map(cleanSnippet).filter(Boolean);
        return '<button type="button" class="cx-row" data-msg="day" data-date="' + esc(h.date) + '">' +
          '<span class="cx-row-glyph"><svg class="icon"><use href="#i-meetings"/></svg></span><span class="cx-row-body">' +
          '<span class="cx-meta"><span class="cx-num">' + esc(h.date) + '</span><span class="cx-time">' + esc(h.matches + ' ' + W.plural(Number(h.matches), 'match', 'matches')) + '</span></span>' +
          snips.map(function (s) { return '<span class="cx-row-sub three">' + esc(s) + '</span>'; }).join('') +
          '</span><span class="chev"></span></button>';
      }).join('') + '</div>';
    }
    if (!S.days) return '<div class="cx-list">' + W.skeletonRows(5) + '</div>';
    if (!S.days.length) return '<div class="cx-list"><p class="cx-empty">Nothing is archived yet. Conversations move here at the end of each day.</p></div>';
    return (q.length >= 2 ? '<p class="cx-note" style="margin:0 2px 10px">Press return to search the archive.</p>' : '') +
      '<div class="cx-list">' + S.days.map(function (d) {
        return '<button type="button" class="cx-row" data-msg="day" data-date="' + esc(d.date) + '">' +
          '<span class="cx-row-glyph"><svg class="icon"><use href="#i-meetings"/></svg></span><span class="cx-row-body">' +
          '<span class="cx-meta"><span class="cx-num">' + esc(d.date) + '</span><span class="cx-time">' + esc((d.chatCount || 0) + ' ' + W.plural(d.chatCount, 'chat', 'chats') + ' · ' + (d.exchangeCount || 0) + ' ' + W.plural(d.exchangeCount, 'message', 'messages')) + '</span></span>' +
          (d.summary ? '<span class="cx-row-sub">' + esc(d.summary) + '</span>' : '') +
          '</span><span class="chev"></span></button>';
      }).join('') + '</div>';
  }
  function renderList() {
    var focus = document.activeElement && document.activeElement.id === 'msg-q';
    var caret = focus ? document.activeElement.selectionStart : null;
    pane.innerHTML = '<div class="cx" data-tint="messages">' + heroHtml() + controlsHtml() + crossingHtml() +
      (S.view === 'recent' ? recentBody() : archiveBody()) + '</div>';
    if (focus) { var input = $('msg-q'); if (input) { input.focus(); try { input.setSelectionRange(caret, caret); } catch (_e) {} } }
  }

  // ── detail: one recent message ────────────────────────
  function findRecent(key) {
    var list = S.recent || [];
    for (var i = 0; i < list.length; i++) if (keyOf(list[i], i) === key) return list[i];
    return null;
  }
  function stripHtml(list, user, msgKey) {
    if (!list.length) return '';
    return '<p class="cx-strip-label">' + stripLabel(list, user) + '</p><div class="cx-strip">' + list.map(function (a) {
      var kind = attKind(a);
      var badge = kind === 'video' ? durLabel(a.durationMs) : sizeLabel(a.bytes || a.size);
      var inner = kind === 'image'
        ? '<img src="' + esc(mediaUrl(a, 'thumb')) + '" alt="' + esc(a.label || 'Image') + '" loading="lazy">'
        : kind === 'video'
          ? '<span class="cx-play"><svg class="icon"><use href="#i-video"/></svg></span>'
          : '<svg class="icon"><use href="#i-doc"/></svg>';
      var open = kind === 'image'
        ? 'data-msg="att" data-key="' + esc(msgKey) + '" data-att="' + esc(a.id) + '"'
        : 'data-msg="att-open" data-href="' + esc(mediaUrl(a, 'phone')) + '"';
      return '<button type="button" class="cx-thumb" ' + open + ' title="' + esc(a.label || '') + '">' + inner +
        (badge ? '<span class="cx-thumb-badge">' + esc(badge) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function turnCards(t, msgKey) {
    var a = atts(t);
    return '<div class="cx-card you"><div class="cx-card-label">YOU</div><div class="cx-card-body" data-hl>' + esc(String(t.query || '').trim() || '(empty query)').replace(/\n/g, '<br>') + '</div></div>' +
      stripHtml(a.filter(isUserAtt), true, msgKey) +
      '<div class="cx-card"><div class="cx-card-label">COS</div><div class="cx-card-body md" data-hl>' + W.md(String(t.text || '')) + '</div></div>' +
      stripHtml(a.filter(function (x) { return !isUserAtt(x); }), false, msgKey);
  }
  function copyTurnText(t) {
    var label = numOf(t) != null ? 'Msg ' + numOf(t) : 'Msg';
    return '[' + label + '] User: ' + (t.query || '') + '\n[' + label + '] COS: ' + (t.text || '');
  }
  function renderMessage(key, attId) {
    var t = findRecent(key);
    if (!t) {
      // Opened cold (reload, deep link, iOS reloading the tab): load the recent window, and
      // render() comes back here when it lands, or shows the failure with Retry.
      if (S.recentState === 'error') { pane.innerHTML = retryBox('Messages could not be loaded. Check that the Mac is awake, then try again.'); return; }
      if (S.recentState !== 'ready') { loadRecent(false); pane.innerHTML = '<div class="cx">' + W.skeletonRows(4) + '</div>'; return; }
      pane.innerHTML = '<div class="cx"><p class="cx-empty">That message is no longer in the recent window. Look for it in the Archive.</p></div>';
      return;
    }
    var n = numOf(t);
    var title = n != null ? 'Message #' + n : 'Message';
    if (attId) {
      var a = atts(t).filter(function (x) { return x.id === attId; })[0];
      if (a) {
        W.setCrumb(title + ' · ' + (a.label || 'Image'));
        pane.innerHTML = '<div class="cx"><div class="cx-detail-head"><div><h2 class="cx-detail-title">' + esc(a.label || 'Image') + '</h2>' +
          '<p class="cx-detail-meta">' + esc((a.width && a.height ? a.width + ' × ' + a.height : '') + (a.width && a.height ? ' · ' : '') + title) + '</p></div>' +
          '<div class="cx-actions"><a class="cx-btn quiet" href="' + esc(mediaUrl(a, 'phone')) + '" target="_blank" rel="noopener">Open full size</a></div></div>' +
          '<figure class="cx-figure"><img src="' + esc(mediaUrl(a, 'phone')) + '" alt="' + esc(a.label || 'Image') + '"></figure></div>';
        return;
      }
    }
    W.setCrumb(title);
    var source = t.source === 'live' ? 'live' : t.source === 'archive' ? 'archive' : 'COS Glasses';
    var meta = [timeLabel(t.timestamp), source, modelOf(t), t.origin || ''].filter(Boolean).join(' · ');
    pane.innerHTML = '<div class="cx" data-tint="messages"><div class="cx-detail-head"><div><h2 class="cx-detail-title">' + esc(title) + '</h2>' +
      '<p class="cx-detail-meta">' + esc(meta) + '</p></div>' +
      '<div class="cx-actions"><button type="button" class="cx-btn quiet" data-msg="copy-turn" data-key="' + esc(key) + '">Copy turn</button></div></div>' +
      turnCards(t, key) + '</div>';
    pane.querySelectorAll('[data-hl]').forEach(function (el) { highlightIn(el, S.q.trim()); });
  }

  // ── archive day and chat ──────────────────────────────
  function renderDay(date) {
    W.setCrumb(date);
    pane.innerHTML = '<div class="cx">' + W.skeletonRows(4) + '</div>';
    loadDay(date).then(function (d) {
      if (!here(['day', date])) return;
      var chats = (d && d.chats) || [];
      var q = S.q.trim();
      var msgs = chats.reduce(function (n, c) { return n + (Number(c.exchangeCount) || 0); }, 0);
      var rows = chats.map(function (c, i) {
        var ex = c.exchanges || [];
        var m = q.length >= 2 ? chatMatches(ex, q) : { count: 0, snippet: '' };
        return { c: c, i: c.id != null ? c.id : i, topic: chatTopic(ex), m: m };
      });
      var hits = rows.filter(function (r) { return r.m.count > 0; }).length;
      var filtering = q.length >= 2 && hits > 0 && S.onlyMatches;
      var shown = filtering ? rows.filter(function (r) { return r.m.count > 0; }) : rows;
      var bar = q.length >= 2
        ? '<div class="cx-controls"><span class="cx-detail-meta">“' + esc(q) + '” · ' + hits + ' of ' + chats.length + ' ' + W.plural(chats.length, 'chat', 'chats') + '</span>' +
          (hits ? '<label class="cx-check"><input type="checkbox" data-msg="only"' + (S.onlyMatches ? ' checked' : '') + '> Only matches</label>' : '') + '</div>'
        : '';
      var body = !chats.length ? '<p class="cx-empty">No conversations were archived on ' + esc(date) + '.</p>'
        : !shown.length ? '<p class="cx-empty">No chat on this day contains “' + esc(q) + '”.</p>'
        : shown.map(function (r) {
          var started = toDate(r.c.startedAt);
          var line = 'Chat ' + (Number(r.i) + 1) + (started ? ' · ' + shortTime(started) : '') + ' · ' + (r.c.exchangeCount || (r.c.exchanges || []).length) + ' messages';
          return '<button type="button" class="cx-row" data-msg="chat" data-date="' + esc(date) + '" data-index="' + esc(r.i) + '">' +
            '<span class="cx-row-glyph"><svg class="icon"><use href="#i-messages"/></svg></span><span class="cx-row-body">' +
            '<span class="cx-row-title strong">' + esc(r.topic || r.c.summary || 'Untitled chat') + '</span>' +
            '<span class="cx-meta" style="margin-top:4px">' + (r.m.count ? '<span class="cx-cap ok">' + r.m.count + ' ' + W.plural(r.m.count, 'match', 'matches') + '</span>' : '') +
              '<span class="cx-time">' + esc(line) + '</span></span>' +
            (r.m.snippet ? '<span class="cx-row-sub three">' + esc(r.m.snippet) + '</span>' : r.c.summary ? '<span class="cx-row-sub">' + esc(r.c.summary) + '</span>' : '') +
            '</span><span class="chev"></span></button>';
        }).join('');
      pane.innerHTML = '<div class="cx" data-tint="messages"><div class="cx-detail-head"><div><h2 class="cx-detail-title">' + esc(date) + '</h2>' +
        '<p class="cx-detail-meta">' + esc(chats.length + ' ' + W.plural(chats.length, 'chat', 'chats') + ' · ' + msgs + ' ' + W.plural(msgs, 'message', 'messages')) + '</p></div></div>' +
        bar + '<div class="cx-list">' + body + '</div></div>';
    }, function (err) {
      if (!here(['day', date])) return;
      pane.innerHTML = err && err.status === 404 ? '<div class="cx"><div class="cx-notice warn">That day is no longer in the archive.</div></div>'
        : retryBox(err && err.message ? err.message : 'The day could not be read.');
    });
  }
  var find = { q: '', hits: [], at: 0 };
  function renderChat(date, index) {
    W.setCrumb(date + ' · chat ' + (Number(index) + 1));
    pane.innerHTML = '<div class="cx">' + W.skeletonRows(4) + '</div>';
    api('/api/archive/' + encodeURIComponent(date) + '/chats/' + encodeURIComponent(index) + '/messages').then(function (d) {
      if (!here(['day', date, String(index)])) return;
      var msgs = (d && d.messages) || [];
      find.q = S.q.trim();
      pane.innerHTML = '<div class="cx" data-tint="messages">' +
        '<div class="cx-find"><input class="field" type="search" id="msg-find" placeholder="Find in this chat" value="' + esc(find.q) + '" autocomplete="off" aria-label="Find in this chat">' +
        '<span class="cx-find-count" id="msg-find-count"></span>' +
        '<button type="button" data-msg="find-prev" aria-label="Previous match"><svg class="icon"><use href="#i-back"/></svg></button>' +
        '<button type="button" data-msg="find-next" aria-label="Next match"><svg class="icon"><use href="#i-chev"/></svg></button></div>' +
        '<div class="cx-detail-head"><div><h2 class="cx-detail-title">Chat ' + (Number(index) + 1) + '</h2>' +
        '<p class="cx-detail-meta">' + esc(date + ' · ' + msgs.length + ' ' + W.plural(msgs.length, 'message', 'messages')) + '</p></div></div>' +
        (msgs.length ? msgs.map(function (t, i) {
          var n = numOf(t);
          return '<section class="cx-turn" data-turn="' + i + '"><div class="cx-meta" style="margin:0 2px 8px"><span class="cx-num">' + (n != null ? 'Message #' + esc(n) : 'Message') + '</span>' +
            '<span class="cx-time">' + esc(timeLabel(t.timestamp)) + '</span><span class="cx-cap ok hidden" data-match-tag>match</span>' +
            '<button type="button" class="link-btn" style="min-height:0;font-size:13px;margin-left:auto" data-msg="copy-chat-turn" data-i="' + i + '">Copy turn</button></div>' +
            turnCards(t, 'chat-' + i) + '</section>';
        }).join('') : '<p class="cx-empty">That chat holds no messages.</p>') + '</div>';
      pane._chat = msgs;
      applyFind(true);
    }, function (err) {
      if (!here(['day', date, String(index)])) return;
      pane.innerHTML = err && err.status === 404 ? '<div class="cx"><p class="cx-empty">That chat is no longer in the archive.</p></div>'
        : retryBox(err && err.message ? err.message : 'The chat could not be read.');
    });
  }
  function applyFind(scroll) {
    var q = find.q.toLowerCase();
    var turns = Array.prototype.slice.call(pane.querySelectorAll('.cx-turn'));
    find.hits = [];
    turns.forEach(function (el, i) {
      var t = (pane._chat || [])[i] || {};
      var hit = q.length >= 2 && (String(t.query || '').toLowerCase().indexOf(q) >= 0 || String(t.text || '').toLowerCase().indexOf(q) >= 0);
      el.classList.toggle('match', hit);
      var tag = el.querySelector('[data-match-tag]'); if (tag) tag.classList.toggle('hidden', !hit);
      if (hit) find.hits.push(el);
    });
    var count = $('msg-find-count');
    if (count) count.textContent = q.length < 2 ? '' : find.hits.length ? (find.at + 1) + ' of ' + find.hits.length : 'no matches';
    if (scroll && find.hits.length) { find.at = Math.min(find.at, find.hits.length - 1); find.hits[find.at].scrollIntoView({ block: 'center' }); if (count) count.textContent = (find.at + 1) + ' of ' + find.hits.length; }
  }

  // ── render and route ──────────────────────────────────
  var current = [];
  // Whether Messages is still showing these arguments: a late answer never paints over
  // another pane, or over a different message, day or chat.
  function here(args) {
    var r = W.parseRoute();
    return r.pane === 'messages' && r.args.join('/') === (args || []).join('/');
  }
  function retryBox(text) {
    return '<div class="cx"><div class="cx-notice warn"><span>' + esc(text) + '</span></div><button type="button" class="cx-btn quiet" data-msg="retry">Try again</button></div>';
  }
  function render() {
    var a = current;
    if (W.parseRoute().pane !== 'messages') return;
    if (!a.length || a[0] === 'archive') return renderList();
    if (a[0] === 'm') return renderMessage(a[1], a[2] === 'a' ? a[3] : null);
  }
  function load(args) {
    current = args || [];
    if (!current.length || current[0] === 'archive') {
      S.view = current[0] === 'archive' ? 'archive' : 'recent';
      // Older than a minute: refetch quietly, with the rows still on screen (the rail's "Last
      // from the glasses" line refreshes too, and the two must not disagree).
      loadRecent(!!S.recent && Date.now() - (S.recentAt || 0) > 60000);
      if (S.view === 'archive') loadDays(false);
      renderList();
    } else if (current[0] === 'm') renderMessage(current[1], current[2] === 'a' ? current[3] : null);
    else if (current[0] === 'day' && current.length === 2) renderDay(current[1]);
    else if (current[0] === 'day' && current.length >= 3) renderChat(current[1], current[2]);
    else renderList();
  }

  pane.addEventListener('click', function (e) {
    var t = e.target.closest('[data-msg]');
    if (!t || t.tagName === 'INPUT') return;
    var act = t.getAttribute('data-msg');
    if (act === 'view') return W.go('messages', t.getAttribute('data-view') === 'archive' ? ['archive'] : []);
    if (act === 'refresh') { S.recentState = 'idle'; loadRecent(true); if (S.view === 'archive') { S.daysState = 'idle'; loadDays(true); } return; }
    if (act === 'clear') { S.q = ''; S.archiveRan = ''; S.archiveHits = null; return renderList(); }
    if (act === 'open') return W.go('messages', ['m', t.getAttribute('data-key')]);
    if (act === 'day') return W.go('messages', ['day', t.getAttribute('data-date')]);
    if (act === 'chat') return W.go('messages', ['day', t.getAttribute('data-date'), t.getAttribute('data-index')]);
    if (act === 'att') return W.go('messages', ['m', t.getAttribute('data-key'), 'a', t.getAttribute('data-att')]);
    if (act === 'att-open') { window.open(t.getAttribute('data-href'), '_blank', 'noopener'); return; }
    if (act === 'retry') { if (S.recentState === 'error') { S.recentState = 'idle'; S.recent = null; } return load(current); }
    if (act === 'handoff') {
      var list = (S.recent || []).slice().reverse();
      var nd = new Date(), day = S.recentDate || (nd.getFullYear() + '-' + String(nd.getMonth() + 1).padStart(2, '0') + '-' + String(nd.getDate()).padStart(2, '0'));
      var lines = ['COS Glasses handoff · ' + day + ' · last ' + list.length + ' turns', 'Continue from this context. Global msg numbers refer to glasses history.', ''];
      list.forEach(function (turn) { lines.push(copyTurnText(turn)); lines.push(''); });
      W.copyText(lines.join('\n')).then(function () { W.toast('Copied'); }, function (err) { W.toast(err.message); });
      return;
    }
    if (act === 'copy-turn') { var turn = findRecent(t.getAttribute('data-key')); if (turn) W.copyText(copyTurnText(turn)).then(function () { W.toast('Copied'); }, function (err) { W.toast(err.message); }); return; }
    if (act === 'copy-chat-turn') { var ct = (pane._chat || [])[Number(t.getAttribute('data-i'))]; if (ct) W.copyText(copyTurnText(ct)).then(function () { W.toast('Copied'); }, function (err) { W.toast(err.message); }); return; }
    if (act === 'find-next' || act === 'find-prev') {
      if (!find.hits.length) return;
      find.at = (find.at + (act === 'find-next' ? 1 : -1) + find.hits.length) % find.hits.length;
      applyFind(true);
    }
  });
  pane.addEventListener('change', function (e) {
    if (e.target.matches('[data-msg="only"]')) { S.onlyMatches = e.target.checked; renderDay(current[1]); }
  });
  pane.addEventListener('input', function (e) {
    if (e.target.id === 'msg-q') {
      S.q = e.target.value;
      clearTimeout(pane._t);
      pane._t = setTimeout(renderList, 120);
    } else if (e.target.id === 'msg-find') {
      find.q = e.target.value.trim(); find.at = 0; applyFind(true);
    }
  });
  pane.addEventListener('submit', function (e) {
    if (!e.target.matches('[data-msg-form="search"]')) return;
    e.preventDefault();
    S.q = ($('msg-q') || {}).value || S.q;
    if (S.q.trim().length >= 2) {
      if (S.view !== 'archive') { W.go('messages', ['archive']); }
      runArchiveSearch();
    }
  });

  W.registerPane('messages', {
    load: load,
    // Keeps the rows on screen while the new window loads (emptying it moved the page).
    refresh: function () { S.recentState = 'idle'; loadRecent(true); },
    // Back unwinds one step: a chat goes to its day, a day to the archive list, an image to its message.
    up: function (args) {
      if (args[0] === 'day' && args.length >= 3) return ['day', args[1]];
      if (args[0] === 'day') return ['archive'];
      if (args[0] === 'm' && args[2] === 'a') return ['m', args[1]];
      return null;
    }
  });
})();
