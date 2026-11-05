/* COS Control Web: the pinned COS chat (Drop it plan sections 1 and 12, server 6.99.10).
   Lives inside Messages: the pinned row is the first row of Recent (#/messages), the chat is #/messages/cos, and from
   860 px the two sit side by side. Everything here is gated on capabilities.dropIt.enabled from /api/health; with it
   off, Messages renders exactly as before and this module draws nothing.

   The composer has two visible buttons, so a phone with no keyboard needs no key combination and no long press:
   - Ask (filled): POST /api/query-jobs with source 'web', the glasses' own route. The server picks the conversation and
     mints the message number, so the answer is a normal Messages turn (Recent on the Mac and here, and the lens list).
     Steer and Cancel are the existing query-job routes. The Model menu lists what meeting Ask offers.
   - Drop (outlined): POST /api/drops, then the receipt with Undo and Move. A drop the server reads as a question runs
     the Ask the same way and is linked back (POST /api/drops/:id/ask), as COS Control does.
   With a keyboard, Return asks and Option-Return drops; Shift-Return is a new line.

   The rail badge on Messages is a number for `waiting` (GET /api/inbox/summary) and a dot for unread only. It is read
   with the shell's existing status read (shell.js checkServer), never on a timer of its own, and painting it touches
   only the badge, never the pane. */
