/* COS Control Web: session questions and approvals (server 6.99.12), the cards the Even app shows
   (session-question-phone.ts), answered with the same POST /api/session-questions/:id/answer.

   Shown at the top of every pane while one waits, so wherever the page is, the question is in front of you.
   The page reads GET /api/session-questions?client=web only when all of these hold:
   - /api/models says capabilities.sessionQuestions.webClient (the server takes the browser session on that route; an
     older server answers it 401, which would sign the page out, so the page never calls it there);
   - the broker is on (sessionQuestions.enabled);
   - this tab is visible and signed in.
   `client=web` makes the Mac count this page as a client that can answer (the same 30 s window as the phone), so it
   holds a question for it instead of showing its own dialog at once. A hidden tab stops polling, and the Mac takes
   its questions back within 30 s. The poll is a plain fetch: a 401 stops the poll quietly and never signs the page out
   (the panes say so on their next read).

   Allow once, Deny and Send are tap-then-confirm, as in the Even app: an approval runs a command on the Mac. Leave for
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
    sending: {},          // id -> clientAnswerId while a POST is out
    notes: {},            // id -> one line under the card
    answerIds: {},        // id -> the clientAnswerId this page answers under (a retry replays it)
    timer: null,
    tick: null,
    stopped: false
  };
  var DEFAULT_POLL_MS = 10000;

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
      return fetch('/api/session-questions?client=web', { headers: { 'X-COS-Web': '1' }, credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
        if (res.status === 401) { Q.stopped = true; clearCards(); return; }
        if (!res.ok) { schedule(DEFAULT_POLL_MS); return; }
        return res.json().then(function (d) {
          if (!d || d.enabled === false) { clearCards(); schedule(60000); return; }
          take(Array.isArray(d.items) ? d.items : []);
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
  function take(items) {
    var pending = items.filter(function (i) { return i && i.answerable !== false && (i.kind === 'question' || i.kind === 'approval'); });
    var before = Q.items.map(function (i) { return i.id; }).join('|');
    var after = pending.map(function (i) { return i.id; }).join('|');
    var ids = {}; pending.forEach(function (i) { ids[i.id] = 1; });
    Object.keys(Q.picks).forEach(function (id) { if (!ids[id]) { delete Q.picks[id]; delete Q.armed[id]; delete Q.notes[id]; delete Q.answerIds[id]; } });
    pending.forEach(function (i) {
      if (!Q.picks[i.id]) Q.picks[i.id] = (i.questions || []).map(function () { return { labels: [], other: '' }; });
    });
    Q.items = pending;
    // A card that is already drawn is never redrawn by a poll: a half-typed Other answer stays as it is.
    if (before !== after) render();
  }
  function clearCards() { if (Q.items.length) { Q.items = []; render(); } }

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
  function questionCard(item) {
    var picks = Q.picks[item.id] || [];
    var sending = !!Q.sending[item.id];
    var blocks = (item.questions || []).map(function (q, qi) {
      var p = picks[qi] || { labels: [], other: '' };
      var type = q.multiSelect ? 'checkbox' : 'radio';
      var name = 'sq-' + item.id + '-' + qi;
      return '<fieldset class="sq-q"><legend class="sq-q-text">' + esc(q.question) + (q.header ? ' <span class="sq-q-tag">' + esc(q.header) + '</span>' : '') + '</legend>' +
        (q.multiSelect ? '<p class="sq-fine">Pick any that apply.</p>' : '') +
        '<div class="sq-options">' + q.options.map(function (o, oi) {
          var on = p.labels.indexOf(o.label) >= 0;
          return '<label class="sq-option"><input type="' + type + '" name="' + esc(name) + '" data-sq-pick data-sq-id="' + esc(item.id) + '" data-q="' + qi + '" data-o="' + oi + '"' + (on ? ' checked' : '') + (sending ? ' disabled' : '') + '>' +
            '<span class="sq-option-text"><span class="sq-option-label">' + esc(o.label) + '</span>' + (o.description ? '<span class="sq-option-desc">' + esc(o.description) + '</span>' : '') + '</span></label>';
        }).join('') + '</div>' +
        '<input class="field sq-other" type="text" maxlength="2000" placeholder="Other: type your own answer" aria-label="Your own answer" data-sq-other data-sq-id="' + esc(item.id) + '" data-q="' + qi + '" value="' + esc(p.other) + '"' + (sending ? ' disabled' : '') + '>' +
        '</fieldset>';
    }).join('');
    var armed = Q.armed[item.id] === 'send';
    return '<article class="sq-card" data-sq-card="' + esc(item.id) + '" data-kind="question">' +
      '<header class="sq-head"><h2 class="sq-title">' + esc(engine(item)) + ' has a question</h2><span class="sq-secs" data-sq-secs="' + esc(item.id) + '">' + esc(timeLeft(secondsLeft(item))) + '</span></header>' +
      blocks +
      '<div class="sq-acts"><button type="button" class="cx-btn primary sq-send" data-sq="send" data-sq-id="' + esc(item.id) + '"' + (sending || !complete(item) ? ' disabled' : '') + '>' + (sending ? 'Sending…' : armed ? 'Tap again to send' : 'Send') + '</button>' +
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
  function render() {
    var active = document.activeElement;
    var focus = active && active.hasAttribute && active.hasAttribute('data-sq-other') ? { id: active.getAttribute('data-sq-id'), q: active.getAttribute('data-q'), start: active.selectionStart, end: active.selectionEnd } : null;
    host.innerHTML = Q.items.map(function (i) { return i.kind === 'approval' ? approvalCard(i) : questionCard(i); }).join('');
    host.hidden = !Q.items.length;
    if (focus) {
      var box = host.querySelector('[data-sq-other][data-sq-id="' + focus.id + '"][data-q="' + focus.q + '"]');
      if (box) { box.focus({ preventScroll: true }); try { box.setSelectionRange(focus.start, focus.end); } catch (_e) {} }
    }
    clearInterval(Q.tick);
    if (Q.items.length) Q.tick = setInterval(tickSeconds, 1000);
  }
  function itemOf(id) { for (var i = 0; i < Q.items.length; i++) if (Q.items[i].id === id) return Q.items[i]; return null; }
  // The seconds move without a redraw (a redraw would drop a half-typed answer).
  function tickSeconds() {
    host.querySelectorAll('[data-sq-secs]').forEach(function (el) { var it = itemOf(el.getAttribute('data-sq-secs')); if (it) el.textContent = timeLeft(secondsLeft(it)); });
  }
  function patchCard(id) {
    var item = itemOf(id), card = host.querySelector('[data-sq-card="' + id + '"]');
    if (!item || !card) return render();
    var send = card.querySelector('[data-sq="send"]');
    if (send) { send.disabled = !!Q.sending[id] || !complete(item); send.textContent = Q.sending[id] ? 'Sending…' : Q.armed[id] === 'send' ? 'Tap again to send' : 'Send'; }
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
    api('/api/session-questions/' + encodeURIComponent(id) + '/answer', { method: 'POST', body: body, timeoutMs: 20000 }).then(function () {
      delete Q.sending[id];
      Q.items = Q.items.filter(function (i) { return i.id !== id; });
      render();
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
  host.addEventListener('click', function (e) {
    var b = e.target.closest('[data-sq]');
    if (!b || b.disabled) return;
    var id = b.getAttribute('data-sq-id'), what = b.getAttribute('data-sq'), item = itemOf(id);
    if (!item) return;
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
    // Tap, then tap again: the first tap only arms the button.
    if (Q.armed[id] !== what) { Q.armed[id] = what; patchCard(id); return; }
    if (what === 'send') return sendAnswers(item);
    if (what === 'allow' || what === 'deny') return post(id, { decision: what }, what === 'allow' ? 'Allowed once.' : 'Denied.');
  });
  host.addEventListener('change', function (e) {
    var t = e.target;
    if (!t.hasAttribute('data-sq-pick')) return;
    var id = t.getAttribute('data-sq-id'), item = itemOf(id); if (!item) return;
    var qi = Number(t.getAttribute('data-q')), q = item.questions[qi], label = q.options[Number(t.getAttribute('data-o'))].label;
    var p = Q.picks[id][qi];
    if (q.multiSelect) p.labels = t.checked ? p.labels.concat([label]) : p.labels.filter(function (l) { return l !== label; });
    else { p.labels = [label]; p.other = ''; var box = host.querySelector('[data-sq-other][data-sq-id="' + id + '"][data-q="' + qi + '"]'); if (box) box.value = ''; }
    Q.armed[id] = '';
    patchCard(id);
  });
  host.addEventListener('input', function (e) {
    var t = e.target;
    if (!t.hasAttribute('data-sq-other')) return;
    var id = t.getAttribute('data-sq-id'), item = itemOf(id); if (!item) return;
    var qi = Number(t.getAttribute('data-q')), q = item.questions[qi], p = Q.picks[id][qi];
    p.other = t.value;
    // Single choice: typing your own answer clears the picked option, as on the phone.
    if (!q.multiSelect && t.value.trim() && p.labels.length) {
      p.labels = [];
      host.querySelectorAll('[data-sq-pick][data-sq-id="' + id + '"][data-q="' + qi + '"]').forEach(function (r) { r.checked = false; });
    }
    Q.armed[id] = '';
    patchCard(id);
  });

  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else if (signedIn()) start(); });
  W.onShell(function () { start(); });

  W.sessionQuestions = { _state: Q, _take: take, _render: render, poll: poll };
})();
