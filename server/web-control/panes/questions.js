/* COS Control Web: session questions and approvals (server 6.99.12), the cards the Even app shows
   (session-question-phone.ts), answered with the same POST /api/session-questions/:id/answer.

   Shown at the top of every pane while one waits, so wherever the page is, the question is in front of you.
   The page reads GET /api/session-questions?client=web only when all of these hold:
   - /api/models says capabilities.sessionQuestions.webClient (the server takes the browser session on that route; an
     older server answers it 401, which would sign the page out, so the page never calls it there);
   - the broker is on (sessionQuestions.enabled);
   - this tab is visible and signed in.
   An open tab never makes the Mac hold a question back from its own pop-up (6.99.13, Miles's option B). What the page
   adds (6.99.26, Miles 11/07: "Away rule, like phone") is its touch: `hold=1&presenceAgeMs=<ms>`, how long ago a touch
   or a key landed on this page while it was in front. While the Mac's desk is idle, a question that starts within 30
   minutes of that touch is held for the away hold (up to 10 minutes), answerable here and on the glasses or phone; at
   the desk the Mac's own pop-up shows at once. No touch since the page opened sends no presence. The poll is a plain
   fetch: a 401 stops the poll quietly and never signs the page out (the panes say so on their next read).

   A question the Mac's own prompt waits on (`settled` with `waitingAtMac`, a held one that went back to the Mac) shows
   read-only in the cards drawn for that session (Today's waiting sheet), with its words when this page saw them while
   it was held: the server keeps codes only once a question settles. Nothing here can answer it.

   Allow once, Deny and Submit are tap-then-confirm, as in the Even app: an approval runs a command on the Mac. Leave for
   the Mac hands the request back to the Mac's own dialog. Plan approvals never come here: the broker never holds
   ExitPlanMode (lib/permission-broker.ts UNBROKERED_TOOLS). */
