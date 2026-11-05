/* COS Control Web: the pinned COS chat (Drop it plan sections 1 and 12, server 6.99.10) and, from 6.99.12, Ask COS.
   Lives inside Messages: the pinned row is the first row of Recent (#/messages), the chat is #/messages/cos, and from
   860 px the two sit side by side.
   - Drop it on (capabilities.dropIt.enabled): the pinned COS chat, as in 6.99.10.
   - Drop it off, durable query jobs on (6.99.12): the same row and chat as "Ask COS", with Ask only. No inbox read.
   - Both off: Messages renders exactly as before and this module draws nothing.

   The composer has visible buttons, so a phone with no keyboard needs no key combination and no long press:
   - Ask (filled): POST /api/query-jobs with source 'web', the glasses' own route. The server picks the conversation and
     mints the message number, so the answer is a normal Messages turn (Recent on the Mac and here, and the lens list).
     Steer and Cancel are the existing query-job routes. The Model and Effort menus come from /api/models (6.99.12).
   - Drop (outlined, Drop it on only): POST /api/drops, then the receipt with Undo and Move. A drop the server reads as a
     question runs the Ask the same way and is linked back (POST /api/drops/:id/ask), as COS Control does.
     6.99.13: Drop takes the composer's files too (up to capabilities.dropIt.attachments, 5), as attachmentIds. The
     server keeps them with the drop; the receipt lists each one with Open, and Undo removes them. A drop read as a
     question sends its files with the Ask. An older server without that field keeps the words-only note.
   - The clip (6.99.12) attaches photos, PDF, TXT, MD, CSV, JSON, XLSX, MP4 and MOV, as the Even app does: photos are
     resized to a 1024 px JPEG and posted to /api/media, other files go raw to /api/media/file, and the Ask carries up to
     five attachmentIds. Paste and drag-drop add files too. Drop sends them too where the server says it takes them.
   With a keyboard, Return asks and Option-Return drops; Shift-Return is a new line.

   The same composer answers in the message reader (6.99.12): Reply sends that turn's sessionId, so the answer continues
   that conversation when it is still live (lib/web-ask-admission.ts).

   The rail badge on Messages is a number for `waiting` (GET /api/inbox/summary) and a dot for unread only. It is read
   with the shell's existing status read (shell.js checkServer), never on a timer of its own, and painting it touches
   only the badge, never the pane. */