(function () {
  'use strict';
  var W = window.COSWeb;
  var $ = W.$, esc = W.esc, api = W.api;
  var STORE = 'cos.web.cosChat';

  var C = {
    caps: null,             // null until /api/health is read: { dropIt, jobs, steer }
    capsLoading: null,
    summary: null,          // { unread, waiting, lastLine, lastAt }
    items: null,            // the chat, oldest first
    feedState: 'idle',      // idle | loading | ready | error
    feedError: '',
    asks: [],               // web Asks from this page: { cid, jobId, query, at, status, partial, response, no, sessionId, error, dropId, steering }
    draft: '',
    busy: '',               // '' | 'ask' | 'drop'
    note: '',               // one line under the composer (a refusal, a failure)
    moving: '',             // the feed item whose Move list is open
    models: null,           // [{ value, label, available }]
    host: null,
    onChange: null,         // messages.js: re-render when Drop it turns on or off
    onAnswered: null        // messages.js: re-read Recent when a web Ask lands
  };
  var saved = W.readStore(STORE);
  C.model = typeof saved.model === 'string' ? saved.model : '';

  // ── small helpers ─────────────────────────────────────
  function uuid() {
    // crypto.randomUUID needs a secure context; a plain-http tailnet page is not one.
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function save() { W.writeStore(STORE, { model: C.model, session: C.session || null }); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  // A web Ask continues the conversation it started today; a new day starts a new one.
  C.session = saved.session && saved.session.day === today() ? saved.session : null;
  function wide() { return window.matchMedia('(min-width: 860px)').matches; }
  function keyboardFirst() { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; }
  function timeLabel(v) {
    var d = W.toDate(v); if (!d) return '';
    var now = new Date();
    var same = d.toDateString() === now.toDateString();
    var t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return same ? t : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + t;
  }
  function clip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
  var SOURCE = { web: 'Typed on the web', mac: 'Typed on the Mac', g2: 'Said on the glasses', telegram: 'From Telegram' };
  var MARK = '<svg class="icon" aria-hidden="true"><use href="#i-mark"/></svg>';

  // ── capabilities and the rail badge ───────────────────
  function on() { return !!(C.caps && C.caps.dropIt); }
  function setCaps(h) {
    var caps = (h && h.capabilities) || {};
    var drop = caps.dropIt;
    var next = {
      dropIt: !!(drop && drop.enabled === true),
      jobs: caps.durableQueryJobs === true || h && h.durableQueryJobs === true || !!(caps.durableQueryJobs && caps.durableQueryJobs.enabled),
      steer: !!(C.caps && C.caps.steer)
    };
    var changed = !C.caps || C.caps.dropIt !== next.dropIt;
    C.caps = next;
    if (!next.dropIt) { clearRail(); C.summary = null; }
    if (changed && C.onChange) C.onChange();
    if (next.dropIt) refreshSummary();
  }
  // The shell's status read (shell.js checkServer) hands its /api/health answer here.
  function fromHealth(h) { setCaps(h); }
  function ensureCaps() {
    if (C.caps) return Promise.resolve(C.caps);
    if (!C.capsLoading) C.capsLoading = api('/api/health').then(function (h) { setCaps(h); return C.caps; }, function () { C.capsLoading = null; return null; });
    return C.capsLoading;
  }
  function refreshSummary() {
    if (!on()) return Promise.resolve(null);
    return api('/api/inbox/summary').then(function (s) {
      C.summary = s; paintRail(); paintPin(); return s;
    }, function (err) {
      // Drop it turned off since the last health read: the route answers drop_it_off.
      if (err && err.code === 'drop_it_off') { C.caps.dropIt = false; clearRail(); if (C.onChange) C.onChange(); }
      return null;
    });
  }
  function waitingOf(s) { var n = s && Number(s.waiting); return Number.isInteger(n) && n > 0 ? n : 0; }
  function unreadOf(s) { var n = s && Number(s.unread); return Number.isInteger(n) && n > 0 ? n : 0; }
  // A number for what waits on you, a dot for unread only. Created on first paint, so with Drop it off the rail's DOM
  // is untouched.
  function paintRail() {
    var waiting = waitingOf(C.summary), unread = unreadOf(C.summary);
    document.querySelectorAll('.rail-btn[data-pane="messages"], #section-menu [data-goto="messages"]').forEach(function (b) {
      var count = b.querySelector('[data-inbox-count]');
      if (!count) {
        count = document.createElement('span'); count.className = 'inbox-count hidden'; count.setAttribute('data-inbox-count', '');
        var dot = document.createElement('span'); dot.className = 'inbox-dot hidden'; dot.setAttribute('data-inbox-dot', '');
        b.appendChild(count); b.appendChild(dot);
      }
      count.textContent = waiting > 99 ? '99+' : String(waiting);
      count.classList.toggle('hidden', !waiting);
      b.querySelector('[data-inbox-dot]').classList.toggle('hidden', !(unread && !waiting));
      var label = waiting ? waiting + ' waiting on you' : unread ? unread + ' new in COS' : '';
      b.setAttribute('aria-label', 'Messages' + (label ? ', ' + label : ''));
    });
  }
  function clearRail() {
    document.querySelectorAll('[data-inbox-count],[data-inbox-dot]').forEach(function (el) { el.classList.add('hidden'); });
    document.querySelectorAll('.rail-btn[data-pane="messages"], #section-menu [data-goto="messages"]').forEach(function (b) {
      if (b.querySelector('[data-inbox-count]')) b.setAttribute('aria-label', 'Messages');
    });
  }

  // ── the pinned row (first in Recent) ──────────────────
  function pinStatus() {
    var s = C.summary, w = waitingOf(s), u = unreadOf(s);
    return [w ? w + ' waiting' : '', u ? u + ' new' : ''].filter(Boolean).join(' · ');
  }
  function pinnedRowHtml(selected) {
    var s = C.summary;
    var line = s && s.lastLine ? s.lastLine : 'Text it anything: a thought, an ask, a reminder. It texts back.';
    var status = pinStatus();
    return '<button type="button" class="cx-row cc-pin" data-msg="cos"' + (selected ? ' aria-current="true"' : '') + '>' +
      '<span class="cx-row-glyph cc-pin-glyph">' + MARK + '</span>' +
      '<span class="cx-row-body"><span class="cx-meta"><span class="cx-num">COS</span>' +
        '<span class="cc-pinned">Pinned</span>' +
        '<span class="cx-time" data-cos-pin-time>' + esc(s && s.lastAt ? timeLabel(s.lastAt) : '') + '</span>' +
        '<span class="cc-pin-status' + (waitingOf(s) ? ' hot' : '') + '" data-cos-pin-status>' + esc(status) + '</span></span>' +
        '<span class="cx-row-title" data-cos-pin-line>' + esc(line) + '</span></span><span class="chev"></span></button>';
  }
  // Updates the row's words in place: the list around it is never rebuilt for a badge.
  function paintPin() {
    var s = C.summary;
    document.querySelectorAll('[data-cos-pin-status]').forEach(function (el) { el.textContent = pinStatus(); el.classList.toggle('hot', !!waitingOf(s)); });
    document.querySelectorAll('[data-cos-pin-time]').forEach(function (el) { el.textContent = s && s.lastAt ? timeLabel(s.lastAt) : ''; });
    if (s && s.lastLine) document.querySelectorAll('[data-cos-pin-line]').forEach(function (el) { el.textContent = s.lastLine; });
  }

  // ── models (the meeting Ask list, as Ask preferences) ──
  var CLAUDE = { opus: 'Claude Opus', sonnet: 'Claude Sonnet', haiku: 'Claude Haiku', fable: 'Claude Fable' };
  function loadModels() {
    if (C.models) return;
    C.models = [];
    api('/api/meeting-ask/config').then(function (conf) {
      var out = [], seen = {};
      ((conf && conf.models) || []).forEach(function (m) {
        if (!m || !m.engine) return;
        var value = m.engine === 'claude' && CLAUDE[m.model] ? m.model : m.engine === 'codex' ? 'codex-frontier' : '';
        if (!value || seen[value]) return;
        seen[value] = 1;
        out.push({ value: value, label: value === 'codex-frontier' ? 'Codex' : CLAUDE[value], available: m.available !== false });
      });
      C.models = out;
      if (!C.model && conf && conf.selected) {
        var sel = conf.selected, pick = sel.engine === 'claude' && CLAUDE[sel.model] ? sel.model : sel.engine === 'codex' ? 'codex-frontier' : '';
        if (pick && out.some(function (o) { return o.value === pick && o.available; })) C.model = pick;
      }
      paintModelMenu();
    }, function () { C.models = []; paintModelMenu(); });
    // Steer exists only where the server says so (/api/models capabilities.durableQueryJobs.steer).
    api('/api/models').then(function (m) {
      var j = m && m.capabilities && m.capabilities.durableQueryJobs;
      if (C.caps) C.caps.steer = !!(j && j.steer);
    }, function () {});
  }
  function modelMenuHtml() {
    var list = C.models || [];
    var opts = ['<option value="">Default</option>'].concat(list.map(function (m) {
      return '<option value="' + esc(m.value) + '"' + (m.value === C.model ? ' selected' : '') + (m.available ? '' : ' disabled') + '>' + esc(m.label + (m.available ? '' : ' (not available)')) + '</option>';
    }));
    return '<label class="cc-model"><span>Model</span><select class="field" data-cos-model aria-label="Model for Ask">' + opts.join('') + '</select></label>';
  }
  function paintModelMenu() {
    var slot = C.host && C.host.querySelector('[data-cos-model-slot]');
    // An open menu is never rebuilt under the finger (it would close the iOS picker).
    if (!slot || (document.activeElement && slot.contains(document.activeElement))) return;
    slot.innerHTML = modelMenuHtml();
  }

  // ── the chat ──────────────────────────────────────────
  function chatSkeleton() {
    var hint = keyboardFirst() ? 'Return asks. Option-Return drops. Shift-Return starts a new line.' : 'Ask gets an answer from COS. Drop files it.';
    return '<section class="cc" data-cos-chat data-tint="messages" aria-label="COS chat">' +
      '<header class="cc-head"><span class="cc-avatar big">' + MARK + '</span><div class="cc-head-text"><h2 class="cc-title">COS</h2>' +
        '<p class="cc-sub">Text it anything: a thought, an ask, a reminder. It texts back.</p></div>' +
        '<div class="cc-head-acts"><button type="button" class="link-btn cc-all" data-cos="all">All messages</button>' +
        '<button type="button" class="link-btn" data-cos="read-all">Mark all read</button></div></header>' +
      '<div class="cc-feed" data-cos-feed aria-live="polite"></div>' +
      '<form class="cc-composer" data-cos-form autocomplete="off">' +
        '<textarea class="field cc-input" id="cos-input" rows="1" maxlength="2000" placeholder="Ask COS, or drop a thought, a task, a reminder" aria-label="Message to COS"></textarea>' +
        '<div class="cc-buttons"><button type="button" class="cx-btn primary cc-ask" data-cos="ask">Ask</button>' +
          '<button type="button" class="cx-btn cc-drop" data-cos="drop">Drop</button></div>' +
        '<div class="cc-foot"><span data-cos-model-slot></span><span class="cc-hint">' + esc(hint) + ' A drop never sends anything to anyone.</span></div>' +
        '<p class="cc-note hidden" data-cos-note role="status"></p>' +
      '</form></section>';
  }
  function mount(host, visible) {
    if (!host) return;
    C.host = host;
    if (!host.querySelector('[data-cos-chat]')) {
      host.innerHTML = chatSkeleton();
      var input = $('cos-input');
      if (input) { input.value = C.draft; W.autoGrow(input); }
      paintButtons();
      paintModelMenu();
    }
    if (!visible) return;
    loadModels();
    if (C.items === null || C.feedState === 'error') loadFeed(); else paintFeed(true);
  }
  function chatVisible() { var el = C.host && C.host.querySelector('[data-cos-chat]'); return !!(el && el.offsetParent !== null); }

  function loadFeed() {
    if (C.feedState === 'loading') return;
    C.feedState = 'loading';
    if (C.items === null) paintFeed(false);
    api('/api/inbox/feed?limit=100').then(function (d) {
      C.items = (d && d.items) || [];
      C.feedState = 'ready';
      paintFeed(true);
      markReadIfShown();
    }, function (err) {
      C.feedState = 'error';
      C.feedError = err && err.code === 'drop_it_off' ? 'Drop it is off on this Mac.' : 'The chat could not be read. Check that the Mac is awake, then try again.';
      paintFeed(false);
    });
  }
  function mergeItems(list) {
    if (!Array.isArray(list)) return;
    if (!C.items) C.items = [];
    list.forEach(function (it) {
      var i = -1;
      for (var k = 0; k < C.items.length; k++) if (C.items[k].id === it.id) { i = k; break; }
      if (i >= 0) C.items[i] = it; else C.items.push(it);
    });
    C.items.sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
  }
  function markReadIfShown(force) {
    if (!chatVisible() || !C.items || !C.items.length) return;
    if (!force && C.summary && !unreadOf(C.summary)) return;
    var last = C.items[C.items.length - 1];
    api('/api/inbox/read', { method: 'POST', body: { through: last.id } }).then(function (r) {
      if (C.summary) { C.summary.unread = r.unread; if (typeof r.waiting === 'number') C.summary.waiting = r.waiting; }
      paintRail(); paintPin();
    }, function () {});
  }

  // One feed item as a chat line: Miles's words on the right, COS on the left.
  var PRIMARY = { open_card: 1, open_thread: 1, open_memory: 1, open_session: 1, open_messages: 1 };
  function actionsHtml(item) {
    if (item.state !== 'live') return '';
    var acts = (item.actions || []).filter(function (a) { return a.id !== 'send_to_session'; });
    var choices = acts.filter(function (a) { return /^choose:/.test(a.id); });
    var html = '';
    if (choices.length) {
      html += '<ol class="cc-choices">' + choices.map(function (a, i) {
        return '<li><button type="button" class="cc-choice" data-cos="act" data-item="' + esc(item.id) + '" data-act="' + esc(a.id) + '"><span class="cc-choice-n">' + (i + 1) + '</span>' + esc(a.label) + '</button></li>';
      }).join('') + '</ol>';
    }
    var rest = acts.filter(function (a) { return !/^choose:/.test(a.id); });
    if (item.needsReply) rest.push({ id: 'dismiss', label: 'Dismiss' });
    if (rest.length) {
      html += '<div class="cc-acts">' + rest.map(function (a) {
        var cls = PRIMARY[a.id] ? 'cx-btn primary' : 'link-btn cc-text-btn';
        return '<button type="button" class="' + cls + '" data-cos="act" data-item="' + esc(item.id) + '" data-act="' + esc(a.id) + '">' + esc(a.label) + '</button>';
      }).join('') + '</div>';
    }
    if ((item.actions || []).some(function (a) { return a.id === 'send_to_session'; })) html += '<p class="cc-fine">Send it to the session from COS Control on your Mac.</p>';
    if (C.moving === item.id) html += moveHtml(item);
    return html;
  }
  function dropOf(item) {
    for (var i = 0; i < (C.items || []).length; i++) if (C.items[i].threadId === item.threadId && C.items[i].kind === 'drop') return C.items[i];
    return null;
  }
  function moveHtml(item) {
    var opts = [{ dest: 'note', label: 'Just a note' }, { dest: 'memory', label: 'A memory' }, { dest: 'reminder', label: 'A reminder' }];
    (item.links || []).forEach(function (l) { if (l.kind === 'card' && l.domain) opts.unshift({ dest: 'new_card', label: 'A new card in ' + l.domain, domain: l.domain }); });
    return '<div class="cc-move" role="group" aria-label="Move it to"><p class="cc-fine">Move it to</p>' + opts.map(function (o) {
      return '<button type="button" class="cc-choice" data-cos="move-to" data-item="' + esc(item.id) + '" data-dest="' + o.dest + '"' + (o.domain ? ' data-domain="' + esc(o.domain) + '"' : '') + '>' + esc(o.label) + '</button>';
    }).join('') + '<button type="button" class="link-btn cc-text-btn" data-cos="move-cancel">Keep it where it is</button></div>';
  }
  function itemHtml(item) {
    if (item.kind === 'drop' || item.kind === 'answer') {
      return '<div class="cc-line you' + (item.kind === 'answer' ? ' answer' : '') + '"' + (item.kind === 'drop' ? ' data-drop-thread="' + esc(item.threadId) + '"' : '') + '><div class="cc-bubble">' + esc(item.line) + '</div>' +
        (item.kind === 'drop' ? '<div class="cc-src">' + esc(SOURCE[item.source] || '') + '</div>' : '') + '</div>';
    }
    var quote = item.kind === 'followup' ? (function () { var d = dropOf(item); return d ? '<button type="button" class="cc-quote" data-cos="quote" data-thread="' + esc(item.threadId) + '">Re: ' + esc(clip(d.line, 70)) + '</button>' : ''; })() : '';
    return '<div class="cc-line cos' + (item.state !== 'live' ? ' done' : '') + (item.needsReply && item.state === 'live' ? ' waits' : '') + '" data-item-id="' + esc(item.id) + '">' +
      '<span class="cc-avatar">' + MARK + '</span><div class="cc-card">' + quote +
      (item.title ? '<p class="cc-card-title">' + esc(item.title) + '</p>' : '') +
      '<p class="cc-card-line">' + esc(item.line) + '</p>' + actionsHtml(item) + '</div></div>';
  }
  // The finished answer as Markdown; while it streams, plain words, so a half-written "**bold" never shows its stars.
  function answerHtml(a) {
    if (a.response) return W.md(a.response);
    if (!a.partial) return '';
    return '<p>' + esc(a.partial.replace(/\*\*|__|`|^#+\s*/gm, '')).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
  }
  function askHtml(a, linked) {
    var running = a.status === 'sending' || a.status === 'queued' || a.status === 'running';
    var title = a.no ? 'Message #' + a.no : 'Asking COS';
    var state = a.status === 'completed' ? 'Answered' : a.status === 'canceled' ? 'Canceled' : a.status === 'failed' || a.status === 'interrupted' ? 'Did not finish' : a.status === 'sending' ? 'Sending' : 'Answering';
    var body = answerHtml(a);
    var acts = '';
    if (running && a.jobId) {
      acts = (C.caps && C.caps.steer && a.steerable !== false ? '<button type="button" class="link-btn cc-text-btn" data-cos="steer" data-cid="' + a.cid + '">Steer</button>' : '') +
        '<button type="button" class="link-btn cc-text-btn" data-cos="cancel" data-cid="' + a.cid + '">Cancel</button>';
    } else if (a.status === 'completed' && a.no) {
      acts = '<button type="button" class="cx-btn primary" data-cos="open-msg" data-no="' + a.no + '">Open in Messages</button>';
    }
    // A drop that became a question already shows its words as the drop: only the answer card is added.
    return (linked ? '' : '<div class="cc-line you"><div class="cc-bubble">' + esc(a.query) + '</div><div class="cc-src">Asked on the web</div></div>') +
      '<div class="cc-line cos" data-ask="' + a.cid + '"><span class="cc-avatar">' + MARK + '</span><div class="cc-card">' +
      '<p class="cc-card-title"><span data-ask-title>' + esc(title) + '</span><span class="cx-time" data-ask-state>' + esc(state) + '</span></p>' +
      '<div class="cc-answer md" data-ask-body>' + (body || '<span class="cc-wait">COS is answering. It also lands in Messages on the glasses.</span>') + '</div>' +
      (a.error ? '<p class="cc-fine warn">' + esc(a.error) + '</p>' : '') +
      '<div class="cc-acts" data-ask-acts>' + acts + '</div>' +
      (a.steering ? '<form class="cc-steer" data-cos-steer="' + a.cid + '"><input class="field" type="text" maxlength="2000" placeholder="Steer the answer" aria-label="Steer the answer"><button type="submit" class="cx-btn">Send</button></form>' : '') +
      '</div></div>';
  }
  function paintFeed(stick) {
    var feed = C.host && C.host.querySelector('[data-cos-feed]');
    if (!feed) return;
    // Never rebuild under the finger: a focused steer box or an open Move list keeps the lines as they are.
    if (document.activeElement && feed.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    var html;
    if (C.items === null && C.feedState !== 'error') html = W.skeletonRows(3);
    else if (C.feedState === 'error' && C.items === null) html = '<div class="cx-notice warn"><span>' + esc(C.feedError) + '</span></div><button type="button" class="cx-btn quiet" data-cos="retry">Try again</button>';
    else {
      var rows = (C.items || []).map(function (it) { return { at: it.createdAt, html: itemHtml(it) }; });
      C.asks.forEach(function (a) { rows.push({ at: new Date(a.at + (a.dropId ? 1 : 0)).toISOString(), html: askHtml(a, !!a.dropId) }); });
      rows.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
      html = rows.length ? rows.map(function (r) { return r.html; }).join('') : '<p class="cc-empty">Nothing here yet. Ask COS something, or drop a thought and COS files it.</p>';
    }
    var scroller = scrollerOf(feed);
    var atBottom = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80 : true;
    feed.innerHTML = html;
    if (stick || atBottom) scrollToEnd(feed);
  }
  // From 860 px the chat column scrolls by itself; on a phone the page does.
  function scrollerOf(feed) { return wide() ? feed : document.scrollingElement; }
  function scrollToEnd(feed) {
    if (wide()) feed.scrollTop = feed.scrollHeight;
    else if (W.parseRoute().args[0] === 'cos') window.scrollTo(0, document.body.scrollHeight);
  }
  // A running Ask updates its own card in place, so a poll never rebuilds the chat.
  function paintAsk(a) {
    var el = C.host && C.host.querySelector('[data-ask="' + a.cid + '"]');
    if (!el) return paintFeed(false);
    var running = a.status === 'sending' || a.status === 'queued' || a.status === 'running';
    var title = el.querySelector('[data-ask-title]'); if (title) title.textContent = a.no ? 'Message #' + a.no : 'Asking COS';
    var st = el.querySelector('[data-ask-state]'); if (st) st.textContent = a.status === 'completed' ? 'Answered' : a.status === 'canceled' ? 'Canceled' : a.status === 'failed' || a.status === 'interrupted' ? 'Did not finish' : 'Answering';
    var body = el.querySelector('[data-ask-body]'); var text = a.response || a.partial;
    if (body && text && body.getAttribute('data-len') !== String(text.length) + (a.response ? 'r' : '')) { body.innerHTML = answerHtml(a); body.setAttribute('data-len', String(text.length) + (a.response ? 'r' : '')); }
    if (!running) paintFeed(false);
  }

  function paintButtons() {
    var input = $('cos-input'); var text = input ? input.value.trim() : '';
    var ask = C.host && C.host.querySelector('[data-cos="ask"]'), drop = C.host && C.host.querySelector('[data-cos="drop"]');
    var jobs = !C.caps || C.caps.jobs;
    if (ask) { ask.disabled = !text || !!C.busy || !jobs; ask.textContent = C.busy === 'ask' ? 'Asking…' : 'Ask'; }
    if (drop) { drop.disabled = !text || !!C.busy; drop.textContent = C.busy === 'drop' ? 'Dropping…' : 'Drop'; }
    if (!jobs) setNote('Ask needs the durable query jobs switch on your Mac. Drop still works.');
  }
  function setNote(text) {
    var el = C.host && C.host.querySelector('[data-cos-note]');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
  }

  // ── Drop ──────────────────────────────────────────────
  function doDrop() {
    var input = $('cos-input'); var text = input ? input.value.trim() : '';
    if (!text || C.busy) return;
    var dropId = uuid();
    C.busy = 'drop'; setNote(''); paintButtons();
    var send = function (retry) {
      return api('/api/drops', { method: 'POST', body: { dropId: dropId, text: text, source: 'web' }, timeoutMs: 30000 }).catch(function (err) {
        // The same dropId is safe to send again: the server answers the first result.
        if (retry && err && err.code === 'timeout') return send(false);
        throw err;
      });
    };
    send(true).then(function (ans) {
      C.busy = ''; C.draft = '';
      var box = $('cos-input'); if (box) { box.value = ''; W.autoGrow(box); }
      mergeItems(ans.items);
      paintFeed(true); paintButtons();
      if (ans.next && ans.next.kind === 'ask' && C.caps && C.caps.jobs) submitAsk(ans.next.prompt, ans.drop.id);
      refreshSummary();
    }, function (err) {
      C.busy = ''; paintButtons();
      // The words stay in the box until the server has them.
      setNote(err && err.code === 'drop_it_off' ? 'Drop it is off on this Mac.' : 'Not dropped: ' + ((err && err.message) || 'the Mac did not answer') + ' Your words are still here.');
    });
  }

  // ── Ask ───────────────────────────────────────────────
  function doAsk() {
    var input = $('cos-input'); var text = input ? input.value.trim() : '';
    if (!text || C.busy) return;
    C.busy = 'ask'; setNote(''); paintButtons();
    submitAsk(text, null, function (ok) {
      C.busy = '';
      if (ok) { C.draft = ''; var box = $('cos-input'); if (box) { box.value = ''; W.autoGrow(box); } }
      paintButtons();
    });
  }
  function submitAsk(text, dropId, done) {
    var a = { cid: uuid(), query: text, at: Date.now(), status: 'sending', partial: '', dropId: dropId || '' };
    C.asks.push(a);
    paintFeed(true);
    var body = { clientJobId: a.cid, generation: 1, query: text, source: 'web', activityToolMode: 'status' };
    if (C.model) body.model = C.model;
    if (C.session && C.session.id) body.sessionId = C.session.id;
    if (C.caps && C.caps.steer) body.steerable = true;
    var admit = function (retry) {
      return api('/api/query-jobs', { method: 'POST', body: body, timeoutMs: 30000 }).catch(function (err) {
        // A lost answer: the job may exist. Ask for it by its client id before saying anything failed.
        if (err && err.code === 'timeout') {
          return api('/api/query-jobs/by-client/' + a.cid + '?generation=1').catch(function () { if (retry) return admit(false); throw err; });
        }
        throw err;
      });
    };
    admit(true).then(function (d) {
      var job = d && d.job; if (!job) throw new Error('The Mac did not take the question.');
      take(a, job);
      if (job.sessionId) { C.session = { id: job.sessionId, day: today() }; save(); }
      if (dropId) api('/api/drops/' + encodeURIComponent(dropId) + '/ask', { method: 'POST', body: { clientJobId: a.cid, generation: 1 } }).catch(function () {});
      if (done) done(true);
      poll(a);
    }, function (err) {
      a.status = 'failed';
      a.error = err && err.code === 'durable_query_jobs_disabled' ? 'Ask needs the durable query jobs switch on your Mac.' : 'Not sent: ' + ((err && err.message) || 'the Mac did not answer');
      paintFeed(false);
      if (done) done(false);
    });
  }
  function take(a, job) {
    a.jobId = job.jobId; a.status = job.status || a.status;
    if (job.globalMsgNum) a.no = job.globalMsgNum;
    if (typeof job.partialText === 'string') a.partial = job.partialText;
    if (typeof job.response === 'string') a.response = job.response;
    if (job.steerable === false) a.steerable = false;
    if (job.error && (a.status === 'failed' || a.status === 'interrupted')) a.error = 'COS could not finish this answer. Ask again when you are ready.';
  }
  function poll(a) {
    var started = Date.now();
    var tick = function () {
      if (!a.jobId) return;
      api('/api/query-jobs/' + a.jobId + '?generation=1').then(function (d) {
        if (d && d.job) take(a, d.job);
        paintAsk(a);
        if (['completed', 'failed', 'canceled', 'interrupted'].indexOf(a.status) >= 0) return finished(a);
        if (Date.now() - started < 20 * 60000) setTimeout(tick, document.hidden ? 4000 : 1000);
      }, function () { if (Date.now() - started < 20 * 60000) setTimeout(tick, 3000); });
    };
    setTimeout(tick, 600);
  }
  function finished(a) {
    paintFeed(false);
    if (C.onAnswered) C.onAnswered();
    // A drop that became a question gets its answer as a follow-up: read the chat again.
    if (a.dropId) { C.asks = C.asks.filter(function (x) { return x !== a; }); setTimeout(function () { loadFeedQuietly(); }, 300); }
    refreshSummary();
  }
  function loadFeedQuietly() {
    api('/api/inbox/feed?limit=100').then(function (d) { C.items = (d && d.items) || []; paintFeed(false); markReadIfShown(); }, function () {});
  }

  // ── actions on a line ─────────────────────────────────
  function act(itemId, action) {
    var item = (C.items || []).filter(function (i) { return i.id === itemId; })[0];
    if (!item) return;
    if (action === 'move') { C.moving = C.moving === itemId ? '' : itemId; return paintFeed(false); }
    if (action === 'open_card') return W.go('work');
    if (action === 'open_thread') return W.go('threads');
    if (action === 'open_memory') return W.go('memories');
    if (action === 'open_session') return W.go('sessions');
    if (action === 'open_messages') return W.go('messages');
    // P2 (6.99.11): pings and follow-ups. Opens go where the item's link lives; Prep asks COS; Reply starts a reminder.
    var linkOf = function (kind) { return (item.links || []).filter(function (l) { return l.kind === kind; })[0]; };
    if (action === 'open_result') return W.go(linkOf('session') ? 'sessions' : linkOf('card') ? 'work' : 'messages');
    if (action === 'open') { if (linkOf('thread')) return W.go('threads'); if (linkOf('meeting')) return W.go('meetings'); return; }
    if (action === 'review') return W.go('work');
    if (action === 'prep') { if (C.caps && C.caps.jobs) submitAsk('Prep me for ' + (item.title || 'my next meeting'), ''); return; }
    if (action === 'reply') {
      var box = document.getElementById('cos-input');
      if (box) { box.value = 'remind me '; box.focus(); }
      return;
    }
    var P2_POST = { reminder_done: 1, snooze_1h: 1, snooze_tomorrow: 1 };
    var body = action === 'undo' || action === 'dismiss' || /^choose:/.test(action) || /^when:/.test(action) || P2_POST[action] ? { itemId: itemId, action: action } : null;
    if (!body) return;
    api('/api/inbox/action', { method: 'POST', body: body }).then(function (ans) {
      if (ans && ans.items) mergeItems(ans.items);
      if (ans && ans.item) mergeItems([ans.item]);
      // A reminder action answers the finished item itself (merged above); dismiss answers counts only.
      if (action === 'dismiss') item.state = 'done';
      if (ans && ans.next && ans.next.kind === 'ask' && C.caps && C.caps.jobs) submitAsk(ans.next.prompt, ans.drop.id);
      paintFeed(false); refreshSummary();
    }, function (err) { W.toast((err && err.message) || 'That did not go through.'); });
  }
  function moveTo(itemId, dest, domain) {
    var item = (C.items || []).filter(function (i) { return i.id === itemId; })[0];
    if (!item) return;
    var body = { dest: dest };
    if (dest === 'new_card' && domain) body.target = { id: domain, label: domain, domain: domain };
    api('/api/drops/' + encodeURIComponent(item.threadId) + '/move', { method: 'POST', body: body }).then(function (ans) {
      C.moving = '';
      mergeItems(ans.items); loadFeedQuietly(); refreshSummary();
    }, function (err) { W.toast((err && err.message) || 'That could not be moved.'); });
  }
  function steer(cid, text) {
    var a = C.asks.filter(function (x) { return x.cid === cid; })[0];
    if (!a || !a.jobId || !text.trim()) return;
    a.steering = false;
    api('/api/query-jobs/' + a.jobId + '/steer', { method: 'POST', body: { generation: 1, steerId: uuid(), text: text.trim() } }).then(function (r) {
      W.toast(r && r.state === 'accepted' ? 'COS has it.' : 'Too late to steer this one.');
    }, function (err) { W.toast((err && err.message) || 'The steer did not go through.'); });
    paintFeed(false);
  }
  function cancel(cid) {
    var a = C.asks.filter(function (x) { return x.cid === cid; })[0];
    if (!a || !a.jobId) return;
    api('/api/query-jobs/' + a.jobId + '/cancel', { method: 'POST', body: { generation: 1 } }).then(function (d) { if (d && d.job) take(a, d.job); paintAsk(a); }, function (err) { W.toast((err && err.message) || 'Cancel did not go through.'); });
  }

  // ── events (delegated from the Messages pane) ─────────
  function onClick(t) {
    var what = t.getAttribute('data-cos');
    if (what === 'ask') return doAsk();
    if (what === 'drop') return doDrop();
    if (what === 'all') return W.go('messages');
    if (what === 'read-all') return markReadIfShown(true);
    if (what === 'retry') { C.feedState = 'idle'; return loadFeed(); }
    if (what === 'act') return act(t.getAttribute('data-item'), t.getAttribute('data-act'));
    if (what === 'move-to') return moveTo(t.getAttribute('data-item'), t.getAttribute('data-dest'), t.getAttribute('data-domain'));
    if (what === 'move-cancel') { C.moving = ''; return paintFeed(false); }
    if (what === 'open-msg') return W.go('messages', ['m', t.getAttribute('data-no')]);
    if (what === 'steer') { var a = C.asks.filter(function (x) { return x.cid === t.getAttribute('data-cid'); })[0]; if (a) { a.steering = !a.steering; paintFeed(false); var f = C.host.querySelector('[data-cos-steer] input'); if (f) f.focus(); } return; }
    if (what === 'cancel') return cancel(t.getAttribute('data-cid'));
    if (what === 'quote') {
      // Tapping "Re: ..." scrolls to the drop it answers.
      var drop = C.host.querySelector('[data-drop-thread="' + t.getAttribute('data-thread') + '"]');
      if (drop) drop.scrollIntoView({ block: 'center' });
    }
  }
  function onKey(e) {
    if (!e.target || e.target.id !== 'cos-input' || e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
    e.preventDefault();
    if (e.altKey) doDrop(); else doAsk();
  }
  function onInput(e) {
    if (e.target && e.target.id === 'cos-input') { C.draft = e.target.value; W.autoGrow(e.target); paintButtons(); }
  }
  function onChangeEvent(e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-cos-model')) { C.model = e.target.value; save(); }
  }
  function onSubmit(e) {
    var f = e.target.closest && e.target.closest('[data-cos-steer]');
    if (f) { e.preventDefault(); steer(f.getAttribute('data-cos-steer'), (f.querySelector('input') || {}).value || ''); return true; }
    if (e.target.matches && e.target.matches('[data-cos-form]')) { e.preventDefault(); return true; }
    return false;
  }
  // Crossing 860 px shows the chat beside the list: load it then.
  window.matchMedia('(min-width: 860px)').addEventListener('change', function (m) {
    if (m.matches && on() && C.host && W.parseRoute().pane === 'messages') mount(C.host, true);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && on() && chatVisible()) loadFeedQuietly();
  });

  W.cosChat = {
    on: on, known: function () { return !!C.caps; }, ensureCaps: ensureCaps, fromHealth: fromHealth, refreshSummary: refreshSummary,
    pinnedRowHtml: pinnedRowHtml, mount: mount, wide: wide,
    onClick: onClick, onKey: onKey, onInput: onInput, onChange: onChangeEvent, onSubmit: onSubmit,
    setOnChange: function (fn) { C.onChange = fn; }, setOnAnswered: function (fn) { C.onAnswered = fn; },
    // Test and render hooks: what the chat holds right now.
    _state: C
  };
})();
