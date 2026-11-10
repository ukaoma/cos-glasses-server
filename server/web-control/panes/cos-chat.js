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

   6.99.16, the COS thread (capabilities.dropIt.thread, routes/cos-thread.ts): each Ask from the chat's own composer
   reads GET /api/cos-thread first. `continue` sends that sessionId; `fresh` sends none and carries the server's digest
   as the Ask's `reference` (the query-jobs field for quoted context, so the Messages row shows only the question).
   While an Ask in the thread is still answering, the next one continues its conversation without asking. When an Ask
   finishes, POST /api/cos-thread/turn once with its answer. "New thread" in the header posts /api/cos-thread/new.
   Without the capability, the old rule stands: one conversation per day, kept in this browser.

   The rail badge on Messages (7.0.9, Miles 11/08: "notifications would just be for net new messages") is a number for
   `unread` only: what COS sent since the chat was last open on any device (the server keeps readAt, and the first
   7.0.9 open marked everything older as read). A dot, with no number, says something in the chat waits on your reply
   (`asked`). Work's Your move is not counted here: it has its own count on Today and in Work. It is read with the
   shell's existing status read (shell.js checkServer), never on a timer of its own, and painting it touches only the
   badge, never the pane. */
(function () {
  'use strict';
  var W = window.COSWeb;
  var $ = W.$, esc = W.esc, api = W.api;
  var STORE = 'cos.web.cosChat';
  var DRAFTS = 'cos.web.cosDrafts';

  var C = {
    archive: null,          // 7.0.9: the older questions (GET /api/inbox/archive) once opened, newest first
    archiveOpen: false,
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
    onAnswered: null,       // messages.js: re-read Recent when a web Ask lands
    thread: null,           // 6.99.16: the last GET /api/cos-thread answer
    threadCarried: '',      // the thread's newest session started fresh: 'summary' (it carried a digest) or 'plain'
    threadBusy: false,
    threadSession: '',      // 7.0.2: the session the COS thread's next Ask continues ('' when it starts fresh)
    defaultGen: 0           // 7.0.2: the newest /api/models read for the Default label; older answers are dropped
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
  // 6.99.16: the COS thread, advertised inside dropIt while Drop it is on.
  function threadOn() { return !!(C.caps && C.caps.dropIt && C.caps.thread); }
  function setCaps(h) {
    var caps = (h && h.capabilities) || {};
    var drop = caps.dropIt;
    var next = {
      dropIt: !!(drop && drop.enabled === true),
      // 6.99.13: how many files a drop takes. 0 (an older server): Drop is words only and says so.
      dropFiles: drop && drop.enabled === true && Number.isInteger(drop.attachments) && drop.attachments > 0 ? Math.min(drop.attachments, MAX_ATTS) : 0,
      // 6.99.16: /api/health carries it at features.durableQueryJobs (a boolean); /api/models at capabilities.durableQueryJobs.enabled.
      jobs: caps.durableQueryJobs === true || h && h.durableQueryJobs === true || !!(caps.durableQueryJobs && caps.durableQueryJobs.enabled) ||
        !!(h && h.features && h.features.durableQueryJobs === true),
      steer: !!(C.caps && C.caps.steer),
      thread: !!(drop && drop.enabled === true && drop.thread && drop.thread.protocol === 1),
      // 6.99.19: Prep (capabilities.prep, protocol 1). Absent on an older server: "Prep me" stays a plain Ask.
      prep: prepCapsOf(caps.prep),
      // 11/07: how many files a session turn takes (threadTurnAttachments). 0 (an older server): words only, and Today's
      // reply box shows no clip, so a file can never be dropped from a turn in silence.
      turnFiles: h && Number.isInteger(h.threadTurnAttachments) && h.threadTurnAttachments > 0 ? Math.min(h.threadTurnAttachments, MAX_ATTS) : 0,
      // 6.99.27: any file for a session turn, up to this many bytes (threadTurnFileBytes). 0: the chat's list only.
      turnFileBytes: h && Number.isInteger(h.threadTurnFileBytes) && h.threadTurnFileBytes > 0 ? Math.min(h.threadTurnFileBytes, MAX_DOC) : 0,
      // 6.99.31: the Mac runs the phone key signer (webKeySigner 1, only with COS_WEB_KEY_AUTHORITY on). Absent: 0, nothing offered.
      webKeySigner: h && h.webKeySigner === 1 ? 1 : 0
    };
    if (next.prep && next.prep.serverInstanceId) PREP_INST = next.prep.serverInstanceId;
    var changed = !C.caps || C.caps.dropIt !== next.dropIt || C.caps.jobs !== next.jobs || C.caps.thread !== next.thread;
    var filesChanged = !!C.caps && C.caps.dropFiles !== next.dropFiles;
    C.caps = next;
    if (!next.dropIt) { clearRail(); C.summary = null; }
    if (changed && C.onChange) C.onChange();
    else if (filesChanged) paintButtons(CHAT);
    if (next.dropIt) refreshSummary();
  }
  function prepCapsOf(p) {
    if (!p || typeof p !== 'object' || !(Number(p.protocol) >= 1)) return null;
    var files = Number.isInteger(p.maxFiles) && p.maxFiles > 0 ? Math.min(p.maxFiles, 10) : 10;
    var chars = Number.isInteger(p.steerChars) && p.steerChars > 0 ? Math.min(p.steerChars, 4000) : 4000;
    return { protocol: Number(p.protocol), maxFiles: files, steerChars: chars, bind: p.bind === true, suggest: p.suggest === true,
      serverInstanceId: typeof p.serverInstanceId === 'string' ? p.serverInstanceId : '' };
  }
  // The shell's status read (shell.js checkServer) hands its /api/health answer here.
  function fromHealth(h) { setCaps(h); if (C.asks.some(relayPending)) loadRelayRows(15000); }
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
  // `asked` is the chat's own part of `waiting` (7.0.9). An older server without it: the chat's part cannot be told
  // apart from Work's, so nothing is claimed as waiting on a reply here.
  function waitingOf(s) { var n = s && Number(s.asked); return Number.isInteger(n) && n > 0 ? n : 0; }
  function unreadOf(s) { var n = s && Number(s.unread); return Number.isInteger(n) && n > 0 ? n : 0; }
  // A number for what is new, a dot for a reply the chat waits on. Created on first paint, so with Drop it off the
  // rail's DOM is untouched.
  function paintRail() {
    var waiting = waitingOf(C.summary), unread = unreadOf(C.summary);
    document.querySelectorAll('.rail-btn[data-pane="messages"], #section-menu [data-goto="messages"]').forEach(function (b) {
      var count = b.querySelector('[data-inbox-count]');
      if (!count) {
        count = document.createElement('span'); count.className = 'inbox-count hidden'; count.setAttribute('data-inbox-count', '');
        var dot = document.createElement('span'); dot.className = 'inbox-dot hidden'; dot.setAttribute('data-inbox-dot', '');
        b.appendChild(count); b.appendChild(dot);
      }
      count.textContent = unread > 99 ? '99+' : String(unread);
      count.classList.toggle('hidden', !unread);
      b.querySelector('[data-inbox-dot]').classList.toggle('hidden', !(waiting && !unread));
      var label = [unread ? unread + ' new in COS' : '', waiting ? waiting + ' waiting on your reply' : ''].filter(Boolean).join(', ');
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
    return [u ? u + ' new' : '', w ? w + ' waiting on your reply' : ''].filter(Boolean).join(' · ');
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
  // 7.0.2 (A7): what "Default" resolves to on this Mac (/api/models defaultModel: the session's preference, then
  // COS_G2_DEFAULT_MODEL, then the built-in default), named in the menu: "Default (Codex Frontier)". On 11/07 Default
  // was Codex while Codex was out of usage, and nothing on the page said so. An older server sends no field: plain Default.
  // A session bound to a key profile reads "Default (key profile)".
  function defaultLabel(d) {
    if (d && d.source === 'profile') return 'key profile';
    var pref = d && typeof d.preference === 'string' ? d.preference : '';
    if (!pref) return '';
    for (var i = 0; i < CLAUDE_MENU.length; i++) if (CLAUDE_MENU[i][0] === pref) return CLAUDE_MENU[i][1];
    if (pref === 'haiku') return 'Claude Haiku';
    return ENGINE[pref] ? (ENGINE[pref] + (FALLBACK[pref] ? ' ' + FALLBACK[pref] : '')) : '';
  }
  // The session an Ask from the chat continues, whose preference "Default" follows: the COS thread's newest session in
  // thread mode, else the chat's own (C.session).
  function defaultSession() { return threadOn() ? String(C.threadSession || '') : C.session && C.session.id ? String(C.session.id) : ''; }
  // Each read is stamped with a generation and the session it asked about. An answer is used for the label only while
  // it is still the newest read and the chat still continues that session, so a slow answer for an older session never
  // overwrites a newer label (skeptic, 7.0.2).
  function modelsRead() {
    var sid = defaultSession();
    return { gen: ++C.defaultGen, sid: sid, path: '/api/models' + (sid ? '?sessionId=' + encodeURIComponent(sid) : '') };
  }
  function currentRead(r) { return r.gen === C.defaultGen && r.sid === defaultSession(); }
  // QA W5: the label is read again after each Ask finishes and whenever that session changes, so it never goes stale.
  function refreshDefault() {
    if (!C.models) return null;
    var r = modelsRead();
    return api(r.path).then(function (m) {
      if (!currentRead(r)) return;
      var label = defaultLabel(m && m.defaultModel);
      if (label !== C.defaultLabel) { C.defaultLabel = label; paintModelMenu(); }
    }, function () {});
  }
  function loadModels() {
    if (C.models) return;
    C.models = [];
    var r = modelsRead();
    api(r.path).then(function (m) {
      C.models = modelsFrom(m);
      if (currentRead(r)) C.defaultLabel = defaultLabel(m && m.defaultModel);
      if (C.model && !C.models.some(function (o) { return o.value === C.model; })) { C.model = ''; save(); }
      // Steer exists only where the server says so (/api/models capabilities.durableQueryJobs.steer).
      var j = m && m.capabilities && m.capabilities.durableQueryJobs;
      if (C.caps) C.caps.steer = !!(j && j.steer);
      paintModelMenu();
    }, function () { C.models = []; paintModelMenu(); });
  }
  function modelMenuHtml() {
    var list = C.models || [];
    var opts = ['<option value="">' + esc(C.defaultLabel ? 'Default (' + C.defaultLabel + ')' : 'Default') + '</option>'].concat(list.map(function (m) {
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
        cameraHtml('data-cos-file') + clipHtml('data-cos-file') +
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
  function chatMode() { return dropOn() ? (threadOn() ? 'drop-thread' : 'drop') : 'ask'; }
  function chatSkeleton() {
    var drop = dropOn();
    return '<section class="cc" data-cos-chat data-mode="' + chatMode() + '" data-tint="messages" aria-label="' + (drop ? 'COS chat' : 'Ask COS') + '">' +
      '<header class="cc-head"><span class="cc-avatar big">' + MARK + '</span><div class="cc-head-text"><h2 class="cc-title">' + (drop ? 'COS' : 'Ask COS') + '</h2>' +
        '<p class="cc-sub">' + (drop ? 'Text it anything: a thought, an ask, a reminder. It texts back.' : 'Ask anything, with photos or files. Each answer lands in Messages with its number, here and on the glasses.') + '</p></div>' +
        '<div class="cc-head-acts"><button type="button" class="link-btn cc-all" data-cos="all">All messages</button>' +
        (drop ? '<button type="button" class="link-btn" data-cos="read-all">Mark all read</button>' : '') +
        (threadOn() ? '<button type="button" class="link-btn" data-cos="new-thread">New thread</button>' : '') + '</div>' +
        (threadOn() ? '<p class="cc-thread" data-cos-thread role="status">' + esc(threadLine()) + '</p>' : '') + '</header>' +
      '<div class="cc-feed" data-cos-feed aria-live="polite"></div>' +
      composerHtml(CHAT, { drop: drop, placeholder: drop ? 'Ask COS or drop a thought' : 'Ask COS anything', label: 'Message to COS' }) +
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
      if (P) paintPrep(true);
    }
    if (!visible) return;
    loadModels();
    if (threadOn()) loadThread();
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
  // ── older questions (7.0.9, Miles 11/08: "Expire after 7 days") ──
  // What still asks for a reply but was asked 7 days ago or more stops counting as waiting (server rule
  // WAITING_EXPIRY_DAYS, drop-service.ts) and shows here, closed until opened. Each still answers as in the chat, and
  // answering it takes it off this list. The count and the days come from the server, so no rule is kept here.
  function archivedOf(s) { var n = s && Number(s.archived); return Number.isInteger(n) && n > 0 ? n : 0; }
  function archiveHtml() {
    var n = C.archive ? C.archive.length : archivedOf(C.summary);
    if (!n) return '';
    var days = (C.summary && Number(C.summary.waitingExpiryDays)) || 7;
    var body = !C.archiveOpen ? '' : C.archive === null ? '<p class="cc-fine">Reading older questions.</p>'
      : C.archive.map(itemHtml).join('');
    return '<details class="cc-archive" data-cos-archive' + (C.archiveOpen ? ' open' : '') + '><summary data-cos="archive">' +
      n + (n === 1 ? ' older question' : ' older questions') + '</summary>' +
      '<p class="cc-fine">Asked more than ' + days + ' days ago, so ' + (n === 1 ? 'it no longer counts' : 'they no longer count') + ' as waiting on you. You can still answer here.</p>' +
      body + '</details>';
  }
  function loadArchive() {
    return api('/api/inbox/archive').then(function (d) {
      C.archive = (d && Array.isArray(d.items)) ? d.items : [];
      paintFeed(false);
    }, function () { if (C.archive === null) C.archive = []; paintFeed(false); });
  }
  function toggleArchive() {
    C.archiveOpen = !C.archiveOpen;
    if (C.archiveOpen) { C.archive = null; loadArchive(); }
    else paintFeed(false);
  }
  function markReadIfShown(force) {
    if (!dropOn() || !chatVisible() || !C.items || !C.items.length) return;
    if (!force && C.summary && !unreadOf(C.summary)) return;
    var last = C.items[C.items.length - 1];
    api('/api/inbox/read', { method: 'POST', body: { through: last.id } }).then(function (r) {
      if (C.summary) { C.summary.unread = r.unread; if (typeof r.waiting === 'number') C.summary.waiting = r.waiting; if (typeof r.asked === 'number') C.summary.asked = r.asked; }
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
    // A P2 follow-up already carries its own Dismiss (6.99.11); add one only to an item that does not (6.99.15: it showed twice).
    if (item.needsReply && !rest.some(function (a) { return a.id === 'dismiss'; })) rest.push({ id: 'dismiss', label: 'Dismiss' });
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
  // The finished answer as Markdown, its lens-plain inline lists on their own lines first (structureLensAnswer); while it
  // streams, plain words, so a half-written "**bold" never shows its stars.
  function answerHtml(a) {
    if (a.response) return W.md(W.structureLensAnswer(a.response));
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
  // ── what a running answer is doing, and where a relayed message went (7.0.9) ──
  // Miles 11/08: "It's hard to see when a session is making progress, whereas when you're wearing it on the glasses, we
  // can see the whole audit trail." The steps are the job's own trail (GET /api/query-jobs/:id?trail=1, the lens's
  // data, redacted for secrets on the Mac at the journal), read by the poll this card already runs. While it runs: the
  // newest few, newest last. Once it ends: a quiet "N steps" that opens.
  var TERMINAL = { completed: 1, failed: 1, canceled: 1, interrupted: 1 };
  function askRunning(a) { return !TERMINAL[a.status]; }
  function hasText(a) { return !!(a.response || a.partial); }
  var STEP_VERBS = { read: 'Read', edit: 'Edited', write: 'Edited', bash: 'Ran', search: 'Searched', task: 'Delegated', other: 'Used' };
  var LIVE_STEPS = 6, DONE_STEPS = 40;
  // A path on the Mac shows as its last part only. Paths are not secrets on the Mac, but the web never shows one.
  var MAC_PATH = /(?:~|\/(?:Users|home|private|var|tmp|opt|Volumes|Library|System|Applications|etc))(?:\/[^\s'"`()<>\[\]{},;|]+)+\/?/g;
  function scrubPaths(text) {
    return String(text || '').replace(MAC_PATH, function (p) { var parts = p.replace(/\/+$/, '').split('/'); return parts[parts.length - 1] || 'a file'; });
  }
  function stepText(e) {
    if (!e || typeof e !== 'object') return null;
    if (e.kind === 'tool') {
      var target = clip(scrubPaths(e.target), 90), detail = clip(scrubPaths(e.detail), 60);
      if (target === 'SendMessage') return { kind: 'tool', text: 'Sent a message' + (detail ? ' ' + detail : '') };
      var verb = STEP_VERBS[e.verb] || 'Used';
      return { kind: 'tool', text: (target ? verb + ' ' + target : verb) + (detail ? ' (' + detail + ')' : '') };
    }
    if (e.kind === 'status' && (e.detail || e.needs_action)) return { kind: 'note', text: clip(scrubPaths(e.detail || e.needs_action), 140) };
    if (e.kind === 'prose' && e.text) return { kind: 'prose', text: clip(scrubPaths(e.text), 160) };
    return null;
  }
  function stepsOf(a) {
    var out = [];
    (a.trail || []).forEach(function (e) { var t = stepText(e); if (t && t.text) out.push(t); });
    return out;
  }
  function stepLi(t) { return '<li class="cc-step ' + t.kind + '">' + esc(t.text) + '</li>'; }
  function earlierLi(n) { return n > 0 ? '<li class="cc-step more">' + n + ' earlier ' + (n === 1 ? 'step' : 'steps') + '</li>' : ''; }
  function stepsHtml(a) {
    var steps = stepsOf(a);
    if (!steps.length) return '';
    if (askRunning(a)) {
      var live = steps.slice(-LIVE_STEPS);
      return '<ol class="cc-steps live" aria-label="What COS is doing">' + earlierLi(steps.length - live.length) + live.map(stepLi).join('') + '</ol>';
    }
    var kept = steps.slice(-DONE_STEPS);
    return '<details class="cc-steps-done"' + (a.stepsOpen ? ' open' : '') + '><summary data-cos="steps" data-cid="' + esc(a.cid) + '">' +
      steps.length + (steps.length === 1 ? ' step' : ' steps') + '</summary><ol class="cc-steps">' + earlierLi(steps.length - kept.length) + kept.map(stepLi).join('') + '</ol></details>';
  }

  // Issue 4 (Miles 11/08, Message #465 "Why aren't you responding to the other session?"): an answer that sent a message
  // to another session (SendMessage in its trail) gets that session's reply in that session, never here. The card says
  // where it went, opens that session, and shows its newest reply once the session has answered. Read from the session
  // list the shell already keeps (W.sessionList, cached), refreshed by the live stream and the shell's status read.
  function relaysOf(a) {
    var out = [];
    (a.trail || []).forEach(function (e) {
      if (!e || e.kind !== 'tool' || String(e.target) !== 'SendMessage') return;
      var m = /^to (.+)$/.exec(String(e.detail || '').trim());
      var name = m && m[1] !== 'another session' && m[1] !== 'every session' ? m[1].trim() : '';
      if (out.indexOf(name) < 0) out.push(name);
    });
    return out.slice(-2);
  }
  function rowTitle(r) { return String(r.display_label || r.custom_title || r.title || '').replace(/\s+/g, ' ').trim(); }
  function relayRow(name) {
    if (!name || !Array.isArray(C.sessionRows)) return null;
    var want = name.toLowerCase(), sid = /^session ([0-9a-f]{8})$/i.exec(name);
    for (var i = 0; i < C.sessionRows.length; i++) {
      var r = C.sessionRows[i], id = String(r.session_id || r.id || '').replace(/^(claude|codex|cursor):/, '');
      if (sid ? id.toLowerCase().indexOf(sid[1].toLowerCase()) === 0 : rowTitle(r).toLowerCase() === want || id.toLowerCase() === want) return r;
    }
    return null;
  }
  function msOf(v) { var d = W.toDate(v); return d ? d.getTime() : 0; }
  // The session's newest reply, only once it came after this Ask started.
  function relayReply(r, a) {
    var text = r && String(r.last_reply || '').trim();
    if (!text) return '';
    var at = msOf(r.state_since) || msOf(r.last_activity_at);
    return at && at > (a.at || 0) ? text : '';
  }
  function relayHtml(a) {
    var names = relaysOf(a);
    if (!names.length) return '';
    return '<div class="cc-relays" data-ask-relay>' + names.map(function (name) {
      var r = relayRow(name), title = r ? rowTitle(r) || name : name, reply = relayReply(r, a);
      var id = r ? String(r.session_id || r.id || '').replace(/^(claude|codex|cursor):/, '') : '';
      var where = title ? 'Sent to ' + title + '.' : 'Sent to another session.';
      return '<div class="cc-relay"><p class="cc-relay-line">' + esc(where) + ' Its answer shows in that session, not here.</p>' +
        (reply ? '<p class="cc-relay-reply"><span class="cc-relay-who">' + esc(title || 'The session') + ' replied</span>' + esc(clip(scrubPaths(reply), 400)) + '</p>' :
          askRunning(a) ? '' : '<p class="cc-fine">Its reply shows here when it answers.</p>') +
        '<div class="cc-acts">' + (r ? '<button type="button" class="cx-btn" data-cos="open-session" data-provider="' + esc(r.provider || 'claude') + '" data-sid="' + esc(id) + '">Open session</button>'
          : '<button type="button" class="cx-btn quiet" data-cos="open-sessions">Open Sessions</button>') + '</div></div>';
    }).join('') + '</div>';
  }
  function relayPending(a) {
    if (!relaysOf(a).length || Date.now() - (a.at || 0) > 2 * 3600000) return false;
    return relaysOf(a).some(function (n) { var r = relayRow(n); return !relayReply(r, a); });
  }
  var relayHooked = false;
  function loadRelayRows(maxAgeMs) {
    if (!W.sessionList) return;
    W.sessionList(maxAgeMs).then(function (d) {
      if (!d || !Array.isArray(d.sessions)) return;
      C.sessionRows = d.sessions;
      C.asks.forEach(function (x) { if (relaysOf(x).length) paintRelay(x); });
    }, function () {});
  }
  // No loop of its own: the first read when a relay shows up, then the live stream's frames and the shell's status read.
  function watchRelays(a) {
    if (!relaysOf(a).length || a.relayWatched) return;
    a.relayWatched = true;
    loadRelayRows(15000);
    if (!relayHooked && W.live && typeof W.live.on === 'function') {
      relayHooked = true;
      W.live.on(function () { if (C.asks.some(relayPending)) loadRelayRows(15000); });
    }
  }
  function paintRelay(a) {
    var el = document.querySelector('[data-ask="' + a.cid + '"]');
    var box = el && el.querySelector('[data-ask-relay-slot]');
    if (!box) return;
    var html = relayHtml(a);
    if (box.getAttribute('data-html') !== html) { box.innerHTML = html; box.setAttribute('data-html', html); }
  }
  // Issue 2 (Message #463 said "Answered" over "COS is answering"): a finished Ask with no words. The card used to read
  // "no words yet" as "still answering". Now it reads the turn from Messages once (the answer may have reached Messages
  // after this card's last read), and if Messages has no words either, says so, with its steps and where it sent things.
  function emptyAnswerHtml(a) {
    if (a.recovering) return '<span class="cc-wait">Reading the answer from Messages.</span>';
    if (relaysOf(a).length) return '';
    return '<span class="cc-wait">COS finished without a written answer.' + (stepsOf(a).length ? ' What it did is under steps.' : '') + '</span>';
  }
  function recoverAnswer(a) {
    if (a.recovered || a.recovering) return Promise.resolve();
    a.recovered = true;
    if (!a.no) return Promise.resolve();
    a.recovering = true;
    paintAsk(a);
    return api('/api/sessions/today/all-messages?limit=100').then(function (d) {
      var list = (d && d.messages) || [];
      for (var i = list.length - 1; i >= 0; i--) {
        var t = list[i], no = t.no != null ? t.no : t.globalMsgNum;
        if (Number(no) === Number(a.no) && (!a.sessionId || !t.sessionId || t.sessionId === a.sessionId)) {
          if (typeof t.text === 'string' && t.text.trim()) a.response = t.text;
          break;
        }
      }
    }, function () {}).then(function () { a.recovering = false; paintAsk(a, true); });
  }
  function askHtml(a, linked) {
    var running = a.status === 'sending' || a.status === 'queued' || a.status === 'running';
    var title = a.no ? 'Message #' + a.no : 'Asking COS';
    var body = answerHtml(a);
    // "COS is answering" only while it is; a finished Ask with no words says so (issue 2).
    if (!body) body = a.status === 'completed' ? emptyAnswerHtml(a) : askRunning(a) ? '<span class="cc-wait">COS is answering. It also lands in Messages on the glasses.</span>' : '';
    var acts = '';
    if (running && a.jobId) {
      acts = (C.caps && C.caps.steer && a.steerable !== false ? '<button type="button" class="link-btn cc-text-btn" data-cos="steer" data-cid="' + a.cid + '">Steer</button>' : '') +
        '<button type="button" class="link-btn cc-text-btn" data-cos="cancel" data-cid="' + a.cid + '">Cancel</button>';
    } else if (a.status === 'completed' && a.no) {
      acts = '<button type="button" class="cx-btn primary" data-cos="open-msg" data-no="' + a.no + '">Open in Messages</button>';
    } else if ((a.status === 'failed' || a.status === 'interrupted') && a.jobId && !a.retried && !a.prepDraftId) {
      acts = a.againBlocked
        ? '<button type="button" class="cx-btn" disabled aria-disabled="true">Ask again</button><span class="cc-fine">' + esc(a.againBlocked) + '</span>'
        : '<button type="button" class="cx-btn primary" data-cos="again" data-cid="' + a.cid + '">Ask again</button>';
    }
    // A drop that became a question already shows its words as the drop: only the answer card is added.
    return (linked ? '' : '<div class="cc-line you"><div class="cc-bubble">' + esc(a.query) + '</div>' + sentAttsHtml(a.atts) + '<div class="cc-src">' + (a.replyKey ? 'Replied on the web' : 'Asked on the web') + '</div></div>') +
      '<div class="cc-line cos" data-ask="' + a.cid + '"><span class="cc-avatar">' + MARK + '</span><div class="cc-card">' +
      '<p class="cc-card-title"><span data-ask-title>' + esc(title) + '</span><span class="cx-time" data-ask-state>' + esc(askState(a)) + '</span></p>' +
      '<div class="cc-answer md" data-ask-body>' + body + '</div>' +
      '<div class="cc-steps-slot" data-ask-steps>' + stepsHtml(a) + '</div>' +
      '<div data-ask-relay-slot>' + relayHtml(a) + '</div>' +
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
      // 7.0.9: a question asked 7 days ago or more (the server marks it `archived`) lives under older questions.
      var rows = (C.items || []).filter(function (it) { return !it.archived; }).map(function (it) { return { at: it.createdAt, html: itemHtml(it) }; });
      C.asks.forEach(function (a) { if (!a.replyKey) rows.push({ at: new Date(a.at + (a.dropId ? 1 : 0)).toISOString(), html: askHtml(a, !!a.dropId) }); });
      rows.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
      var older = archiveHtml();
      html = rows.length || older ? older + rows.map(function (r) { return r.html; }).join('')
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
  // `inPlace`: repaint this card only, never the chat around it (a late answer from recoverAnswer).
  function paintAsk(a, inPlace) {
    var el = document.querySelector('[data-ask="' + a.cid + '"]');
    if (!el) return a.replyKey ? paintReplyFeed(a.replyKey) : paintFeed(false);
    var running = a.status === 'sending' || a.status === 'queued' || a.status === 'running';
    var title = el.querySelector('[data-ask-title]'); if (title) title.textContent = a.no ? 'Message #' + a.no : 'Asking COS';
    var st = el.querySelector('[data-ask-state]'); if (st) st.textContent = askState(a);
    var body = el.querySelector('[data-ask-body]'); var text = a.response || a.partial;
    if (body && text && body.getAttribute('data-len') !== String(text.length) + (a.response ? 'r' : '')) { body.innerHTML = answerHtml(a); body.setAttribute('data-len', String(text.length) + (a.response ? 'r' : '')); }
    // No words and no longer running: never leave "COS is answering" under a finished card (issue 2).
    else if (body && !text && !askRunning(a)) { var none = a.status === 'completed' ? emptyAnswerHtml(a) : ''; if (body.getAttribute('data-none') !== none) { body.innerHTML = none; body.setAttribute('data-none', none); body.removeAttribute('data-len'); } }
    var steps = el.querySelector('[data-ask-steps]');
    if (steps) { var sig = (a.trail ? a.trail.length + ':' + (a.trail.length ? a.trail[a.trail.length - 1].trailSeq : 0) : '0') + (askRunning(a) ? 'r' : 'd'); if (steps.getAttribute('data-sig') !== sig) { steps.innerHTML = stepsHtml(a); steps.setAttribute('data-sig', sig); } }
    paintRelay(a);
    if (!running && !inPlace) { if (a.replyKey) paintReplyFeed(a.replyKey); else paintFeed(false); }
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
  // QA 6.99.27 (User 3): every browser on an iPhone or iPad is WebKit and decodes HEIC, including the Home Screen web
  // app, whose user agent has no "Safari" in it. iPadOS asks for the desktop site by default, so it reads as a Mac
  // with a touch screen.
  function appleMobile() {
    var nav = window.navigator || {}, ua = nav.userAgent || '';
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1);
  }
  function heicReadable() { return isSafari() || appleMobile(); }
  /** What a file is to COS: 'photo', 'doc' or 'video', with a refusal sentence when it cannot be attached. */
  function classify(file) {
    var type = String(file.type || '').toLowerCase(), ext = extOf(file.name);
    var heic = /^image\/hei[cf]/.test(type) || ext === 'heic' || ext === 'heif';
    if (heic && !heicReadable()) return { refuse: file.name + ' is a HEIC photo, which only Safari can read here. Attach it from Safari, or save it as a JPEG first.' };
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
  // ── the attach kit (11/07: "attach files and images from the dashboard view as well") ──
  // The clip, the chips, the limits and the upload above, for any place that sends files with words: the chat's own
  // composers, Today's reply and note boxes (panes/today-actions.js) and the Ask sheet (app.js). One copy, used by all.
  // A box is { atts: [], signedOut: false, ui } (W.cosChat.attach.box): ui.changed(box) repaints after any change, ui.removed(box) runs after a
  // Remove, ui.signedOut(box) says the browser was signed out mid-upload. Progress moves only the chip's own bar
  // (paintProgress, by the chip's id). Nothing here sends: each caller sends the ready ids its own way, and only once
  // pending() and failed() are both false.
  // opts.any (a session turn): no accept list, so any file, and the label says the limits.
  function clipHtml(fileAttr, opts) {
    var any = !!(opts && opts.any);
    var label = any ? 'Attach photos or files, up to 5, ' + mb(opts.any) + ' each' : 'Attach photos or files';
    return '<label class="cx-btn cc-attach" title="' + esc(label) + '"><svg class="icon" aria-hidden="true"><use href="#i-clip"/></svg><span class="sr-only">' + esc(label) + '</span>' +
      // No capture attribute: iOS then offers Photo Library, Take Photo and Choose File.
      '<input type="file" class="cc-file" multiple' + (any ? '' : ' accept="' + ACCEPT + '"') + ' ' + fileAttr + ' aria-label="' + esc(label) + '"></label>';
  }
  // 6.99.27 (Miles: "take picture"): the camera itself, one tap. On a phone or tablet only: a desktop browser ignores
  // `capture` and would open a second file picker labelled Take photo.
  function cameraOn() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  function cameraHtml(fileAttr) {
    if (!cameraOn()) return '';
    return '<label class="cx-btn cc-attach cc-camera" title="Take photo"><svg class="icon" aria-hidden="true"><use href="#i-camera"/></svg><span class="sr-only">Take photo</span>' +
      '<input type="file" class="cc-file" accept="image/*" capture="environment" ' + fileAttr + ' aria-label="Take photo"></label>';
  }
  // The limits in plain words, under the chips of a session turn.
  function limitLine(box) {
    return box && box.anyBytes ? 'Up to 5 files, ' + mb(box.anyBytes) + ' each (videos up to ' + mb(MAX_VIDEO) + '). The session gets where each one is on your Mac.' : 'Up to 5 photos or files.';
  }
  // A composer here has no ui of its own (it is made before COMPOSER_UI below exists): it is the chat's.
  function uiOf(box) { return box.ui || COMPOSER_UI; }
  function boxChanged(box) { var ui = uiOf(box); if (ui.changed) ui.changed(box); }
  /**
   * 6.99.27: what a SESSION turn takes, which is more than the chat does. The agent gets each file's place on the Mac and
   * opens it with its own tools, so any type goes, up to `maxBytes` (the Mac's threadTurnFileBytes, 64 MB) and up to
   * 100 MB for an MP4 or MOV (the media store's video cap). Photos go as taken: kind 'photo' only for the chip.
   * QA 6.99.27 (Skeptic W3): the 100 MB is only for a file whose type is video/mp4 or video/quicktime (or, with no type,
   * whose name says so). Any other video (WebM, MKV) is a turn file on the Mac, whose cap is 64 MB, so it is refused
   * here before the upload rather than after it.
   */
  function classifyForSession(file, maxBytes) {
    var type = String(file.type || '').toLowerCase(), ext = extOf(file.name);
    var kindOf = type || VIDEO_EXT[ext] || '';
    var video = kindOf === 'video/mp4' || kindOf === 'video/quicktime';
    var cap = video ? MAX_VIDEO : maxBytes;
    if (file.size > cap) return { refuse: file.name + ' is ' + mb(file.size) + '. A session takes ' + (video ? 'a video' : 'a file') + ' up to ' + mb(cap) + '.' };
    if (!file.size) return { refuse: file.name + ' is empty.' };
    if (/^image\//.test(type) || PHOTO_EXT[ext]) {
      var heic = /^image\/hei[cf]/.test(type) || ext === 'heic' || ext === 'heif';
      return { kind: 'photo', mime: type || 'application/octet-stream', showable: !heic || heicReadable() };
    }
    if (video) return { kind: 'video', mime: kindOf };
    return { kind: DOC_EXT[ext] ? 'doc' : 'file', mime: type && type !== 'application/octet-stream' ? type : DOC_EXT[ext] || 'application/octet-stream' };
  }
  function dropThumb(t) { if (t.raw && /^blob:/.test(t.thumb || '')) { try { URL.revokeObjectURL(t.thumb); } catch (_e) {} } }
  function objectUrl(file) { try { return URL.createObjectURL(file); } catch (_e) { return ''; } }
  function boxAdd(box, files) {
    var list = Array.prototype.slice.call(files || []);
    var refusals = [];
    list.forEach(function (file) {
      if (box.atts.length >= MAX_ATTS) { refusals.push('Up to 5 attachments per message. ' + file.name + ' was not added.'); return; }
      var c = box.anyBytes ? classifyForSession(file, box.anyBytes) : classify(file);
      if (c.refuse) { refusals.push(c.refuse); return; }
      var t = { id: uuid(), file: file, name: file.name || (c.kind === 'photo' ? 'Photo' : 'File'), size: file.size, kind: c.kind, mime: c.mime || '', state: 'reading', progress: 0, mediaId: '', thumb: '', error: '' };
      // 6.99.27, a session turn: the file as it is, never resized or converted (the agent reads the original), and the
      // upload says so, so the Mac keeps a format the media store does not read (lib/turn-file-store.ts).
      if (box.anyBytes) { t.raw = true; t.purpose = 'session-turn'; if (c.kind === 'photo' && c.showable) t.thumb = objectUrl(file); }
      box.atts.push(t);
      startUpload(box, t);
    });
    if (list.length) box.signedOut = false;
    return refusals;
  }
  function addFiles(k, files) {
    if (!files || !files.length) return;
    var refusals = boxAdd(k, files);
    setNote(k, refusals.join(' '));
    paintChips(k); paintButtons(k);
  }
  function chipMeta(t) {
    if (t.state === 'reading') return t.kind === 'photo' ? 'Resizing' : 'Preparing';
    if (t.state === 'uploading') return 'Uploading ' + Math.round(t.progress * 100) + '%';
    if (t.state === 'failed') return t.error || 'Did not upload';
    return sizeLabel(t.size);
  }
  // attr: the click attribute the box's own handler reads ('data-cos' here, 'data-ta' on Today, 'data-action' in the
  // Ask sheet), so a chip's Remove never reaches another box's handler.
  function chipHtml(t, attr) {
    attr = attr || 'data-cos';
    var icon = t.thumb ? '<img src="' + esc(t.thumb) + '" alt="">' : '<svg class="icon" aria-hidden="true"><use href="#i-' + (t.kind === 'video' ? 'video' : t.kind === 'photo' ? 'photo' : 'doc') + '"/></svg>';
    return '<div class="cc-chip ' + t.state + '" data-chip="' + t.id + '"><span class="cc-chip-thumb">' + icon + '</span>' +
      '<span class="cc-chip-text"><span class="cc-chip-name">' + esc(t.name) + '</span><span class="cc-chip-meta" data-chip-meta>' + esc(chipMeta(t)) + '</span></span>' +
      (t.state === 'failed' ? '<button type="button" class="link-btn cc-chip-retry" ' + attr + '="att-retry" data-att="' + t.id + '">Retry</button>' : '') +
      '<button type="button" class="cc-chip-x" ' + attr + '="att-remove" data-att="' + t.id + '" aria-label="Remove ' + esc(t.name) + '"><span aria-hidden="true">×</span></button>' +
      (t.state === 'uploading' || t.state === 'reading' ? '<span class="cc-chip-bar" data-chip-bar style="width:' + Math.round(t.progress * 100) + '%"></span>' : '') + '</div>';
  }
  function paintChips(k) {
    var form = formOf(k), box = form && form.querySelector('[data-cos-chips]');
    if (!box) return;
    box.innerHTML = k.atts.map(function (t) { return chipHtml(t); }).join('');
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
  function boxRemove(box, id) {
    box.atts = box.atts.filter(function (t) { if (t.id === id) { if (t.xhr) { try { t.xhr.abort(); } catch (_e) {} } dropThumb(t); } return t.id !== id; });
    var ui = uiOf(box); if (ui.removed) ui.removed(box);
    boxChanged(box);
  }
  function removeAtt(k, id) { boxRemove(k, id); }
  function boxRetry(box, id) {
    var t = findAtt(box, id);
    if (!t) return false;
    box.signedOut = false;
    startUpload(box, t);
    boxChanged(box);
    return true;
  }
  // QA 6.99.27: the files that went with a message leave the box. That is not a Remove, so ui.removed is not told (the
  // reader's clears the status line, which may be telling the person about the message that just took them). Answers
  // what left, enough to put each back as a kept chip (boxRestore) if the message does not go after all.
  function boxTake(box, ids) {
    var went = [];
    box.atts = box.atts.filter(function (t) {
      if (!t.mediaId || ids.indexOf(t.mediaId) < 0) return true;
      went.push({ mediaId: t.mediaId, name: t.name, size: t.size, kind: t.kind, mime: t.mime, keptAt: t.keptAt || 0 });
      dropThumb(t);
      return false;
    });
    if (went.length) boxChanged(box);
    return went;
  }
  // Files the Mac already keeps, back on the box as ready chips (no upload), at most five in all. Answers how many are
  // on the box afterwards out of those asked for.
  function boxRestore(box, files) {
    var back = 0;
    (files || []).forEach(function (f) {
      if (!f || !f.mediaId) return;
      if (box.atts.some(function (t) { return t.mediaId === f.mediaId; })) { back++; return; }
      if (box.atts.length >= MAX_ATTS) return;
      box.atts.push({ id: uuid(), file: null, name: f.name || 'File', size: f.size || 0, kind: f.kind || 'file', mime: f.mime || '', state: 'ready', progress: 1, mediaId: f.mediaId, thumb: '', error: '', keptAt: f.keptAt || 0 });
      back++;
    });
    if (back) boxChanged(box);
    return back;
  }
  // Everything goes, an upload still running included (its request is stopped, and its late answer finds no record).
  function boxClear(box) {
    box.atts.forEach(function (t) { if (t.xhr) { try { t.xhr.abort(); } catch (_e) {} } dropThumb(t); });
    box.atts = [];
    boxChanged(box);
  }
  // The chat's composers, as boxes.
  var COMPOSER_UI = {
    changed: function (k) { paintChips(k); paintButtons(k); },
    removed: function (k) { if (!uploadsFailed(k) && /did not upload/i.test(k.note)) setNote(k, ''); },
    signedOut: function (k) { setNote(k, 'This browser was signed out. Your message and files are kept. Sign in, then tap Retry on each file.'); }
  };
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
  // extra: more headers (6.99.27: X-COS-Purpose for a session turn's file).
  // QA 6.99.27 (User 8): an upload that makes no progress for a minute stops and says so, and one that stopped while
  // the page was hidden (the phone locked, the browser in the background) says that, never that the Mac did not answer.
  var UPLOAD_STALL_MS = 60000;
  function uploadRequest(path, body, headers, onProgress, t, extra) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      t.xhr = xhr;
      var stall = null, stalled = false, wasHidden = !!document.hidden;
      var onVisibility = function () { if (document.hidden) wasHidden = true; };
      var watch = function () { clearTimeout(stall); stall = setTimeout(function () { stalled = true; try { xhr.abort(); } catch (_e) {} }, UPLOAD_STALL_MS); };
      var settle = function () {
        clearTimeout(stall); stall = null; t.xhr = null;
        if (document.removeEventListener) document.removeEventListener('visibilitychange', onVisibility);
      };
      // The bytes are all sent: the Mac is reading the file, which is not a stall.
      var sent = function () { clearTimeout(stall); stall = null; };
      var stopped = function () {
        var err = wasHidden || document.hidden ? new Error('The upload stopped while the phone was locked. Retry it.') : new Error('The upload stopped. Nothing moved for a minute. Retry it.');
        err.code = wasHidden || document.hidden ? 'upload_locked' : 'upload_stalled';
        return err;
      };
      if (document.addEventListener) document.addEventListener('visibilitychange', onVisibility);
      xhr.open('POST', path, true);
      xhr.setRequestHeader('X-COS-Web', '1');
      Object.keys(headers).forEach(function (h) { xhr.setRequestHeader(h, headers[h]); });
      if (extra) Object.keys(extra).forEach(function (h) { xhr.setRequestHeader(h, extra[h]); });
      if (xhr.upload) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable && e.total) { onProgress(e.loaded / e.total); if (e.loaded >= e.total) { sent(); return; } }
          watch();
        };
        xhr.upload.onload = sent;
      }
      xhr.onload = function () {
        settle();
        var data = {}; try { data = JSON.parse(xhr.responseText || '{}'); } catch (_e) { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        var err = new Error('The Mac answered ' + xhr.status + '.'); err.status = xhr.status;
        err.code = data && (typeof data.error === 'string' ? data.error : data.error && data.error.code) || '';
        reject(err);
      };
      xhr.onerror = function () {
        settle();
        if (wasHidden || document.hidden) return reject(stopped());
        var err = new Error('The Mac did not answer.'); err.code = 'network'; reject(err);
      };
      xhr.onabort = function () {
        settle();
        if (stalled) return reject(stopped());
        var err = new Error('Removed.'); err.code = 'aborted'; reject(err);
      };
      xhr.send(body);
      watch();
    });
  }
  var UPLOAD_COPY = {
    batch_too_large: 'Too large for one upload.', too_many_images: 'Up to 5 attachments per message.',
    media_processing_unavailable: 'The Mac cannot read photos right now.', unsupported_kind: 'COS cannot read this kind of file.',
    unsupported_media_type: 'COS cannot read this kind of file.', file_too_large: 'Too large for COS.', attachment_too_large: 'Too large for COS.',
    server_maintenance: 'The Mac is updating. Retry in a minute.', network: 'The Mac did not answer. Retry when it is awake.',
    upload_locked: 'The upload stopped while the phone was locked. Retry it.', upload_stalled: 'The upload stopped. Nothing moved for a minute. Retry it.'
  };
  function uploadError(box, t, err) {
    if (err && err.code === 'aborted') return;
    t.state = 'failed';
    if (err && err.status === 401) {
      // Signed out mid-message (the browser session expired or every browser was signed out). Nothing is thrown away:
      // the words and the files stay, and Sign in again opens the sign-in screen on purpose, not by surprise.
      t.error = 'Signed out';
      box.signedOut = true;
      var ui = uiOf(box); if (ui.signedOut) ui.signedOut(box);
    } else {
      t.error = uploadErrorText(err);
    }
    boxChanged(box);
  }
  /**
   * One file to the media store, the way every web upload goes: a photo resized to a 1024 px JPEG and posted to /api/media,
   * any other file raw to /api/media/file. Resolves with the media ref ({ id }). `t` is the upload's record ({ file, name,
   * kind, mime }); it gets `xhr` while sending (Remove aborts it) and `thumb` for a photo. hooks.uploading() runs once the
   * bytes start, hooks.progress(0..1) as they go. 6.99.14: the live meeting view's Add file uses this too.
   */
  function uploadMedia(t, hooks) {
    var at = new Date(t.file.lastModified || Date.now()).toISOString();
    if (t.kind === 'photo' && !t.raw) {
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
    }, function (p) { hooks.progress(p); }, t, t.purpose ? { 'X-COS-Purpose': t.purpose } : null).then(function (d) { return d && d.attachment; });
  }
  /** The chip's words for a failed upload (never the sign-in case, which each caller says its own way). */
  function uploadErrorText(err) {
    if (err && err.code === 'photo_too_large') return 'Over 2 MB even after resizing';
    if (err && !err.status && !err.code) return err.message || 'Did not upload';
    return UPLOAD_COPY[err && err.code] || (err && err.status === 413 ? 'Too large for COS.' : 'Did not upload');
  }
  function startUpload(box, t) {
    t.state = 'reading'; t.progress = 0; t.error = ''; t.mediaId = '';
    var step = uploadMedia(t, {
      uploading: function () { t.state = 'uploading'; boxChanged(box); },
      progress: function (p) { t.progress = p; paintProgress(box, t); }
    });
    step.then(function (ref) {
      if (!findAtt(box, t.id)) return;
      if (!ref || !ref.id) { var e = new Error('The Mac did not keep the file.'); e.code = ''; throw e; }
      t.mediaId = ref.id; t.state = 'ready'; t.progress = 1; t.keptAt = Date.now();
      boxChanged(box);
    }).catch(function (err) {
      if (!findAtt(box, t.id)) return;
      if (err && err.code === 'photo_too_large') { t.state = 'failed'; t.error = uploadErrorText(err); boxChanged(box); return; }
      if (err && !err.status && !err.code) { t.state = 'failed'; t.error = uploadErrorText(err); boxChanged(box); return; }
      uploadError(box, t, err);
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

  // ── the COS thread (6.99.16) ──────────────────────────
  var THREAD_REF = 'Summary carried over from earlier in this COS thread';
  function threadLine() {
    var t = C.thread && C.thread.thread, n = C.thread && C.thread.next;
    var carried = C.threadCarried || (n && n.reason === 'manual' ? (n.digest ? 'summary' : 'plain') : '');
    if (carried) return carried === 'summary' ? 'New thread. It carries a short summary of the last one.' : 'New thread.';
    var asks = t && Number(t.asks) > 0 ? Number(t.asks) : 0;
    return asks ? 'Continues your COS thread · ' + asks + (asks === 1 ? ' ask' : ' asks') : '';
  }
  function paintThread() {
    var line = threadLine();
    document.querySelectorAll('[data-cos-thread]').forEach(function (el) { el.textContent = line; });
  }
  // Every thread answer (read, a turn recorded, New thread) also says which session the next Ask continues, so the
  // Default label follows the thread's own session (skeptic, 7.0.2). A fresh start continues none.
  function threadIdOf(t) { return t && t.thread && typeof t.thread.id === 'string' ? t.thread.id : ''; }
  function setThread(t) {
    C.thread = t;
    var n = t && t.next;
    var sid = n ? (n.mode === 'continue' && typeof n.sessionId === 'string' ? n.sessionId : '') : (t && t.thread && typeof t.thread.sessionId === 'string' ? t.thread.sessionId : '');
    if (sid !== C.threadSession) { C.threadSession = sid; if (threadOn()) refreshDefault(); }
    paintThread();
  }
  function loadThread() {
    return api('/api/cos-thread').then(function (t) { setThread(t); return t; }, function () { return null; });
  }
  // What the next Ask in the thread sends: a sessionId to continue, or none and the digest to carry.
  function threadPlan() {
    // An Ask in the thread still answering: the next one continues its conversation (its turn is not recorded yet).
    var live = C.asks.filter(function (x) { return x.threaded && x.sessionId && x.turnState !== 'done' && Date.now() - x.at < 20 * 60000; });
    if (live.length) return Promise.resolve({ sessionId: live[live.length - 1].sessionId, digest: null });
    return loadThread().then(function (t) {
      var n = t && t.next;
      if (n && n.mode === 'continue' && n.sessionId) return { sessionId: n.sessionId, digest: null };
      if (n && n.mode === 'fresh') return { sessionId: '', digest: typeof n.digest === 'string' && n.digest ? n.digest : null };
      // The thread could not be read: continue the session it last named, if any.
      var last = C.thread && C.thread.thread && C.thread.thread.sessionId;
      return { sessionId: last || '', digest: null };
    });
  }
  // Once per Ask, when it has finished: the thread records it, with the answer when there is one.
  function postTurn(a) {
    if (!a.threaded || !a.sessionId || a.turnState) return;
    a.turnState = 'posting';
    var body = { clientId: a.cid, sessionId: a.sessionId, query: String(a.query).slice(0, 20000) };
    if (a.status === 'completed' && typeof a.response === 'string' && a.response) body.answer = a.response.slice(0, 40000);
    if (Number.isInteger(a.no) && a.no > 0) body.messageNo = a.no;
    api('/api/cos-thread/turn', { method: 'POST', body: body }).then(function (t) {
      a.turnState = 'done';
      if (t && t.thread) setThread(t);
    }, function () { a.turnState = 'done'; });
  }
  function newThread() {
    if (C.threadBusy) return;
    C.threadBusy = true;
    api('/api/cos-thread/new', { method: 'POST', body: {} }).then(function (t) {
      C.threadBusy = false;
      C.threadCarried = '';
      setThread(t);
    }, function (err) {
      C.threadBusy = false;
      W.toast((err && err.message) || 'New thread did not go through.');
    });
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
    // 7.0.2 (A6): what Ask again sends: the same words, files and conversation.
    a.again = { attachmentIds: (opts.attachmentIds || []).slice(0, MAX_ATTS), atts: (opts.atts || []).slice(0, MAX_ATTS), sessionId: opts.sessionId || '', replyKey: opts.replyKey || '', context: opts.context || '', contextRef: opts.contextRef || '' };
    C.asks.push(a);
    if (a.replyKey) paintReplyFeed(a.replyKey); else paintFeed(true);
    var body = { clientJobId: a.cid, generation: 1, query: text, source: 'web', activityToolMode: 'status' };
    if (C.model) body.model = C.model;
    if (C.effort) body.effort = C.effort;
    // 6.99.16: an Ask from the chat's own composer belongs to the COS thread (a Reply keeps its turn's conversation).
    // An Ask again only reaches here once askAgain has confirmed the conversation is still this one (skeptic, 7.0.2).
    a.threaded = threadOn() && !opts.replyKey;
    // A Reply never takes the chat's session: with no session of its own it starts a conversation, as its card says.
    if (!a.threaded && !opts.replyKey && C.session && C.session.id) body.sessionId = C.session.id;
    // A reply continues the turn's own conversation (kept when it is still live; else the server starts a new one).
    if (opts.sessionId) body.sessionId = opts.sessionId;
    // 7.0.2: which conversation this Ask is for, as Ask again needs it: the replied-to turn's session, the COS thread
    // (its id, read when the plan is made), or the chat's own session ('' for a new one).
    a.conv = a.replyKey ? { kind: 'reply', sessionId: opts.sessionId || '' } : a.threaded ? { kind: 'thread', threadId: '' } : { kind: 'chat', sessionId: body.sessionId || '' };
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
    var prepare = (a.threaded ? threadPlan().then(function (plan) {
      a.conv.threadId = threadIdOf(C.thread);
      if (plan.sessionId) { body.sessionId = plan.sessionId; C.threadSession = plan.sessionId; }
      else if (plan.digest) body.reference = { query: THREAD_REF, response: plan.digest };
      a.carried = plan.sessionId ? '' : plan.digest ? 'summary' : 'plain';
    }) : Promise.resolve()).then(function () {
      // An Ask again: the conversation its first try was for must still be the one this send resolved to, checked here,
      // after the plan, immediately before admission (root review, 7.0.2: the thread can change between askAgain's check
      // and this send's own thread read, and a retry carries old files and context).
      if (opts.expect && !sameConversation(opts.expect, a)) throw Object.assign(new Error(MOVED_ON), { code: 'conversation_moved' });
      withContext(body, opts.context, opts.contextRef);
    });
    prepare.then(function () { return admit(true); }).then(function (d) {
      var job = d && d.job; if (!job) throw new Error('The Mac did not take the question.');
      take(a, job);
      var before = defaultSession();
      if (a.threaded) { C.threadCarried = a.carried; if (job.sessionId) C.threadSession = job.sessionId; paintThread(); }
      else if (job.sessionId && !a.replyKey) { C.session = { id: job.sessionId, day: today() }; save(); }
      if (defaultSession() !== before) refreshDefault();
      if (dropId) api('/api/drops/' + encodeURIComponent(dropId) + '/ask', { method: 'POST', body: { clientJobId: a.cid, generation: 1 } }).catch(function () {});
      if (done) done(true);
      poll(a);
    }, function (err) {
      if (err && err.code === 'conversation_moved' && opts.retryOf) {
        // Nothing was sent: this try leaves the chat, and the failed card it came from says why, its button disabled.
        C.asks = C.asks.filter(function (x) { return x !== a; });
        opts.retryOf.retried = false; opts.retryOf.againBlocked = MOVED_ON;
        if (a.replyKey) paintReplyFeed(a.replyKey); else paintFeed(false);
        if (done) done(false);
        return;
      }
      a.status = 'failed';
      a.error = err && err.code === 'durable_query_jobs_disabled' ? 'Ask needs the durable query jobs switch on your Mac.'
        : err && /attachment/.test(String(err.code || '')) ? 'An attachment could not be read: ' + ((err && err.message) || err.code) +
          // An Ask again never came from the box (QA): say what to do instead of pointing at it.
          (opts.reask ? ' Attach the file again in the box and ask again.' : ' Your words and files are still in the box.')
          : 'Not sent: ' + ((err && err.message) || 'the Mac did not answer');
      if (a.replyKey) paintReplyFeed(a.replyKey); else paintFeed(false);
      if (done) done(false);
    });
    return a;
  }
  // An Ask from Today carries what Today shows (app.js askCos, panes/today-actions.js summary) as the quoted reference,
  // after a carried thread summary when there is one. Bounded, and only on the Ask it was given to.
  // Today round 2: "Ask about this" names its own reference (ABOUT_REF).
  var TODAY_REF = 'What Today in COS Control shows right now', CONTEXT_MAX = 6000;
  function withContext(body, context, ref) {
    var text = typeof context === 'string' ? context.trim().slice(0, CONTEXT_MAX) : '';
    if (!text) return;
    var name = typeof ref === 'string' && ref ? ref : TODAY_REF;
    if (body.reference) body.reference = { query: body.reference.query + ', then ' + name.charAt(0).toLowerCase() + name.slice(1), response: body.reference.response + '\n\n' + text };
    else body.reference = { query: name, response: text };
  }

  // ── Ask about this (Today round 2, Miles 11/09) ───────
  // Today's box under the model summary (app.js sendTodayAsk) asks here. The typed words are the question; the summary,
  // when it was written and the sessions it read go as the Ask's reference, which the server quotes as untrusted data
  // (lib/prompt-reference-boundary.ts), so nothing in them can act as an instruction. Each session is named by the title
  // its Sessions row shows, so COS can pass an instruction to it with its own relay (SendMessage to that title; the
  // answer card then says "Sent to <title>", relayHtml). Never transcript text: only the last message into each session,
  // as the summary already read it. The same lines as desktop Control 0.5.384's ```today-context block.
  var ABOUT_REF = 'The Today summary and the sessions it read', ABOUT_ROWS = 12;
  function aboutClock(v) { var d = W.toDate(v); return d ? W.clock(d) : ''; }
  function aboutAgo(v) {
    var d = W.toDate(v); if (!d) return '';
    var m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
  }
  // A fence cannot be closed from inside: three backticks become three single quotes; one line per field.
  function aboutText(v, n) { return clip(String(v == null ? '' : v).replace(/```/g, "'''"), n); }
  function aboutContextText(ctx) {
    if (!ctx || typeof ctx !== 'object') return '';
    var summary = aboutText(ctx.summary, 1200);
    var rows = Array.isArray(ctx.sessions) ? ctx.sessions.filter(function (r) { return r && r.title; }) : [];
    if (!summary && !rows.length) return '';
    var when = aboutClock(ctx.at);
    var lines = [];
    if (summary) lines.push('Today summary' + (when ? ', written ' + when : '') + ':', summary, '');
    lines.push('Sessions Today read (' + rows.length + '):');
    rows.slice(0, ABOUT_ROWS).forEach(function (r) {
      var moved = aboutAgo(r.movedAt);
      lines.push('- ' + [aboutText(r.title, 120), aboutText(r.provider || 'claude', 12), aboutText(r.state, 12)].join(' | ') +
        (moved ? ' | last activity ' + moved : '') + (r.lastAsk ? ' | last ask: "' + aboutText(r.lastAsk, 160).replace(/"/g, "'") + '"' : ''));
    });
    if (rows.length > ABOUT_ROWS) lines.push('and ' + (rows.length - ABOUT_ROWS) + ' more');
    return lines.join('\n').slice(0, CONTEXT_MAX);
  }
  function askAbout(text, ctx) {
    return ensureCaps().then(function (caps) {
      if (!caps || !caps.jobs) { var off = new Error('Ask needs the durable query jobs switch on your Mac.'); off.code = 'durable_query_jobs_disabled'; throw off; }
      var q = String(text || '').trim();
      if (!q) throw new Error('Type what to ask first.');
      var body = aboutContextText(ctx);
      return new Promise(function (resolve, reject) {
        submitAsk(q, null, function (ok) { if (ok) resolve(['cos']); else reject(new Error('Not sent. Your words are still in the box on Today.')); },
          body ? { context: body, contextRef: ABOUT_REF } : undefined);
      });
    });
  }
  function take(a, job) {
    a.jobId = job.jobId; a.status = job.status || a.status;
    if (job.globalMsgNum) a.no = job.globalMsgNum;
    if (job.sessionId) a.sessionId = job.sessionId;
    if (typeof job.partialText === 'string') a.partial = job.partialText;
    if (typeof job.response === 'string') a.response = job.response;
    // 7.0.9: the steps, as the lens reads them (bounded on the Mac to 200 entries and 32,000 characters).
    if (Array.isArray(job.trail)) { a.trail = job.trail; watchRelays(a); }
    if (job.steerable === false) a.steerable = false;
    if (job.error && (a.status === 'failed' || a.status === 'interrupted')) a.error = errorLine(job);
  }
  // 7.0.2 (A6, the Duo audit): the line on a failed card says why and what to do, by the server's error.code. On 11/07
  // Codex was out of usage until Nov 13 and the card said only "COS could not finish this answer". The reset time comes
  // from the provider's own words in error.message when they carry one, else from retryAfterMs, else it is left out.
  var GENERIC_FAIL = 'COS could not finish this answer. Ask again when you are ready.';
  var PROVIDER_NAME = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', ollama: 'Ollama' };
  function providerName(job) {
    if (job && PROVIDER_NAME[job.provider]) return PROVIDER_NAME[job.provider];
    var m = String((job && (job.resolvedModel || job.requestedModel)) || '');
    if (/^codex/.test(m)) return 'Codex';
    if (/^cursor/.test(m)) return 'Cursor';
    if (/^ollama/.test(m)) return 'Ollama';
    if (/^(opus|fable|sonnet|haiku)/.test(m)) return 'Claude';
    return '';
  }
  // "until <when>" or "for <how long>" from the provider's words or retryAfterMs; '' when neither says. A machine time
  // (ISO 8601, or one that names UTC or GMT) is shown in this browser's own time zone.
  var RESET_ISO = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/;
  function localWhen(d) {
    try { return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_e) { return ''; }
  }
  function resetTime(err) {
    var msg = String((err && err.message) || '').slice(0, 2000);
    var m = /\b(?:try again|available again|resets?)\s+(at|on|after|in)?\s*([^.!\n·(]{2,48})/i.exec(msg), prep = m ? String(m[1] || '').toLowerCase() : '';
    if (!m) { m = /\buntil\s+()([^.!\n·(]{2,48})/i.exec(msg); prep = ''; }
    if (m) {
      var iso = RESET_ISO.exec(msg.slice(m.index));
      var when = iso && iso.index < 24 ? new Date(iso[0].replace(' ', 'T')) : /\b(?:UTC|GMT)\b/.test(m[2]) ? new Date(m[2].trim()) : null;
      if (when && !isNaN(when.getTime())) { var local = localWhen(when); if (local) return 'until ' + local; }
      var t = m[2].replace(/[\s,;:]+$/, '').trim();
      if (/\d/.test(t)) return (prep === 'in' ? 'for ' : 'until ') + t;
    }
    var ms = err && Number(err.retryAfterMs);
    if (ms > 0 && isFinite(ms)) { var later = localWhen(new Date(Date.now() + ms)); return later ? 'until ' + later : ''; }
    return '';
  }
  function errorLine(job) {
    var err = (job && job.error) || {}, code = String(err.code || ''), who = providerName(job);
    if (code === 'provider_limit') {
      var until = resetTime(err);
      return (who || 'This model') + ' is out of usage ' + (until || 'for now') + '. Pick another model under Model and ask again.';
    }
    if (code === 'provider_auth') return (who || 'This model') + ' is not signed in on your Mac. Sign in there, or pick another model under Model and ask again.';
    if (code === 'provider_context_too_long') return 'This conversation is too long for ' + (who || 'this model') + '. Start a new chat, or pick a model with a larger context under Model.';
    if (code === 'provider_timeout') return 'The model took longer than the time limit, so COS stopped waiting. Ask again, or pick a lower Effort for a faster answer.';
    if (code === 'interrupted' || (job && job.status === 'interrupted' && !code)) {
      if (err.cause === 'server_shutdown') return 'COS on your Mac shut down before this answer finished. When it is back, ask again.';
      if (err.cause === 'crash_loop_parked') return 'COS on your Mac stopped after crashing several times, so it set this question aside. Open COS Control on the Mac, then ask again.';
      return 'COS on your Mac restarted before this answer finished. Ask again when you are ready.';
    }
    return GENERIC_FAIL;
  }
  // Ask again: the same words and files as a new Ask (a new client job id), with the model and effort picked now, to the
  // SAME conversation as the first try. If that conversation has moved on (New thread, another thread now current, the
  // chat on another session, thread mode switched), nothing is sent: the button stays, disabled, with why (skeptic,
  // 7.0.2). A Reply goes to its turn's session as before. The failed card keeps its line and, once resent, loses the
  // button. Resolves to the new Ask, or null.
  var MOVED_ON = 'This conversation has moved on. Copy your words into a new Ask.';
  // Whether the Ask `a` (being sent now) resolved to the conversation `c`: the same thread, the chat's same session, or
  // the same Reply session. Read after the send's own plan, so it sees the thread that send will really use.
  function sameConversation(c, a) {
    if (!c || !a.conv || c.kind !== a.conv.kind) return false;
    if (c.kind === 'thread') return threadOn() && !!c.threadId && a.conv.threadId === c.threadId;
    return a.conv.sessionId === c.sessionId;
  }
  function conversationGone(a) {
    var c = a.conv;
    if (!c || c.kind === 'reply') return Promise.resolve('');
    if (c.kind === 'chat') {
      var now = C.session && C.session.id ? String(C.session.id) : '';
      return Promise.resolve(threadOn() || now !== c.sessionId ? MOVED_ON : '');
    }
    if (!threadOn() || !c.threadId) return Promise.resolve(MOVED_ON);
    return loadThread().then(function (t) { return threadIdOf(t) === c.threadId ? '' : MOVED_ON; });
  }
  function askAgain(cid) {
    var a = C.asks.filter(function (x) { return x.cid === cid; })[0];
    // A Prep card is never resent as a plain Ask (QA W4): Prep has its own Run.
    if (!a || a.retried || a.checking || a.againBlocked || a.prepDraftId || !(a.status === 'failed' || a.status === 'interrupted') || !a.jobId) return Promise.resolve(null);
    a.checking = true;
    return conversationGone(a).then(function (why) {
      a.checking = false;
      if (why) { a.againBlocked = why; if (a.replyKey) paintReplyFeed(a.replyKey); else paintFeed(false); return null; }
      a.retried = true;
      var g = a.again || {}, o = {};
      if (g.attachmentIds && g.attachmentIds.length) { o.attachmentIds = g.attachmentIds.slice(0, MAX_ATTS); o.atts = (g.atts || []).slice(0, MAX_ATTS); }
      if (g.replyKey) { o.replyKey = g.replyKey; o.sessionId = g.sessionId; }
      if (g.context) o.context = g.context;
      if (g.contextRef) o.contextRef = g.contextRef;
      o.reask = true;
      if (a.conv) { o.expect = a.conv; o.retryOf = a; }
      return submitAsk(a.query, null, null, o);
    });
  }
  function poll(a) {
    var started = Date.now();
    var tick = function () {
      if (!a.jobId) return;
      api('/api/query-jobs/' + a.jobId + '?generation=1&trail=1').then(function (d) {
        if (d && d.job) take(a, d.job);
        paintAsk(a);
        if (['completed', 'failed', 'canceled', 'interrupted'].indexOf(a.status) >= 0) return finished(a);
        if (Date.now() - started < 20 * 60000) setTimeout(tick, document.hidden ? 4000 : 1000);
      }, function () { if (Date.now() - started < 20 * 60000) setTimeout(tick, 3000); });
    };
    setTimeout(tick, 600);
  }
  function finished(a) {
    if (a.status === 'completed' && !hasText(a)) recoverAnswer(a);
    postTurn(a);
    refreshDefault();
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
  function askFromSheet(text, extra) {
    return ensureCaps().then(function (caps) {
      if (!caps || !caps.jobs) { var off = new Error('Ask needs the durable query jobs switch on your Mac.'); off.code = 'durable_query_jobs_disabled'; throw off; }
      return new Promise(function (resolve, reject) {
        // 11/07: files attached in the Ask sheet go with the question, as from the chat's own clip (ready ids only:
        // the sheet never asks while one is uploading or failed).
        var o = {};
        if (extra && extra.context) o.context = extra.context;
        if (extra && Array.isArray(extra.attachmentIds) && extra.attachmentIds.length) { o.attachmentIds = extra.attachmentIds.slice(0, MAX_ATTS); o.atts = Array.isArray(extra.atts) ? extra.atts.slice(0, MAX_ATTS) : []; }
        submitAsk(String(text || '').trim(), null, function (ok) { if (ok) resolve(['cos']); else reject(new Error('Not sent. The question is in Ask COS; try again there.')); },
          o.context || o.attachmentIds ? o : undefined);
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
    // 7.0.9: an older question answers from its list exactly as from the chat.
    var fromArchive = !item || !!item.archived;
    if (!item) item = (C.archive || []).filter(function (i) { return i.id === itemId; })[0];
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
    // 6.99.19: with Prep on the Mac, Prep me opens the Prep composer (notes and files first); without it, the plain Ask.
    if (action === 'prep') { if (prepOn()) return openPrep(item); if (C.caps && C.caps.jobs) submitAsk('Prep me for ' + (item.title || 'my next meeting'), ''); return; }
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
      // Answered: it is no longer an older question, wherever it was.
      if (fromArchive) { delete item.archived; (C.items || []).forEach(function (i) { if (i.id === itemId) delete i.archived; }); if (C.archive) C.archive = C.archive.filter(function (i) { return i.id !== itemId; }); if (C.archiveOpen) loadArchive(); }
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

  // ── Prep (6.99.19, PREP_CONTRACT_v1) ──────────────────
  // With capabilities.prep on the Mac, "Prep me" on a prep card opens this composer above the chat's own: what the prep
  // should focus on, and files, the way the live meeting view takes them. It is a server draft (POST /api/prep/drafts,
  // the clientDraftId kept in this browser, so opening it again resumes it through GET). Every write sends the draft's
  // revision; a 409 revision_conflict hands back the newer draft, which is shown, with one line saying so. Prep me
  // posts .../run, and the job it returns is drawn and polled in the chat exactly like an Ask (take, poll, and the
  // by-client lookup when the answer to the run was lost). Files reach a meeting only from that meeting's live view.
  var PREP_STORE = 'cos.web.prepDrafts';
  var PREP_ACCEPT = 'image/*,.heic,.heif,application/pdf,.pdf,text/plain,.txt,text/markdown,.md,text/csv,.csv,application/json,.json,.xlsx';
  var PREP_SAVE_MS = 700;
  var PREP_FILE_STATE = { unsupported: 'No readable text', failed: 'Could not be read', 'secret-held': 'Held: it appears to contain credentials' };
  // Amendment 19: every Prep write names the server it expects (X-COS-Expected-Server-Instance), the id last read from
  // capabilities.prep or the most recent Prep answer (every one carries it). The id survives restarts; a different id
  // means a different COS server answered (409 server_instance_mismatch).
  var PREP_INST = '';
  var P = null;   // the open composer: { key, title, startsAt, draft, steer, dirty, ups, note, warn, running, runId, chain, timer, conflicts }
  function prepCaps() { return C.caps && C.caps.prep ? C.caps.prep : null; }
  function prepOn() { return !!prepCaps(); }
  function prepMax() { var c = prepCaps(); return c ? c.maxFiles : 10; }
  function prepChars() { var c = prepCaps(); return c ? c.steerChars : 4000; }
  function prepRec(key) { var r = W.readStore(PREP_STORE)[key]; return r && typeof r === 'object' && typeof r.cd === 'string' ? r : null; }
  function savePrepRec(key, rec) {
    var all = W.readStore(PREP_STORE);
    all[key] = rec;
    // The newest twenty: a prep card a week old has no reason to be found again here.
    var keys = Object.keys(all).sort(function (a, b) { return (Number(all[a] && all[a].at) || 0) - (Number(all[b] && all[b].at) || 0); });
    while (keys.length > 20) delete all[keys.shift()];
    W.writeStore(PREP_STORE, all);
  }
  function forgetPrepRec(key) { var all = W.readStore(PREP_STORE); delete all[key]; W.writeStore(PREP_STORE, all); }
  // The run in flight, kept with the draft in this browser (closing the composer or reloading the page does not lose it):
  // its clientRequestId and its own model, effort and continue, so a retry is the same request and the server re-drives it.
  function setPendingRun(p, run) {
    p.pending = run;
    var rec = prepRec(p.key); if (!rec) return;
    if (run) rec.run = run; else delete rec.run;
    savePrepRec(p.key, rec);
  }
  /** A Prep route, answered as { status, body } (a 409 carries the newer draft). Never rejects: no answer is status 0. */
  function prepCall(path, opts) {
    var o = opts || {}, method = o.method || 'GET';
    var headers = { 'X-COS-Web': '1' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && PREP_INST) headers['X-COS-Expected-Server-Instance'] = PREP_INST;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, o.timeoutMs || (method === 'GET' ? 20000 : 30000)) : null;
    return fetch(path, { method: method, headers: headers, credentials: 'same-origin', body: o.body !== undefined ? JSON.stringify(o.body) : undefined, signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        return res.text().then(function (t) {
          clearTimeout(timer); var b = {}; try { b = t ? JSON.parse(t) : {}; } catch (_e) { b = {}; }
          b = b || {};
          var inst = typeof b.serverInstanceId === 'string' && b.serverInstanceId ? b.serverInstanceId : b.draft && typeof b.draft.serverInstanceId === 'string' ? b.draft.serverInstanceId : '';
          // The server's id as it answers now: from a read, a write it took, or the refusal that says it changed.
          if (inst && (res.status < 300 || (res.status === 409 && prepCode({ body: b }) === 'server_instance_mismatch'))) PREP_INST = inst;
          if (res.status === 428 && typeof console !== 'undefined') console.error('[prep] a write went without X-COS-Expected-Server-Instance', method, path);
          return { status: res.status, body: b };
        });
      })
      .catch(function () { clearTimeout(timer); return { status: 0, body: {} }; });
  }
  // sha256 of the bytes this browser uploaded (amendment 20). crypto.subtle needs a secure context, and a plain-http
  // tailnet page is not one, so a small FIPS 180-4 implementation stands in there.
  function sha256Hex(bytes) {
    var subtle = typeof crypto !== 'undefined' && crypto.subtle && (typeof window === 'undefined' || window.isSecureContext !== false) ? crypto.subtle : null;
    if (subtle) return subtle.digest('SHA-256', bytes).then(function (h) { return hex(new Uint8Array(h)); }, function () { return sha256Js(bytes); });
    return Promise.resolve(sha256Js(bytes));
  }
  function hex(a) { return Array.prototype.map.call(a, function (x) { return (x + 0x100).toString(16).slice(1); }).join(''); }
  var SHA_K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256Js(bytes) {
    var len = bytes.length, total = ((len + 9 + 63) >> 6) << 6, m = new Uint8Array(total);
    m.set(bytes); m[len] = 0x80;
    var bits = len * 8, dv = new DataView(m.buffer);
    dv.setUint32(total - 8, Math.floor(bits / 0x100000000)); dv.setUint32(total - 4, bits >>> 0);
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], w = new Array(64);
    var rotr = function (x, n) { return (x >>> n) | (x << (32 - n)); };
    for (var off = 0; off < total; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
      for (i = 0; i < 64; i++) {
        var t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
        var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + k) | 0;
    }
    return h.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }
  /** The exact bytes the media upload sent: the resized JPEG for a photo (uploadMedia keeps it as t.thumb), else the file. */
  function uploadedBytes(t) {
    if (t.kind === 'photo' && /^data:/.test(t.thumb || '')) {
      var bin = atob(t.thumb.slice(t.thumb.indexOf(',') + 1)), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return Promise.resolve(out);
    }
    if (t.file && typeof t.file.arrayBuffer === 'function') return t.file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return Promise.reject(new Error('This browser could not read the file again to check it. Remove it and add it again.'));
  }
  function prepCode(r) { var b = (r && r.body) || {}; return typeof b.error === 'string' ? b.error : (b.error && b.error.code) || b.code || b.reason || ''; }
  var PREP_CONFLICT = 'This prep changed on another device. It now shows the newest notes and files. Check them, then try again.';
  function prepErrorText(r) {
    var code = prepCode(r);
    if (r.status === 0) return 'COS on your Mac did not answer. Check that it is awake, then try again.';
    if (r.status === 401) return 'This browser was signed out. Your words are kept here. Sign in, then try again.';
    if (code === 'server_instance_mismatch') return 'The COS server on your Mac changed. Close this prep and tap Prep me on the card again.';
    if (r.status === 428) return 'This page did not name the Mac\u2019s COS server, so nothing was changed. Reload the page, then try again.';
    if (code === 'media_hash_mismatch') return 'The file your Mac kept does not match what this browser sent. Retry to send it again.';
    if (code === 'maintenance' || r.status === 503) return 'COS is updating. Try again in a minute.';
    if (code === 'prep_file_limit' || r.status === 413) return 'This prep holds ' + prepMax() + ' files. Remove one, then retry.';
    if (code === 'prep_draft_limit') return 'COS already keeps as many preps as it can. Open an old prep card, tap Archive this prep, then try again.';
    if (r.status === 507) return 'COS is out of room for prep files. Remove some files from older preps, then retry.';
    if (code === 'durable_query_jobs_disabled') return 'Prep me needs the durable query jobs switch on your Mac. Your notes and files are saved.';
    if (/^media_/.test(code)) return 'The upload expired before COS kept it. Retry.';
    if (r.status === 404) return 'This prep is no longer on your Mac. Close it and tap Prep me on the card again.';
    var msg = r.body && typeof r.body.message === 'string' ? r.body.message : '';
    return msg ? msg : 'COS did not take that (HTTP ' + r.status + '). Try again.';
  }
  function prepQueue(p, fn) { var next = p.chain.then(fn); p.chain = next.catch(function () {}); return next; }
  function prepPath(p) { return '/api/prep/drafts/' + encodeURIComponent(p.draft.id); }
  function prepFiles(d) { return ((d && d.files) || []).filter(function (f) { return f && f.status !== 'removed'; }); }
  function prepUploading(p) { return p.ups.some(function (t) { return t.state !== 'failed'; }); }
  function prepWhen(iso) { return iso && isFinite(Date.parse(iso)) ? timeLabel(iso) : ''; }

  function openPrep(item) {
    var act = ((item && item.actions) || []).filter(function (a) { return a && a.id === 'prep'; })[0] || {};
    var info = (act.prep && typeof act.prep === 'object' ? act.prep : item.prep && typeof item.prep === 'object' ? item.prep : {}) || {};
    var key = 'item:' + item.id;
    // Resolves to this composer once its draft is read (or the read failed, its note set): Today's Start prep waits on it.
    if (P && P.key === key) { var same = P; paintPrep(); focusPrep(); return (same.loaded || Promise.resolve()).then(function () { return same; }); }
    if (P) closePrep();
    P = { key: key, title: clip(info.title || item.title || 'my next meeting', 200), startsAt: typeof info.startsAt === 'string' ? info.startsAt : null,
      draft: null, steer: '', dirty: false, ups: [], note: '', warn: false, running: false, pending: null, chain: Promise.resolve(), timer: null, conflicts: 0, loading: true };
    paintPrep(true); focusPrep();
    // On a phone the page scrolls: bring the composer up to where the card was tapped.
    var slot = prepSlot(false); if (slot && slot.scrollIntoView && !wide()) slot.scrollIntoView({ block: 'start' });
    var p = P;
    p.loaded = loadPrep(p);
    return p.loaded.then(function () { return p; });
  }
  function closePrep() {
    if (!P) return;
    var p = P;
    // Words typed and not yet saved go out once more on the way.
    if (p.dirty && p.draft) savePrepSteer(p);
    clearTimeout(p.timer);
    p.ups.forEach(function (t) { if (t.xhr) { try { t.xhr.abort(); } catch (_e) {} } });
    P = null;
    paintPrep();
  }
  // Resume when this browser has the draft; otherwise create it (the same clientDraftId answers the same draft).
  function loadPrep(p) {
    var rec = prepRec(p.key);
    var run = rec && rec.run;
    if (run && typeof run.rid === 'string') p.pending = { rid: run.rid, model: run.model || '', effort: run.effort || '', cont: !!run.cont };
    var create = function (cd) {
      savePrepRec(p.key, { cd: cd, id: '', at: Date.now() });
      var body = { clientDraftId: cd, title: p.title };
      if (p.startsAt) body.startsAt = p.startsAt;
      return prepCall('/api/prep/drafts', { method: 'POST', body: body });
    };
    var step = rec && rec.id ? prepCall('/api/prep/drafts/' + encodeURIComponent(rec.id)).then(function (r) {
      return r.status === 404 ? create(uuid()) : r;
    }) : create(rec ? rec.cd : uuid());
    return step.then(function (r) {
      p.loading = false;
      if (r.status >= 200 && r.status < 300 && r.body.draft) { adoptPrep(p, r.body.draft, false); if (p.dirty) schedulePrepSave(p); return; }
      setPrepNote(p, prepErrorText(r), true);
    });
  }
  function adoptPrep(p, draft, conflict) {
    p.draft = draft;
    var rec = prepRec(p.key);
    var next = { cd: (draft && draft.clientDraftId) || (rec && rec.cd) || '', id: draft.id, at: Date.now() };
    if (rec && rec.run) next.run = rec.run;
    savePrepRec(p.key, next);
    if (conflict || !p.dirty) {
      p.steer = typeof draft.steer === 'string' ? draft.steer : '';
      if (conflict) { p.dirty = false; clearTimeout(p.timer); p.conflicts++; }
      var box = P === p && prepBox();
      if (box && box.value !== p.steer) { box.value = p.steer; W.autoGrow(box); }
    }
    if (conflict) setPrepNote(p, PREP_CONFLICT, true);
    paintPrep();
  }
  /** A write to the draft: the answer's draft is adopted (a 409 revision_conflict's too, with the line that says so). */
  function prepWrite(p, method, path, body) {
    return prepCall(path, { method: method, body: body }).then(function (r) {
      var conflict = r.status === 409 && prepCode(r) === 'revision_conflict';
      if (r.body && r.body.draft && (conflict || (r.status >= 200 && r.status < 300))) adoptPrep(p, r.body.draft, conflict);
      if (r.status === 409 && prepCode(r) === 'server_instance_mismatch') { r.mismatch = true; reloadAfterServerChange(p); }
      return r;
    });
  }
  // A different COS server answered than the one this prep was read from: say so, read the draft again,
  // and keep words not yet saved, which go out once the draft is read.
  var PREP_SERVER_CHANGED = 'The COS server on your Mac changed since this prep opened. It was read again. Check it, then try again.';
  function reloadAfterServerChange(p) {
    setPrepNote(p, PREP_SERVER_CHANGED, true);
    if (p.reloading || !p.draft) return;
    p.reloading = true;
    prepCall(prepPath(p)).then(function (r) {
      p.reloading = false;
      if (r.status === 200 && r.body.draft) { adoptPrep(p, r.body.draft, false); if (p.dirty) schedulePrepSave(p); }
    });
  }
  function schedulePrepSave(p) { clearTimeout(p.timer); p.timer = setTimeout(function () { savePrepSteer(p); }, PREP_SAVE_MS); }
  function savePrepSteer(p) {
    clearTimeout(p.timer); p.timer = null;
    return prepQueue(p, function () {
      if (!p.dirty || !p.draft) return null;
      var text = p.steer; p.dirty = false;
      return prepWrite(p, 'PATCH', prepPath(p), { revision: p.draft.revision, steer: text }).then(function (r) {
        if (r.mismatch) { if (p.steer === text) p.dirty = true; return r; }
        if ((r.status >= 200 && r.status < 300) || r.status === 409) return r;
        // Kept, and sent again with the next change or with Prep me.
        if (p.steer === text) p.dirty = true;
        setPrepNote(p, 'Your notes are not saved yet. ' + prepErrorText(r), true);
        return r;
      });
    });
  }
  function onPrepInput(box) {
    var p = P; if (!p) return;
    var max = prepChars();
    if (box.value.length > max) box.value = box.value.slice(0, max);
    p.steer = box.value; p.dirty = true;
    W.autoGrow(box);
    schedulePrepSave(p);
    paintPrepParts(p);
  }

  // Files: the composer's own upload (uploadMedia), then POST .../files with the draft's revision.
  function addPrepFiles(list) {
    var p = P; if (!p) return 0;
    var files = Array.prototype.slice.call(list || []), refusals = [];
    if (!p.draft) { setPrepNote(p, 'This prep is still opening. Add the files again in a moment.', true); return files.length; }
    files.forEach(function (file) {
      if (prepFiles(p.draft).length + p.ups.length >= prepMax()) { refusals.push('A prep holds ' + prepMax() + ' files. ' + (file.name || 'A file') + ' was not added.'); return; }
      var c = classify(file);
      if (c.refuse) { refusals.push(c.refuse); return; }
      if (c.kind === 'video') { refusals.push((file.name || 'That video') + ' is a video. Prep reads documents and the text in images, so attach a PDF, a text file or a screenshot.'); return; }
      var t = { id: uuid(), file: file, name: file.name || (c.kind === 'photo' ? 'Screenshot' : 'File'), size: file.size, kind: c.kind, mime: c.mime || '', state: 'reading', progress: 0, mediaId: '', error: '' };
      p.ups.push(t);
      sendPrepFile(p, t);
    });
    setPrepNote(p, refusals.join(' '), !!refusals.length);
    paintPrep();
    return refusals.length;
  }
  function sendPrepFile(p, t) {
    t.state = t.mediaId ? 'adding' : 'reading'; t.progress = 0; t.error = '';
    var step = t.mediaId ? Promise.resolve({ id: t.mediaId }) : uploadMedia(t, {
      uploading: function () { t.state = 'uploading'; paintPrep(); },
      progress: function (x) { t.progress = x; paintPrepProgress(t); }
    });
    paintPrep();
    step.then(function (ref) {
      if (p.ups.indexOf(t) < 0) return null;
      if (!ref || !ref.id) { var e = new Error('COS did not keep the file. Retry.'); e.code = 'kept'; throw e; }
      t.mediaId = ref.id; t.state = 'adding'; paintPrep();
      // Amendment 20: the sha256 of exactly the bytes uploaded, which the server checks its copy against.
      return t.sha256 ? null : uploadedBytes(t).then(sha256Hex).then(function (h) { t.sha256 = h; });
    }).then(function () {
      if (p.ups.indexOf(t) < 0 || !t.mediaId) return null;
      // v1.1: one operationId per add, the same on a retry after a lost answer (the server answers the first result).
      t.opId = t.opId || uuid();
      return prepQueue(p, function () {
        var path = prepPath(p) + '/files';
        var body = function () { return { operationId: t.opId, revision: p.draft.revision, media: [{ id: t.mediaId, name: t.name.slice(0, 240), sha256: t.sha256 }] }; };
        return prepWrite(p, 'POST', path, body()).then(function (r) { return r.status === 0 ? prepWrite(p, 'POST', path, body()) : r; });
      });
    }).then(function (r) {
      if (!r || p.ups.indexOf(t) < 0) return;
      if (r.status >= 200 && r.status < 300) { p.ups = p.ups.filter(function (x) { return x !== t; }); paintPrep(); return prepUploadsSettled(p); }
      // Refused (a 4xx), so nothing was recorded: Retry is a new operation. No answer or a 5xx: Retry is the same one.
      if (r.status >= 400 && r.status < 500) t.opId = '';
      // The staged copy is gone or differs: Retry uploads the bytes again.
      var code = prepCode(r);
      if (code === 'media_hash_mismatch' || /^media_(not_found|expired)$/.test(code)) { t.mediaId = ''; t.sha256 = ''; }
      t.state = 'failed';
      t.error = r.mismatch ? 'Not added: the Mac\u2019s COS server changed. Retry.' : r.status === 409 && code === 'revision_conflict' ? 'Not added: the prep changed. Retry.' : prepErrorText(r);
      paintPrep();
      prepUploadsSettled(p);
    }).catch(function (err) {
      if (p.ups.indexOf(t) < 0 || (err && err.code === 'aborted')) return;
      t.state = 'failed';
      t.error = err && err.code === 'kept' ? err.message : err && err.status === 401 ? 'Signed out. Sign in, then retry.' : uploadErrorText(err);
      paintPrep();
      prepUploadsSettled(p);
    });
  }
  function removePrepFile(p, fileId) {
    if (!p.draft) return;
    prepQueue(p, function () {
      return prepWrite(p, 'DELETE', prepPath(p) + '/files/' + encodeURIComponent(fileId) + '?revision=' + encodeURIComponent(p.draft.revision));
    }).then(function (r) { if (r && !(r.status >= 200 && r.status < 300) && r.status !== 409) setPrepNote(p, 'Not removed. ' + prepErrorText(r), true); });
  }

  // Prep me: the notes saved first, then .../run. The run in flight (its clientRequestId and its own params) is kept with
  // the draft until its outcome is known, so the next tap, a close or a reload resends the same request.
  function runPrep(p) {
    if (!p || !p.draft || p.running || prepUploading(p)) return;
    p.running = true; setPrepNote(p, '', false); paintPrep();
    var seen = p.conflicts;
    if (p.dirty) savePrepSteer(p);
    prepQueue(p, function () {
      // The notes changed elsewhere, or did not save: nothing runs on words the person has not seen.
      if (p.conflicts !== seen) return { status: -1, body: {} };
      if (p.dirty) return { status: -2, body: {} };
      if (!p.pending) {
        var cont = !!((p.draft.runs || []).length && p.draft.conversation && p.draft.conversation.sessionId);
        setPendingRun(p, { rid: uuid(), model: C.model || '', effort: C.effort || '', cont: cont });
      }
      return postRun(p, p.pending, true);
    }).then(function (r) { return settleRun(p, r, true); });
  }
  // Today's Start prep (prepStart): the run waits until every file it added is in the draft. A file that did not upload
  // stops it, with one line saying so, so a prep never runs without a file the person chose for it.
  var PREP_FILE_HELD = 'A file did not upload, so this prep has not started. Retry or remove it, then tap Prep me.';
  function prepUploadsSettled(p) {
    if (!p || !p.autoRun || P !== p || prepUploading(p)) return;
    p.autoRun = false;
    if (p.ups.length) { setPrepNote(p, PREP_FILE_HELD, true); return paintPrep(); }
    runPrep(p);
  }
  // The context typed on Today joins the draft's notes: kept as they are when they already hold it, else added after them.
  function mergeSteer(old, add) {
    var a = String(add || '').trim(), o = String(old || '');
    if (!a) return o;
    if (!o.trim()) return a.slice(0, prepChars());
    if (o.indexOf(a) >= 0) return o;
    return (o.replace(/\s+$/, '') + '\n\n' + a).slice(0, prepChars());
  }
  // Prep off on the Mac, Ask on: "Prep me for <title> at <time>", the context typed on Today as the Ask's quoted
  // reference (data, never instructions; ``` cannot close the fence), as askAbout sends the Today summary.
  var PREP_ASK_REF = 'Context added for this prep on Today';
  function prepAskContext(title, when, steer) {
    var text = aboutText(steer, 2000);
    if (!text) return '';
    return ['Meeting: ' + aboutText(title, 200), when ? 'Starts: ' + when : '', 'Added context: ' + text].filter(Boolean).join('\n');
  }
  function runBody(p, run) {
    var body = { clientRequestId: run.rid, revision: p.draft.revision };
    if (run.model) body.model = run.model;
    if (run.effort) body.effort = run.effort;
    if (run.cont) body.continue = true;
    return body;
  }
  function postRun(p, run, retryLost) {
    var path = prepPath(p) + '/run';
    return prepWrite(p, 'POST', path, runBody(p, run)).then(function (r) { return r.status === 0 && retryLost ? prepWrite(p, 'POST', path, runBody(p, run)) : r; });
  }
  function settleRun(p, r, mayRedrive) {
    p.running = false;
    var code = prepCode(r), run = r.body && r.body.run;
    if (r.status === 202 || r.status === 200) { setPendingRun(p, null); return ended(p, run, r.body.job) || startPrepJob(p, run || {}, r.body.job || null); }
    if (r.status === 0) return recoverPrepRun(p, p.pending ? p.pending.rid : '');
    // One run at a time per draft. Still being submitted: send THAT run again, with its own params (the server
    // re-drives it). Already taken: show it, as its own Ask, instead of a second one.
    if (r.status === 409 && code === 'run_in_progress' && run) {
      if (run.state === 'submitting' && typeof run.clientRequestId === 'string' && mayRedrive) {
        setPendingRun(p, { rid: run.clientRequestId, model: run.model || '', effort: run.effort || '', cont: !!run.continue });
        p.running = true; paintPrep();
        return prepQueue(p, function () { return postRun(p, p.pending, true); }).then(function (r2) { return settleRun(p, r2, false); });
      }
      if (run.clientJobId) { setPendingRun(p, null); return startPrepJob(p, run, null); }
    }
    // The run failed on the Mac: say so plainly; the next tap is a fresh run.
    if (r.status === 409 && code === 'run_failed') {
      setPendingRun(p, null);
      var why = run && typeof run.error === 'string' && run.error ? run.error.replace(/_/g, ' ') : '';
      setPrepNote(p, 'This prep did not start on your Mac' + (why ? ' (' + why + ')' : '') + '. Tap Prep me to try again.', true);
      return paintPrep();
    }
    // No answer the Mac could vouch for (503, run_status_unknown): keep the run; the next tap is the same request.
    if (r.status >= 500) { setPrepNote(p, prepErrorText(r) + ' Tap Prep me again; it will not run twice.', true); return paintPrep(); }
    // Refused, so no run exists: the next tap is a new request. (-1 and -2: stopped here; the note already says why.)
    if (r.status > 0) setPendingRun(p, null);
    if (r.status !== -1 && r.status !== -2 && r.status !== 409) setPrepNote(p, prepErrorText(r), true);
    paintPrep();
  }
  // The run's answer was lost twice. v1.1: GET .../runs/<clientRequestId> answers {run, job} when the run was taken and
  // 404 run_not_accepted when it was not. A server without that route: the draft lists its runs, and the run's
  // clientJobId finds the job (/api/query-jobs/by-client).
  // 202 {run}: the Mac is still admitting it, so ask again shortly (a few times). 503 run_status_unknown: the Mac could
  // not tell; the next tap is the same request, so it cannot run twice.
  var PREP_RUN_WAITS = [1500, 1500, 3000, 3000, 5000];
  function recoverPrepRun(p, rid, tries) {
    tries = tries || 0;
    return prepCall(prepPath(p) + '/runs/' + encodeURIComponent(rid)).then(function (r) {
      if (r.status === 200 && r.body.run && (r.body.run.clientJobId || r.body.run.outcome)) { setPendingRun(p, null); return ended(p, r.body.run, r.body.job) || startPrepJob(p, r.body.run, r.body.job || null); }
      if (r.status === 202 && tries < PREP_RUN_WAITS.length) {
        setPrepNote(p, 'Your Mac is starting this prep.', false); p.running = true; paintPrep();
        return new Promise(function (res) { setTimeout(res, PREP_RUN_WAITS[tries]); }).then(function () { p.running = false; return recoverPrepRun(p, rid, tries + 1); });
      }
      if (r.status === 202 || (r.status === 404 && prepCode(r) === 'run_not_accepted') || (r.status === 503 && prepCode(r) === 'run_status_unknown')) return notStarted(p);
      return recoverFromDraft(p, rid);
    });
  }
  // A run that already ended and whose job the Mac no longer keeps (outcome 'unavailable', job null): there is nothing
  // to poll. Its copied answer is shown when the Mac kept one; otherwise one line says so. The stored run is released
  // by the caller, so the next tap is a fresh run.
  function ended(p, run, job) {
    if (!run || job || !(run.outcome === 'unavailable' || run.settledAt)) return false;
    if (typeof run.answer === 'string' && run.answer) {
      var a = { cid: run.clientJobId || uuid(), query: prepQuery(p), at: Date.now(), status: 'completed', partial: '', response: run.answer, dropId: '', replyKey: '', prepDraftId: p.draft.id, atts: [] };
      C.asks.push(a);
      if (P === p) closePrep();
      paintFeed(true);
      return true;
    }
    setPrepNote(p, 'This prep finished earlier, but its answer is no longer kept. Tap Prep me to run it again.', true);
    paintPrep();
    return true;
  }
  function notStarted(p) {
    setPrepNote(p, 'COS on your Mac did not answer, so this prep may not have started. Tap Prep me again; it will not run twice.', true);
    paintPrep();
  }
  function recoverFromDraft(p, rid) {
    return prepCall(prepPath(p)).then(function (r) {
      if (r.status === 200 && r.body.draft) adoptPrep(p, r.body.draft, false);
      var run = r.status === 200 ? (((r.body.draft || {}).runs) || []).filter(function (x) { return x && x.clientRequestId === rid; })[0] : null;
      if (run && run.clientJobId) { setPendingRun(p, null); return startPrepJob(p, run, null); }
      notStarted(p);
    });
  }
  // v1.1: the job is an ordinary web Ask titled "Prep: <title>"; the chat shows the same words, and the focus under them.
  function prepQuery(p) {
    var steer = String((p.draft && p.draft.steer) || '').trim();
    return 'Prep: ' + p.title + (steer ? '\n' + clip(steer, 160) : '');
  }
  function startPrepJob(p, run, job) {
    var cid = (run && run.clientJobId) || (job && job.clientJobId) || '';
    var a = { cid: cid || uuid(), query: prepQuery(p), at: Date.now(), status: 'sending', partial: '', dropId: '', replyKey: '', prepDraftId: p.draft.id,
      atts: prepFiles(p.draft).filter(function (f) { return f.status === 'ready'; }).map(function (f) { return { name: f.name, kind: f.kind === 'image' ? 'photo' : 'doc' }; }) };
    C.asks.push(a);
    if (P === p) closePrep();
    paintFeed(true);
    if (job && job.jobId) { take(a, job); paintAsk(a); poll(a); return a; }
    if (!cid) { a.status = 'failed'; a.error = 'Not sent: the Mac did not say which answer is this prep. Tap Prep me on the card again.'; paintFeed(false); return a; }
    api('/api/query-jobs/by-client/' + encodeURIComponent(cid) + '?generation=1').then(function (d) {
      if (!d || !d.job) throw new Error('the Mac did not find the prep answer');
      take(a, d.job); paintAsk(a); poll(a);
    }).catch(function (err) {
      a.status = 'failed';
      a.error = 'Not sent: ' + ((err && err.message) || 'the Mac did not answer') + '. Tap Prep me on the card again; it will not run twice.';
      paintFeed(false);
    });
    return a;
  }

  // Archive this prep (DELETE /api/prep/drafts/:id, the server keeps it as archived): it frees one of the drafts the Mac
  // keeps, and the card's Prep me then starts a new one. Nothing a meeting already took is touched.
  function archivePrep(p) {
    if (!p.draft || p.running || p.archiving) return;
    p.archiving = true; setPrepNote(p, 'Archiving this prep…', false);
    clearTimeout(p.timer);
    prepQueue(p, function () {
      return prepCall(prepPath(p) + '?revision=' + encodeURIComponent(p.draft.revision), { method: 'DELETE' });
    }).then(function (r) {
      p.archiving = false;
      if (r.status >= 200 && r.status < 300) {
        forgetPrepRec(p.key);
        p.dirty = false; p.pending = null;
        if (P === p) closePrep();
        W.toast('Prep archived. Prep me on the card starts a new one.');
        return;
      }
      var conflict = r.status === 409 && prepCode(r) === 'revision_conflict';
      if (conflict && r.body.draft) return adoptPrep(p, r.body.draft, true);
      setPrepNote(p, 'Not archived. ' + prepErrorText(r), true);
    });
  }

  // ── the Prep composer on the page ─────────────────────
  // It sits above the chat's composer, outside the feed, so a poll that redraws the feed never takes the words or the
  // caret. Built once per draft; after that only its parts are written.
  function prepSlot(create) {
    var chat = C.host && C.host.querySelector && C.host.querySelector('[data-cos-chat]');
    if (!chat) return null;
    var slot = chat.querySelector('[data-cos-prep]');
    if (!P) { if (slot) slot.remove(); return null; }
    if (!slot && create !== false) {
      slot = document.createElement('div');
      slot.className = 'cc-prep'; slot.setAttribute('data-cos-prep', '');
      chat.insertBefore(slot, chat.querySelector('[data-cos-form="chat"]'));
    }
    return slot;
  }
  function prepBox() { var slot = prepSlot(false); return slot && slot.querySelector('[data-cos-prep-steer]'); }
  function focusPrep() { var box = prepBox(); if (box && keyboardFirst()) box.focus(); }
  function prepHeadLine(p) {
    var when = prepWhen(p.startsAt);
    return (when ? 'Starts ' + when + '. ' : '') + 'Add what matters and any files, then Prep me. Add them to the meeting from its live view.';
  }
  function prepPanelHtml(p) {
    return '<section class="mt-panel cc-prep-panel" aria-label="' + esc('Prep for ' + p.title) + '">' +
      '<div class="mt-ask-head"><h3 class="mt-ask-title cc-prep-title">' + esc('Prep for ' + p.title) + '</h3>' +
        '<span class="cc-prep-head-acts"><button type="button" class="mt-link" data-cos="prep-archive">Archive this prep</button>' +
        '<button type="button" class="mt-link" data-cos="prep-close">Close</button></span></div>' +
      '<p class="mt-ask-line">' + esc(prepHeadLine(p)) + '</p>' +
      '<form class="mt-composer cc-prep-form" data-cos-prep-form autocomplete="off">' +
        '<textarea class="field" rows="3" data-cos-prep-steer maxlength="' + prepChars() + '" placeholder="What should this prep focus on?" aria-label="What should this prep focus on?">' + esc(p.steer) + '</textarea></form>' +
      '<div class="cc-prep-acts"><span class="mt-muted cc-prep-count" data-prep-count>' + esc(prepCountText(p)) + '</span>' +
        '<label class="cx-btn quiet mt-addfile cc-prep-add" title="Add a screenshot or files to this prep">' + '<svg class="icon" aria-hidden="true"><use href="#i-clip"/></svg><span>Add file</span>' +
          '<input type="file" class="cc-file" multiple accept="' + PREP_ACCEPT + '" data-cos-prep-file aria-label="Add files to this prep"></label>' +
        '<button type="button" class="cx-btn primary" data-cos="prep-run">' + esc(prepRunLabel(p)) + '</button></div>' +
      '<p class="' + (p.warn ? 'mt-amber-line' : 'mt-muted') + ' cc-prep-note" data-prep-note role="status"' + (p.note ? '' : ' hidden') + '>' + esc(p.note) +
        (p.signedOut ? ' <button type="button" class="link-btn cc-text-btn" data-cos="sign-in">Sign in again</button>' : '') + '</p>' +
      // The box and Prep me first, so both show as soon as it opens; the files list under them grows downward.
      '<div data-prep-files>' + prepFilesHtml(p) + '</div>' +
      '</section>';
  }
  function prepFileMeta(f) {
    if (f.status === 'ready') return [f.notice || '', Number(f.bytes) > 0 ? sizeLabel(Number(f.bytes)) : ''].filter(Boolean).join(' · ');
    return f.notice || PREP_FILE_STATE[f.status] || '';
  }
  function prepUpMeta(t) {
    if (t.state === 'reading') return t.kind === 'photo' ? 'Preparing the image' : 'Preparing';
    if (t.state === 'uploading') return 'Uploading ' + Math.round(t.progress * 100) + '%';
    if (t.state === 'adding') return t.kind === 'photo' ? 'Reading the text in the image' : 'Adding to the prep';
    return t.error || 'Did not upload';
  }
  function prepFilesHtml(p) {
    var files = prepFiles(p.draft), ups = p.ups;
    var title = p.loading ? 'Opening this prep…' : files.length ? 'Files · ' + files.length + (ups.length ? ' · adding ' + ups.filter(function (t) { return t.state !== 'failed'; }).length : '')
      : ups.length ? 'Adding files' : 'No files yet. Add file, paste or drop one here.';
    var rows = files.map(function (f) {
      var meta = prepFileMeta(f);
      return '<li class="mt-up ready"><span class="mt-files-name">' + esc(f.name) + '</span>' + (meta ? '<span class="mt-up-meta mt-muted">' + esc(meta) + '</span>' : '') +
        '<span class="mt-up-acts"><button type="button" class="mt-link" data-cos="prep-remove" data-file="' + esc(f.id) + '" aria-label="' + esc('Remove ' + f.name) + '">Remove</button></span></li>';
    }).concat(ups.map(function (t) {
      return '<li class="mt-up ' + t.state + '" data-prep-up="' + esc(t.id) + '"><span class="mt-files-name">' + esc(t.name) + '</span>' +
        '<span class="mt-up-meta ' + (t.state === 'failed' ? 'mt-amber' : 'mt-muted') + '" data-up-meta>' + esc(prepUpMeta(t)) + '</span>' +
        '<span class="mt-up-acts">' + (t.state === 'failed' ? '<button type="button" class="mt-link" data-cos="prep-retry" data-up="' + esc(t.id) + '">Retry</button>' : '') +
        '<button type="button" class="mt-link" data-cos="prep-cancel" data-up="' + esc(t.id) + '" aria-label="' + esc('Remove ' + t.name) + '">' + (t.state === 'failed' ? 'Remove' : 'Cancel') + '</button></span>' +
        (t.state === 'uploading' || t.state === 'reading' ? '<span class="mt-up-bar" data-up-bar style="width:' + Math.round(t.progress * 100) + '%"></span>' : '') + '</li>';
    }));
    return '<div class="mt-files live"><div class="mt-files-head quiet"><svg class="icon" aria-hidden="true"><use href="#i-clip"/></svg><span>' + esc(title) + '</span></div>' +
      (rows.length ? '<ul class="mt-files-list">' + rows.join('') + '</ul>' : '') + '</div>';
  }
  function prepCountText(p) {
    var n = p.steer.length, max = prepChars();
    return n >= max - 400 ? n.toLocaleString() + ' of ' + max.toLocaleString() + ' characters' : '';
  }
  function prepRunLabel(p) { return p.running ? 'Prepping…' : prepUploading(p) ? 'Uploading…' : 'Prep me'; }
  function setPrepNote(p, text, warn) {
    p.note = text || ''; p.warn = !!warn && !!text;
    p.signedOut = /signed out/i.test(p.note);
    if (P === p) paintPrepParts(p);
  }
  function paintPrep(rebuild) {
    var slot = prepSlot(!!P);
    if (!slot || !P) return;
    if (rebuild || slot.getAttribute('data-key') !== P.key) {
      slot.setAttribute('data-key', P.key);
      slot.innerHTML = prepPanelHtml(P);
      var box = slot.querySelector('[data-cos-prep-steer]'); if (box) W.autoGrow(box);
      return;
    }
    var files = slot.querySelector('[data-prep-files]'); if (files) files.innerHTML = prepFilesHtml(P);
    paintPrepParts(P);
  }
  // The button, the count and the note: never the box (the words and the caret stay where they are).
  function paintPrepParts(p) {
    var slot = P === p ? prepSlot(false) : null; if (!slot) return;
    var run = slot.querySelector('[data-cos="prep-run"]');
    if (run) { run.disabled = !p.draft || p.running || prepUploading(p); run.textContent = prepRunLabel(p); }
    var count = slot.querySelector('[data-prep-count]'); if (count) count.textContent = prepCountText(p);
    var pick = slot.querySelector('[data-cos-prep-file]'); if (pick) pick.disabled = !p.draft || prepFiles(p.draft).length + p.ups.length >= prepMax();
    var note = slot.querySelector('[data-prep-note]');
    if (note) {
      note.className = (p.warn ? 'mt-amber-line' : 'mt-muted') + ' cc-prep-note';
      note.innerHTML = esc(p.note) + (p.signedOut ? ' <button type="button" class="link-btn cc-text-btn" data-cos="sign-in">Sign in again</button>' : '');
      note.hidden = !p.note;
    }
  }
  function paintPrepProgress(t) {
    var slot = prepSlot(false); if (!slot) return;
    var row = slot.querySelector('[data-prep-up="' + t.id + '"]'); if (!row) return;
    var meta = row.querySelector('[data-up-meta]'); if (meta) meta.textContent = prepUpMeta(t);
    var bar = row.querySelector('[data-up-bar]'); if (bar) bar.style.width = Math.round(t.progress * 100) + '%';
  }
  function onPrepClick(t, what) {
    var p = P; if (!p) return;
    if (what === 'prep-close') return closePrep();
    if (what === 'prep-run') return runPrep(p);
    if (what === 'prep-archive') return archivePrep(p);
    if (what === 'prep-remove') return removePrepFile(p, t.getAttribute('data-file'));
    var up = p.ups.filter(function (x) { return x.id === t.getAttribute('data-up'); })[0];
    if (!up) return;
    if (what === 'prep-retry' && up.state === 'failed') return sendPrepFile(p, up);
    if (what === 'prep-cancel') {
      if (up.xhr) { try { up.xhr.abort(); } catch (_e) {} }
      p.ups = p.ups.filter(function (x) { return x !== up; });
      paintPrep();
      prepUploadsSettled(p);
    }
  }
  function onPrepDrag(e, slot) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (!(types && Array.prototype.indexOf.call(types, 'Files') >= 0)) return;
    e.preventDefault();
    if (e.type === 'dragover' || e.type === 'dragenter') { slot.classList.add('dragging'); return; }
    slot.classList.remove('dragging');
    if (e.type === 'drop') addPrepFiles(e.dataTransfer.files);
  }

  // ── events (delegated from the Messages pane) ─────────
  function onClick(t) {
    var what = t.getAttribute('data-cos');
    if (/^prep-/.test(what || '')) return onPrepClick(t, what);
    if (what === 'ask') return doAsk(kOf(t));
    if (what === 'drop') return doDrop();
    if (what === 'all') return W.go('messages');
    if (what === 'read-all') return markReadIfShown(true);
    if (what === 'new-thread') return newThread();
    if (what === 'retry') { C.feedState = 'idle'; return loadFeed(); }
    if (what === 'act') return act(t.getAttribute('data-item'), t.getAttribute('data-act'));
    if (what === 'move-to') return moveTo(t.getAttribute('data-item'), t.getAttribute('data-dest'), t.getAttribute('data-domain'));
    if (what === 'move-cancel') { C.moving = ''; return paintFeed(false); }
    if (what === 'open-msg') return W.go('messages', ['m', t.getAttribute('data-no')]);
    if (what === 'open-session') return W.go('sessions', [t.getAttribute('data-provider') || 'claude', t.getAttribute('data-sid')]);
    if (what === 'open-sessions') return W.go('sessions');
    if (what === 'archive') return toggleArchive();
    if (what === 'steps') { var sa = C.asks.filter(function (x) { return x.cid === t.getAttribute('data-cid'); })[0]; if (sa) sa.stepsOpen = !sa.stepsOpen; return; }
    if (what === 'steer') {
      var a = C.asks.filter(function (x) { return x.cid === t.getAttribute('data-cid'); })[0];
      if (a) { a.steering = !a.steering; if (a.replyKey) paintReplyFeed(a.replyKey); else paintFeed(false); var f = document.querySelector('[data-cos-steer="' + a.cid + '"] input'); if (f) f.focus(); }
      return;
    }
    if (what === 'cancel') return cancel(t.getAttribute('data-cid'));
    if (what === 'again') return askAgain(t.getAttribute('data-cid'));
    if (what === 'att-remove') return removeAtt(kOf(t), t.getAttribute('data-att'));
    if (what === 'att-retry') {
      var k = kOf(t);
      if (findAtt(k, t.getAttribute('data-att'))) { setNote(k, ''); boxRetry(k, t.getAttribute('data-att')); }
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
    if (!isComposerInput(e.target) || e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.shiftKey) return;
    e.preventDefault();
    var k = kOf(e.target);
    if (e.altKey) { if (k === CHAT && dropOn()) doDrop(); return; }
    doAsk(k);
  }
  function onInput(e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-cos-prep-steer')) return onPrepInput(e.target);
    if (isComposerInput(e.target)) { var k = kOf(e.target); k.draft = e.target.value; saveDraft(k); W.autoGrow(e.target); paintButtons(k); }
  }
  function onChangeEvent(e) {
    var t = e.target;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute('data-cos-model')) { C.model = t.value; save(); syncMenus(); }
    else if (t.hasAttribute('data-cos-effort')) { C.effort = t.value; save(); syncMenus(); }
    else if (t.hasAttribute('data-cos-file')) { addFiles(kOf(t), t.files); t.value = ''; }
    else if (t.hasAttribute('data-cos-prep-file')) { addPrepFiles(t.files); t.value = ''; }
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
    if (e.target.matches && e.target.matches('[data-cos-prep-form]')) { e.preventDefault(); return true; }
    return false;
  }
  // Paste a photo or a file into the box; drop files on the composer.
  function onPaste(e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-cos-prep-steer')) {
      var pf = e.clipboardData && e.clipboardData.files;
      if (pf && pf.length) { e.preventDefault(); addPrepFiles(pf); }
      return;
    }
    if (!isComposerInput(e.target)) return;
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); addFiles(kOf(e.target), files); }
  }
  function onDrag(e) {
    var prep = e.target && e.target.closest && e.target.closest('[data-cos-prep]');
    if (prep) return onPrepDrag(e, prep);
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
  // 7.0.2 (A2, the Duo audit): after the keyboard closes on the chat (one column, the page scrolls), iOS can leave the
  // page scrolled past its end, which showed as blank page under Model and Effort. Once it has closed (app.js
  // COSWeb.onKeyboard 'after'), scrollY comes back inside the page's range, and when the chat's own box had the
  // keyboard the composer goes back to the bottom of the screen.
  var LAST = { composer: false };
  document.addEventListener('focusin', function (e) {
    var f = e && e.target && e.target.closest ? e.target.closest('[data-cos-form]') : null;
    LAST.composer = !!(f && f.getAttribute('data-cos-form') === CHAT.name);
  });
  function settleAfterKeyboard() {
    var r = W.parseRoute();
    if (wide() || r.pane !== 'messages' || r.args[0] !== 'cos') return false;
    var se = document.scrollingElement || document.documentElement;
    if (!se) return false;
    var max = Math.max(0, Math.round((se.scrollHeight || 0) - (window.innerHeight || 0))), y = Math.round(window.scrollY || 0);
    if (y > max) { window.scrollTo(0, max); return true; }
    var form = formOf(CHAT);
    if (LAST.composer && form && form.getBoundingClientRect && (window.innerHeight || 0) - form.getBoundingClientRect().bottom > 1) { window.scrollTo(0, max); return true; }
    return false;
  }
  // 7.0.2 (A4): two columns (860 px and up, the unfolded Duo) with the keyboard up for a field in the chat column.
  // cos-chat.css makes the column the visible box (html.kb-chat), but a sticky column only reaches its top once the page
  // has scrolled to it, so on open the page scrolls it there, and where the page is too short to, the column is capped
  // to what is left above the keyboard. The cap follows each change of the visible box while the keyboard is up (a
  // keyboard rising in steps, QA W6) and goes when it closes, when focus leaves the column, or below 860 px (a fold
  // with the keyboard up never keeps it).
  var DOCK_MIN_PX = 120;
  function dockWide(what, v) {
    var mr = C.host;
    if (!mr || !mr.style) return false;
    var a = document.activeElement;
    var keep = (what === 'open' || what === 'move') && wide() && !!a && !!mr.contains && mr.contains(a) && W.parseRoute().pane === 'messages';
    v = v || (W.viewportFit ? W.viewportFit() : null);
    if (!keep || !v || !mr.getBoundingClientRect) { mr.style.maxHeight = ''; return false; }
    var want = v.top + 8, top = mr.getBoundingClientRect().top;
    // On open, and on any later move that left the column's top too low to fit a usable column (an unfold with the
    // keyboard up, canary 7.0.2 WARNING 2), the page scrolls the column up to the visible box.
    var low = top > v.top + v.height - DOCK_MIN_PX - 8;
    if ((what === 'open' || low) && top > want + 1) { window.scrollBy(0, Math.round(top - want)); top = mr.getBoundingClientRect().top; }
    mr.style.maxHeight = Math.max(DOCK_MIN_PX, Math.round(v.top + v.height - Math.max(top, v.top) - 8)) + 'px';
    return true;
  }
  // 7.0.2 (QA W7): which composer the keyboard is for. html.kb-up (app.js) says only that a keyboard is up on the page;
  // html.kb-chat says it is for a field in the chat column (cos-chat.css docks the column and the one-column composer on
  // it), and .cc-kb marks the one composer that has it (only that one turns compact). The Messages search box at 860 px
  // and up, or a field in another pane, leaves the chat as it is.
  function markKeyboard(up) {
    var a = up ? document.activeElement : null, de = document.documentElement;
    var form = a && a.closest ? a.closest('[data-cos-form]') : null;
    document.querySelectorAll('.cc-composer.cc-kb').forEach(function (f) { if (f !== form) f.classList.remove('cc-kb'); });
    if (form && form.classList) form.classList.add('cc-kb');
    var inChat = !!(a && C.host && C.host.contains && C.host.contains(a));
    if (de && de.classList) de.classList.toggle('kb-chat', inChat);
    return inChat;
  }
  // The composer that has the keyboard, brought into view on open and on every later change of the visible box (a fold
  // or an unfold with the keyboard up, canary 7.0.2). Only while the keyboard is for the chat, and only for a composer
  // (a steer box or the search box is left where it is).
  function revealComposer() {
    var a = document.activeElement, de = document.documentElement;
    if (!a || !de || !de.classList || !de.classList.contains('kb-chat')) return false;
    var form = a.closest ? a.closest('[data-cos-form]') : null;
    if (!form || !form.scrollIntoView) return false;
    form.scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (W.onKeyboard) W.onKeyboard(function (what, v) {
    if (what === 'after') { settleAfterKeyboard(); return; }
    markKeyboard(what !== 'close');
    dockWide(what, v);
    if (what !== 'close') revealComposer();
  });
  // Focus moving between fields while the keyboard stays up: mark (and dock) for the new one.
  document.addEventListener('focusin', function () {
    if (!W.keyboardUp || !W.keyboardUp()) return;
    markKeyboard(true);
    dockWide('move');
  });

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
    // Today round 2: "Ask about this" under the Today summary (app.js sendTodayAsk).
    askAbout: askAbout, aboutContextText: aboutContextText,
    onClick: onClick, onKey: onKey, onInput: onInput, onChange: onChangeEvent, onSubmit: onSubmit, onPaste: onPaste, onDrag: onDrag,
    setOnChange: function (fn) { C.onChange = fn; }, setOnAnswered: function (fn) { C.onAnswered = fn; },
    // Test and render hooks: what the chat holds right now.
    classify: classify, uploadMedia: uploadMedia, uploadErrorText: uploadErrorText, uuid: uuid,
    // 11/07: the attach kit, for Today's reply and note boxes and the Ask sheet (see "the attach kit" above).
    attach: {
      max: MAX_ATTS, accept: ACCEPT,
      // opts.anyBytes (a session turn): any file up to that size, sent as it is (classifyForSession).
      box: function (ui, opts) { return { atts: [], signedOut: false, ui: ui || {}, anyBytes: opts && opts.anyBytes > 0 ? opts.anyBytes : 0 }; },
      add: boxAdd, remove: boxRemove, retry: boxRetry, clear: boxClear,
      take: boxTake, restore: boxRestore,
      pending: uploadsPending, failed: uploadsFailed,
      ids: function (box) { return readyAtts(box).slice(0, MAX_ATTS).map(function (t) { return t.mediaId; }); },
      sent: function (box) { return readyAtts(box).slice(0, MAX_ATTS).map(function (t) { return { name: t.name, kind: t.kind, thumb: t.thumb }; }); },
      chipsHtml: function (box, attr) { return box.atts.map(function (t) { return chipHtml(t, attr); }).join(''); },
      clipHtml: clipHtml, cameraHtml: cameraHtml, limitLine: limitLine,
      // Files on the clipboard (a pasted screenshot), or none.
      pasted: function (e) { var f = e && e.clipboardData && e.clipboardData.files; return f && f.length ? f : null; },
      // Files dragged over `zone`: marks it while they hover, and answers the files on the drop. Null for anything else.
      dragged: function (e, zone) {
        var types = e && e.dataTransfer && e.dataTransfer.types;
        if (!types || Array.prototype.indexOf.call(types, 'Files') < 0) return null;
        e.preventDefault();
        if (e.type === 'dragover' || e.type === 'dragenter') { zone.classList.add('dragging'); return null; }
        zone.classList.remove('dragging');
        return e.type === 'drop' ? e.dataTransfer.files : null;
      },
      // How many files a session turn takes on this Mac (threadTurnAttachments); 0 means words only.
      turnFiles: function () { return C.caps && C.caps.turnFiles > 0 ? C.caps.turnFiles : 0; },
      turnFileBytes: function () { return C.caps && C.caps.turnFiles > 0 && C.caps.turnFileBytes > 0 ? C.caps.turnFileBytes : 0; },
      // 6.99.31: 1 when the Mac offers "Approve on this phone" (the 3144 signer), else 0.
      webKeySigner: function () { return C.caps && C.caps.webKeySigner === 1 ? 1 : 0; },
      askOn: askOn, ensureCaps: ensureCaps
    },
    // 6.99.19: Prep. meetings.js reads the capability from here (one /api/health read for the page).
    prepCaps: prepCaps,
    // Today's Next up (app.js prepNext): Prep me for that meeting, as the chat's own Prep me does. With Prep on the Mac
    // the Prep composer opens (it paints when the chat mounts; the same meeting reopens the same draft); without it,
    // the plain Ask. Resolves to 'prep', 'ask' or '' (neither is on).
    prepFor: function (title, startsAt) {
      return ensureCaps().then(function () {
        var t = String(title || '').trim() || 'my next meeting';
        var item = { id: 'today-next:' + (startsAt || '') + ':' + t, title: t, prep: { title: t, startsAt: startsAt || null } };
        if (prepOn()) { openPrep(item); return 'prep'; }
        if (C.caps && C.caps.jobs) { submitAsk('Prep me for ' + t, ''); return 'ask'; }
        return '';
      });
    },
    // Prep on every Next up row (Miles 11/09): Start prep under a row of Today. With Prep on the Mac, the Prep composer
    // opens for that meeting (the same draft prepFor opens), the typed context joins its notes, the files go up through
    // the composer's own path (addPrepFiles), and Prep me runs once they are in. Without Prep, the plain Ask "Prep me for
    // <title> at <time>" with the context as its quoted reference. Resolves to 'prep', 'ask' or '' (neither is on).
    prepStart: function (title, startsAt, extra) {
      var steer = String((extra && extra.steer) || '').trim(), files = (extra && extra.files) || [];
      return ensureCaps().then(function () {
        var t = String(title || '').trim() || 'my next meeting';
        if (prepOn()) {
          var item = { id: 'today-next:' + (startsAt || '') + ':' + t, title: t, prep: { title: t, startsAt: startsAt || null } };
          return openPrep(item).then(function (p) {
            if (!p || P !== p || !p.draft) return 'prep';
            var merged = mergeSteer(p.steer, steer);
            if (merged !== p.steer) {
              p.steer = merged; p.dirty = true;
              var box = prepBox(); if (box && box.value !== p.steer) { box.value = p.steer; W.autoGrow(box); }
              paintPrepParts(p);
            }
            if (files.length && addPrepFiles(files) > 0) return 'prep';
            p.autoRun = true;
            prepUploadsSettled(p);
            return 'prep';
          });
        }
        if (C.caps && C.caps.jobs) {
          var d = startsAt ? W.toDate(startsAt) : null, when = d ? W.clock(d) : '';
          var context = prepAskContext(t, when, steer);
          return new Promise(function (resolve, reject) {
            submitAsk('Prep me for ' + t + (when ? ' at ' + when : ''), null, function (ok) { if (ok) resolve('ask'); else reject(new Error('Prep did not start. Your context is still under the meeting on Today.')); },
              context ? { context: context, contextRef: PREP_ASK_REF } : undefined);
          });
        }
        return '';
      });
    },
    // The file types the Prep composer takes (Today's Add files uses the same list).
    prepAccept: PREP_ACCEPT,
    // The Prep server id to name on a write: the newest from capabilities.prep or any Prep answer (meetings.js reports its own).
    prepInstance: function () { return PREP_INST; }, notePrepInstance: function (id) { if (typeof id === 'string' && id) PREP_INST = id; },
    _prep: function () { return P; }, _openPrep: openPrep, _prepHtml: function () { return P ? prepPanelHtml(P) : ''; }, _addPrepFiles: addPrepFiles,
    _runPrep: function () { runPrep(P); }, _sha256Js: sha256Js, _closePrep: closePrep, _onPrepInput: onPrepInput, _savePrepSteer: function () { return P ? savePrepSteer(P) : null; },
    _errorLine: errorLine, _askAgain: askAgain, _askHtml: askHtml, _paintFeed: paintFeed, _paintAsk: paintAsk, _poll: poll, _finished: finished, _stepsHtml: stepsHtml, _relayHtml: relayHtml, _scrubPaths: scrubPaths, _settle: settleAfterKeyboard, _dockWide: dockWide, _revealComposer: revealComposer, _markKeyboard: markKeyboard, _refreshDefault: refreshDefault, _defaultLabel: defaultLabel, _modelMenuHtml: modelMenuHtml,
    _state: C, _composer: composer, _classify: classify, _modelsFrom: modelsFrom, _addFiles: addFiles, _itemHtml: itemHtml, _setCaps: setCaps, _threadLine: threadLine, _postTurn: postTurn
  };
})();