(function () {
  'use strict';
  var W = window.COSWeb;
  var $ = W.$, esc = W.esc, api = W.api;
  var STORE = 'cos.web.cosChat';
  var DRAFTS = 'cos.web.cosDrafts';

  var C = {
    caps: null,             // null until /api/health is read: { dropIt, jobs, steer }
    capsLoading: null,
    summary: null,          // { unread, waiting, lastLine, lastAt }
    items: null,            // the chat, oldest first
    feedState: 'idle',      // idle | loading | ready | error
    feedError: '',
    asks: [],               // web Asks from this page: { cid, jobId, query, at, status, partial, response, no, sessionId, error, dropId, steering, atts, replyKey }
    moving: '',             // the feed item whose Move list is open
    models: null,           // [{ value, label, available }]
    host: null,
    onChange: null,         // messages.js: re-render when Drop it or Ask turns on or off
    onAnswered: null        // messages.js: re-read Recent when a web Ask lands
  };
  var saved = W.readStore(STORE);
  C.model = typeof saved.model === 'string' ? saved.model : '';
  C.effort = typeof saved.effort === 'string' ? saved.effort : '';

  // ── small helpers ─────────────────────────────────────
  function uuid() {
    // crypto.randomUUID needs a secure context; a plain-http tailnet page is not one.
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function save() { W.writeStore(STORE, { model: C.model, effort: C.effort, session: C.session || null }); }
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
  // Drop it on: the pinned COS chat. Ask on (durable query jobs): the composer, with or without Drop it.
  function dropOn() { return !!(C.caps && C.caps.dropIt); }
  function dropFiles() { return C.caps && C.caps.dropIt && C.caps.dropFiles > 0 ? C.caps.dropFiles : 0; }
  function askOn() { return !!(C.caps && C.caps.jobs); }
  function on() { return dropOn() || askOn(); }
  function setCaps(h) {
    var caps = (h && h.capabilities) || {};
    var drop = caps.dropIt;
    var next = {
      dropIt: !!(drop && drop.enabled === true),
      // 6.99.13: how many files a drop takes. 0 (an older server): Drop is words only and says so.
      dropFiles: drop && drop.enabled === true && Number.isInteger(drop.attachments) && drop.attachments > 0 ? Math.min(drop.attachments, MAX_ATTS) : 0,
      jobs: caps.durableQueryJobs === true || h && h.durableQueryJobs === true || !!(caps.durableQueryJobs && caps.durableQueryJobs.enabled),
      steer: !!(C.caps && C.caps.steer)
    };
    var changed = !C.caps || C.caps.dropIt !== next.dropIt || C.caps.jobs !== next.jobs;
    var filesChanged = !!C.caps && C.caps.dropFiles !== next.dropFiles;
    C.caps = next;
    if (!next.dropIt) { clearRail(); C.summary = null; }
    if (changed && C.onChange) C.onChange();
    else if (filesChanged) paintButtons(CHAT);
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
    if (!dropOn()) return Promise.resolve(null);
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
    var s = dropOn() ? C.summary : null;
    var line = s && s.lastLine ? s.lastLine : dropOn() ? 'Text it anything: a thought, an ask, a reminder. It texts back.'
      : 'Ask anything, with photos or files. The answer lands in Messages with its number.';
    var status = dropOn() ? pinStatus() : '';
    return '<button type="button" class="cx-row cc-pin" data-msg="cos"' + (selected ? ' aria-current="true"' : '') + '>' +
      '<span class="cx-row-glyph cc-pin-glyph">' + MARK + '</span>' +
      '<span class="cx-row-body"><span class="cx-meta"><span class="cx-num">' + (dropOn() ? 'COS' : 'Ask COS') + '</span>' +
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

  // ── models and effort (6.99.12: /api/models, as the Even app offers them) ──
  // Claude's tiers are always offered (the server resolves each to its newest model); Codex, Cursor and Ollama come from
  // the Mac's live catalogs, and Cursor and Ollama only when the Mac says they are ready.
  var CLAUDE_MENU = [['opus', 'Claude Opus'], ['fable', 'Claude Fable'], ['sonnet', 'Claude Sonnet']];
  var ENGINE = { 'codex-frontier': 'Codex', 'codex-balanced': 'Codex', 'cursor-grok': 'Cursor', 'cursor-composer': 'Cursor', ollama: 'Ollama' };
  var FALLBACK = { 'codex-frontier': 'Frontier', 'codex-balanced': 'Balanced', 'cursor-grok': 'Grok', 'cursor-composer': 'Composer', ollama: '' };
  var EFFORTS = [['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max'], ['ultracode', 'Ultracode']];
  function modelsFrom(m) {
    var out = CLAUDE_MENU.map(function (c) { return { value: c[0], label: c[1], available: true }; });
    var seen = { opus: 1, fable: 1, sonnet: 1 };
    ((m && m.options) || []).forEach(function (o) {
      var pref = o && o.preference;
      if (!pref || seen[pref] || !ENGINE[pref]) return;
      if (/^cursor-/.test(pref) && m.cursorReady !== true) return;
      if (pref === 'ollama' && m.ollamaReady !== true) return;
      seen[pref] = 1;
      var name = String(o.displayName || o.id || FALLBACK[pref] || '').trim();
      out.push({ value: pref, label: (ENGINE[pref] + (name ? ' ' + name : '')).slice(0, 48), available: true });
    });
    return out;
  }
  function loadModels() {
    if (C.models) return;
    C.models = [];
    api('/api/models').then(function (m) {
      C.models = modelsFrom(m);
      if (C.model && !C.models.some(function (o) { return o.value === C.model; })) { C.model = ''; save(); }
      // Steer exists only where the server says so (/api/models capabilities.durableQueryJobs.steer).
      var j = m && m.capabilities && m.capabilities.durableQueryJobs;
      if (C.caps) C.caps.steer = !!(j && j.steer);
      paintModelMenu();
    }, function () { C.models = []; paintModelMenu(); });
  }
  function modelMenuHtml() {
    var list = C.models || [];
    var opts = ['<option value="">Default</option>'].concat(list.map(function (m) {
      return '<option value="' + esc(m.value) + '"' + (m.value === C.model ? ' selected' : '') + (m.available ? '' : ' disabled') + '>' + esc(m.label + (m.available ? '' : ' (not available)')) + '</option>';
    }));
    var efforts = ['<option value="">Default</option>'].concat(EFFORTS.map(function (e) {
      return '<option value="' + e[0] + '"' + (e[0] === C.effort ? ' selected' : '') + '>' + e[1] + '</option>';
    }));
    return '<label class="cc-model"><span>Model</span><select class="field" data-cos-model aria-label="Model for Ask">' + opts.join('') + '</select></label>' +
      '<label class="cc-model"><span>Effort</span><select class="field" data-cos-effort aria-label="Effort for Ask">' + efforts.join('') + '</select></label>';
  }
  function paintModelMenu() {
    document.querySelectorAll('[data-cos-model-slot]').forEach(function (slot) {
      // An open menu is never rebuilt under the finger (it would close the iOS picker).
      if (document.activeElement && slot.contains(document.activeElement)) return;
      slot.innerHTML = modelMenuHtml();
    });
  }

  // ── composers: the chat's and the reader's Reply ──────
  // One composer per place, so a half-written reply never leaks into the chat. Words survive a reload (localStorage,
  // per composer); files survive a sign-in in this tab but not a reload.
  var drafts = W.readStore(DRAFTS);
  var K = {};
  function composer(name) {
    if (!K[name]) K[name] = { name: name, inputId: name === 'chat' ? 'cos-input' : 'cos-in-' + name.replace(/[^A-Za-z0-9_-]/g, '_'), draft: typeof drafts[name] === 'string' ? drafts[name] : '', atts: [], busy: '', note: '', sessionId: '', no: null };
    return K[name];
  }
  var CHAT = composer('chat');
  function saveDraft(k) {
    var all = W.readStore(DRAFTS);
    if (k.draft) all[k.name] = k.draft; else delete all[k.name];
    // Keep the newest few: a reader opened on every turn would otherwise fill the store.
    var keys = Object.keys(all); if (keys.length > 12) delete all[keys[0]];
    W.writeStore(DRAFTS, all);
  }
  function formOf(k) { return document.querySelector('[data-cos-form="' + k.name + '"]'); }
  function inputOf(k) { return document.getElementById(k.inputId); }
  function kOf(el) { var f = el && el.closest && el.closest('[data-cos-form]'); return f ? composer(f.getAttribute('data-cos-form')) : CHAT; }
  var ACCEPT = 'image/*,.heic,.heif,application/pdf,.pdf,text/plain,.txt,text/markdown,.md,text/csv,.csv,application/json,.json,' +
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx,video/mp4,.mp4,video/quicktime,.mov';
  function composerHtml(k, o) {
    var drop = !!o.drop;
    var hint = keyboardFirst() ? (drop ? 'Return asks. Option-Return drops. Shift-Return starts a new line.' : 'Return asks. Shift-Return starts a new line.') : '';
    return '<form class="cc-composer" data-cos-form="' + esc(k.name) + '" autocomplete="off">' +
      '<div class="cc-chips hidden" data-cos-chips></div>' +
      '<textarea class="field cc-input" id="' + esc(k.inputId) + '" rows="1" maxlength="2000" placeholder="' + esc(o.placeholder) + '" aria-label="' + esc(o.label) + '"></textarea>' +
      '<div class="cc-buttons">' +
        '<label class="cx-btn cc-attach" title="Attach photos or files"><svg class="icon" aria-hidden="true"><use href="#i-clip"/></svg><span class="sr-only">Attach photos or files</span>' +
          '<input type="file" class="cc-file" multiple accept="' + ACCEPT + '" data-cos-file aria-label="Attach photos or files"></label>' +
        '<button type="button" class="cx-btn primary cc-ask" data-cos="ask">Ask</button>' +
        (drop ? '<button type="button" class="cx-btn cc-drop" data-cos="drop">Drop</button>' : '') + '</div>' +
      '<div class="cc-foot"><span class="cc-menus" data-cos-model-slot>' + (C.models ? modelMenuHtml() : '') + '</span>' +
        (hint || drop ? '<span class="cc-hint">' + esc(hint + (drop ? (hint ? ' ' : '') + 'A drop never sends anything to anyone.' : '')) + '</span>' : '') + '</div>' +
      '<p class="cc-note hidden" data-cos-note role="status"></p>' +
      '</form>';
  }
  // After the HTML is in the page: the words, the chips and the buttons as the composer holds them.
  function hydrate(k) {
    var input = inputOf(k);
    if (input) { input.value = k.draft; W.autoGrow(input); }
    paintChips(k); paintButtons(k); setNote(k, k.note);
  }

  // ── the chat ──────────────────────────────────────────
  function chatMode() { return dropOn() ? 'drop' : 'ask'; }
  function chatSkeleton() {
    var drop = dropOn();
    return '<section class="cc" data-cos-chat data-mode="' + chatMode() + '" data-tint="messages" aria-label="' + (drop ? 'COS chat' : 'Ask COS') + '">' +
      '<header class="cc-head"><span class="cc-avatar big">' + MARK + '</span><div class="cc-head-text"><h2 class="cc-title">' + (drop ? 'COS' : 'Ask COS') + '</h2>' +
        '<p class="cc-sub">' + (drop ? 'Text it anything: a thought, an ask, a reminder. It texts back.' : 'Ask anything, with photos or files. Each answer lands in Messages with its number, here and on the glasses.') + '</p></div>' +
        '<div class="cc-head-acts"><button type="button" class="link-btn cc-all" data-cos="all">All messages</button>' +
        (drop ? '<button type="button" class="link-btn" data-cos="read-all">Mark all read</button>' : '') + '</div></header>' +
      '<div class="cc-feed" data-cos-feed aria-live="polite"></div>' +
      composerHtml(CHAT, { drop: drop, placeholder: drop ? 'Ask COS, or drop a thought, a task, a reminder' : 'Ask COS anything', label: 'Message to COS' }) +
      '</section>';
  }
  function mount(host, visible) {
    if (!host) return;
    C.host = host;
    var el = host.querySelector('[data-cos-chat]');
    // Drop it turned on or off: the chat's buttons differ, so it is drawn again (the words are kept).
    if (!el || el.getAttribute('data-mode') !== chatMode()) {
      host.innerHTML = chatSkeleton();
      hydrate(CHAT);
    }
    if (!visible) return;
    loadModels();
    // Ask only: no inbox to read; the chat holds this page's Asks. Inbox lines from a Drop it session are not shown.
    if (!dropOn()) { if (C.feedMode !== 'ask') { C.items = []; C.feedState = 'ready'; C.feedMode = 'ask'; } paintFeed(true); return; }
    if (C.items === null || C.feedState === 'error' || C.feedMode !== 'drop') loadFeed(); else paintFeed(true);
  }
  function chatVisible() { var el = C.host && C.host.querySelector('[data-cos-chat]'); return !!(el && el.offsetParent !== null); }

  function loadFeed() {
    if (C.feedState === 'loading') return;
    C.feedState = 'loading';
    C.feedMode = 'drop';
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
    if (!dropOn() || !chatVisible() || !C.items || !C.items.length) return;
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
  // 6.99.13: a drop's files, each opening from the media store in a new tab. Under your words they are what you sent;
  // on a receipt each says Open. Undo takes the links away with the files. The classes are cc-dfile*, never cc-file:
  // .cc-file is the clip's invisible file input (opacity 0, absolute), and a link wearing it does not show.
  function fileLinksHtml(item, mine) {
    var files = (item.links || []).filter(function (l) { return l.kind === 'file' && MEDIA_ID.test(String(l.id)); });
    if (!files.length) return '';
    return '<div class="cc-dfiles' + (mine ? ' mine' : '') + '">' + files.map(function (f) {
      var url = '/api/media/' + encodeURIComponent(f.id) + '/content';
      var photo = /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(String(f.label)) || f.label === 'Photo';
      return '<a class="cc-dfile" href="' + esc(url + '?variant=phone') + '" target="_blank" rel="noopener" aria-label="Open ' + esc(f.label) + '">' +
        '<span class="cc-dfile-thumb">' + (photo ? '<img src="' + esc(url + '?variant=thumb') + '" alt="" loading="lazy">' : '<svg class="icon" aria-hidden="true"><use href="#i-doc"/></svg>') + '</span>' +
        '<span class="cc-dfile-name">' + esc(f.label) + '</span>' + (mine ? '' : '<span class="cc-dfile-open">Open</span>') + '</a>';
    }).join('') + '</div>';
  }
  function itemHtml(item) {
    if (item.kind === 'drop' || item.kind === 'answer') {
      return '<div class="cc-line you' + (item.kind === 'answer' ? ' answer' : '') + '"' + (item.kind === 'drop' ? ' data-drop-thread="' + esc(item.threadId) + '"' : '') + '><div class="cc-bubble">' + esc(item.line) + '</div>' +
        (item.kind === 'drop' ? fileLinksHtml(item, true) + '<div class="cc-src">' + esc(SOURCE[item.source] || '') + '</div>' : '') + '</div>';
    }
    var quote = item.kind === 'followup' ? (function () { var d = dropOf(item); return d ? '<button type="button" class="cc-quote" data-cos="quote" data-thread="' + esc(item.threadId) + '">Re: ' + esc(clip(d.line, 70)) + '</button>' : ''; })() : '';
    return '<div class="cc-line cos' + (item.state !== 'live' ? ' done' : '') + (item.needsReply && item.state === 'live' ? ' waits' : '') + '" data-item-id="' + esc(item.id) + '">' +
      '<span class="cc-avatar">' + MARK + '</span><div class="cc-card">' + quote +
      (item.title ? '<p class="cc-card-title">' + esc(item.title) + '</p>' : '') +
      '<p class="cc-card-line">' + esc(item.line) + '</p>' + fileLinksHtml(item, false) + actionsHtml(item) + '</div></div>';
  }
  // The finished answer as Markdown; while it streams, plain words, so a half-written "**bold" never shows its stars.
  function answerHtml(a) {
    if (a.response) return W.md(a.response);
    if (!a.partial) return '';
    return '<p>' + esc(a.partial.replace(/\*\*|__|`|^#+\s*/gm, '')).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
  }
  // What was attached to an Ask, as it was sent: the photo itself, or the file's kind and name.
  function sentAttsHtml(list) {
    if (!list || !list.length) return '';
    return '<div class="cc-sent-atts">' + list.map(function (t) {
      return '<span class="cc-sent-att" title="' + esc(t.name) + '">' + (t.thumb ? '<img src="' + esc(t.thumb) + '" alt="' + esc(t.name) + '">' : '<svg class="icon" aria-hidden="true"><use href="#i-' + (t.kind === 'video' ? 'video' : 'doc') + '"/></svg>') +
        (t.thumb ? '' : '<span class="cc-sent-name">' + esc(clip(t.name, 22)) + '</span>') + '</span>';
    }).join('') + '</div>';
  }
  function askState(a) {
    return a.status === 'completed' ? 'Answered' : a.status === 'canceled' ? 'Canceled' : a.status === 'failed' || a.status === 'interrupted' ? 'Did not finish' : a.status === 'sending' ? 'Sending' : 'Answering';
  }
  function askHtml(a, linked) {
    var running = a.status === 'sending' || a.status === 'queued' || a.status === 'running';
    var title = a.no ? 'Message #' + a.no : 'Asking COS';
    var body = answerHtml(a);
    var acts = '';
    if (running && a.jobId) {
      acts = (C.caps && C.caps.steer && a.steerable !== false ? '<button type="button" class="link-btn cc-text-btn" data-cos="steer" data-cid="' + a.cid + '">Steer</button>' : '') +
        '<button type="button" class="link-btn cc-text-btn" data-cos="cancel" data-cid="' + a.cid + '">Cancel</button>';
    } else if (a.status === 'completed' && a.no) {
      acts = '<button type="button" class="cx-btn primary" data-cos="open-msg" data-no="' + a.no + '">Open in Messages</button>';
    }
    // A drop that became a question already shows its words as the drop: only the answer card is added.
    return (linked ? '' : '<div class="cc-line you"><div class="cc-bubble">' + esc(a.query) + '</div>' + sentAttsHtml(a.atts) + '<div class="cc-src">' + (a.replyKey ? 'Replied on the web' : 'Asked on the web') + '</div></div>') +
      '<div class="cc-line cos" data-ask="' + a.cid + '"><span class="cc-avatar">' + MARK + '</span><div class="cc-card">' +
      '<p class="cc-card-title"><span data-ask-title>' + esc(title) + '</span><span class="cx-time" data-ask-state>' + esc(askState(a)) + '</span></p>' +
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
      C.asks.forEach(function (a) { if (!a.replyKey) rows.push({ at: new Date(a.at + (a.dropId ? 1 : 0)).toISOString(), html: askHtml(a, !!a.dropId) }); });
      rows.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
      html = rows.length ? rows.map(function (r) { return r.html; }).join('')
        : dropOn() ? '<p class="cc-empty">Nothing here yet. Ask COS something, or drop a thought and COS files it.</p>'
          : '<p class="cc-empty">Ask COS anything. Attach photos or files with the clip.</p>';
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
  // A running Ask updates its own card in place, so a poll never rebuilds the chat (or the reader).
  function paintAsk(a) {
    var el = document.querySelector('[data-ask="' + a.cid + '"]');
    if (!el) return a.replyKey ? paintReplyFeed(a.replyKey) : paintFeed(false);
    var running = a.status === 'sending' || a.status === 'queued' || a.status === 'running';
    var title = el.querySelector('[data-ask-title]'); if (title) title.textContent = a.no ? 'Message #' + a.no : 'Asking COS';
    var st = el.querySelector('[data-ask-state]'); if (st) st.textContent = askState(a);
    var body = el.querySelector('[data-ask-body]'); var text = a.response || a.partial;
    if (body && text && body.getAttribute('data-len') !== String(text.length) + (a.response ? 'r' : '')) { body.innerHTML = answerHtml(a); body.setAttribute('data-len', String(text.length) + (a.response ? 'r' : '')); }
    if (!running) { if (a.replyKey) paintReplyFeed(a.replyKey); else paintFeed(false); }
  }

  function uploadsPending(k) { return k.atts.some(function (t) { return t.state === 'reading' || t.state === 'uploading'; }); }
  function uploadsFailed(k) { return k.atts.some(function (t) { return t.state === 'failed'; }); }
  function paintButtons(k) {
    k = k || CHAT;
    var form = formOf(k); if (!form) return;
    var input = inputOf(k); var text = input ? input.value.trim() : '';
    var ask = form.querySelector('[data-cos="ask"]'), drop = form.querySelector('[data-cos="drop"]');
    var jobs = !C.caps || C.caps.jobs;
    var waiting = uploadsPending(k), failed = uploadsFailed(k);
    if (ask) { ask.disabled = !text || !!k.busy || !jobs || waiting || failed; ask.textContent = k.busy === 'ask' ? 'Asking…' : waiting ? 'Uploading…' : (k.name === 'chat' ? 'Ask' : 'Reply'); }
    if (drop) {
      // 6.99.13: with files on a server that takes them, Drop waits for the uploads as Ask does. Files with no words keep
      // Drop tappable so the tap can say what is missing.
      var withFiles = k.atts.length > 0 && dropFiles();
      drop.disabled = !!k.busy || (!text && !withFiles) || (withFiles && (waiting || failed));
      drop.textContent = k.busy === 'drop' ? 'Dropping…' : withFiles && waiting ? 'Uploading…' : 'Drop';
    }
    var attach = form.querySelector('.cc-attach'), picker = form.querySelector('[data-cos-file]');
    if (attach) attach.classList.toggle('full', k.atts.length >= MAX_ATTS);
    if (picker) picker.disabled = k.atts.length >= MAX_ATTS || !!k.busy;
    if (!jobs) setNote(k, 'Ask needs the durable query jobs switch on your Mac.' + (drop ? ' Drop still works.' : ''));
    else if (failed && !k.note) setNote(k, 'A file did not upload. Retry it or remove it, then Ask.');
  }
  function setNote(k, text) {
    k.note = text || '';
    var form = formOf(k);
    var el = form && form.querySelector('[data-cos-note]');
    if (!el) return;
    el.innerHTML = esc(k.note) + (k.signedOut ? ' <button type="button" class="link-btn cc-text-btn" data-cos="sign-in">Sign in again</button>' : '');
    el.classList.toggle('hidden', !k.note);
  }

  // ── attachments (6.99.12, the Even app's composer) ────
  var MAX_ATTS = 5;                       // MAX_ATTACHMENTS_PER_PROMPT
  var MEDIA_ID = /^m_[a-f0-9]{24}$/;      // shared/media-attachment.ts MEDIA_ID_RE
  var MAX_PHOTO = 2 * 1024 * 1024;        // MAX_IMAGE_BYTES, after the resize
  var MAX_DOC = 64 * 1024 * 1024;         // MAX_OTHER_MEDIA_BYTES
  var MAX_VIDEO = 100 * 1024 * 1024;      // MAX_VIDEO_MEDIA_BYTES
  var PHOTO_EDGE = 1024, PHOTO_QUALITY = 0.85;
  var DOC_EXT = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  var VIDEO_EXT = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4' };
  var PHOTO_EXT = { jpg: 1, jpeg: 1, png: 1, gif: 1, webp: 1, heic: 1, heif: 1 };
  function extOf(name) { var m = /\.([A-Za-z0-9]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
  function mb(bytes) { var n = bytes / 1048576; return (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10) + ' MB'; }
  function sizeLabel(bytes) { return bytes >= 1048576 ? mb(bytes) : Math.max(1, Math.round(bytes / 1024)) + ' KB'; }
  function isSafari() {
    var ua = (window.navigator && window.navigator.userAgent) || '';
    return /safari/i.test(ua) && !/chrome|chromium|crios|fxios|edg|android|opr/i.test(ua);
  }
  /** What a file is to COS: 'photo', 'doc' or 'video', with a refusal sentence when it cannot be attached. */
  function classify(file) {
    var type = String(file.type || '').toLowerCase(), ext = extOf(file.name);
    var heic = /^image\/hei[cf]/.test(type) || ext === 'heic' || ext === 'heif';
    if (heic && !isSafari()) return { refuse: file.name + ' is a HEIC photo, which only Safari can read here. Attach it from Safari, or save it as a JPEG first.' };
    if (/^image\//.test(type) || PHOTO_EXT[ext]) return { kind: 'photo' };
    if (/^video\//.test(type) || VIDEO_EXT[ext]) {
      if (!VIDEO_EXT[ext] && type !== 'video/mp4' && type !== 'video/quicktime') return { refuse: file.name + ' is a video COS cannot read. Use MP4 or MOV.' };
      if (file.size > MAX_VIDEO) return { refuse: file.name + ' is ' + mb(file.size) + '. The largest video COS takes is 100 MB.' };
      return { kind: 'video', mime: type || VIDEO_EXT[ext] };
    }
    if (DOC_EXT[ext] || type === 'application/pdf' || type === 'text/plain' || type === 'text/csv' || type === 'text/markdown' || type === 'application/json') {
      if (file.size > MAX_DOC) return { refuse: file.name + ' is ' + mb(file.size) + '. The largest file COS takes is 64 MB.' };
      return { kind: 'doc', mime: type && type !== 'application/octet-stream' ? type : DOC_EXT[ext] || type };
    }
    return { refuse: file.name + ' cannot be attached. COS takes photos, PDF, TXT, MD, CSV, JSON, XLSX, MP4 and MOV.' };
  }
  function addFiles(k, files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var refusals = [];
    list.forEach(function (file) {
      if (k.atts.length >= MAX_ATTS) { refusals.push('Up to 5 attachments per message. ' + file.name + ' was not added.'); return; }
      var c = classify(file);
      if (c.refuse) { refusals.push(c.refuse); return; }
      var t = { id: uuid(), file: file, name: file.name || (c.kind === 'photo' ? 'Photo' : 'File'), size: file.size, kind: c.kind, mime: c.mime || '', state: 'reading', progress: 0, mediaId: '', thumb: '', error: '' };
      k.atts.push(t);
      startUpload(k, t);
    });
    k.signedOut = false;
    setNote(k, refusals.join(' '));
    paintChips(k); paintButtons(k);
  }
  function chipMeta(t) {
    if (t.state === 'reading') return t.kind === 'photo' ? 'Resizing' : 'Preparing';
    if (t.state === 'uploading') return 'Uploading ' + Math.round(t.progress * 100) + '%';
    if (t.state === 'failed') return t.error || 'Did not upload';
    return sizeLabel(t.size);
  }
  function chipHtml(t) {
    var icon = t.thumb ? '<img src="' + esc(t.thumb) + '" alt="">' : '<svg class="icon" aria-hidden="true"><use href="#i-' + (t.kind === 'video' ? 'video' : t.kind === 'photo' ? 'photo' : 'doc') + '"/></svg>';
    return '<div class="cc-chip ' + t.state + '" data-chip="' + t.id + '"><span class="cc-chip-thumb">' + icon + '</span>' +
      '<span class="cc-chip-text"><span class="cc-chip-name">' + esc(t.name) + '</span><span class="cc-chip-meta" data-chip-meta>' + esc(chipMeta(t)) + '</span></span>' +
      (t.state === 'failed' ? '<button type="button" class="link-btn cc-chip-retry" data-cos="att-retry" data-att="' + t.id + '">Retry</button>' : '') +
      '<button type="button" class="cc-chip-x" data-cos="att-remove" data-att="' + t.id + '" aria-label="Remove ' + esc(t.name) + '"><span aria-hidden="true">×</span></button>' +
      (t.state === 'uploading' || t.state === 'reading' ? '<span class="cc-chip-bar" data-chip-bar style="width:' + Math.round(t.progress * 100) + '%"></span>' : '') + '</div>';
  }
  function paintChips(k) {
    var form = formOf(k), box = form && form.querySelector('[data-cos-chips]');
    if (!box) return;
    box.innerHTML = k.atts.map(chipHtml).join('');
    box.classList.toggle('hidden', !k.atts.length);
  }
  // Progress moves the bar and the words only, never the chip row (a tap on Remove must not miss).
  function paintProgress(k, t) {
    var chip = document.querySelector('[data-chip="' + t.id + '"]');
    if (!chip) return;
    var meta = chip.querySelector('[data-chip-meta]'); if (meta) meta.textContent = chipMeta(t);
    var bar = chip.querySelector('[data-chip-bar]'); if (bar) bar.style.width = Math.round(t.progress * 100) + '%';
  }
  function findAtt(k, id) { for (var i = 0; i < k.atts.length; i++) if (k.atts[i].id === id) return k.atts[i]; return null; }
  function removeAtt(k, id) {
    k.atts = k.atts.filter(function (t) { if (t.id === id && t.xhr) { try { t.xhr.abort(); } catch (_e) {} } return t.id !== id; });
    if (!uploadsFailed(k) && /did not upload/i.test(k.note)) setNote(k, '');
    paintChips(k); paintButtons(k);
  }
  /** A photo, drawn into a canvas at most 1024 px on its longest edge, as a JPEG at quality 0.85. */
  function resizePhoto(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
        var s = Math.min(1, PHOTO_EDGE / Math.max(w0, h0, 1));
        var w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
        var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        var g = canvas.getContext('2d');
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);   // a transparent PNG gets white, not black, as a JPEG
        g.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This browser could not open that photo.')); };
      img.src = url;
    });
  }
  /**
   * One upload with its progress. XMLHttpRequest, not fetch: fetch reports no upload progress. Same request as fetch
   * with credentials 'same-origin' (the cookie goes with any same-origin XHR) plus X-COS-Web: 1, which a cookie write
   * needs. A 401 here never opens the sign-in screen: the chip says so and the message stays (see uploadError).
   */
  function uploadRequest(path, body, headers, onProgress, t) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      t.xhr = xhr;
      xhr.open('POST', path, true);
      xhr.setRequestHeader('X-COS-Web', '1');
      Object.keys(headers).forEach(function (h) { xhr.setRequestHeader(h, headers[h]); });
      if (xhr.upload) xhr.upload.onprogress = function (e) { if (e.lengthComputable && e.total) onProgress(e.loaded / e.total); };
      xhr.onload = function () {
        t.xhr = null;
        var data = {}; try { data = JSON.parse(xhr.responseText || '{}'); } catch (_e) { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        var err = new Error('The Mac answered ' + xhr.status + '.'); err.status = xhr.status;
        err.code = data && (typeof data.error === 'string' ? data.error : data.error && data.error.code) || '';
        reject(err);
      };
      xhr.onerror = function () { t.xhr = null; var err = new Error('The Mac did not answer.'); err.code = 'network'; reject(err); };
      xhr.onabort = function () { t.xhr = null; var err = new Error('Removed.'); err.code = 'aborted'; reject(err); };
      xhr.send(body);
    });
  }
  var UPLOAD_COPY = {
    batch_too_large: 'Too large for one upload.', too_many_images: 'Up to 5 attachments per message.',
    media_processing_unavailable: 'The Mac cannot read photos right now.', unsupported_kind: 'COS cannot read this kind of file.',
    unsupported_media_type: 'COS cannot read this kind of file.', file_too_large: 'Too large for COS.', attachment_too_large: 'Too large for COS.',
    server_maintenance: 'The Mac is updating. Retry in a minute.', network: 'The Mac did not answer. Retry when it is awake.'
  };
  function uploadError(k, t, err) {
    if (err && err.code === 'aborted') return;
    t.state = 'failed';
    if (err && err.status === 401) {
      // Signed out mid-message (the browser session expired or every browser was signed out). Nothing is thrown away:
      // the words and the files stay, and Sign in again opens the sign-in screen on purpose, not by surprise.
      t.error = 'Signed out';
      k.signedOut = true;
      setNote(k, 'This browser was signed out. Your message and files are kept. Sign in, then tap Retry on each file.');
    } else {
      t.error = uploadErrorText(err);
    }
    paintChips(k); paintButtons(k);
  }
  /**
   * One file to the media store, the way every web upload goes: a photo resized to a 1024 px JPEG and posted to /api/media,
   * any other file raw to /api/media/file. Resolves with the media ref ({ id }). `t` is the upload's record ({ file, name,
   * kind, mime }); it gets `xhr` while sending (Remove aborts it) and `thumb` for a photo. hooks.uploading() runs once the
   * bytes start, hooks.progress(0..1) as they go. 6.99.14: the live meeting view's Add file uses this too.
   */
  function uploadMedia(t, hooks) {
    var at = new Date(t.file.lastModified || Date.now()).toISOString();
    if (t.kind === 'photo') {
      return resizePhoto(t.file).then(function (dataUrl) {
        var data = dataUrl.slice(dataUrl.indexOf(',') + 1);
        var bytes = Math.floor(data.length * 3 / 4);
        if (bytes > MAX_PHOTO) { var big = new Error('Over 2 MB even after resizing.'); big.code = 'photo_too_large'; throw big; }
        t.thumb = dataUrl; hooks.uploading();
        var body = JSON.stringify({ images: [{ data: data, label: t.name.slice(0, 120), capturedAt: at }], kind: 'user_photo' });
        return uploadRequest('/api/media', body, { 'Content-Type': 'application/json' }, function (p) { hooks.progress(p); }, t);
      }).then(function (d) { return d && d.attachments && d.attachments[0]; });
    }
    hooks.uploading();
    return uploadRequest('/api/media/file', t.file, {
      'Content-Type': t.mime || 'application/octet-stream',
      'X-COS-Filename': encodeURIComponent(t.name),
      'X-COS-Captured-At': at
    }, function (p) { hooks.progress(p); }, t).then(function (d) { return d && d.attachment; });
  }
  /** The chip's words for a failed upload (never the sign-in case, which each caller says its own way). */
  function uploadErrorText(err) {
    if (err && err.code === 'photo_too_large') return 'Over 2 MB even after resizing';
    if (err && !err.status && !err.code) return err.message || 'Did not upload';
    return UPLOAD_COPY[err && err.code] || (err && err.status === 413 ? 'Too large for COS.' : 'Did not upload');
  }
  function startUpload(k, t) {
    t.state = 'reading'; t.progress = 0; t.error = '';
    var step = uploadMedia(t, {
      uploading: function () { t.state = 'uploading'; paintChips(k); paintButtons(k); },
      progress: function (p) { t.progress = p; paintProgress(k, t); }
    });
    step.then(function (ref) {
      if (!findAtt(k, t.id)) return;
      if (!ref || !ref.id) { var e = new Error('The Mac did not keep the file.'); e.code = ''; throw e; }
      t.mediaId = ref.id; t.state = 'ready'; t.progress = 1;
      paintChips(k); paintButtons(k);
    }).catch(function (err) {
      if (!findAtt(k, t.id)) return;
      if (err && err.code === 'photo_too_large') { t.state = 'failed'; t.error = uploadErrorText(err); paintChips(k); paintButtons(k); return; }
      if (err && !err.status && !err.code) { t.state = 'failed'; t.error = uploadErrorText(err); paintChips(k); paintButtons(k); return; }
      uploadError(k, t, err);
    });
  }
  function readyAtts(k) { return k.atts.filter(function (t) { return t.state === 'ready' && t.mediaId; }); }
  function clearAtts(k) { k.atts = []; paintChips(k); }

  // ── Drop ──────────────────────────────────────────────
  function doDrop() {
    var k = CHAT;
    var input = inputOf(k); var text = input ? input.value.trim() : '';
    if (k.busy) return;
    // An older server files words only (no capabilities.dropIt.attachments): say so, and send nothing.
    if (k.atts.length && !dropFiles()) { setNote(k, 'Drop takes words only on this Mac. Ask sends the files with your words, or remove them to drop.'); return; }
    if (!text) { if (k.atts.length) setNote(k, 'Add a few words with the files so COS knows where they go.'); return; }
    if (uploadsPending(k)) return;
    if (uploadsFailed(k)) { setNote(k, 'A file did not upload. Retry it or remove it, then Drop.'); return; }
    // What is shown as sent is exactly what is sent: never more than the server takes.
    var ready = readyAtts(k).slice(0, dropFiles() || 0);
    var dropId = uuid();
    var body = { dropId: dropId, text: text, source: 'web' };
    if (ready.length) body.attachmentIds = ready.map(function (t) { return t.mediaId; });
    k.busy = 'drop'; setNote(k, ''); paintButtons(k);
    var send = function (retry) {
      return api('/api/drops', { method: 'POST', body: body, timeoutMs: 30000 }).catch(function (err) {
        // The same dropId is safe to send again: the server answers the first result.
        if (retry && err && err.code === 'timeout') return send(false);
        throw err;
      });
    };
    send(true).then(function (ans) {
      k.busy = ''; k.draft = ''; saveDraft(k);
      var box = inputOf(k); if (box) { box.value = ''; W.autoGrow(box); }
      if (ready.length) clearAtts(k);
      mergeItems(ans.items);
      paintFeed(true); paintButtons(k);
      if (ans.next && ans.next.kind === 'ask' && C.caps && C.caps.jobs) submitAsk(ans.next.prompt, ans.drop.id, null, askFilesOf(ans.next));
      refreshSummary();
    }, function (err) {
      k.busy = ''; paintButtons(k);
      // The words and the files stay in the box until the server has them.
      var kept = ready.length ? ' Your words and files are still here.' : ' Your words are still here.';
      // A refused file says why in the server's own words (attachment_expired, too_many_attachments, words_needed...).
      setNote(k, err && err.code === 'drop_it_off' ? 'Drop it is off on this Mac.' : 'Not dropped: ' + ((err && err.message) || 'the Mac did not answer.') + kept);
    });
  }

  // A drop read as a question runs the Ask with the drop's files (the server names them in next.attachmentIds).
  function askFilesOf(next) {
    var ids = next && Array.isArray(next.attachmentIds) ? next.attachmentIds.filter(function (id) { return MEDIA_ID.test(String(id)); }).slice(0, MAX_ATTS) : [];
    return ids.length ? { attachmentIds: ids } : undefined;
  }

  // ── Ask ───────────────────────────────────────────────
  function doAsk(k) {
    k = k || CHAT;
    var input = inputOf(k); var text = input ? input.value.trim() : '';
    if (!text || k.busy || uploadsPending(k) || uploadsFailed(k)) return;
    // What is shown as sent is exactly what is sent: never more than the server's five per prompt.
    var ready = readyAtts(k).slice(0, MAX_ATTS);
    k.busy = 'ask'; setNote(k, ''); paintButtons(k);
    var opts = { attachmentIds: ready.map(function (t) { return t.mediaId; }), atts: ready.map(function (t) { return { name: t.name, kind: t.kind, thumb: t.thumb }; }) };
    if (k.name !== 'chat') { opts.sessionId = k.sessionId; opts.replyKey = k.name; }
    submitAsk(text, null, function (ok) {
      k.busy = '';
      if (ok) { k.draft = ''; saveDraft(k); clearAtts(k); var box = inputOf(k); if (box) { box.value = ''; W.autoGrow(box); } }
      paintButtons(k);
    }, opts);
  }
  function submitAsk(text, dropId, done, opts) {
    opts = opts || {};
    var a = { cid: uuid(), query: text, at: Date.now(), status: 'sending', partial: '', dropId: dropId || '', atts: opts.atts || [], replyKey: opts.replyKey || '' };
    C.asks.push(a);
    if (a.replyKey) paintReplyFeed(a.replyKey); else paintFeed(true);
    var body = { clientJobId: a.cid, generation: 1, query: text, source: 'web', activityToolMode: 'status' };
    if (C.model) body.model = C.model;
    if (C.effort) body.effort = C.effort;
    if (C.session && C.session.id) body.sessionId = C.session.id;
    // A reply continues the turn's own conversation (kept when it is still live; else the server starts a new one).
    if (opts.sessionId) body.sessionId = opts.sessionId;
    if (opts.attachmentIds && opts.attachmentIds.length) body.attachmentIds = opts.attachmentIds.slice(0, MAX_ATTS);
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
      if (job.sessionId && !a.replyKey) { C.session = { id: job.sessionId, day: today() }; save(); }
      if (dropId) api('/api/drops/' + encodeURIComponent(dropId) + '/ask', { method: 'POST', body: { clientJobId: a.cid, generation: 1 } }).catch(function () {});
      if (done) done(true);
      poll(a);
    }, function (err) {
      a.status = 'failed';
      a.error = err && err.code === 'durable_query_jobs_disabled' ? 'Ask needs the durable query jobs switch on your Mac.'
        : err && /attachment/.test(String(err.code || '')) ? 'An attachment could not be read: ' + ((err && err.message) || err.code) + ' Your words and files are still in the box.'
          : 'Not sent: ' + ((err && err.message) || 'the Mac did not answer');
      if (a.replyKey) paintReplyFeed(a.replyKey); else paintFeed(false);
      if (done) done(false);
    });
    return a;
  }
  function take(a, job) {
    a.jobId = job.jobId; a.status = job.status || a.status;
    if (job.globalMsgNum) a.no = job.globalMsgNum;
    if (job.sessionId) a.sessionId = job.sessionId;
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
    if (a.replyKey) paintReplyFeed(a.replyKey); else paintFeed(false);
    if (C.onAnswered) C.onAnswered();
    // A drop that became a question gets its answer as a follow-up: read the chat again.
    if (a.dropId) { C.asks = C.asks.filter(function (x) { return x !== a; }); setTimeout(function () { loadFeedQuietly(); }, 300); }
    refreshSummary();
  }
  function loadFeedQuietly() {
    if (!dropOn()) return;
    api('/api/inbox/feed?limit=100').then(function (d) { C.items = (d && d.items) || []; paintFeed(false); markReadIfShown(); }, function () {});
  }
  // The Ask sheet (app.js askCos) hands its words here, so the answer streams in the chat instead of vanishing.
  function askFromSheet(text) {
    return ensureCaps().then(function (caps) {
      if (!caps || !caps.jobs) { var off = new Error('Ask needs the durable query jobs switch on your Mac.'); off.code = 'durable_query_jobs_disabled'; throw off; }
      return new Promise(function (resolve, reject) {
        submitAsk(String(text || '').trim(), null, function (ok) { if (ok) resolve(['cos']); else reject(new Error('Not sent. The question is in Ask COS; try again there.')); });
      });
    });
  }

  // ── Reply in the message reader (6.99.12) ─────────────
  function replyName(key) { return 'reply-' + String(key); }
  function replyHtml(key, turn) {
    if (!askOn()) return '';
    var k = composer(replyName(key));
    k.sessionId = turn && typeof turn.sessionId === 'string' ? turn.sessionId : '';
    k.no = turn ? (turn.no != null ? turn.no : turn.globalMsgNum) : null;
    var label = k.no != null ? 'Reply to Message #' + k.no : 'Reply';
    return '<section class="cc cx-reply" data-reply-host="' + esc(key) + '" aria-label="' + esc(label) + '">' +
      '<h3 class="cx-reply-title">Reply</h3>' +
      '<p class="cx-reply-sub">' + esc(k.sessionId ? 'Continues this conversation. The answer lands in Messages with its own number.' : 'Starts a conversation. The answer lands in Messages with its own number.') + '</p>' +
      '<div class="cc-feed cx-reply-feed" data-reply-feed="' + esc(key) + '" aria-live="polite">' + replyFeedHtml(key) + '</div>' +
      composerHtml(k, { drop: false, placeholder: label, label: label }) + '</section>';
  }
  function replyFeedHtml(key) {
    return C.asks.filter(function (a) { return a.replyKey === replyName(key); }).map(function (a) { return askHtml(a, false); }).join('');
  }
  function paintReplyFeed(name) {
    var key = String(name).replace(/^reply-/, '');
    var feed = document.querySelector('[data-reply-feed="' + key + '"]');
    if (!feed) return;
    if (document.activeElement && feed.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    feed.innerHTML = replyFeedHtml(key);
  }
  // messages.js calls this once the reader's HTML is in the page.
  function mountReply(key) {
    var k = composer(replyName(key));
    hydrate(k);
    loadModels();
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
      if (ans && ans.next && ans.next.kind === 'ask' && C.caps && C.caps.jobs) submitAsk(ans.next.prompt, ans.drop.id, null, askFilesOf(ans.next));
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
    if (a.replyKey) paintReplyFeed(a.replyKey); else paintFeed(false);
  }
  function cancel(cid) {
    var a = C.asks.filter(function (x) { return x.cid === cid; })[0];
    if (!a || !a.jobId) return;
    api('/api/query-jobs/' + a.jobId + '/cancel', { method: 'POST', body: { generation: 1 } }).then(function (d) { if (d && d.job) take(a, d.job); paintAsk(a); }, function (err) { W.toast((err && err.message) || 'Cancel did not go through.'); });
  }

  // ── events (delegated from the Messages pane) ─────────
  function onClick(t) {
    var what = t.getAttribute('data-cos');
    if (what === 'ask') return doAsk(kOf(t));
    if (what === 'drop') return doDrop();
    if (what === 'all') return W.go('messages');
    if (what === 'read-all') return markReadIfShown(true);
    if (what === 'retry') { C.feedState = 'idle'; return loadFeed(); }
    if (what === 'act') return act(t.getAttribute('data-item'), t.getAttribute('data-act'));
    if (what === 'move-to') return moveTo(t.getAttribute('data-item'), t.getAttribute('data-dest'), t.getAttribute('data-domain'));
    if (what === 'move-cancel') { C.moving = ''; return paintFeed(false); }
    if (what === 'open-msg') return W.go('messages', ['m', t.getAttribute('data-no')]);
    if (what === 'steer') {
      var a = C.asks.filter(function (x) { return x.cid === t.getAttribute('data-cid'); })[0];
      if (a) { a.steering = !a.steering; if (a.replyKey) paintReplyFeed(a.replyKey); else paintFeed(false); var f = document.querySelector('[data-cos-steer="' + a.cid + '"] input'); if (f) f.focus(); }
      return;
    }
    if (what === 'cancel') return cancel(t.getAttribute('data-cid'));
    if (what === 'att-remove') return removeAtt(kOf(t), t.getAttribute('data-att'));
    if (what === 'att-retry') {
      var k = kOf(t), att = findAtt(k, t.getAttribute('data-att'));
      if (att) { k.signedOut = false; setNote(k, ''); startUpload(k, att); paintChips(k); paintButtons(k); }
      return;
    }
    if (what === 'sign-in') { if (W.showAuth) W.showAuth('Sign in again. Your message and files are kept; tap Retry on each file after.'); return; }
    if (what === 'quote') {
      // Tapping "Re: ..." scrolls to the drop it answers.
      var drop = C.host.querySelector('[data-drop-thread="' + t.getAttribute('data-thread') + '"]');
      if (drop) drop.scrollIntoView({ block: 'center' });
    }
  }
  function isComposerInput(el) { return !!(el && el.classList && el.classList.contains('cc-input')); }
  function onKey(e) {
    if (!isComposerInput(e.target) || e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
    e.preventDefault();
    var k = kOf(e.target);
    if (e.altKey) { if (k === CHAT && dropOn()) doDrop(); return; }
    doAsk(k);
  }
  function onInput(e) {
    if (isComposerInput(e.target)) { var k = kOf(e.target); k.draft = e.target.value; saveDraft(k); W.autoGrow(e.target); paintButtons(k); }
  }
  function onChangeEvent(e) {
    var t = e.target;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute('data-cos-model')) { C.model = t.value; save(); syncMenus(); }
    else if (t.hasAttribute('data-cos-effort')) { C.effort = t.value; save(); syncMenus(); }
    else if (t.hasAttribute('data-cos-file')) { addFiles(kOf(t), t.files); t.value = ''; }
  }
  // Two composers can be on screen (the chat beside a reader is not, but a reload can leave either): keep both menus true.
  function syncMenus() {
    document.querySelectorAll('[data-cos-model]').forEach(function (s) { if (s !== document.activeElement) s.value = C.model; });
    document.querySelectorAll('[data-cos-effort]').forEach(function (s) { if (s !== document.activeElement) s.value = C.effort; });
  }
  function onSubmit(e) {
    var f = e.target.closest && e.target.closest('[data-cos-steer]');
    if (f) { e.preventDefault(); steer(f.getAttribute('data-cos-steer'), (f.querySelector('input') || {}).value || ''); return true; }
    if (e.target.matches && e.target.matches('[data-cos-form]')) { e.preventDefault(); return true; }
    return false;
  }
  // Paste a photo or a file into the box; drop files on the composer.
  function onPaste(e) {
    if (!isComposerInput(e.target)) return;
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); addFiles(kOf(e.target), files); }
  }
  function onDrag(e) {
    var form = e.target && e.target.closest && e.target.closest('[data-cos-form]');
    if (!form) return;
    var types = e.dataTransfer && e.dataTransfer.types;
    var hasFiles = types && Array.prototype.indexOf.call(types, 'Files') >= 0;
    if (!hasFiles) return;
    e.preventDefault();
    if (e.type === 'dragover' || e.type === 'dragenter') { form.classList.add('dragging'); return; }
    form.classList.remove('dragging');
    if (e.type === 'drop') addFiles(composer(form.getAttribute('data-cos-form')), e.dataTransfer.files);
  }
  // Crossing 860 px shows the chat beside the list: load it then.
  window.matchMedia('(min-width: 860px)').addEventListener('change', function (m) {
    if (m.matches && on() && C.host && W.parseRoute().pane === 'messages') mount(C.host, true);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && dropOn() && chatVisible()) loadFeedQuietly();
  });

  W.cosChat = {
    on: on, dropOn: dropOn, askOn: askOn, known: function () { return !!C.caps; }, ensureCaps: ensureCaps, fromHealth: fromHealth, refreshSummary: refreshSummary,
    pinnedRowHtml: pinnedRowHtml, mount: mount, wide: wide,
    replyHtml: replyHtml, mountReply: mountReply, askFromSheet: askFromSheet,
    onClick: onClick, onKey: onKey, onInput: onInput, onChange: onChangeEvent, onSubmit: onSubmit, onPaste: onPaste, onDrag: onDrag,
    setOnChange: function (fn) { C.onChange = fn; }, setOnAnswered: function (fn) { C.onAnswered = fn; },
    // Test and render hooks: what the chat holds right now.
    classify: classify, uploadMedia: uploadMedia, uploadErrorText: uploadErrorText, uuid: uuid,
    _state: C, _composer: composer, _classify: classify, _modelsFrom: modelsFrom, _addFiles: addFiles, _itemHtml: itemHtml, _setCaps: setCaps
  };
})();
