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
    waiting: [],          // X1 contract: the questions live sessions wait on (held, at_mac, answered)
    webAnswer: null,      // X1 final contract: what an answer from this page must carry right now (only with a hold switch on)
    picks: {},            // id -> [{ labels: [], other: '' }] per question
    armed: {},            // id -> 'send' | 'allow' | 'deny'
    armedAt: {},          // id -> when it was armed (COSWeb.confirmReady)
    sending: {},          // id -> clientAnswerId while a POST is out
    notes: {},            // id -> one line under the card
    answerIds: {},        // id -> the clientAnswerId this page answers under (a retry replays it)
    atMac: [],            // settled items the Mac's own prompt still waits on, newest first
    seen: {},             // id -> { questions: [text], summary } the words of a card this page drew while it was held
    answered: {},         // id -> { sessionId, at } answered here or anywhere (settled `answered`), for two minutes
    missing: {},          // id -> the question a Submit tap found unanswered, until the next pick
    timer: null,
    tick: null,
    stopped: false,
    inflight: false,      // a poll is on the wire
    again: false,         // something asked for a poll while one was out: one more as soon as it lands
    lastPollAt: 0,        // when the last poll went out (Date.now)
    load: 'unread'        // W13: 'unread' (no read yet), 'ok' (the last read was the server's answer) or 'failed' (it was not)
  };
  var DEFAULT_POLL_MS = 10000;
  var POLL_TIMEOUT_MS = 15000;
  // 6.99.27 (Miles 11/07 09:29, "a big delay to see the questions on the homepage"): while this tab is visible on
  // Today it reads every 3 s, whatever the server's idle pace (10 s). Before, a question parked just after an idle read
  // waited up to 10 s plus the round trip for the next one. Hidden, the page reads nothing (visibilitychange below).
  var TODAY_POLL_MS = 3000;
  // A nudge (a session that just went to waiting, Today coming on screen) never reads more often than this.
  var NUDGE_GAP_MS = 1000;
  // Miles's words for a question at the Mac (11/07), one place: Today's Needs you reads them from here too.
  // W1 A5 (Miles 11/09, "there is no ability to answer the question"): said once, and honest that this page cannot answer it.
  // Q1 M3 (X1 canary A1; lib/thread-turn-queue.ts:451): a message sent to a session held on its prompt is queued for the
  // end of the turn. It does not answer the question, and nothing promises a way to answer it here.
  var MAC_LINE = "Answer this at your Mac's prompt. A message sent from here does not answer it; it waits until the question is answered at the Mac.";
  // A question that went straight to the Mac's prompt: no route carries its words (the hook keeps none), so say so.
  var MAC_NO_WORDS = "COS cannot read this question's words from here. They show at the Mac's prompt.";
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
    // QA 6.99.27 (N4): through nudge, so it keeps the 1 s gap and the one read on the wire like every other ask.
    if (before === null || before > 60000) nudge();
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
  // The capability for this poll. Once this server has said the web may poll, a poll never waits on /api/models again:
  // an old answer is refreshed alongside the poll (6.99.27: after five minutes away, coming back read /api/models first
  // and only then the questions). The first read of a page still waits for it, so an older server is never polled.
  function capForPoll() {
    if (usable(Q.cap)) { if (Date.now() - Q.capAt >= 5 * 60000) readCap(); return Promise.resolve(Q.cap); }
    return readCap();
  }
  function onToday() { var st = W.state; return !!(st && st.pane === 'today'); }
  // The wait before the next read: the server's pace, 3 s while one waits (an answer elsewhere clears it here too), and
  // 3 s while this tab shows Today.
  function nextWait(every) { return Q.items.length || onToday() ? Math.min(every, TODAY_POLL_MS) : every; }
  function schedule(ms) {
    clearTimeout(Q.timer);
    Q.timer = setTimeout(poll, ms);
  }
  function landed() {
    Q.inflight = false;
    // QA 6.99.27 (N4): the read asked for while this one was out goes through nudge, so it waits out the 1 s gap too.
    if (Q.again) { Q.again = false; nudge(); }
  }
  // W13 (QA week of 11/01-11/08): whether the last read was the server's answer. A failed read leaves no cards, and Today's
  // sheet read "no card" as "at the Mac's prompt" (a Claude session) with no way to read again. Each change tells the
  // mounted sheets (their onChange), never on a read that changed nothing.
  function noteLoad(state) {
    if (Q.load === state) return;
    Q.load = state;
    tellMounts();
  }
  function tellMounts() {
    mounts.forEach(function (m) {
      if (m.onChange) { try { m.onChange(itemsFor(m.sessionId).length, atMacFor(m.sessionId).length); } catch (_e) {} }
    });
  }
  function poll() {
    clearTimeout(Q.timer);
    if (Q.stopped || document.hidden || !signedIn()) return;
    // One read on the wire at a time: a second ask while one is out becomes one more read when it lands.
    if (Q.inflight) { Q.again = true; return; }
    Q.inflight = true; Q.again = false; Q.lastPollAt = Date.now();
    capForPoll().then(function (cap) {
      if (!usable(cap)) { Q.again = false; landed(); clearCards(); schedule(60000); noteLoad(cap ? 'ok' : 'failed'); return; }
      // 6.99.32 (QA 6.99.30 canary W1): a Mac that hangs (asleep, a stale Tailscale route) never answered and never
      // refused, so this read stayed in flight forever: no more polls, and the Mac never marked down. It gives up after
      // POLL_TIMEOUT_MS, says the Mac is not answering, and polls again. The limit covers the body too (QA 6.99.32
      // Skeptic W-1): a Mac that sleeps between the headers and the body otherwise held the poll for good.
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var limit = ctrl ? setTimeout(function () { ctrl.abort(); }, POLL_TIMEOUT_MS) : null;
      return fetch(pollUrl(), { headers: { 'X-COS-Web': '1' }, credentials: 'same-origin', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
        // QA 6.99.30 (Skeptic): this 3 s read is what Sessions and Meetings pages keep running, so it tells app.js the Mac
        // answered (any status) or did not (below); otherwise a "down" mark stranded Submit, Allow and Deny for minutes.
        if (W.noteServer) W.noteServer(true);
        if (res.status === 401) { clearTimeout(limit); Q.again = false; landed(); Q.stopped = true; clearCards(); return; }
        if (!res.ok) { clearTimeout(limit); schedule(DEFAULT_POLL_MS); landed(); noteLoad('failed'); return; }
        return res.json().then(function (d) {
          clearTimeout(limit);
          if (!d || d.enabled === false) { Q.again = false; landed(); clearCards(); schedule(60000); noteLoad('ok'); return; }
          // Painted as soon as the read lands: take() draws the cards and repaints Today's Needs you and the pet.
          // The state first, so a redraw take() makes already reads 'ok'; a read that changed no card redraws nothing, so
          // the sheets still hear that the failure is over.
          var was = Q.load;
          Q.load = 'ok';
          take(Array.isArray(d.items) ? d.items : [], Array.isArray(d.settled) ? d.settled : [], Array.isArray(d.waiting) ? d.waiting : null, d.webAnswer);
          if (was !== 'ok') tellMounts();
          var every = Number(d.pollIntervalMs) > 0 ? Number(d.pollIntervalMs) : DEFAULT_POLL_MS;
          schedule(nextWait(every));
          landed();
        }, function () {
          // The body never finished (cut off, or the limit fired mid-body). The Mac did answer the headers, so it is not
          // marked down; the poll is freed and goes again.
          clearTimeout(limit); schedule(DEFAULT_POLL_MS); landed(); noteLoad('failed');
        });
      }, function () {
        // No answer at all: refused, unreachable, or the limit fired before the headers (the only abort this read has).
        clearTimeout(limit);
        if (W.noteServer) W.noteServer(false);
        schedule(DEFAULT_POLL_MS); landed(); noteLoad('failed');
      });
    }).catch(function () { schedule(DEFAULT_POLL_MS); landed(); noteLoad('failed'); });
  }
  // Read now, unless a read went out under NUDGE_GAP_MS ago (then at the end of that gap) or one is on the wire (then
  // once more when it lands). Today calls this when a session goes to waiting, so its question shows at once.
  function nudge() {
    if (Q.stopped || document.hidden || !signedIn()) return;
    if (Q.inflight) { Q.again = true; return; }
    var since = Date.now() - Q.lastPollAt;
    schedule(since >= NUDGE_GAP_MS ? 0 : NUDGE_GAP_MS - since);
  }
  // The first read of the page goes at once; after that (back from hidden, a new sign-in), through nudge (QA 6.99.27, N4).
  function start() { Q.stopped = false; if (!Q.lastPollAt) poll(); else nudge(); }
  function stop() { clearTimeout(Q.timer); }

  // ── state from a poll ─────────────────────────────────
  // ── X1 contract v1 (COORD 2026-11-09 21:35): `waiting[]`, every AskUserQuestion a live Claude session waits on that the
  // server saw asked: state held (a COS surface can answer it now), at_mac (only the Mac's own prompt can) or answered
  // (kept 120 s). Words only in memory, as on the server. Keyed by `<sessionId>:<toolUseId>`, never by session alone.
  var WAITING_STATES = { held: 1, at_mac: 1, answered: 1 };
  function waitingEntry(w) {
    if (!w || typeof w.key !== 'string' || !WAITING_STATES[w.state] || typeof w.sessionId !== 'string') return null;
    var qs = (Array.isArray(w.questions) ? w.questions : []).slice(0, 4).map(function (q) {
      return { question: String((q && q.question) || ''), header: String((q && q.header) || ''), multiSelect: !!(q && q.multiSelect),
        options: (q && Array.isArray(q.options) ? q.options : []).slice(0, 8).map(function (o) { return { label: String((o && o.label) || ''), description: String((o && o.description) || '') }; }) };
    }).filter(function (q) { return q.question; });
    return { key: w.key, sessionId: w.sessionId.toLowerCase(), provider: 'claude', toolUseId: typeof w.toolUseId === 'string' ? w.toolUseId : null, state: w.state,
      answerable: w.answerable === true && w.state === 'held', heldId: typeof w.heldId === 'string' && /^pq_[a-f0-9]{24}$/.test(w.heldId) ? w.heldId : null,
      questions: qs, askedAt: Date.parse(w.askedAt) || 0, answeredAt: Date.parse(w.answeredAt) || 0 };
  }
  function take(items, settled, waiting, webAnswer) {
    // An older server sends no `waiting`: keep the last list only for a moment's read, never invent one.
    Q.waiting = Array.isArray(waiting) ? waiting.map(waitingEntry).filter(Boolean) : [];
    // X1 final contract (`webAnswer`, sent with `waiting` while a hold switch is on): { touchRequired, touchMaxMs,
    // confirmApprovals }. Absent: the page learns any rule from a refusal, as before.
    Q.webAnswer = webAnswer && typeof webAnswer === 'object'
      ? { touchRequired: webAnswer.touchRequired === true, touchMaxMs: Number(webAnswer.touchMaxMs) > 0 ? Number(webAnswer.touchMaxMs) : 60000, confirmApprovals: webAnswer.confirmApprovals === true }
      : null;
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
    Object.keys(Q.picks).forEach(function (id) { if (!ids[id]) { delete Q.picks[id]; delete Q.armed[id]; delete Q.notes[id]; delete Q.answerIds[id]; delete Q.missing[id]; } });
    pending.forEach(function (i) {
      if (!Q.picks[i.id]) Q.picks[i.id] = keptPicks(i) || (i.questions || []).map(function () { return { labels: [], other: '' }; });
    });
    forgetPicks(ids);
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
  // X1 contract: a question held for the whole wait (fullHold) is on the Mac's screen too. Both answers count; the first wins.
  var FULL_HOLD_LINE = 'Answer here or at your Mac. The first answer counts.';
  function noteHtml(item) {
    var text = Q.notes[item.id] || '';
    return (item.fullHold === true ? '<p class="sq-fullhold">' + esc(FULL_HOLD_LINE) + '</p>' : '') + '<p class="sq-note' + (text ? '' : ' hidden') + '" data-sq-note="' + esc(item.id) + '" role="status">' + esc(text) + '</p>';
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
  // 6.99.27 (Miles's phone, 11/07 09:32: "It's not allowing me to answer the Qs"): Submit was greyed out until every
  // question had an answer, below the fold on a long card, and a multi-select said "Pick any that apply" though the broker
  // takes no empty answer (validateQuestionAnswers: `unanswered`). Now the card says what each question needs, keeps
  // its progress and the answer button in a footer that stays on screen, and a tap with something missing goes to it.
  function needText(q) { return q.multiSelect ? 'Pick one or more.' : 'Pick one.'; }
  function answeredCount(item) { var n = 0; (item.questions || []).forEach(function (_q, qi) { if (answerWords(item, qi)) n++; }); return n; }
  function firstMissing(item, after) {
    var qs = item.questions || [], n = qs.length;
    for (var k = 1; k <= n; k++) { var qi = ((after == null ? -1 : after) + k) % n; if (!answerWords(item, qi)) return qi; }
    return -1;
  }
  function progressText(item) {
    var qs = item.questions || [], done = answeredCount(item), miss = Q.missing[item.id];
    if (miss != null && !complete(item)) return qLabel(qs[miss], miss) + ' still needs an answer. ' + needText(qs[miss]);
    if (qs.length < 2) return done ? 'Ready to submit.' : 'Not answered yet. ' + needText(qs[0]);
    return done + ' of ' + qs.length + ' answered';
  }
  function sendText(id) {
    if (Q.sending[id]) return 'Submitting…';
    if (Q.armed[id] === 'send') return 'Tap again to submit';
    var item = itemOf(id);
    return item && (item.questions || []).length > 1 ? 'Review and submit' : 'Submit';
  }
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
        '<p class="sq-need" data-sq-need="' + qi + '" data-state="' + (answerWords(item, qi) ? 'done' : 'todo') + '">' + esc(needText(q)) + '</p>' +
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
      // Sticky to the bottom of the screen while the card is on it (questions.css): the progress, and the button that
      // always answers: it never greys out for a missing answer, it goes to it.
      '<div class="sq-foot" data-sq-foot="' + esc(item.id) + '">' +
        '<p class="sq-progress" data-sq-progress="' + esc(item.id) + '" role="status"' + (Q.missing[item.id] != null && !complete(item) ? ' data-alert="1"' : '') + '>' + esc(progressText(item)) + '</p>' +
        '<div class="sq-acts"><button type="button" class="cx-btn primary sq-send" data-sq="send" data-sq-id="' + esc(item.id) + '"' + (sending || offline() ? ' disabled' : '') + '>' + sendText(item.id) + '</button>' +
        '<button type="button" class="link-btn sq-leave" data-sq="leave" data-sq-id="' + esc(item.id) + '"' + (sending || offline() ? ' disabled' : '') + '>Leave for the Mac</button></div>' +
        (offline() ? '<p class="sq-offline" role="status">' + esc(OFFLINE_LINE) + '</p>' : '') +
        noteHtml(item) + '</div></article>';
  }
  function approvalCard(item) {
    var a = item.approval || { tool: item.tool, summary: '', detail: '' };
    var sending = !!Q.sending[item.id];
    var armed = Q.armed[item.id];
    return '<article class="sq-card" data-sq-card="' + esc(item.id) + '" data-kind="approval">' +
      '<header class="sq-head"><h2 class="sq-title">' + esc(engine(item)) + ' wants to use ' + esc(a.tool || item.tool || 'a tool') + '</h2><span class="sq-secs" data-sq-secs="' + esc(item.id) + '">' + esc(timeLeft(secondsLeft(item))) + '</span></header>' +
      '<pre class="sq-command">' + esc(a.summary || 'No details were sent with this request.') + '</pre>' +
      (a.detail && a.detail !== a.summary ? '<details class="sq-details"><summary>Full command</summary><pre class="sq-command">' + esc(a.detail) + '</pre></details>' : '') +
      '<div class="sq-acts"><button type="button" class="cx-btn primary" data-sq="allow" data-sq-id="' + esc(item.id) + '"' + (sending || offline() ? ' disabled' : '') + '>' + (armed === 'allow' ? 'Tap again to allow' : 'Allow once') + '</button>' +
        '<button type="button" class="cx-btn sq-deny" data-sq="deny" data-sq-id="' + esc(item.id) + '"' + (sending || offline() ? ' disabled' : '') + '>' + (armed === 'deny' ? 'Tap again to deny' : 'Deny') + '</button>' +
        '<button type="button" class="link-btn sq-leave" data-sq="leave" data-sq-id="' + esc(item.id) + '"' + (sending || offline() ? ' disabled' : '') + '>Leave for the Mac</button></div>' +
      (offline() ? '<p class="sq-offline" role="status">' + esc(OFFLINE_LINE) + '</p>' : '') +
      noteHtml(item) + '</article>';
  }
  // A question or an approval the Mac's own prompt waits on: what it asks when this page saw it held, and where to answer.
  // No buttons: nothing here can deliver an answer to that prompt.
  function macCard(item) {
    if (item.fromWaiting) {
      var body0 = (item.questions || []).map(function (q) {
        return '<p class="sq-q-text sq-mac-q">' + esc(q.question) + '</p>' + (q.options.length ? '<ul class="sq-mac-opts">' + q.options.map(function (o) {
          return '<li>' + esc(o.label) + (o.description ? '<span class="sq-mac-desc"> ' + esc(o.description) + '</span>' : '') + '</li>';
        }).join('') + '</ul>' : '');
      }).join('') || '<p class="sq-mac-nowords">' + esc(MAC_NO_WORDS) + '</p>';
      return '<article class="sq-card sq-mac" data-sq-mac="' + esc(item.id) + '" data-kind="question">' +
        '<header class="sq-head"><h2 class="sq-title">' + esc(engine(item)) + ' has a question</h2></header>' + body0 +
        '<p class="sq-mac-line">' + esc(MAC_LINE) + '</p></article>';
    }
    var words = Q.seen[item.id] || { questions: [], summary: '' };
    var title = item.kind === 'approval' ? engine(item) + ' wants to use ' + (item.tool || 'a tool') : engine(item) + ' has a question';
    var body = item.kind === 'approval'
      ? (words.summary ? '<pre class="sq-command">' + esc(words.summary) + '</pre>' : '')
      : words.questions.map(function (q) { return '<p class="sq-q-text sq-mac-q">' + esc(q) + '</p>'; }).join('');
    if (!body) body = '<p class="sq-mac-nowords">' + esc(MAC_NO_WORDS) + '</p>';
    return '<article class="sq-card sq-mac" data-sq-mac="' + esc(item.id) + '" data-kind="' + esc(item.kind) + '">' +
      '<header class="sq-head"><h2 class="sq-title">' + esc(title) + '</h2></header>' + body +
      '<p class="sq-mac-line">' + esc(MAC_LINE) + '</p></article>';
  }
  function atMacFor(sessionId) {
    // Every item names its session (the broker validates it), so no session asked for matches none: the top of every
    // pane never draws a Mac card.
    var want = String(sessionId || '').toLowerCase();
    // X1 contract: a question at the Mac's own prompt that this server saw asked has its words in `waiting`. One card per
    // question, matched by tool_use_id: a held item that went back to the Mac and the waiting entry are the same question.
    var waits = Q.waiting.filter(function (w) { return w.sessionId === want && w.state === 'at_mac'; });
    var cards = waits.map(function (w) {
      return { id: 'w:' + w.key, kind: 'question', sessionId: w.sessionId, provider: 'claude', toolUseId: w.toolUseId, fromWaiting: true, questions: w.questions };
    });
    var ids = {}; waits.forEach(function (w) { if (w.toolUseId) ids[w.toolUseId] = 1; });
    var settled = Q.atMac.filter(function (i) {
      if (String(i.sessionId || '').toLowerCase() !== want) return false;
      if (i.toolUseId) return !ids[i.toolUseId];
      // An older server gives a settled item no tool_use_id: show it only when no waiting entry speaks for the session.
      return !waits.length;
    });
    return settled.concat(cards);
  }
  function waitingFor(sessionId) {
    var want = String(sessionId || '').toLowerCase();
    return Q.waiting.filter(function (w) { return w.sessionId === want; });
  }
  // True when this session's newest event here is an answer (from this page or any other screen) of the last two
  // minutes, with nothing held for it now and nothing at the Mac since.
  function answeredFor(sessionId) {
    var want = String(sessionId || '').toLowerCase();
    if (!want || itemsFor(want).length) return false;
    var at = 0, macAt = 0;
    Object.keys(Q.answered).forEach(function (id) { var a = Q.answered[id]; if (a.sessionId === want && Date.now() - a.at <= ANSWERED_MS) at = Math.max(at, a.at); });
    atMacFor(want).forEach(function (i) { macAt = Math.max(macAt, Date.parse(i.settledAt) || Date.parse(i.createdAt) || 0); });
    // X1 contract: answered anywhere (the Mac's prompt or a COS surface) in the last 120 s, newer than any question still open.
    Q.waiting.forEach(function (w) {
      if (w.sessionId !== want) return;
      if (w.state === 'answered' && Date.now() - w.answeredAt <= ANSWERED_MS) at = Math.max(at, w.answeredAt);
      else if (w.state !== 'answered') macAt = Math.max(macAt, w.askedAt || Date.now());
    });
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
    var cards = list.map(function (i) { return i.kind === 'approval' ? approvalCard(i) : questionCard(i, m.scope); }).join('') + mac.map(macCard).join('');
    // The page's own host (over every pane): folded it is one line until tapped (questions.css .sq-banner, 6.99.30).
    if (m.el === host && list.length) cards = bannerHtml(list) + '<div class="sq-cards' + (Q.bannerOpen ? ' open' : '') + '" id="sq-cards">' + cards + '</div>';
    else if (m.el === host) Q.bannerOpen = false;
    m.el.innerHTML = cards;
    m.el.hidden = !list.length && !mac.length;
    if (focus) {
      var box = m.el.querySelector('[data-sq-other][data-sq-id="' + focus.id + '"][data-q="' + focus.q + '"]');
      if (box) { box.focus({ preventScroll: true }); try { box.setSelectionRange(focus.start, focus.end); } catch (_e) {} }
    }
    if (m.onChange) { try { m.onChange(list.length, mac.length); } catch (_e) {} }
  }
  // 6.99.30 (canary): "1 question for you. Answer", one line over the pane on a folded phone; a tap opens the cards.
  function bannerHtml(list) {
    var qs = list.filter(function (i) { return i.kind !== 'approval'; }).length, n = list.length;
    var noun = qs === n ? (n === 1 ? 'question' : 'questions') : qs === 0 ? (n === 1 ? 'approval' : 'approvals') : (n === 1 ? 'request' : 'requests');
    return '<button type="button" class="sq-banner" data-sq="banner" aria-expanded="' + (Q.bannerOpen ? 'true' : 'false') + '" aria-controls="sq-cards">' +
      '<span class="sq-banner-text">' + esc(n + ' ' + noun + ' for you.') + '</span><span class="sq-banner-act">' + (Q.bannerOpen ? 'Hide' : 'Answer') + '</span></button>';
  }
  // 6.99.30 (canary): with the Mac not answering (app.js noteServer), Submit, Allow and Deny wait and say why, instead of
  // offering a tap that cannot land.
  function offline() { return !!(W.serverUp && W.serverUp() === false); }
  var OFFLINE_LINE = 'Your Mac is not answering. You can answer here once it is back.';
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
    if (send) { send.disabled = !!Q.sending[id] || offline(); send.textContent = sendText(id); }
    var progress = card.querySelector('[data-sq-progress]');
    if (progress && item.kind === 'question') {
      progress.textContent = progressText(item);
      if (Q.missing[id] != null && !complete(item)) progress.setAttribute('data-alert', '1'); else progress.removeAttribute('data-alert');
    }
    card.querySelectorAll('[data-sq-need]').forEach(function (need) { need.setAttribute('data-state', answerWords(item, Number(need.getAttribute('data-sq-need'))) ? 'done' : 'todo'); });
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
    not_found: 'This question is gone.', invalid_answer: 'That answer was not accepted. Check each question has a choice.',
    // X1 contract, web door with a full-hold flag on: none of these settle the card; the person taps again.
    web_touch_required: 'Not sent: tap anywhere on this page, then answer again.',
    // X1 final contract (Q1 O1): held, but not on your devices yet (the Mac has not been idle long enough). Not settled.
    not_shown: 'Not sent: this question is not on your devices yet. Answer it at the Mac, or try again in a minute.',
    confirm_required: 'Not sent: tap again to confirm.', confirm_invalid: 'Not sent: that confirmation ran out. Tap again to confirm.'
  };
  var KEEPS_CARD = { invalid_answer: 1, web_touch_required: 1, confirm_required: 1, confirm_invalid: 1, not_shown: 1 };
  // QA round 1: an answer that never reached the server (no HTTP status: offline, a dropped link, a timeout) says so in
  // plain words, with the button to tap; the retry goes under the same clientAnswerId, so the server replays it.
  function unreachable(item, what) {
    // QA 6.99.27 (User 7): the button's own name. A card with more than one question says Review and submit.
    var tap = what === 'leave' ? 'Leave for the Mac' : item && item.kind === 'approval' ? (what === 'deny' ? 'Deny' : 'Allow once')
      : item && (item.questions || []).length > 1 ? 'Review and submit' : 'Submit';
    return 'Could not reach your Mac. Tap ' + tap + ' to retry.';
  }
  // Answered, here or on another screen: recorded before the card is redrawn (a waiting sheet reads it as it repaints),
  // then Today stops pointing at the Mac and reads its lists again.
  function noteAnswered(item, id) { if (item && item.sessionId) Q.answered[id] = { sessionId: String(item.sessionId).toLowerCase(), at: Date.now() }; }
  function answeredTold() {
    changed();
    if (W.today && W.today.refresh) { try { W.today.refresh(); } catch (_e) {} }
  }
  // X1 contract: the web door sends how long ago this page was last touched (the tap that sent it counts). An older server
  // or a flags-off server ignores the field.
  function withTouch(body) {
    var age = presenceAge();
    if (age !== null) body.presenceAgeMs = age;
    return body;
  }
  function confirmThen(id, body, doneLine) {
    Q.sending[id] = 1; render();
    var c = withTouch({ decision: body.decision });
    api('/api/session-questions/' + encodeURIComponent(id) + '/confirm', { method: 'POST', body: c, timeoutMs: 20000 }).then(function (d) {
      if (!d || typeof d.confirmId !== 'string' || !/^pc_[a-f0-9]{24}$/.test(d.confirmId)) throw Object.assign(new Error('confirm'), { status: 403, code: 'confirm_invalid' });
      body.confirmId = d.confirmId;
      post(id, body, doneLine);
    }, function (err) {
      delete Q.sending[id];
      var settles = err && REFUSED[err.code] && !KEEPS_CARD[err.code];
      if (settles) { Q.items = Q.items.filter(function (i) { return i.id !== id; }); render(); changed(); W.toast(REFUSED[err.code]); schedule(500); return; }
      Q.notes[id] = REFUSED[err && err.code] || (err && err.status == null ? unreachable(itemOf(id), body.decision) : 'Not sent: ' + ((err && err.message) || 'the Mac did not answer') + ' Tap again to retry.');
      render();
    });
  }
  function post(id, body, doneLine) {
    // X1 final contract: when the server says approvals need a confirm, get it first rather than learn it from a refused
    // answer. It still follows the person's second tap; a 403 confirm_required below stays the fallback.
    if (body.decision && !body.confirmId && Q.webAnswer && Q.webAnswer.confirmApprovals) return confirmThen(id, body, doneLine);
    Q.sending[id] = 1; Q.armed[id] = ''; Q.notes[id] = '';
    if (!Q.answerIds[id]) Q.answerIds[id] = answerId();
    body.clientAnswerId = Q.answerIds[id];
    withTouch(body);
    render();
    var asked = itemOf(id);
    api('/api/session-questions/' + encodeURIComponent(id) + '/answer', { method: 'POST', body: body, timeoutMs: 20000 }).then(function () {
      delete Q.sending[id];
      noteAnswered(asked, id);
      Q.items = Q.items.filter(function (i) { return i.id !== id; });
      render(); answeredTold();
      W.toast(doneLine);
      schedule(500);
    }, function (err) {
      delete Q.sending[id];
      // X1 contract: an approval the server wants confirmed gets its confirm (bound to this item and decision, 60 s, single
      // use) and goes once more. The person already tapped twice; nothing is sent without a second tap.
      if (err && err.status === 403 && err.code === 'confirm_required' && body.decision && !body.confirmId) {
        return confirmThen(id, body, doneLine);
      }
      var settled = err && REFUSED[err.code] && !KEEPS_CARD[err.code];
      if (settled) {
        if (err.code === 'already_answered') noteAnswered(asked, id);
        Q.items = Q.items.filter(function (i) { return i.id !== id; });
        render();
        if (err.code === 'already_answered') answeredTold(); else changed();
        W.toast(REFUSED[err.code]); schedule(500); return;
      }
      // A timeout or a lost answer: the same clientAnswerId goes again on the next tap and the server replays it.
      Q.notes[id] = REFUSED[err && err.code] || (err && err.status == null ? unreachable(asked, body.decision || 'send')
        : 'Not sent: ' + ((err && err.message) || 'the Mac did not answer') + ' Tap again to retry.');
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
  // Scroll a part of the card into view: smooth unless reduced motion asks otherwise. Questions carry a scroll margin
  // (questions.css) so the top bar and the sticky footer never cover them.
  function bringIn(el, block) {
    if (!el || !el.scrollIntoView) return;
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: block || 'start', behavior: still ? 'auto' : 'smooth' });
  }
  function goToQuestion(card, qi) {
    var to = card && card.querySelector('[data-sq-qblock="' + qi + '"]');
    bringIn(to, 'start');
    var f = to && to.querySelector('input');
    if (f && f.focus && !f.disabled) f.focus({ preventScroll: true });
  }
  function goToSubmit(card) {
    bringIn(card && card.querySelector('[data-sq-review]'), 'nearest');
    var send = card && card.querySelector('[data-sq="send"]');
    if (send && send.focus && !send.disabled) send.focus({ preventScroll: true });
  }
  // As in the terminal: a pick on a single-choice question moves on to the next one still unanswered, or to Submit.
  var ADVANCE_MS = 160;
  function advance(card, item, qi) {
    if (!card || (item.questions || []).length < 2) return;
    var next = firstMissing(item, qi);
    setTimeout(function () { if (itemOf(item.id) && !Q.sending[item.id]) { if (next === -1) goToSubmit(card); else goToQuestion(card, next); } }, ADVANCE_MS);
  }
  function onClick(e) {
    var b = e.target.closest('[data-sq]');
    if (!b || b.disabled) return;
    if (b.getAttribute('data-sq') === 'banner') { Q.bannerOpen = !Q.bannerOpen; drawInto(hostsOf()[0]); return; }
    var id = b.getAttribute('data-sq-id'), what = b.getAttribute('data-sq'), item = itemOf(id);
    if (!item) return;
    var card = b.closest ? b.closest('.sq-card') : null;
    if (what === 'step') {
      // The strip brings a question to the top, or the answers and Submit into view.
      var n = b.getAttribute('data-sq-step');
      if (n === 'submit') goToSubmit(card); else goToQuestion(card, Number(n));
      return;
    }
    if (what === 'send' && !complete(item)) {
      // Something is missing: say which, and go to it. Never a greyed-out button that does nothing.
      Q.armed[id] = '';
      Q.missing[id] = firstMissing(item, null);
      patchCard(id);
      goToQuestion(card, Q.missing[id]);
      return;
    }
    if (what === 'leave') {
      Q.armed[id] = '';
      if (!Q.answerIds[id]) Q.answerIds[id] = answerId();
      Q.sending[id] = 1; render();
      api('/api/session-questions/' + encodeURIComponent(id) + '/answer', { method: 'POST', body: withTouch({ clientAnswerId: Q.answerIds[id], handBack: true }), timeoutMs: 20000 }).then(function () {
        delete Q.sending[id]; Q.items = Q.items.filter(function (i) { return i.id !== id; }); render(); W.toast('Left for the Mac.'); schedule(500);
      }, function (err) {
        delete Q.sending[id];
        if (err && REFUSED[err.code] && !KEEPS_CARD[err.code]) { Q.items = Q.items.filter(function (i) { return i.id !== id; }); render(); changed(); W.toast(REFUSED[err.code]); return; }
        if (err && KEEPS_CARD[err.code]) { Q.notes[id] = REFUSED[err.code]; render(); return; }
        Q.notes[id] = err && err.status == null ? unreachable(item, 'leave') : 'Not sent: ' + ((err && err.message) || 'the Mac did not answer'); render();
      });
      return;
    }
    // Tap, then tap again: the first tap only arms the button, and the second counts only once the first has been on
    // screen a moment (COSWeb.confirmReady, the rule Today's overlay uses), so a double tap never allows or sends.
    if (Q.armed[id] !== what) {
      Q.armed[id] = what; Q.armedAt[id] = Date.now(); patchCard(id);
      if (what === 'send') goToSubmit(card);   // the first tap is the review: the answers come into view
      return;
    }
    if (W.confirmReady && !W.confirmReady(Q.armedAt[id])) return;
    if (what === 'send') return sendAnswers(item);
    if (what === 'allow' || what === 'deny') return post(id, { decision: what }, what === 'allow' ? 'Allowed once.' : 'Denied.');
  }
  function onChange(e) {
    var t = e.target;
    if (!t.hasAttribute('data-sq-pick')) return;
    var id = t.getAttribute('data-sq-id'), qi = Number(t.getAttribute('data-q')), item = itemOf(id);
    if (!applyPick(id, qi, Number(t.getAttribute('data-o')), !!t.checked)) return;
    if (!item.questions[qi].multiSelect) advance(t.closest ? t.closest('.sq-card') : null, item, qi);
  }
  // One pick, from a tap or a number key: the model first, then every drawn copy of the card follows it.
  function applyPick(id, qi, oi, checked) {
    var item = itemOf(id); if (!item || Q.sending[id]) return false;
    var q = item.questions[qi]; if (!q || !q.options[oi]) return false;
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
    if (Q.missing[id] != null) delete Q.missing[id];
    keepPicks(id);
    patchCard(id);
    return true;
  }
  // 6.99.30 (QA): a reload mid-answer keeps the picks and the typed Other words, per question id, for this tab only
  // (sessionStorage). Restored only onto the same question (the same number of parts, and labels it still offers);
  // dropped once the question is answered or gone.
  var PICKS_KEY = 'cos.web.questions.picks';
  function picksStore() { try { var v = JSON.parse(window.sessionStorage.getItem(PICKS_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_e) { return {}; } }
  function writePicks(all) { try { window.sessionStorage.setItem(PICKS_KEY, JSON.stringify(all)); } catch (_e) {} }
  function keepPicks(id) {
    var all = picksStore(), p = Q.picks[id];
    if (!p) return;
    all[id] = p.map(function (x) { return { labels: x.labels.slice(0, 20), other: String(x.other || '').slice(0, 2000) }; });
    writePicks(all);
  }
  function keptPicks(item) {
    var kept = picksStore()[item.id], qs = item.questions || [];
    if (!Array.isArray(kept) || kept.length !== qs.length) return null;
    return qs.map(function (q, qi) {
      var k = kept[qi] || {}, labels = (q.options || []).map(function (o) { return o.label; });
      return { labels: (Array.isArray(k.labels) ? k.labels : []).filter(function (l) { return labels.indexOf(l) >= 0; }), other: typeof k.other === 'string' ? k.other : '' };
    });
  }
  function forgetPicks(live) {
    var all = picksStore(), gone = Object.keys(all).filter(function (id) { return !live[id]; });
    if (!gone.length) return;
    gone.forEach(function (id) { delete all[id]; });
    writePicks(all);
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
      if (!q.multiSelect) advance(block.closest ? block.closest('.sq-card') : null, item, qi);
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
    // 6.99.30 (QA): the same card drawn on Today and in the sheet keeps one answer: the words go into every copy.
    hostsOf().forEach(function (m) {
      m.el.querySelectorAll('[data-sq-other][data-sq-id="' + id + '"][data-q="' + qi + '"]').forEach(function (box) { if (box !== t) box.value = t.value; });
    });
    // Single choice: typing your own answer clears the picked option, as on the phone.
    if (!q.multiSelect && t.value.trim() && p.labels.length) {
      p.labels = [];
      hostsOf().forEach(function (m) { m.el.querySelectorAll('[data-sq-pick][data-sq-id="' + id + '"][data-q="' + qi + '"]').forEach(function (r) { r.checked = false; }); });
    }
    Q.armed[id] = '';
    if (Q.missing[id] != null) delete Q.missing[id];
    keepPicks(id);
    patchCard(id);
  }
  function listen(el) { el.addEventListener('click', onClick); el.addEventListener('change', onChange); el.addEventListener('input', onInput); el.addEventListener('keydown', onKey); }
  listen(host);
  // Draw this session's cards into `el` and keep them in step; `onChange(count)` hears each redraw.
  function mount(el, sessionId, onChange) {
    if (!el) return null;
    var m = { el: el, sessionId: String(sessionId || '').toLowerCase(), scope: 'sqm' + (mounts.length + 1), onChange: onChange || null };
    mounts.push(m); listen(el); drawInto(m);
    if (!Q.stopped) nudge();
    return { count: function () { return itemsFor(m.sessionId).length; }, unmount: function () { mounts = mounts.filter(function (x) { return x !== m; }); } };
  }

  // QA 6.99.27 (User 2): Today's own card (#sq-host) has a sticky footer, and the keyboard covers the bottom of the
  // layout viewport, so with Other focused the footer sat under it. What covers the bottom goes on the host as --sq-kb
  // and questions.css lifts the footer by it. 6.99.30: read the one way Control Web reads the visible viewport (app.js
  // COSWeb.viewportFit, which Today's sheet uses too): the layout viewport under the visible box, in layout px, so a
  // pinch zoom alone lifts nothing and a page the browser panned to the field lifts by what is really under it.
  // The card in Today's sheet (.ta-q) needs none of this: the sheet itself is the visible box (today-actions.js fit).
  function keyboardInset() {
    var v = W.viewportFit ? W.viewportFit() : null;
    return v && v.vv ? v.below : 0;
  }
  function fitKeyboard() {
    var inset = keyboardInset();
    if (host.style && host.style.setProperty) host.style.setProperty('--sq-kb', inset + 'px');
    // A keyboard up (120 px or more, or any strip under a field of the card): the footer stops sticking (questions.css).
    var v = W.viewportFit ? W.viewportFit() : null, a = document.activeElement;
    var typing = !!(a && host.contains && host.contains(a) && a.hasAttribute && a.hasAttribute('data-sq-other'));
    if (host.classList) host.classList.toggle('sq-kb-up', !!(v && v.vv && (v.inset >= 120 || (typing && v.inset > 0))));
  }
  if (window.visualViewport) { window.visualViewport.addEventListener('resize', fitKeyboard); window.visualViewport.addEventListener('scroll', fitKeyboard); }
  window.addEventListener('resize', fitKeyboard); window.addEventListener('orientationchange', fitKeyboard);
  window.addEventListener('pageshow', fitKeyboard);
  host.addEventListener('focusin', fitKeyboard); host.addEventListener('focusout', function () { setTimeout(fitKeyboard, 0); });
  // The Mac going away or coming back redraws the cards at once (their buttons wait while it is away).
  if (W.onServer) W.onServer(function () { render(); });

  // Hidden: no reads at all (a phone in a pocket spends nothing). Visible again: one read at once (within the 1 s gap).
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else if (signedIn()) start(); });
  W.onShell(function () { start(); });
  // Coming to Today: a read at once (within the nudge gap), then every 3 s while it stays on screen.
  if (W.onRoute) W.onRoute(function (r) { if (r && r.pane === 'today') nudge(); });

  W.sessionQuestions = { _state: Q, _take: take, _render: render, _presenceAge: presenceAge, _pollUrl: pollUrl, _key: onKey, _advanceMs: ADVANCE_MS, _todayPollMs: TODAY_POLL_MS, _fitKeyboard: fitKeyboard, poll: poll, nudge: nudge, mount: mount,
    itemsFor: itemsFor, atMacFor: atMacFor, waitingFor: waitingFor, answeredFor: answeredFor, wordsOf: wordsOf, fullHoldLine: FULL_HOLD_LINE, macLine: MAC_LINE, macNoWords: MAC_NO_WORDS, answeredLine: ANSWERED_LINE,
    loadState: function () { return Q.load; }, retry: function () { nudge(); } };
})();