(function () {
  'use strict';
  var W = window.COSWeb;
  var esc = W.esc, api = W.api;
  var host = document.getElementById('sq-host');
  if (!host) return;

  var Q = {
    cap: null,            // capabilities.sessionQuestions, once read
    capAt: 0,
    items: [],            // pending items, oldest first
    picks: {},            // id -> [{ labels: [], other: '' }] per question
    armed: {},            // id -> 'send' | 'allow' | 'deny'
    armedAt: {},          // id -> when it was armed (COSWeb.confirmReady)
    sending: {},          // id -> clientAnswerId while a POST is out
    notes: {},            // id -> one line under the card
    answerIds: {},        // id -> the clientAnswerId this page answers under (a retry replays it)
    atMac: [],            // settled items the Mac's own prompt still waits on, newest first
    seen: {},             // id -> { questions: [text], summary } the words of a card this page drew while it was held
    answered: {},         // id -> { sessionId, at } answered here or anywhere (settled `answered`), for two minutes
    timer: null,
    tick: null,
    stopped: false
  };
  var DEFAULT_POLL_MS = 10000;
  // Miles's words for a question at the Mac (11/07), one place: Today's Needs you reads them from here too.
  var MAC_LINE = "Waiting on your Mac's prompt. Answer it on the Mac (or through Screens).";
  var ANSWERED_LINE = 'Answered. The session carries on.';
  var ANSWERED_MS = 120000;

  // ── this page's touch, for the Mac's away hold (6.99.26) ──
  // A real touch, click or key while the tab is in front. Kept on both clocks; its age is the larger of the two, so a
  // phone that slept never sends a touch younger than it is (the server's own rule, lib/client-liveness).
  var PRESENCE_MAX_MS = 86400000;
  var touch = { mono: null, wall: null };
  function monoNow() { return typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : null; }
  function presenceAge() {
    if (touch.wall === null) return null;
    var m = monoNow();
    var age = Math.max(0, Date.now() - touch.wall, m !== null && touch.mono !== null ? m - touch.mono : 0);
    age = Math.round(age);
    return age <= PRESENCE_MAX_MS ? age : null;
  }
  function noteTouch(e) {
    if (document.hidden || (e && e.isTrusted === false)) return;
    var before = presenceAge();
    touch.mono = monoNow(); touch.wall = Date.now();
    // The first touch in a while reaches the Mac now, not at the next poll, so a question that starts a moment later
    // is held for this page.
    if ((before === null || before > 60000) && !Q.stopped && signedIn()) schedule(250);
  }
  ['pointerdown', 'touchstart', 'keydown'].forEach(function (t) { document.addEventListener(t, noteTouch, { capture: true, passive: true }); });
  function pollUrl() {
    var age = presenceAge();
    return '/api/session-questions?client=web&hold=1' + (age === null ? '' : '&presenceAgeMs=' + age);
  }

  function signedIn() { var shell = document.getElementById('app-shell'); return !!(shell && !shell.classList.contains('hidden')); }
  function answerId() {
    var b = new Uint8Array(12); crypto.getRandomValues(b);
    return 'gw_' + Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
  }
  function secondsLeft(item) {
    var created = Date.parse(item.createdAt), deadline = Date.parse(item.deadlineAt);
    var span = Math.max(0, Math.ceil((deadline - created) / 1000));
    var left = Math.ceil((deadline - Date.now()) / 1000);
    return Math.max(0, Math.min(span, isFinite(left) ? left : 0));
  }
  function timeLeft(s) { return s > 99 ? Math.ceil(s / 60) + ' min left' : s + ' s left'; }
  function engine(item) { return item.provider === 'codex' ? 'Codex' : 'Claude'; }

  // ── the capability, then the poll ─────────────────────
  function readCap() {
    if (Q.cap && Date.now() - Q.capAt < 5 * 60000) return Promise.resolve(Q.cap);
    return api('/api/models').then(function (m) {
      Q.cap = (m && m.capabilities && m.capabilities.sessionQuestions) || { enabled: false };
      Q.capAt = Date.now();
      return Q.cap;
    }, function () { return null; });
  }
  function usable(cap) { return !!(cap && cap.enabled === true && cap.webClient === true); }
  function schedule(ms) {
    clearTimeout(Q.timer);
    Q.timer = setTimeout(poll, ms);
  }
  function poll() {
    clearTimeout(Q.timer);
    if (Q.stopped || document.hidden || !signedIn()) return;
    readCap().then(function (cap) {
      if (!usable(cap)) { clearCards(); schedule(60000); return; }
      return fetch(pollUrl(), { headers: { 'X-COS-Web': '1' }, credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
        if (res.status === 401) { Q.stopped = true; clearCards(); return; }
        if (!res.ok) { schedule(DEFAULT_POLL_MS); return; }
        return res.json().then(function (d) {
          if (!d || d.enabled === false) { clearCards(); schedule(60000); return; }
          take(Array.isArray(d.items) ? d.items : [], Array.isArray(d.settled) ? d.settled : []);
          var every = Number(d.pollIntervalMs) > 0 ? Number(d.pollIntervalMs) : DEFAULT_POLL_MS;
          // While one waits, read faster so an answer from the glasses or the Mac clears it here too.
          schedule(Q.items.length ? Math.min(every, 3000) : every);
        });
      }, function () { schedule(DEFAULT_POLL_MS); });
    });
  }
  function start() { Q.stopped = false; poll(); }
  function stop() { clearTimeout(Q.timer); }

  // ── state from a poll ─────────────────────────────────
  function take(items, settled) {
    var pending = items.filter(function (i) { return i && i.answerable !== false && (i.kind === 'question' || i.kind === 'approval'); });
    var atMac = (settled || []).filter(function (i) { return i && i.waitingAtMac === true && (i.kind === 'question' || i.kind === 'approval'); });
    var before = Q.items.map(function (i) { return i.id; }).join('|') + '/' + Q.atMac.map(function (i) { return i.id; }).join('|');
    var after = pending.map(function (i) { return i.id; }).join('|') + '/' + atMac.map(function (i) { return i.id; }).join('|');
    // The words of a held card, kept while the server lists it either way, so one that goes back to the Mac still says
    // what it asks. Only in memory.
    pending.forEach(function (i) {
      Q.seen[i.id] = { questions: (i.questions || []).map(function (q) { return String((q && q.question) || ''); }).filter(Boolean),
        summary: i.approval && i.approval.summary ? String(i.approval.summary) : '' };
    });
    var listed = {}; pending.concat(atMac).forEach(function (i) { listed[i.id] = 1; });
    Object.keys(Q.seen).forEach(function (id) { if (!listed[id]) delete Q.seen[id]; });
    Q.atMac = atMac;
    // Answered on any screen: the session list may still call the session waiting for a moment; this says it is not.
    (settled || []).forEach(function (i) {
      if (i && i.resolution === 'answered' && i.sessionId && !Q.answered[i.id]) Q.answered[i.id] = { sessionId: String(i.sessionId).toLowerCase(), at: Date.parse(i.settledAt) || Date.now() };
    });
    Object.keys(Q.answered).forEach(function (id) { if (Date.now() - Q.answered[id].at > ANSWERED_MS) delete Q.answered[id]; });
    var ids = {}; pending.forEach(function (i) { ids[i.id] = 1; });
    Object.keys(Q.picks).forEach(function (id) { if (!ids[id]) { delete Q.picks[id]; delete Q.armed[id]; delete Q.notes[id]; delete Q.answerIds[id]; } });
    pending.forEach(function (i) {
      if (!Q.picks[i.id]) Q.picks[i.id] = (i.questions || []).map(function () { return { labels: [], other: '' }; });
    });
    Q.items = pending;
    // A card that is already drawn is never redrawn by a poll: a half-typed Other answer stays as it is.
    if (before !== after) { render(); changed(); }
  }
  function clearCards() { if (Q.items.length || Q.atMac.length) { Q.items = []; Q.atMac = []; render(); changed(); } }
  // Today's Needs you says, per session, whether it can be answered here or waits on the Mac.
  function changed() { if (W.today && W.today.questionsChanged) { try { W.today.questionsChanged(); } catch (_e) {} } }

  // ── drawing ───────────────────────────────────────────
  function complete(item) {
    var picks = Q.picks[item.id] || [];
    return (item.questions || []).every(function (q, qi) {
      var p = picks[qi] || { labels: [], other: '' };
      var n = p.labels.length + (p.other.trim() ? 1 : 0);
      return n > 0 && (q.multiSelect || n === 1);
    });
  }
  function noteHtml(item) {
    var text = Q.notes[item.id] || '';
    return '<p class="sq-note' + (text ? '' : ' hidden') + '" data-sq-note="' + esc(item.id) + '" role="status">' + esc(text) + '</p>';
  }
  // The card reads like Claude Code's own question in the terminal (Miles 11/07): a strip naming each question, ☒ once
  // it has an answer, then ✓ Submit; each question in bold, numbered options with their descriptions under them, Other
  // as the last number, typed in place; keys 1 to 9 pick while a question has focus. Then the answers to review, and
  // Submit, tap then tap again. Stacked rather than one question per page: Today's sheet is at most 480 px wide, folded
  // or not, and a stacked card keeps every choice in view while you review. The strip jumps to each part.
  function qLabel(q, qi) { return q && q.header ? String(q.header) : 'Question ' + (qi + 1); }
  function answerWords(item, qi) {
    var p = (Q.picks[item.id] || [])[qi] || { labels: [], other: '' };
    var parts = p.labels.slice();
    if (p.other.trim()) parts.push(p.other.trim());
    return parts.join(', ');
  }
  function stepText(item, qi) { return (answerWords(item, qi) ? '☒ ' : '☐ ') + qLabel(item.questions[qi], qi); }
  function stripHtml(item) {
    var qs = item.questions || [];
    if (qs.length < 2) return '';
    return '<nav class="sq-steps" aria-label="Questions">' + qs.map(function (q, qi) {
      return '<button type="button" class="sq-step" data-sq="step" data-sq-id="' + esc(item.id) + '" data-sq-step="' + qi + '">' + esc(stepText(item, qi)) + '</button>';
    }).join('') + '<button type="button" class="sq-step" data-sq="step" data-sq-id="' + esc(item.id) + '" data-sq-step="submit">✓ Submit</button></nav>';
  }
  function reviewRows(item) {
    return (item.questions || []).map(function (q, qi) {
      var a = answerWords(item, qi);
      return '<li><span class="sq-review-q">' + esc(qLabel(q, qi)) + '</span><span class="sq-review-a' + (a ? '' : ' empty') + '">' + esc(a || 'Not answered yet') + '</span></li>';
    }).join('');
  }
  function reviewHtml(item) {
    if ((item.questions || []).length < 2) return '';
    return '<div class="sq-review" data-sq-review="' + esc(item.id) + '"><p class="sq-review-head">Your answers</p><ol class="sq-review-list">' + reviewRows(item) + '</ol></div>';
  }
  function sendText(id) { return Q.sending[id] ? 'Submitting…' : Q.armed[id] === 'send' ? 'Tap again to submit' : 'Submit'; }
  function questionCard(item, scope) {
    var picks = Q.picks[item.id] || [];
    var sending = !!Q.sending[item.id];
    var single = (item.questions || []).length < 2;
    var blocks = (item.questions || []).map(function (q, qi) {
      var p = picks[qi] || { labels: [], other: '' };
      var type = q.multiSelect ? 'checkbox' : 'radio';
      var name = (scope || 'sq') + '-' + item.id + '-' + qi;
      return '<fieldset class="sq-q" data-sq-qblock="' + qi + '" data-sq-id="' + esc(item.id) + '"><legend class="sq-q-text">' + esc(q.question) +
          (single && q.header ? ' <span class="sq-q-tag">' + esc(q.header) + '</span>' : '') + '</legend>' +
        (q.multiSelect ? '<p class="sq-fine">Pick any that apply.</p>' : '') +
        '<div class="sq-options">' + q.options.map(function (o, oi) {
          var on = p.labels.indexOf(o.label) >= 0;
          return '<label class="sq-option"><input type="' + type + '" name="' + esc(name) + '" data-sq-pick data-sq-id="' + esc(item.id) + '" data-q="' + qi + '" data-o="' + oi + '"' + (on ? ' checked' : '') + (sending ? ' disabled' : '') + '>' +
            '<span class="sq-num" aria-hidden="true">' + (oi + 1) + '.</span>' +
            '<span class="sq-option-text"><span class="sq-option-label">' + esc(o.label) + '</span>' + (o.description ? '<span class="sq-option-desc">' + esc(o.description) + '</span>' : '') + '</span></label>';
        }).join('') +
        '<label class="sq-option sq-option-other"><span class="sq-num" aria-hidden="true">' + (q.options.length + 1) + '.</span>' +
          '<input class="field sq-other" type="text" maxlength="2000" placeholder="Other: type your own answer" aria-label="Your own answer" data-sq-other data-sq-id="' + esc(item.id) + '" data-q="' + qi + '" value="' + esc(p.other) + '"' + (sending ? ' disabled' : '') + '></label>' +
        '</div></fieldset>';
    }).join('');
    return '<article class="sq-card" data-sq-card="' + esc(item.id) + '" data-kind="question">' +
      '<header class="sq-head"><h2 class="sq-title">' + esc(engine(item)) + ' has a question</h2><span class="sq-secs" data-sq-secs="' + esc(item.id) + '">' + esc(timeLeft(secondsLeft(item))) + '</span></header>' +
      stripHtml(item) + blocks + reviewHtml(item) +
      '<p class="sq-fine sq-keys">Type a number to pick.</p>' +
      '<div class="sq-acts"><button type="button" class="cx-btn primary sq-send" data-sq="send" data-sq-id="' + esc(item.id) + '"' + (sending || !complete(item) ? ' disabled' : '') + '>' + sendText(item.id) + '</button>' +
        '<button type="button" class="link-btn sq-leave" data-sq="leave" data-sq-id="' + esc(item.id) + '"' + (sending ? ' disabled' : '') + '>Leave for the Mac</button></div>' +
      noteHtml(item) + '</article>';
  }
  function approvalCard(item) {
    var a = item.approval || { tool: item.tool, summary: '', detail: '' };
    var sending = !!Q.sending[item.id];
    var armed = Q.armed[item.id];
    return '<article class="sq-card" data-sq-card="' + esc(item.id) + '" data-kind="approval">' +
      '<header class="sq-head"><h2 class="sq-title">' + esc(engine(item)) + ' wants to use ' + esc(a.tool || item.tool || 'a tool') + '</h2><span class="sq-secs" data-sq-secs="' + esc(item.id) + '">' + esc(timeLeft(secondsLeft(item))) + '</span></header>' +
      '<pre class="sq-command">' + esc(a.summary || 'No details were sent with this request.') + '</pre>' +
      (a.detail && a.detail !== a.summary ? '<details class="sq-details"><summary>Full command</summary><pre class="sq-command">' + esc(a.detail) + '</pre></details>' : '') +
      '<div class="sq-acts"><button type="button" class="cx-btn primary" data-sq="allow" data-sq-id="' + esc(item.id) + '"' + (sending ? ' disabled' : '') + '>' + (armed === 'allow' ? 'Tap again to allow' : 'Allow once') + '</button>' +
        '<button type="button" class="cx-btn sq-deny" data-sq="deny" data-sq-id="' + esc(item.id) + '"' + (sending ? ' disabled' : '') + '>' + (armed === 'deny' ? 'Tap again to deny' : 'Deny') + '</button>' +
        '<button type="button" class="link-btn sq-leave" data-sq="leave" data-sq-id="' + esc(item.id) + '"' + (sending ? ' disabled' : '') + '>Leave for the Mac</button></div>' +
      noteHtml(item) + '</article>';
  }
  // A question or an approval the Mac's own prompt waits on: what it asks when this page saw it held, and where to answer.
  // No buttons: nothing here can deliver an answer to that prompt.
  function macCard(item) {
    var words = Q.seen[item.id] || { questions: [], summary: '' };
    var title = item.kind === 'approval' ? engine(item) + ' wants to use ' + (item.tool || 'a tool') : engine(item) + ' has a question';
    var body = item.kind === 'approval'
      ? (words.summary ? '<pre class="sq-command">' + esc(words.summary) + '</pre>' : '')
      : words.questions.map(function (q) { return '<p class="sq-q-text sq-mac-q">' + esc(q) + '</p>'; }).join('');
    return '<article class="sq-card sq-mac" data-sq-mac="' + esc(item.id) + '" data-kind="' + esc(item.kind) + '">' +
      '<header class="sq-head"><h2 class="sq-title">' + esc(title) + '</h2></header>' + body +
      '<p class="sq-mac-line">' + esc(MAC_LINE) + '</p></article>';
  }
  function atMacFor(sessionId) {
    // Every item names its session (the broker validates it), so no session asked for matches none: the top of every
    // pane never draws a Mac card.
    var want = String(sessionId || '').toLowerCase();
    return Q.atMac.filter(function (i) { return String(i.sessionId || '').toLowerCase() === want; });
  }
  // True when this session's newest event here is an answer (from this page or any other screen) of the last two
  // minutes, with nothing held for it now and nothing at the Mac since.
  function answeredFor(sessionId) {
    var want = String(sessionId || '').toLowerCase();
    if (!want || itemsFor(want).length) return false;
    var at = 0, macAt = 0;
    Object.keys(Q.answered).forEach(function (id) { var a = Q.answered[id]; if (a.sessionId === want && Date.now() - a.at <= ANSWERED_MS) at = Math.max(at, a.at); });
    atMacFor(want).forEach(function (i) { macAt = Math.max(macAt, Date.parse(i.settledAt) || Date.parse(i.createdAt) || 0); });
    return at > 0 && at >= macAt;
  }
  function wordsOf(id) { var w = Q.seen[id]; return w ? { questions: w.questions.slice(), summary: w.summary } : null; }
  // Other places can show the cards for one session (Today's overlay, panes/today-actions.js): the same items, picks,
  // answer ids and posts, drawn into their own element. A mount is dropped when its element leaves the page.
  var mounts = [];
  function hostsOf() {
    mounts = mounts.filter(function (m) { return m.el.isConnected !== false; });
    return [{ el: host, sessionId: null, scope: 'sq' }].concat(mounts);
  }
  function itemsFor(sessionId) {
    var want = String(sessionId || '').toLowerCase();
    return Q.items.filter(function (i) { return !want || String(i.sessionId || '').toLowerCase() === want; });
  }
  function drawInto(m) {
    var active = document.activeElement;
    var focus = active && active.hasAttribute && active.hasAttribute('data-sq-other') && m.el.contains && m.el.contains(active) ? { id: active.getAttribute('data-sq-id'), q: active.getAttribute('data-q'), start: active.selectionStart, end: active.selectionEnd } : null;
    var list = itemsFor(m.sessionId), mac = atMacFor(m.sessionId);
    m.el.innerHTML = list.map(function (i) { return i.kind === 'approval' ? approvalCard(i) : questionCard(i, m.scope); }).join('') + mac.map(macCard).join('');
    m.el.hidden = !list.length && !mac.length;
    if (focus) {
      var box = m.el.querySelector('[data-sq-other][data-sq-id="' + focus.id + '"][data-q="' + focus.q + '"]');
      if (box) { box.focus({ preventScroll: true }); try { box.setSelectionRange(focus.start, focus.end); } catch (_e) {} }
    }
    if (m.onChange) { try { m.onChange(list.length, mac.length); } catch (_e) {} }
  }
  function render() {
    hostsOf().forEach(drawInto);
    clearInterval(Q.tick);
    if (Q.items.length) Q.tick = setInterval(tickSeconds, 1000);
  }
  function itemOf(id) { for (var i = 0; i < Q.items.length; i++) if (Q.items[i].id === id) return Q.items[i]; return null; }
  // The seconds move without a redraw (a redraw would drop a half-typed answer).
  function tickSeconds() {
    hostsOf().forEach(function (m) {
      m.el.querySelectorAll('[data-sq-secs]').forEach(function (el) { var it = itemOf(el.getAttribute('data-sq-secs')); if (it) el.textContent = timeLeft(secondsLeft(it)); });
    });
  }
  function patchCard(id) {
    var item = itemOf(id), cards = [];
    hostsOf().forEach(function (m) { var c = m.el.querySelector('[data-sq-card="' + id + '"]'); if (c) cards.push(c); });
    if (!item || !cards.length) return render();
    cards.forEach(function (card) { patchOne(card, id, item); });
  }
  function patchOne(card, id, item) {
    var send = card.querySelector('[data-sq="send"]');
    if (send) { send.disabled = !!Q.sending[id] || !complete(item); send.textContent = sendText(id); }
    // The strip's ☐ and ☒ and the answers to review follow each pick, without redrawing the boxes being typed in.
    card.querySelectorAll('[data-sq-step]').forEach(function (step) { var n = step.getAttribute('data-sq-step'); if (n !== 'submit') step.textContent = stepText(item, Number(n)); });
    var review = card.querySelector('[data-sq-review] .sq-review-list'); if (review) review.innerHTML = reviewRows(item);
    var allow = card.querySelector('[data-sq="allow"]'); if (allow) allow.textContent = Q.armed[id] === 'allow' ? 'Tap again to allow' : 'Allow once';
    var deny = card.querySelector('[data-sq="deny"]'); if (deny) deny.textContent = Q.armed[id] === 'deny' ? 'Tap again to deny' : 'Deny';
    var note = card.querySelector('[data-sq-note]'); if (note) { note.textContent = Q.notes[id] || ''; note.classList.toggle('hidden', !Q.notes[id]); }
  }

  // ── answering ─────────────────────────────────────────
  var REFUSED = {
    already_answered: 'Already answered, on the glasses or the Mac.', expired: 'Too late: the Mac took this back.',
    handed_to_desk: 'The Mac has this one now. Answer it there.', hook_gone: 'The session stopped waiting for this answer.',
    not_found: 'This question is gone.', invalid_answer: 'That answer was not accepted. Check each question has a choice.'
  };
  function post(id, body, doneLine) {
    Q.sending[id] = 1; Q.armed[id] = ''; Q.notes[id] = '';
    if (!Q.answerIds[id]) Q.answerIds[id] = answerId();
    body.clientAnswerId = Q.answerIds[id];
    render();
    var asked = itemOf(id);
    api('/api/session-questions/' + encodeURIComponent(id) + '/answer', { method: 'POST', body: body, timeoutMs: 20000 }).then(function () {
      delete Q.sending[id];
      if (asked && asked.sessionId) Q.answered[id] = { sessionId: String(asked.sessionId).toLowerCase(), at: Date.now() };
      Q.items = Q.items.filter(function (i) { return i.id !== id; });
      render(); changed();
      W.toast(doneLine);
      schedule(500);
    }, function (err) {
      delete Q.sending[id];
      var settled = err && REFUSED[err.code] && err.code !== 'invalid_answer';
      if (settled) {
        Q.items = Q.items.filter(function (i) { return i.id !== id; });
        render(); W.toast(REFUSED[err.code]); schedule(500); return;
      }
      // A timeout or a lost answer: the same clientAnswerId goes again on the next tap and the server replays it.
      Q.notes[id] = REFUSED[err && err.code] || ('Not sent: ' + ((err && err.message) || 'the Mac did not answer') + ' Tap again to retry.');
      render();
    });
  }
  function sendAnswers(item) {
    var picks = Q.picks[item.id] || [];
    var answers = (item.questions || []).map(function (q, qi) {
      var p = picks[qi] || { labels: [], other: '' };
      var entry = { labels: q.options.map(function (o) { return o.label; }).filter(function (l) { return p.labels.indexOf(l) >= 0; }) };
      if (p.other.trim()) entry.other = p.other;
      return entry;
    });
    post(item.id, { answers: answers }, 'Sent to ' + engine(item) + '.');
  }
  function onClick(e) {
    var b = e.target.closest('[data-sq]');
    if (!b || b.disabled) return;
    var id = b.getAttribute('data-sq-id'), what = b.getAttribute('data-sq'), item = itemOf(id);
    if (!item) return;
    if (what === 'step') {
      // The strip jumps to a question, or to the answers and Submit.
      var card = b.closest ? b.closest('.sq-card') : null, n = b.getAttribute('data-sq-step');
      var to = card && card.querySelector(n === 'submit' ? '[data-sq-review]' : '[data-sq-qblock="' + n + '"]');
      if (to && to.scrollIntoView) to.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      var f = to && (n === 'submit' ? card.querySelector('[data-sq="send"]') : to.querySelector('input'));
      if (f && f.focus && !f.disabled) f.focus({ preventScroll: true });
      return;
    }
    if (what === 'leave') {
      Q.armed[id] = '';
      if (!Q.answerIds[id]) Q.answerIds[id] = answerId();
      Q.sending[id] = 1; render();
      api('/api/session-questions/' + encodeURIComponent(id) + '/answer', { method: 'POST', body: { clientAnswerId: Q.answerIds[id], handBack: true }, timeoutMs: 20000 }).then(function () {
        delete Q.sending[id]; Q.items = Q.items.filter(function (i) { return i.id !== id; }); render(); W.toast('Left for the Mac.'); schedule(500);
      }, function (err) {
        delete Q.sending[id];
        if (err && REFUSED[err.code] && err.code !== 'invalid_answer') { Q.items = Q.items.filter(function (i) { return i.id !== id; }); render(); W.toast(REFUSED[err.code]); return; }
        Q.notes[id] = 'Not sent: ' + ((err && err.message) || 'the Mac did not answer'); render();
      });
      return;
    }
    // Tap, then tap again: the first tap only arms the button, and the second counts only once the first has been on
    // screen a moment (COSWeb.confirmReady, the rule Today's overlay uses), so a double tap never allows or sends.
    if (Q.armed[id] !== what) { Q.armed[id] = what; Q.armedAt[id] = Date.now(); patchCard(id); return; }
    if (W.confirmReady && !W.confirmReady(Q.armedAt[id])) return;
    if (what === 'send') return sendAnswers(item);
    if (what === 'allow' || what === 'deny') return post(id, { decision: what }, what === 'allow' ? 'Allowed once.' : 'Denied.');
  }
  function onChange(e) {
    var t = e.target;
    if (!t.hasAttribute('data-sq-pick')) return;
    applyPick(t.getAttribute('data-sq-id'), Number(t.getAttribute('data-q')), Number(t.getAttribute('data-o')), !!t.checked);
  }
  // One pick, from a tap or a number key: the model first, then every drawn copy of the card follows it.
  function applyPick(id, qi, oi, checked) {
    var item = itemOf(id); if (!item || Q.sending[id]) return;
    var q = item.questions[qi]; if (!q || !q.options[oi]) return;
    var label = q.options[oi].label, p = Q.picks[id][qi];
    if (q.multiSelect) p.labels = checked ? (p.labels.indexOf(label) >= 0 ? p.labels : p.labels.concat([label])) : p.labels.filter(function (l) { return l !== label; });
    else {
      p.labels = [label]; p.other = '';
      hostsOf().forEach(function (m) { var box = m.el.querySelector('[data-sq-other][data-sq-id="' + id + '"][data-q="' + qi + '"]'); if (box) box.value = ''; });
    }
    hostsOf().forEach(function (m) {
      m.el.querySelectorAll('[data-sq-pick][data-sq-id="' + id + '"][data-q="' + qi + '"]').forEach(function (r) { r.checked = p.labels.indexOf(q.options[Number(r.getAttribute('data-o'))].label) >= 0; });
    });
    // A change after Submit was armed takes the arm back: review, then submit.
    Q.armed[id] = '';
    patchCard(id);
  }
  // Keys 1 to 9 while a question has focus, as in the terminal: the option with that number, or the last number to type
  // your own. Never while typing in Other, and never with a modifier held.
  function onKey(e) {
    var k = e.key;
    if (!/^[1-9]$/.test(k) || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (!t || !t.closest || (t.hasAttribute && t.hasAttribute('data-sq-other'))) return;
    var block = t.closest('[data-sq-qblock]');
    if (!block) return;
    var id = block.getAttribute('data-sq-id'), qi = Number(block.getAttribute('data-sq-qblock')), item = itemOf(id);
    var q = item && item.questions[qi], n = Number(k);
    if (!q || Q.sending[id]) return;
    if (n <= q.options.length) {
      var label = q.options[n - 1].label, on = (Q.picks[id][qi].labels.indexOf(label) >= 0);
      e.preventDefault();
      applyPick(id, qi, n - 1, q.multiSelect ? !on : true);
      var input = block.querySelector('[data-sq-pick][data-o="' + (n - 1) + '"]');
      if (input && input.focus) input.focus({ preventScroll: true });
    } else if (n === q.options.length + 1) {
      var other = block.querySelector('[data-sq-other]');
      if (other && other.focus) { e.preventDefault(); other.focus(); }
    }
  }
  function onInput(e) {
    var t = e.target;
    if (!t.hasAttribute('data-sq-other')) return;
    var id = t.getAttribute('data-sq-id'), item = itemOf(id); if (!item) return;
    var qi = Number(t.getAttribute('data-q')), q = item.questions[qi], p = Q.picks[id][qi];
    p.other = t.value;
    // Single choice: typing your own answer clears the picked option, as on the phone.
    if (!q.multiSelect && t.value.trim() && p.labels.length) {
      p.labels = [];
      hostsOf().forEach(function (m) { m.el.querySelectorAll('[data-sq-pick][data-sq-id="' + id + '"][data-q="' + qi + '"]').forEach(function (r) { r.checked = false; }); });
    }
    Q.armed[id] = '';
    patchCard(id);
  }
  function listen(el) { el.addEventListener('click', onClick); el.addEventListener('change', onChange); el.addEventListener('input', onInput); el.addEventListener('keydown', onKey); }
  listen(host);
  // Draw this session's cards into `el` and keep them in step; `onChange(count)` hears each redraw.
  function mount(el, sessionId, onChange) {
    if (!el) return null;
    var m = { el: el, sessionId: String(sessionId || '').toLowerCase(), scope: 'sqm' + (mounts.length + 1), onChange: onChange || null };
    mounts.push(m); listen(el); drawInto(m);
    if (!Q.stopped) { clearTimeout(Q.timer); Q.timer = setTimeout(poll, 0); }
    return { count: function () { return itemsFor(m.sessionId).length; }, unmount: function () { mounts = mounts.filter(function (x) { return x !== m; }); } };
  }

  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else if (signedIn()) start(); });
  W.onShell(function () { start(); });

  W.sessionQuestions = { _state: Q, _take: take, _render: render, _presenceAge: presenceAge, _pollUrl: pollUrl, _key: onKey, poll: poll, mount: mount,
    itemsFor: itemsFor, atMacFor: atMacFor, answeredFor: answeredFor, wordsOf: wordsOf, macLine: MAC_LINE, answeredLine: ANSWERED_LINE };
})();
