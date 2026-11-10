/* COS Control Web: Today as a place to act (Miles, 11/06 23:14: "rather than always kicking the user off into the tab
   ... on click it opened up an overlay on the today panel that allowed me to see and interact with and make a
   decision that pushed it inside of its actual tab").

   A tap on Today opens the item in an overlay on Today: a bottom sheet on the folded phone, a side sheet from 600 px.
   - Needs you: what the session waits on. A session question or approval is the same card questions.js draws, with the
     same answer route (POST /api/session-questions/:id/answer), drawn here through its mount(). The session's own
     status line and its last reply. Open session stays a link to the full reader.
   - Running: a peek at what the session is doing now, read with the reader's own activity reducer (applyFeed) from the
     same live stream, and a short note box. Open session goes to the reader.
   - A waiting session (6.99.26): its question cards when this page holds the question; when the Mac's own prompt has
     it, that prompt read-only with Miles's words for it, and no reply box (a reply never answers a prompt); a reply box
     only where a reply is the answer (Codex and Cursor).
   - The pet (6.99.26, Miles 11/07: "Open what matters"): one session in play opens its sheet straight away (app.js
     petTap); several open the short list here, waiting on you first, then running, then done today, each row opening
     its own sheet.
   What a reply or a note shares with the Sessions reader, and what is this file's own copy:
   - Shared (app.js, through COSWeb.sessionKit): the attach, turn and queue path itself (continueSession and parkTurn,
     run with this overlay as their view), the per-browser binding store, one key per draft, the attachability probe
     (sxProbeAttach) and the live feed's reducer. The server's refusals arrive word for word.
   - Copied here, kept in step by hand: the send gates (sendReply mirrors sendSessionTurn: one send at a time, the
     caution confirm, a lost answer becomes Try again), the turn watch (watchTurn polls the same route for the same
     three minutes as the reader's watchTurn), and the refusal box (paintVerdict mirrors renderVerdict, with Open session
     in place of Fork and Refresh).
   - From today's meetings: each suggestion with the decisions COS Control offers on Today (Create task, Dismiss, Open
     in Work, Open card) and Work's Link for a suggested link, through Work's own route (POST
     /api/work-intake/:id/resolve), one decision at a time as Control does. The Today card's count moves at once.
   Close with the X, a tap outside, Escape, or Back (the overlay holds one history entry of its own). Focus moves in and
   comes back to the row. The page behind is inert and does not scroll.

   Files with a reply or a note (11/07, Miles: "Sometimes I need to pass context via a screenshot, photo or file"): the
   COS chat's own clip, chips, limits and upload (W.cosChat.attach), shown only where the Mac says a session turn takes
   files (threadTurnAttachments). The ids go with the words through the same send path; the server writes where each
   file is on the Mac under the words (lib/session-turn-attachments.ts). Send waits for every upload, and a failed one has
   to be retried or removed first. The files are part of the draft's key, so other files are another message.

   Also the summary COS gets when Miles asks from Today (summary(): app.js askCos passes it as the Ask's reference).
   Loaded on the first tap or once the page is idle (app.js ensurePane, #lazy-panes). */
(function () {
  'use strict';
  var W = window.COSWeb;
  if (!W || !W.today || !W.sessionKit) return;
  var T = W.today, K = W.sessionKit, esc = W.esc, api = W.api;

  var UNDO_SECONDS = 8;          // TodayDismissals.undoSeconds
  var STALE_MS = 60000;          // a decision the server dated a minute before the tap was made elsewhere
  var WATCH_MS = 180000;         // follow a sent turn for three minutes, as the reader does
  // The Today summary's cap, read by app.js askCos's callers and the tests (registered as summaryMax). The marker that
  // says something was left out counts against it.
  var SUMMARY_MAX = 4000;
  var SUMMARY_MORE = '[More is on Today than fits here.]';
  var X_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
  // Work's words for an intake refusal, by the code the server sends: a verbatim copy of panes/work.js INTAKE_REFUSALS
  // (Work loads lazily, so the overlay cannot read it there). today-actions.test.ts fails if the two differ.
  // intake_not_found never shows: a suggestion that is gone reads as handled on another screen (GONE).
  var REFUSALS = {
    meeting_identity_changed: 'That meeting was renamed or merged after it was scored. Dismiss this item; the renamed meeting is checked again.',
    meeting_unavailable: 'That meeting can’t be found; it may have been renamed or removed. Dismiss this item.',
    intake_task_changed: 'That task changed or was closed since it was suggested. Dismiss this suggestion.',
    meeting_links_full: 'That task already links eight meetings. Dismiss this suggestion.',
    work_board_read_only: 'This server can’t write Work links yet.',
    card_creation_unavailable: 'This server can’t create Work cards yet. Update the server.',
    task_bridge_unavailable: 'The task bridge didn’t answer. Try again in a moment.',
    intake_text_collision: 'The same words are on closed or archived work. Reopen that task instead, or dismiss this item.',
    intake_busy: 'That item is already being saved.', intake_not_found: 'That item is no longer in Intake. Refresh.',
    invalid_intake_action: 'Refresh Intake and try again.', invalid_intake_id: 'Refresh Intake and try again.',
    intake_store_full: 'Intake is full. Dismiss older items, then try again.',
    intake_store_closed: 'Intake is unavailable while the server restarts. Try again shortly.',
    work_intake_unavailable: 'Intake is unavailable right now. Try again shortly.' };
  var GONE = 'This suggestion is gone. It was handled on another screen.';
  // The decision words, as COS Control's Today says them (todaySuggestionRow). One place each, so a wording change is
  // one edit.
  var CREATE_LABEL = 'Create task', DISMISS_LABEL = 'Dismiss';

  var O = {
    open: null,            // { kind: 'need' | 'run' | 'wait' | 'pet' | 'meeting' | 'intake', key, all }
    opener: null, openerSel: '',
    pushed: false, ignorePops: 0, pops: [],   // pops: our own Back steps still to arrive (quietBack)
    depth: 1,              // history entries the overlay holds: 2 while a session opened from the pet's list shows
    back: null,            // { scroll } the pet's list that session came from, for Back to sessions
    dirty: false,          // something was decided or sent: Today reloads on close
    // From today's meetings
    busy: '',              // the one suggestion being decided (Control: one at a time)
    armedAt: {},           // the one armed confirm: 'dismiss:<id>' | 'stop' | 'caution' -> when (confirmTap)
    rows: {},              // id -> { state, note, undo, taskId, item, asked, until, undoing, undoNote }
    shown: {},             // ids drawn in this overlay, so one that vanishes reads as handled elsewhere
    loop: null,            // the undo route exists on this server (GET /api/work-intake/decisions), null = not asked
    // Needs you and Running
    r: null,               // the session object the reader's send path takes (sessionKit.session)
    row: null,             // the session's row in the session list
    item: null,            // the Needs you item
    stream: null, clock: null, watch: null, qMount: null, qCount: 0, macCount: 0, cautionAsk: false, note: { text: '', kind: '' },
    last: null,            // { text, at } the session's last reply
    lastState: 'idle',     // idle | loading | ready | error | none
    needGone: false
  };

  function $(id) { return document.getElementById(id); }
  // Per session, in this browser: the words in the box, and a send whose answer has not come ({text, key}), kept apart
  // from the Sessions reader's store. A week old and they go.
  var DRAFTS = 'cos.web.today.drafts', DRAFT_DAYS = 7;
  function draftKey(r) { return r.provider + '|' + r.id; }
  function draftOf(r) {
    var d = W.readStore(DRAFTS)[draftKey(r)];
    return d && typeof d === 'object' && Date.now() - (Number(d.at) || 0) < DRAFT_DAYS * 86400000 ? d : null;
  }
  // `unsettled` undefined keeps what is stored; null clears it.
  function keepDraft(r, text, unsettled) {
    var all = W.readStore(DRAFTS), k = draftKey(r), now = Date.now(), prev = all[k] || {};
    Object.keys(all).forEach(function (x) { if (!all[x] || now - (Number(all[x].at) || 0) >= DRAFT_DAYS * 86400000) delete all[x]; });
    var u = unsettled === undefined ? prev.unsettled || null : unsettled ? { text: unsettled.text, key: unsettled.key } : null;
    // A send with files that never settled keeps their ids, so after a reload it goes again exactly as it was.
    if (u && unsettled && unsettled.ids && unsettled.ids.length) u.ids = unsettled.ids.slice();
    var t = String(text || '');
    if (!t.trim() && !u) delete all[k]; else all[k] = { text: t, unsettled: u, at: now };
    W.writeStore(DRAFTS, all);
  }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function clip(text, n) { var s = String(text || '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+$/, '') + '\u2026'; }
  function lower(s) { return String(s || '').toLowerCase(); }
  function phone() { return W.isPhone ? W.isPhone() : true; }

  // ── the layer ──────────────────────────────────────────
  var layer = null;
  function build() {
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = 'ta-layer';
    layer.className = 'ta-layer';
    layer.hidden = true;
    layer.innerHTML = '<div class="ta-scrim" data-ta="close" aria-hidden="true"></div>' +
      '<section class="ta-sheet" id="ta-sheet" role="dialog" aria-modal="true" aria-labelledby="ta-title" tabindex="-1">' +
        '<div class="ta-grip" aria-hidden="true"></div>' +
        '<header class="ta-head" id="ta-head"><div class="ta-head-main"><button type="button" class="link-btn ta-back" id="ta-back" data-ta="back" hidden>Back to sessions</button>' +
          '<h2 class="ta-title" id="ta-title"></h2></div>' +
          '<button type="button" class="ta-x" data-ta="close" aria-label="Close">' + X_ICON + '</button></header>' +
        '<div class="ta-body" id="ta-body"></div>' +
        '<div class="ta-foot" id="ta-foot"></div>' +
      '</section>';
    document.body.appendChild(layer);
    // A tap that lands while the sheet is still opening is the second half of the tap that opened it (qa2-user B1: a
    // double tap on a meeting row dismissed the first suggestion). Caught before anything inside sees it.
    layer.addEventListener('click', function (e) { if (Date.now() < O.settleAt) { e.stopPropagation(); e.preventDefault(); } }, true);
    layer.addEventListener('click', onClick);
    layer.addEventListener('submit', onSubmit);
    layer.addEventListener('focusin', onFocusIn);
    // Focus leaving a field (the keyboard's Hide key, a tap outside) refits on the next frame, once it has moved.
    layer.addEventListener('focusout', function () { fit(); });
    layer.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'ta-input' && O.r) keepDraft(O.r, e.target.value, O.r.draft && O.r.draft.text === e.target.value.trim() ? O.r.draft : undefined);
    });
    // Files: the clip, a pasted screenshot in the box, and files dropped on the reply box.
    layer.addEventListener('change', function (e) {
      if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-ta-file')) { addFiles(e.target.files); e.target.value = ''; }
    });
    layer.addEventListener('paste', function (e) {
      if (!e.target || e.target.id !== 'ta-input' || !filesOn()) return;
      var files = KIT().pasted(e);
      if (files) { e.preventDefault(); addFiles(files); }
    });
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (type) {
      layer.addEventListener(type, function (e) {
        var form = $('ta-form');
        if (!form || !filesOn() || !e.target || !e.target.closest || !e.target.closest('#ta-form')) return;
        var files = KIT().dragged(e, form);
        if (files) addFiles(files);
      });
    });
    // A drag on the dimmed page never scrolls what is behind it.
    // The bleed below the bottom edge is the layer's own ::before (today-actions.css): a drag there is the layer's.
    layer.addEventListener('touchmove', function (e) { if (e.target && (e.target === layer || (e.target.classList && e.target.classList.contains('ta-scrim')))) e.preventDefault(); }, { passive: false });
    return layer;
  }
  // 6.99.30 (Miles's Duo, in Comet as well as Safari): the layer is ALWAYS the visible part of the page, read the one
  // way Control Web reads it (app.js COSWeb.viewportFit): top and height from visualViewport, 100dvh where there is
  // none. Nothing assumes a browser: whatever covers the bottom (an on-screen keyboard, a hardware keyboard's strip,
  // Comet's or any browser's bottom bar) is what the browser reports, and the reply box, Send and a question card's
  // Submit stay above it. Only the backdrop and the sheet's own colour reach on down to the physical bottom
  // (--ta-below plus the bleed, today-actions.css), so no band of Today shows under a bar that lets the page through.
  // (6.99.29 made the closed-keyboard layer the whole layout viewport to cover IMG_0503's 106 px band; that band may be
  // Comet's bottom bar, real covered space, and the composer must not sit under it.)
  // The layout on top of that box:
  //   ta-kb        an on-screen keyboard: what covers the bottom is KB_MIN_PX or more. The header folds to one
  //                compact row, the sheet fills the box, the reply box stays pinned at its bottom, and the
  //                conversation takes what is left. Under about three lines left, ta-kb-tight also hides the
  //                "Working right now" note until the keyboard closes (or the screen turns).
  //   ta-kb-strip  a field in the sheet has focus and something under KB_MIN_PX covers the bottom (a hardware
  //                keyboard's 55 to 70 px strip): the header stays as it is; the strip covers the home indicator,
  //                so the reply box drops that inset.
  // KB_MIN_PX applies whether or not a field has focus: a bottom bar under it (Comet's folded bar measured about 110 px)
  // never folds the header, one of 120 px or more does. A strip counts from KB_STRIP_MIN_PX, so desktop zoom or a
  // scrollbar (1 to 17 px of rounding, QA 6.99.30) never reads as a keyboard strip. Read on visualViewport resize and scroll while the overlay is open, and on window resize and
  // orientationchange, pageshow, the page coming back into view, and focus moving in the sheet: at most once a frame.
  var KB_MIN_PX = 120;
  var KB_STRIP_MIN_PX = 24;
  var BODY_MIN_PX = 72;          // about three lines of the conversation (15 px text at 1.5)
  var KB = { on: false, strip: false, tight: false, frame: 0, listening: false, width: 0, inset: 0, typed: false };
  function tall(el) { return (el && el.offsetHeight) || 0; }
  // What the conversation gets once the compact header and the reply box have theirs.
  function bodyRoom(height) {
    var sheet = $('ta-sheet'), grip = sheet && sheet.querySelector ? sheet.querySelector('.ta-grip') : null;
    return height - tall($('ta-head')) - tall($('ta-foot')) - tall(grip);
  }
  // A field that types (the reply box, a question card's Other) has focus inside the sheet.
  function typing() {
    var a = document.activeElement;
    if (!a || !layer || a === layer || !layer.contains || !layer.contains(a)) return false;
    var tag = String(a.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !/^(checkbox|radio|button|submit|reset|range|color|file|image|hidden)$/i.test(String(a.type || 'text'));
    return !!a.isContentEditable;
  }
  function viewport() { return W.viewportFit ? W.viewportFit() : null; }
  // 7.0.2: `wide` keeps its 6.99.30 meaning, 600 px wide or more, so old and new reports compare. From 7.0.2 a short
  // touch screen at that width counts as a phone (app.js isPhone, A8): that is shortTouch.
  function crumbWide() { return window.matchMedia ? !!window.matchMedia('(min-width: 600px)').matches : !phone(); }
  function crumb(what, v, focus) {
    if (!W.layoutCrumb || !O.open || !v) return;
    W.layoutCrumb(what, { kind: O.open.kind, kb: KB.on, strip: KB.strip, tight: KB.tight, focus: !!focus, inset: v.inset, below: v.below,
      lh: v.layoutH, top: v.top, h: v.height, zoomed: v.zoomed, wide: crumbWide(), shortTouch: crumbWide() && phone() });
  }
  function applyFit() {
    KB.frame = 0;
    if (!layer || !O.open) return null;
    var v = viewport();
    if (!v) return null;
    layer.style.setProperty('--ta-vh', v.height + 'px');
    layer.style.setProperty('--ta-vt', v.top + 'px');
    layer.style.setProperty('--ta-below', v.below + 'px');
    var focus = typing(), on = v.inset >= KB_MIN_PX, strip = !on && focus && v.inset >= KB_STRIP_MIN_PX;
    // A turned screen measures the room again: what was tight in landscape is not in portrait (QA 6.99.29).
    var w = window.innerWidth || 0, turned = !!(KB.width && w && w !== KB.width);
    if (w) KB.width = w;
    var was = KB.on + '|' + KB.strip + '|' + KB.tight;
    if (turned) KB.tight = false;
    // A rise is what covers the bottom growing, by any amount, while the keyboard layout is on: not a class flip (a
    // 120 px bar can already hold ta-kb before the keyboard comes, QA 6.99.32 Skeptic N-3), and not a jump past a step
    // (a keyboard animating up in 20 px frames never crossed one, Codex's root regression on 98f3cde). The reveal is
    // scrollIntoView 'nearest', so a frame where the field is already in view moves nothing. Shrinking never reveals.
    var rose = (on || strip) && v.inset > (KB.inset || 0);
    KB.inset = v.inset;
    if (on !== KB.on) { KB.on = on; KB.tight = false; layer.classList.toggle('ta-kb', on); }
    if (strip !== KB.strip) { KB.strip = strip; layer.classList.toggle('ta-kb-strip', strip); }
    // 6.99.32 (QA 6.99.30 canary W2): the keyboard rises after the focus, so onFocusIn's scroll (250 ms) can land before
    // the layer shrinks and leave a question card's Other field under the keyboard. Once the layout has the keyboard,
    // bring the focused field into view again.
    if (rose && focus) revealFocused();
    // Measured with the compact header in place. Once tight it stays so while the keyboard is up: showing the note
    // again would take the room back and flicker.
    if (on && !KB.tight) KB.tight = bodyRoom(v.height) < BODY_MIN_PX;
    layer.classList.toggle('ta-kb-tight', on && KB.tight);
    // 7.0.2 (A1): the breadcrumb goes on every keyboard open and close in the sheet (a field typing with KB_MIN_PX or more
    // covered), not only when a class flips: a keyboard that came while ta-kb was already on used to send nothing.
    var typed = focus && v.inset >= KB_MIN_PX, opened = typed !== KB.typed;
    KB.typed = typed;
    if (opened || was !== KB.on + '|' + KB.strip + '|' + KB.tight) crumb('kb', v, focus);
    return v;
  }
  function revealFocused() {
    // What has focus when the frame runs, not when it was asked for (QA 6.99.32 Skeptic N-2).
    var go = function () {
      if (!O.open || !typing()) return;
      var a = document.activeElement, f = a && a.id === 'ta-input' ? $('ta-form') : a;
      if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest' });
    };
    // The next frame, so the scroll measures the layout with ta-kb (or ta-kb-strip) applied.
    if (window.requestAnimationFrame) window.requestAnimationFrame(go); else go();
  }
  function fit() {
    if (KB.frame || !O.open) return;
    if (!window.requestAnimationFrame) return applyFit();   // every browser with visualViewport has frames
    KB.frame = window.requestAnimationFrame(applyFit);
  }
  function listenViewport(on) {
    var vv = window.visualViewport;
    if (!vv || KB.listening === on) return;
    KB.listening = on;
    var m = on ? 'addEventListener' : 'removeEventListener';
    if (typeof vv[m] === 'function') { vv[m]('resize', fit); vv[m]('scroll', fit); }
  }
  function unfit() {
    listenViewport(false);
    if (KB.frame && window.cancelAnimationFrame) window.cancelAnimationFrame(KB.frame);
    KB.frame = 0; KB.on = false; KB.strip = false; KB.tight = false; KB.width = 0; KB.inset = 0; KB.typed = false;
    if (!layer) return;
    layer.classList.remove('ta-kb'); layer.classList.remove('ta-kb-strip'); layer.classList.remove('ta-kb-tight');
  }
  // The rest of the moments the visible viewport can change without a visualViewport event of its own (QA 6.99.29: the
  // layer stayed sized for a keyboard that had gone). Each is a no-op while the overlay is closed.
  window.addEventListener('resize', function () { fit(); });
  window.addEventListener('orientationchange', function () { if (O.open) { KB.tight = false; fit(); } });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !O.open) return;
    fit();
    if (O.r && O.open.kind === 'run') paintLive();   // the clock and the state, at once rather than on the next tick
  });
  // Back from the back-forward cache (a swipe back, the app switcher): the live stream is closed and everything shown
  // is as old as the visit away. Open the stream again and read the session again.
  window.addEventListener('pageshow', function (e) {
    if (!O.open) return;
    fit();
    if (e && e.persisted) revive();
  });
  // 6.99.30 (QA): the Mac going away or coming back shows in an open sheet at once, not after the stream gives up: the
  // live line says the Mac is not answering, and back up the stream opens again and the session is read again.
  if (W.onServer) W.onServer(function (up) {
    var r = O.r;
    if (!O.open || !r) return;
    if (!up) { r.feed.connected = false; r.feed.fallback = 'unreachable'; if (r.live) r.live.working = false; paintLive(); paintVerdict(); }
    else revive();
  });

  function openerSelector(t) {
    if (!t || !t.getAttribute) return '';
    var kind = t.getAttribute('data-today'), key = t.getAttribute('data-key');
    if (!kind) return '';
    var q = function (v) { return '"' + String(v).replace(/["\\]/g, '\\$&') + '"'; };
    return '[data-today=' + q(kind) + ']' + (key != null ? '[data-key=' + q(key) + ']' : '');
  }

  // opt.from: a session opened from the pet's list ({ scroll }), which gets Back to sessions and its own history entry,
  // so the phone's Back returns to the list too (Miles's iPhone, 11/07). opt.again: the list shown again from there,
  // its entry already current.
  function open(kind, key, opener, opt) {
    opt = opt || {};
    build();
    if (O.open) stopSession();
    O.back = opt.from || null;
    O.open = { kind: kind, key: String(key || ''), all: kind === 'intake' };
    O.opener = opener || document.activeElement; O.openerSel = openerSelector(opener);
    O.note = { text: '', kind: '' }; O.cautionAsk = false; O.needGone = false; O.armedAt = {};
    O.stopping = false; O.stopKey = '';
    layer.hidden = false;
    document.documentElement.classList.add('ta-open');
    var shell = $('app-shell'); if (shell) shell.setAttribute('inert', '');
    listenViewport(true); applyFit();
    // The entry names what is open, so a reload can open it again and Back still closes it (restore below).
    var entry = { cosTodayOverlay: 1, kind: kind, key: O.open.key };
    if (O.back) entry.from = 'pet';
    try {
      if (opt.again) { /* the list's own entry is current again */ }
      else if (!O.pushed) { history.pushState(entry, ''); O.pushed = true; O.depth = 1; }
      else if (opt.from && O.depth === 1) { history.pushState(entry, ''); O.depth = 2; }
      else history.replaceState(entry, '');
    } catch (_e) { /* no history API: Back simply leaves Today */ }
    var backBtn = $('ta-back'); if (backBtn) backBtn.hidden = !O.back;
    try {
      if (kind === 'need' || kind === 'run' || kind === 'wait') openSession(kind, O.open.key);
      else if (kind === 'pet') openPet();
      else openIntake();
    } catch (err) {
      // A bug here must not leave a half-drawn sheet over an inert page: take it down, keep the history entry for
      // app.js openTodayAction to replace, and let it say so and go where the tap went before.
      close('leave');
      throw err;
    }
    var sheet = $('ta-sheet');
    O.settleAt = Date.now() + settleMs(sheet);
    if (sheet && sheet.focus) sheet.focus({ preventScroll: true });
    // Measured once the sheet is drawn, and sent home as a breadcrumb (app.js layoutCrumb, 6.99.30).
    crumb('open', applyFit(), typing());
  }
  // How long taps inside are ignored after opening: the longest open motion of the sheet and its backdrop (their computed
  // animation and transition, delay included: today-actions.css ta-rise or ta-slide, 220 ms, and fade, 160 ms), plus
  // the second half of a double tap. On the folded Duo a second tap 352 to 417 ms after the first still landed on the
  // sheet's links with a 350 ms window (W1-r2), so the margin brings it to 500 ms, and it never goes under that, so
  // reduced motion (no animation) keeps the same protection.
  var SETTLE_EXTRA_MS = 280, SETTLE_MIN_MS = 500;
  function msList(v) {
    return String(v || '').split(',').map(function (x) { x = x.trim(); var n = parseFloat(x); return isFinite(n) ? (/ms$/.test(x) ? n : n * 1000) : 0; });
  }
  function longestMotion(el) {
    var cs; try { cs = getComputedStyle(el); } catch (_e) { return null; }
    if (!cs) return null;
    var most = 0;
    [['animationDuration', 'animationDelay'], ['transitionDuration', 'transitionDelay']].forEach(function (p) {
      var d = msList(cs[p[0]]), w = msList(cs[p[1]]);
      d.forEach(function (x, i) { most = Math.max(most, x + (w[i % (w.length || 1)] || 0)); });
    });
    return most;
  }
  function settleMs(sheet) {
    var scrim = layer && layer.querySelector ? layer.querySelector('.ta-scrim') : null;
    var a = longestMotion(sheet), b = scrim ? longestMotion(scrim) : null;
    var motion = a == null && b == null ? 220 : Math.max(a || 0, b || 0);   // no computed style: the CSS default
    return Math.max(SETTLE_MIN_MS, motion + SETTLE_EXTRA_MS);
  }

  // how: 'user' (X, outside, Escape), 'pop' (Back), 'leave' (navigating to another pane)
  function close(how) {
    if (!O.open) return;
    stopSession();
    O.open = null;
    if (layer) layer.hidden = true;
    unfit();
    document.documentElement.classList.remove('ta-open');
    var shell = $('app-shell'); if (shell) shell.removeAttribute('inert');
    // X from a session opened off the pet's list unwinds both entries in one step, so the next Back leaves Today as before.
    if (O.pushed && how !== 'pop' && how !== 'leave') {
      var n = O.depth > 1 ? O.depth : 1;
      O.pushed = false;
      quietBack(n);
    }
    if (how === 'pop' || how === 'leave') O.pushed = false;
    clearTimeout(O.expireTimer);
    // Settled lines are done once the overlay closes; Today reads the server again if anything changed here.
    Object.keys(O.rows).forEach(function (id) { var s = O.rows[id].state; if (s !== 'creating' && s !== 'dismissing') delete O.rows[id]; });
    O.shown = {};
    if (O.dirty) { O.dirty = false; T.refresh(); }
    if (how !== 'leave') restoreFocus();
  }
  function restoreFocus() {
    var el = O.opener;
    if (!el || !el.isConnected) el = O.openerSel ? document.querySelector(O.openerSel) : null;
    if (!el) el = document.querySelector('#pane-today .panel-title');
    O.opener = null;
    if (el && el.focus) { try { el.focus({ preventScroll: true }); } catch (_e) { el.focus(); } }
  }
  // Leaving for a tab from inside the overlay replaces the overlay's history entry, so Back from there returns to Today.
  // A session opened off the pet's list holds two entries: the list's comes off first (6.99.30, QA: it stayed under
  // the new tab, and Back from there landed on it and showed nothing), then the tab replaces the overlay's own.
  function leaveTo(pane, args) {
    var hash = '#/' + [pane].concat(args || []).map(encodeURIComponent).join('/');
    var replace = O.pushed, extra = O.pushed && O.depth > 1 ? O.depth - 1 : 0;
    close('leave');
    O.depth = 1;
    if (!replace) { W.go(pane, args || []); return; }
    if (extra) { quietBack(extra, function () { location.replace(hash); }); return; }
    location.replace(hash);
  }
  // A Back step the overlay takes itself (X, Back to sessions, leaving for a tab): its popstate is ours, not the phone's
  // Back, and `then` runs once it lands. If it never arrives (history.go with nothing to go back to, or a browser that
  // drops it) the wait lapses after POP_WAIT_MS and `then` runs anyway, so a real Back later is never swallowed
  // (6.99.30, QA: ignorePops stayed counted and ate the next Back).
  var POP_WAIT_MS = 700;
  function quietBack(n, then) {
    var w = { then: then || null, timer: 0 };
    var drop = function () { var i = O.pops.indexOf(w); if (i < 0) return false; O.pops.splice(i, 1); O.ignorePops = O.pops.length; return true; };
    w.timer = setTimeout(function () { if (drop() && w.then) w.then(); }, POP_WAIT_MS);
    O.pops.push(w); O.ignorePops = O.pops.length;
    try { if (n > 1 && typeof history.go === 'function') history.go(-n); else history.back(); }
    catch (_e) { clearTimeout(w.timer); if (drop() && w.then) w.then(); }
  }
  // A reload with the overlay open keeps its history entry, and the entry before it is Today at the same address, so
  // Back from there showed nothing (measured in Chrome 11/07: a same-document popstate). On load, app.js hands that
  // entry here: open the same thing again, so the first Back closes it as it did before the reload. What cannot be
  // opened (gone, or Today left meanwhile) just clears the entry's mark.
  var KINDS = { need: 1, run: 1, wait: 1, pet: 1, meeting: 1, intake: 1 };
  function restore(st) {
    if (O.open || !st || !st.cosTodayOverlay) return Promise.resolve(false);
    var forget = function () { try { history.replaceState(null, ''); } catch (_e) {} return false; };
    if (!KINDS[st.kind]) return Promise.resolve(forget());
    var started = Date.now();
    return new Promise(function (resolve) {
      (function wait() {
        var d = T.data(), ready = d.at > 0 && (st.kind === 'need' || st.kind === 'run' || st.kind === 'wait' || st.kind === 'pet' || d.intakeLoaded);
        if (W.parseRoute().pane !== 'today' || O.open) return resolve(forget());
        if (!ready) { if (Date.now() - started > 15000) return resolve(forget()); return setTimeout(wait, 150); }
        O.pushed = true;   // this entry is the overlay's own
        // A session opened off the pet's list keeps its Back to sessions: the list's entry is still under it.
        if (st.from === 'pet' && (st.kind === 'wait' || st.kind === 'run')) O.depth = 2;
        try { open(st.kind, String(st.key || ''), null, st.from === 'pet' && O.depth === 2 ? { from: { scroll: 0 }, again: true } : undefined); resolve(true); }
        catch (err) { console.error('[today] could not reopen the overlay after a reload.', err); O.pushed = false; resolve(forget()); }
      })();
    });
  }
  // Back from an enlarged image (panes/reader-media.js pushes one entry over the sheet's) is the image's Back: the
  // viewer closes and the sheet, its scroll and a half-typed note stay (11/08). The viewer says which pops are its own.
  function imagePop(e) { return !!(W.readerMedia && typeof W.readerMedia.popIsMine === 'function' && W.readerMedia.popIsMine(e)); }
  window.addEventListener('popstate', function (e) {
    if (O.pops.length) { var w = O.pops.shift(); clearTimeout(w.timer); O.ignorePops = O.pops.length; if (w.then) w.then(); return; }
    if (imagePop(e)) return;
    // The phone's Back from a session opened off the pet's list goes back to that list, as Back to sessions does.
    if (O.open && O.back) { backToList(); return; }
    if (O.open) close('pop');
  });
  // The pet's list again, where it was scrolled to. From the button the session's entry is taken off history too.
  function backToList(fromButton) {
    var b = O.back;
    if (!b) return;
    if (fromButton && O.depth > 1) quietBack(1);
    O.depth = 1;
    open('pet', '', O.opener, { again: true });
    var body = $('ta-body'); if (body) body.scrollTop = b.scroll || 0;
  }
  W.onRoute(function (r) { if (O.open && r.pane !== 'today') close('leave'); });
  // Escape closes the overlay, unless the Ask sheet is open over it (app.js closes that first).
  document.addEventListener('keydown', function (e) {
    if (!O.open || e.key !== 'Escape' || (W.readerMedia && W.readerMedia.isOpen())) return;
    var ask = $('ask-sheet');
    if (ask && !ask.classList.contains('hidden')) return;
    e.preventDefault();
    close('user');
  }, true);

  // Every tap-then-tap-again in the overlay goes through here: the first tap arms (and disarms anything else), and the
  // second counts only once the first has been on screen COSWeb.confirmReady's moment, so a double tap or a bounce
  // arms and never confirms (W2-r2). A tap too soon leaves it armed.
  function confirmReadyAt(at) { return W.confirmReady ? W.confirmReady(at) : typeof at === 'number' && Date.now() - at >= 400; }
  function confirmTap(key, repaint) {
    var at = O.armedAt[key];
    if (at == null) { O.armedAt = {}; O.armedAt[key] = Date.now(); repaint(); return false; }
    if (!confirmReadyAt(at)) return false;
    O.armedAt = {};
    return true;
  }
  function setHead(title) { var h = $('ta-title'); if (h) h.textContent = title; }

  // ── clicks inside the overlay ─────────────────────────
  function onClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-ta]') : null;
    if (!b || b.disabled) return;
    var what = b.getAttribute('data-ta'), id = b.getAttribute('data-id') || '';
    if (!/^(dismiss|stop|caution-send)$/.test(what) && Object.keys(O.armedAt).length) {
      O.armedAt = {};
      if (O.open && (O.open.kind === 'meeting' || O.open.kind === 'intake')) paintIntake(); else paintLive();
    }
    if (what === 'close') return close('user');
    if (what === 'back') return backToList(true);
    if (what === 'create' || what === 'link') return decide(id, 'accept');
    if (what === 'dismiss') {
      // Without Undo on this server a Dismiss cannot be taken back, so it asks once: tap, then tap again.
      if (O.loop !== true && !confirmTap('dismiss:' + id, paintIntake)) return;
      return decide(id, 'dismiss');
    }
    if (what === 'undo') return undo(id);
    if (what === 'show-all') { O.open.all = true; paintIntake(); return; }
    if (what === 'open-work') return leaveTo('work', ['sort']);
    if (what === 'open-card') return leaveTo('work', id ? [id] : []);
    if (what === 'open-session') return O.r ? leaveTo('sessions', [O.r.provider, O.r.id]) : null;
    if (what === 'open-sessions') return leaveTo('sessions', []);
    if (what === 'q-retry') { if (W.sessionQuestions && W.sessionQuestions.retry) W.sessionQuestions.retry(); return; }
    // A row of the pet's list opens that session's own sheet in its place, with Back to sessions (and the phone's Back)
    // returning to the list where it was scrolled; X still closes the overlay.
    if (what === 'pet-open') {
      var pk = b.getAttribute('data-kind'), lb = $('ta-body');
      return open(pk === 'wait' ? 'wait' : 'run', id, O.opener, { from: { scroll: lb ? lb.scrollTop || 0 : 0 } });
    }
    if (what === 'send') return sendReply();
    if (what === 'approve-phone' && K.approvePhone && O.r) return K.approvePhone(phoneApprovalOptions(O.r));
    if (what === 'att-remove' || what === 'att-retry') {
      var fb = filesBox(); if (!fb) return;
      O.note = { text: '', kind: '' }; paintNote();
      if (what === 'att-remove') KIT().remove(fb, b.getAttribute('data-att')); else KIT().retry(fb, b.getAttribute('data-att'));
      return;
    }
    if (what === 'stop') {
      // A tap arms it (Stop ends the agent's turn on your Mac); the second sends it.
      if (!confirmTap('stop', paintLive)) return;
      return stopRun();
    }
    if (what === 'retry') return sendReply();
    if (what === 'caution-send') {
      // Shown by the Send tap: the same tap twice must not answer it.
      if (!confirmReadyAt(O.armedAt.caution)) return;
      if (O.r) O.r.cautionAck = true; O.cautionAsk = false; O.armedAt = {}; return sendReply();
    }
    if (what === 'caution-cancel') { O.cautionAsk = false; return paintVerdict(); }
    if (what === 'send-anyway') { var rev = O.r && O.r.sendAnyway; if (O.r) O.r.sendAnyway = null; return sendReply({ acknowledgedRevision: rev }); }
    if (what === 'more') { var box = $('ta-last-text'); if (box) box.classList.remove('clamped'); b.remove(); }
  }
  function onSubmit(e) {
    if (e.target && e.target.id === 'ta-form') { e.preventDefault(); sendReply(); }
  }
  // The keyboard rises over the bottom of the sheet: keep the box in view as it does. Any field that types counts
  // (the reply box, a question card's Other): a hardware keyboard's strip is known only by focus (6.99.30).
  function onFocusIn(e) {
    if (!e.target || !typing()) return;
    fit();
    var reply = e.target.id === 'ta-input';
    setTimeout(function () {
      if (!O.open) return;
      applyFit();
      var f = reply ? $('ta-form') : e.target;
      if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest' });
    }, 250);
  }

  // ═════════════ From today's meetings ═════════════
  function intakeList() { return T.data().intake || []; }
  function itemById(id) {
    var hit = intakeList().filter(function (it) { return it.id === id; })[0];
    return hit || (O.rows[id] && O.rows[id].item) || null;
  }
  function textOf(it) { return it.kind === 'link' ? str(it.task && it.task.text) || str(it.text) : str(it.text); }
  // Control's source line (todaySuggestionRow): whose it is and which meeting.
  function sourceOf(it) {
    var meeting = str(it.meeting && it.meeting.title) || 'a meeting today';
    if (it.kind === 'link') return 'Matches the Work card ' + clip(str(it.task && it.task.text) || str(it.pullTitle) || str(it.text), 90) + ', from ' + meeting;
    if (it.ownerIsMiles) return 'Yours, from ' + meeting;
    var owner = str(it.owner).trim();
    return owner ? owner + '\u2019s, from ' + meeting : 'From ' + meeting;
  }
  function caps() { return T.data().intakeCaps || {}; }
  // Control's suggestionAction: a link opens its card (and, as in Work's Sort, can be linked); an ask or a review
  // becomes a task when the server can create cards, else only Open in Work.
  function actionsFor(it) {
    if (it.kind === 'link') return { accept: caps().linkWrites === true ? 'link' : '', acceptLabel: 'Link', card: str(it.task && it.task.workIdentity) };
    return { accept: caps().cardCreation === true ? 'create' : '', acceptLabel: CREATE_LABEL, card: '' };
  }

  function openIntake() {
    // Whether this server can undo decides whether Dismiss asks twice; ask before the first tap can land.
    probeLoop().then(function () { if (O.open && (O.open.kind === 'meeting' || O.open.kind === 'intake')) paintIntake(); });
    paintIntake();
    var foot = $('ta-foot');
    // A waiting sheet opened before may have hidden the foot (its reply box); this one always shows (QA round 1).
    if (foot) { foot.innerHTML = '<div class="ta-links"><button type="button" class="link-btn" data-ta="open-work">Open Sort in Work</button></div>'; foot.hidden = false; }
    // Read Intake again: what was decided on another screen since Today loaded shows as handled, never as a phantom.
    var asked = T.reloadIntake();
    if (asked && asked.then) asked.then(function () { if (O.open && (O.open.kind === 'meeting' || O.open.kind === 'intake')) { noteVanished(); paintIntake(); } });
  }
  function noteVanished() {
    var open = {};
    intakeList().forEach(function (it) { open[it.id] = 1; });
    Object.keys(O.shown).forEach(function (id) {
      if (open[id] || O.rows[id]) return;
      O.rows[id] = { state: 'gone', note: GONE, item: O.shown[id] };
    });
  }
  // What the overlay lists: open suggestions in the server's order, plus this overlay's settled lines in their place.
  function visibleItems() {
    var list = intakeList().slice();
    var listed = {};
    list.forEach(function (it) { listed[it.id] = 1; });
    Object.keys(O.rows).forEach(function (id) { if (!listed[id] && O.rows[id].item) list.push(O.rows[id].item); });
    list.sort(function (a, b) {
      var x = str(a.meeting && a.meeting.filename) + '|' + a.id, y = str(b.meeting && b.meeting.filename) + '|' + b.id;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    if (O.open && O.open.kind === 'meeting' && !O.open.all) list = list.filter(function (it) { return str(it.meeting && it.meeting.title) === O.open.key; });
    return list;
  }
  function openCount() { return intakeList().length; }

  // A row that has left the count: decided here, or gone. One being decided, or refused, still counts (qa2-user N4).
  function settled(id) { var r = O.rows[id]; return !!r && /^(created|dismissed|stale|gone)$/.test(r.state); }
  function rowHtml(it) {
    var row = O.rows[it.id] || { state: 'ready' };
    var acts = actionsFor(it), lock = !!O.busy;
    var text = '<p class="ta-sugg-text">' + esc(textOf(it)) + '</p><p class="ta-sugg-src">' + esc(sourceOf(it)) + '</p>';
    if (it.kind === 'ask' && it.pull && it.pull.title) text += '<p class="ta-sugg-src">' + esc('Your session may already cover this: ' + clip(it.pull.title, 90)) + '</p>';
    var line = '';
    switch (row.state) {
      case 'creating': line = '<span class="ta-wait" role="status">Creating</span>'; break;
      case 'dismissing': line = '<span class="ta-wait" role="status">Dismissing</span>'; break;
      case 'created':
        line = '<span class="ta-done">' + esc(row.linked ? 'Linked. It is in Work.' : 'Created. It is in Work.') + '</span>' +
          '<button type="button" class="link-btn" data-ta="open-card" data-id="' + esc(row.taskId || acts.card) + '">Open card</button>' +
          undoHtml(it, row);
        break;
      case 'dismissed':
        return '<div class="ta-sugg settled" data-row="' + esc(it.id) + '"><span class="ta-done">Dismissed.</span>' + undoHtml(it, row) + '</div>';
      case 'stale': case 'gone':
        return '<div class="ta-sugg settled" data-row="' + esc(it.id) + '">' + text + '<p class="ta-note">' + esc(row.note || GONE) + '</p></div>';
      default: {
        var buttons = '';
        if (acts.accept) buttons += '<button type="button" class="btn small primary" data-ta="' + acts.accept + '" data-id="' + esc(it.id) + '"' + (lock ? ' disabled' : '') + '>' + esc(row.state === 'failed' ? 'Try again' : acts.acceptLabel) + '</button>';
        if (acts.card) buttons += '<button type="button" class="link-btn" data-ta="open-card" data-id="' + esc(acts.card) + '">Open card</button>';
        if (!acts.accept || it.kind !== 'link') buttons += '<button type="button" class="link-btn" data-ta="open-work">Open in Work</button>';
        var armed = O.armedAt['dismiss:' + it.id] != null;
        buttons += '<button type="button" class="link-btn quiet' + (armed ? ' armed' : '') + '" data-ta="dismiss" data-id="' + esc(it.id) + '"' + (lock ? ' disabled' : '') + ' aria-label="' + esc((armed ? 'Tap again to dismiss: ' : 'Dismiss suggestion: ') + clip(textOf(it), 80)) + '" title="Not a task: it leaves Today and does not move to Work at midnight">' + (armed ? 'Tap again to dismiss' : DISMISS_LABEL) + '</button>';
        line = buttons;
        if (row.note) text += '<p class="ta-note" role="alert">' + esc(row.note) + '</p>';
      }
    }
    return '<div class="ta-sugg" data-row="' + esc(it.id) + '">' + text + '<div class="ta-acts">' + line + '</div></div>';
  }
  function undoHtml(it, row) {
    if (O.loop !== true || !row.undo) return '';
    if (row.undoing) return '<span class="ta-wait" role="status">Undoing</span>';
    return '<button type="button" class="link-btn" data-ta="undo" data-id="' + esc(it.id) + '" aria-label="' + esc('Undo: ' + clip(textOf(it), 80)) + '">Undo</button>' +
      (row.undoNote ? '<span class="ta-note">' + esc(row.undoNote) + '</span>' : '');
  }
  function intakeHtml() {
    var list = visibleItems(), n = openCount();
    var groups = [], byTitle = {};
    list.forEach(function (it) {
      var t = str(it.meeting && it.meeting.title) || 'A meeting';
      if (!byTitle[t]) { byTitle[t] = { title: t, items: [] }; groups.push(byTitle[t]); }
      byTitle[t].items.push(it);
      O.shown[it.id] = it;
    });
    var single = O.open && O.open.kind === 'meeting' && !O.open.all;
    var head = '<p class="ta-sub">' + esc(n === 0 ? 'Nothing from today\u2019s meetings is waiting. What you decided is in Work.'
      : (single ? (function () { var k = list.filter(function (it) { return !settled(it.id); }).length; return k + ' from this meeting, ' + n + ' from today in all.'; })() : n + (n === 1 ? ' suggestion' : ' suggestions') + ' from today\u2019s meetings.') +
      ' They move to Work at midnight.') + '</p>';
    var body = groups.map(function (g) {
      return (single ? '' : '<h3 class="ta-group">' + esc(g.title) + '</h3>') + g.items.map(rowHtml).join('');
    }).join('');
    if (!list.length && n > 0 && single) body = '<p class="ta-sub">Nothing left from this meeting.</p>';
    if (!T.data().intakeLoaded) body = '<p class="ta-sub">Reading today\u2019s suggestions\u2026</p>';
    var more = single && n > list.filter(function (it) { return !settled(it.id); }).length ? '<button type="button" class="link-btn" data-ta="show-all">Show all ' + n + ' from today</button>' : '';
    return head + '<div class="ta-list">' + body + '</div>' + more;
  }
  function paintIntake() {
    if (!O.open || (O.open.kind !== 'meeting' && O.open.kind !== 'intake')) return;
    var single = O.open.kind === 'meeting' && !O.open.all;
    setHead(single ? O.open.key : 'From today\u2019s meetings');
    var body = $('ta-body'); if (body) body.innerHTML = intakeHtml();
  }

  // One decision at a time (Control: one resolve, its busy ids): every other button waits for it, and the same tap
  // twice sends once. Accept and dismiss go through Work's own route.
  function decide(id, action) {
    if (O.busy || !id) return;
    var it = itemById(id); if (!it) return;
    var row = O.rows[id];
    if (row && /^(created|dismissed|stale|gone)$/.test(row.state)) return;
    if (action === 'accept' && !actionsFor(it).accept) return;
    var asked = row && row.asked && row.action === action ? row.asked : Date.now();
    O.busy = id;
    O.rows[id] = { state: action === 'accept' ? 'creating' : 'dismissing', item: it, asked: asked, action: action };
    paintIntake();
    return api('/api/work-intake/' + encodeURIComponent(id) + '/resolve', { method: 'POST', body: { action: action }, timeoutMs: 75000 }).then(function (d) {
      O.busy = '';
      var got = (d && d.item) || {}, res = got.resolution || {};
      var at = Date.parse(str(res.at));
      var mine = res.action === action && !(isFinite(at) && at < asked - STALE_MS);
      O.dirty = true;
      T.markGone(id, true);
      workChanged();
      if (!res.action || mine) {
        var undoId = res.at ? id + ':' + res.at : '';
        if (action === 'accept') O.rows[id] = { state: 'created', item: it, taskId: str(res.taskId), linked: it.kind === 'link', undo: undoId };
        else { O.rows[id] = { state: 'dismissed', item: it, undo: undoId, until: Date.now() + UNDO_SECONDS * 1000 }; expireLater(); }
      } else {
        O.rows[id] = { state: 'stale', item: it, note: res.action === 'accept' ? 'Already in Work. It was decided on another screen.' : 'Already dismissed on another screen.' };
      }
      return probeLoop().then(paintIntake);
    }, function (err) {
      O.busy = '';
      var code = err && err.code;
      if (code === 'intake_not_found' || (err && err.status === 404 && code !== 'card_creation_unavailable')) {
        O.rows[id] = { state: 'gone', item: it, note: GONE };
        O.dirty = true; T.markGone(id, true);
      } else {
        var why = (code && REFUSALS[code]) || (err && err.message) || 'That did not go through.';
        if (err && err.code === 'timeout') why = 'Your Mac did not answer in time. It may still have saved it. Trying again is safe.';
        O.rows[id] = { state: action === 'accept' ? 'failed' : 'ready', item: it, note: why, asked: asked, action: action };
      }
      paintIntake();
    });
  }
  function expireLater() {
    clearTimeout(O.expireTimer);
    O.expireTimer = setTimeout(function () {
      var now = Date.now(), left = false;
      Object.keys(O.rows).forEach(function (id) {
        var r = O.rows[id];
        if (r.state !== 'dismissed' || r.undoing) return;
        if (r.until <= now) delete O.rows[id]; else left = true;
      });
      paintIntake();
      if (left) expireLater();
    }, UNDO_SECONDS * 1000 + 250);
  }
  // Undo shows only on a server that has Work's undo route (Control's probeWorkLoopIfNeeded; panes/work.js probeLoop).
  function probeLoop() {
    if (O.loop !== null) return Promise.resolve();
    return api('/api/work-intake/decisions').then(function () { O.loop = true; }, function (err) { if (err && err.status === 404) O.loop = false; });
  }
  function undo(id) {
    var row = O.rows[id];
    if (!row || !row.undo || row.undoing || O.busy) return;
    row.undoing = true; row.undoNote = '';
    paintIntake();
    return api('/api/work-intake/undo', { method: 'POST', body: { batchId: row.undo } }).then(function () {
      delete O.rows[id];
      T.markGone(id, false);
      O.dirty = true; workChanged();
      return T.reloadIntake();
    }, function (err) {
      row.undoing = false;
      if (err && err.status === 404) O.loop = false;
      row.undoNote = err && err.status === 404 ? 'Undo did not go through. Change it in Work.' : (err && err.message) || 'Undo did not go through.';
      if (row.state === 'dismissed') { row.until = Date.now() + UNDO_SECONDS * 1000; expireLater(); }
    }).then(paintIntake);
  }
  // Work's own copy of Intake and the board are stale now: it reads them again the next time it opens.
  function workChanged() {
    var work = W.pane && W.pane('work');
    if (work && work.intakeChanged) { try { work.intakeChanged(); } catch (_e) {} }
  }

  // ═════════════ Needs you and Running ═════════════
  function sessionRowFor(provider, id) {
    var want = lower(id);
    return (T.data().sessions || []).filter(function (s) {
      var k = T.splitSessionId(s.provider, s.session_id || s.id);
      return lower(k.id) === want && (!provider || k.provider === provider);
    })[0] || null;
  }
  function needById(id) { return (T.data().needs || []).filter(function (it) { return it.id === id; })[0] || null; }

  function openSession(kind, key) {
    var provider = '', id = '';
    O.item = null;
    O.wait = null;
    if (kind === 'need') {
      O.item = needById(key);
      if (O.item) { var k = T.splitSessionId(O.item.provider, O.item.sessionId); provider = k.provider; id = k.id; }
    } else {
      // A session waiting on you (a Needs you row): Today's own row gives the words, as it listed them.
      if (kind === 'wait') { var nm = T.needs ? T.needs() : null; O.wait = nm ? nm.rows.filter(function (x) { return x.kind === 'session' && x.key === key; })[0] || null : null; }
      var p = key.split('|'); provider = p[0]; id = p.slice(1).join('|');
    }
    O.row = id ? sessionRowFor(provider, id) : null;
    O.r = id ? K.session(provider, id, VIEW) : null;
    // Working only when the session is not waiting on you: a session paused on a question is not at work (W4-r2).
    // 6.99.29: the row is one signal of the card's one state (app.js sxTruth), timed by its own evidence.
    if (O.r) { O.r.live = {}; K.feed.noteList(O.r, O.row); K.feed.settle(O.r); }
    // What was typed, and a send whose answer never came, survive a close, Back or reload: the same words resend under
    // the same key (skeptic W3, qa2-user N1).
    var kept = O.r ? draftOf(O.r) : null;
    if (kept && kept.unsettled) {
      O.r.draft = { text: kept.unsettled.text, key: kept.unsettled.key };
      if (Array.isArray(kept.unsettled.ids) && kept.unsettled.ids.length) { O.r.draft.ids = kept.unsettled.ids.slice(); O.r.draft.restored = true; }
    }
    O.last = null; O.lastState = 'idle';
    setHead(kind === 'need' ? (O.item ? str(O.item.sessionTitle) || str(O.item.title) || 'Handoff' : 'Needs you')
      : kind === 'wait' ? (O.wait ? O.wait.title : 'A session is waiting for you') : (O.row ? K.title(O.row) : 'Session'));
    var body = $('ta-body');
    if (body) body.innerHTML = '<div id="ta-meta"></div><div id="ta-notsent" class="ta-notsent" role="status"></div><div id="ta-q" class="ta-q" hidden></div><div id="ta-live"></div><div id="ta-last"></div>';
    var foot = $('ta-foot');
    if (foot) { foot.innerHTML = O.r ? composerHtml(kind) : ''; foot.hidden = false; }
    var input = $('ta-input');
    if (input && kept && kept.text) { input.value = kept.text; W.autoGrow(input); }
    if (O.r) {
      paintFiles();
      // The Mac's answer about files may not be in yet: ask once, then draw the clip.
      var kit = KIT(), r0 = O.r;
      paintPhoneOffer(r0);
      if (kit && !kit.turnFiles()) kit.ensureCaps().then(function () { if (O.r === r0) { paintFiles(); paintPhoneOffer(r0); } }, function () {});
      // Files of a send a reload cut off go again with the same words; say so, since their chips are gone.
      if (O.r.draft && O.r.draft.restored) {
        var nf = O.r.draft.ids.length;
        O.note = { text: 'Your last message did not finish sending. Send sends it again with the ' + (nf === 1 ? 'file' : nf + ' files') + ' you attached.', kind: '' };
        paintNote();
      }
    }
    paintMeta();
    if (!O.r) return;
    if (W.sessionQuestions && W.sessionQuestions.mount) {
      // mount() draws at once and calls back before it returns, so the counts come from the callback, not O.qMount:
      // the questions to answer here, and those the Mac's own prompt waits on (drawn read-only).
      O.qMount = W.sessionQuestions.mount($('ta-q'), id, function (n, mac) { O.qCount = n; O.macCount = mac || 0; paintMeta(); });
    }
    if (kind === 'run') { paintLive(); watchStream(O.r); }
    loadLast(O.r);
    K.probe(O.r);
    loadNotSent(O.r);
    if (kind === 'need') recheckNeed(key);
  }
  // 6.99.30: a queued message for this session that the server refused or let expire, said here as in the reader
  // ("Not sent: <reason>"), from the same queue read (app.js sessionKit.notSent). The Sessions list chip follows it.
  function loadNotSent(r) {
    if (!r || !K.notSent || !K.answer) return;
    K.answer(K.path(r.provider, r.id, '/queued-turns')).then(function (q) {
      if (O.r !== r) return;
      var rows = (q && q.status === 200 && q.body && q.body.turns) || [];
      if (q && q.status === 200) K.notSent.note(r.provider, r.id, rows);
      var box = $('ta-notsent'); if (!box) return;
      box.innerHTML = K.notSent.rows(rows).map(function (t) {
        return '<p class="ta-note ta-notsent-line"><strong>' + esc(clip(t.preview || t.prompt || 'A queued message', 80)) + '</strong> ' + esc(K.notSent.line(t)) + '</p>';
      }).join('');
    }, function () {});
  }
  // Back from the back-forward cache with a session open (pageshow persisted): the stream again, the last reply, the
  // write gate and the questions, as on opening.
  function revive() {
    var r = O.r;
    if (!r || !O.open) return;
    if (O.open.kind === 'run') {
      if (O.stream) { try { O.stream.close(); } catch (_e) {} O.stream = null; }
      watchStream(r); paintLive();
    }
    loadLast(r);
    K.probe(r);
    loadNotSent(r);
    if (W.sessionQuestions && W.sessionQuestions.nudge) W.sessionQuestions.nudge();
  }
  function stopSession() {
    if (K.imagesStop) K.imagesStop($('ta-last'));
    if (O.stream) { try { O.stream.close(); } catch (_e) {} O.stream = null; }
    clearInterval(O.clock); O.clock = null;
    clearInterval(O.watch); O.watch = null;
    if (O.qMount) { O.qMount.unmount(); O.qMount = null; }
    O.qCount = 0; O.macCount = 0;
    O.r = null; O.row = null; O.item = null;
  }
  // The Needs you list may be minutes old: read it again, and say so if this one is no longer waiting.
  function recheckNeed(key) {
    var r = O.r;
    api('/api/work-board/your-move').then(function (d) {
      if (O.r !== r) return;
      var items = (d && d.items) || [];
      if (d && d.available !== false && !items.some(function (it) { return it.id === key; })) {
        O.needGone = true; paintMeta();
        T.refresh();   // and Today drops its row
      }
    }, function () {});
  }

  function composerHtml(kind) {
    var label = kind === 'run' ? 'Send a note to this session' : 'Reply to this session';
    return '<div id="ta-verdict"></div>' +
      '<form class="composer ta-composer" id="ta-form">' +
        '<div class="cc-chips ta-files hidden" id="ta-files"></div>' +
        '<textarea id="ta-input" rows="1" placeholder="' + esc(label) + '" aria-label="' + esc(label) + '" enterkeyhint="send"></textarea>' +
        '<div class="composer-actions"><span id="ta-clip" class="ta-clip"></span><button type="submit" class="btn primary small" id="ta-send">Send</button></div>' +
      '</form>' +
      '<p class="status-line" id="ta-status" role="status" aria-live="polite"></p>';
  }

  // The same exact packet picker and handoff as Sessions. This does not upgrade an ordinary Send.
  function phoneApprovalOptions(r) {
    return { r: r, prefix: 'ta', live: function () { return O.r === r && !!O.open; },
      status: function (text, kind) { if (O.r === r) { O.note = { text: text, kind: kind || '' }; paintNote(); } },
      files: function () { return filesState(filesBox(r)); } };
  }
  function paintPhoneOffer(r) { if (K.phoneOffer) K.phoneOffer(r, phoneApprovalOptions(r)); }

  // ── files with a reply or a note (the COS chat's attach kit) ──
  // One box per session, kept while this tab is open, so closing and reopening the sheet keeps what was attached.
  var FILES = {};
  function KIT() { return W.cosChat && W.cosChat.attach ? W.cosChat.attach : null; }
  // Only where the Mac takes files on a session turn: on an older server the words go alone, and no clip says otherwise.
  function filesOn() { var k = KIT(); return !!(k && k.turnFiles() > 0 && O.r); }
  function filesBox(r) {
    r = r || O.r; var kit = KIT();
    if (!r || !kit) return null;
    var key = r.provider + '|' + r.id;
    // 6.99.27: any file the Mac takes on a turn (threadTurnFileBytes), sent as it is; else the chat's list.
    if (!FILES[key]) FILES[key] = kit.box({
      changed: function (box) { if (O.r && FILES[O.r.provider + '|' + O.r.id] === box) paintFiles(); },
      removed: function () {},
      signedOut: function (box) { if (O.r && FILES[O.r.provider + '|' + O.r.id] === box) { O.note = { text: 'This browser was signed out. Your message and files are kept. Sign in, then tap Retry on each file.', kind: 'error' }; paintNote(); } }
    }, { anyBytes: kit.turnFileBytes() });
    // The Mac's answer can come after the box was made: a box with nothing in it yet takes it then.
    if (!FILES[key].anyBytes && !FILES[key].atts.length && kit.turnFileBytes()) FILES[key].anyBytes = kit.turnFileBytes();
    return FILES[key];
  }
  function filesState(box) {
    var kit = KIT();
    if (!kit || !box || !box.atts.length) return 'none';
    return kit.pending(box) ? 'waiting' : kit.failed(box) ? 'failed' : 'ready';
  }
  function paintClip() {
    var slot = $('ta-clip'); if (!slot) return;
    var kit = KIT();
    if (!filesOn()) { slot.innerHTML = ''; return; }
    var box = filesBox(), full = !!(box && box.atts.length >= kit.max);
    var mode = String(box && box.anyBytes || 0);
    if (slot.getAttribute('data-mode') !== mode) { slot.innerHTML = kit.cameraHtml('data-ta-file') + kit.clipHtml('data-ta-file', { any: box && box.anyBytes }); slot.setAttribute('data-mode', mode); }
    var lbls = slot.querySelectorAll ? slot.querySelectorAll('.cc-attach') : [], inps = slot.querySelectorAll ? slot.querySelectorAll('[data-ta-file]') : [];
    Array.prototype.forEach.call(lbls, function (l) { l.classList.toggle('full', full); });
    Array.prototype.forEach.call(inps, function (i) { i.disabled = full || !!(O.r && O.r.sending); });
  }
  function paintFiles() {
    var el = $('ta-files'), kit = KIT(), box = filesBox();
    if (el && kit && box) {
      el.innerHTML = kit.chipsHtml(box, 'data-ta') + (box.atts.length ? '<p class="att-limit">' + esc(kit.limitLine(box)) + '</p>' : '');
      el.classList.toggle('hidden', !box.atts.length);
    }
    paintClip(); paintSendButton();
    // QA 7.0.0: the "Working right now" note says whether files go with the message.
    if (O.r && O.r.verdict) paintVerdict();
  }
  // Send waits while a file uploads. A failed file never greys it out (QA 6.99.27): a tap says why, as the question
  // card does.
  function paintSendButton() {
    var send = $('ta-send'); if (!send) return;
    var sending = !!(O.r && O.r.sending), st = filesState(filesBox());
    send.disabled = sending || st === 'waiting';
    send.textContent = sending ? 'Sending' : st === 'waiting' ? 'Uploading' : 'Send';
  }
  function addFiles(list) {
    var kit = KIT(), box = filesBox();
    if (!kit || !box || !list || !list.length || !filesOn()) return;
    var refusals = kit.add(box, list);
    if (refusals.length) { O.note = { text: refusals.join(' '), kind: 'error' }; paintNote(); }
    paintFiles();
  }

  function needLine(it) {
    var why = T.needWhy(it) + (it.domain ? ' in ' + W.domainLabel(it.domain) : '');
    var age = W.ago(it.updatedAt || it.createdAt);
    if (!age) return why;
    if (age === 'now') return why + ', just now';
    if (/ (min|h)$/.test(age)) return why + ', ' + age + ' ago';
    return why + ', since ' + (age === 'Yesterday' ? 'yesterday' : age);
  }
  function stateWords(s) {
    if (!s) return '';
    var st = K.stateOf(s);
    if (st === 'running') return 'Working now, for ' + T.span(s.state_since || s.last_activity_at);
    if (st === 'waiting') { var l = K.stateLabel(s).replace(/^Waiting( · )?/, ''); return 'Waiting for you' + (l ? ': ' + l.replace(/ · /g, ', ') : ''); }
    if (st === 'error') return K.stateLabel(s).replace(/ · /g, ': ');
    if (st === 'stale') return 'Not running on your Mac';
    return s.running ? 'Open and quiet for ' + T.span(s.last_activity_at || s.state_since) : 'Not running right now';
  }
  function runWords() {
    var r = O.r, f = r && r.feed;
    if (f && (f.connected || f.lastSeq > 0)) {
      var w = K.feed.word(r), since = K.feed.elapsed(f, r);
      if (w === 'Working') return 'Working now' + (since ? ', for ' + since : '');
      if (w === 'Waiting') return 'Waiting for you' + (since ? ', for ' + since : '');
      if (w === 'Failed') return 'Stopped with an error';
      if (w === 'Done') return 'Finished';
      return 'Idle' + (since ? ' for ' + since : '');
    }
    return O.row ? stateWords(O.row) : '';
  }
  function paintMeta() {
    var box = $('ta-meta'); if (!box || !O.open) return;
    var html = '';
    var questions = O.qCount || 0;
    if (O.open.kind === 'need') {
      var it = O.item;
      if (!it) { box.innerHTML = '<p class="ta-note">This is no longer waiting on you. It was handled on another screen.</p>'; return; }
      // Gone: say so in place of the waiting line, never under it (qa2-user N3).
      if (O.needGone) html += '<p class="ta-note" role="status">This is no longer waiting on you. It was handled on another screen.</p>';
      else html += '<p class="ta-sub">' + esc(needLine(it)) + '</p>';
      var card = str(it.title), session = str(it.sessionTitle);
      if (card && card !== session) html += '<p class="ta-card-line">' + esc('Work card: ' + card) + '</p>';
      var p = it.progress && !it.progress.unreadable ? it.progress : null;
      if (p && p.evidence) html += '<blockquote class="ta-quote">' + esc(p.evidence) + '</blockquote>';
    } else if (O.open.kind === 'wait') {
      // A session waiting on you: what it waits on, its question to answer here when the Mac holds one for this page;
      // when the Mac's own prompt has it, that, read-only; else (a reply is the answer) the reply box below. No live
      // peek and no Stop: it is not at work (W4-r2).
      var where = waitWhere();
      html += '<p class="ta-sub">' + T.badge(O.r ? O.r.provider : 'claude') + ' <span>' + esc(waitWhy(where)) + '</span></p>';
      // W13 (QA week of 11/01-11/08): the words Today's row showed for it (its `ask`) stay here, read-only, when no card
      // draws them: the Mac line and a failed read alike. Never twice: not when the line above already says them.
      var ask = waitAsk();
      if (ask && (where === 'mac' || where === 'failed') && !O.macCount) html += '<blockquote class="ta-quote ta-mac-ask">' + esc(ask) + '</blockquote>';
      // W1 A5: no words anywhere (a question that went straight to the Mac): say that, rather than a card with nothing in it.
      if (!ask && where === 'mac' && !O.macCount && !askInWhy()) html += '<p class="ta-sub ta-mac-nowords">' + esc(macNoWords()) + '</p>';
      // The Mac card says it itself when there is one; say it here only when there is none.
      if (where === 'mac' && !O.macCount) html += '<p class="ta-sub ta-mac-line">' + esc(macLine()) + '</p>';
      // W13: the questions could not be read, so whether one waits here is unknown. Say so, never "at the Mac", and read again.
      if (where === 'failed') html += '<p class="ta-note ta-q-failed" role="status">' + esc('Couldn\u2019t load this session\u2019s questions, so one may be waiting here.') +
        ' <button type="button" class="link-btn" data-ta="q-retry">Retry</button></p>';
      if (where === 'answered') html += '<p class="ta-sub ta-mac-line">' + esc((W.sessionQuestions && W.sessionQuestions.answeredLine) || 'Answered. The session carries on.') + '</p>';
      if (where === 'reply') html += '<p class="ta-sub">' + esc('Answer it in a reply below, or open the session.') + '</p>';
    } else if (O.row || O.r) {
      // Once the live feed speaks, the line says what it says, so the header and the peek never disagree (qa2-user N3).
      html += '<p class="ta-sub">' + T.badge(O.r ? O.r.provider : O.row.provider) + ' <span id="ta-run-state">' + esc(runWords()) + '</span></p>';
    }
    if (O.row && O.open.kind === 'need') html += '<p class="ta-sub">' + esc(stateWords(O.row)) + '</p>';
    if (questions) html += '<p class="ta-ask-line">' + esc(questions === 1 ? 'It is asking you this now. Answer here.' : 'It is asking you ' + questions + ' things now. Answer here.') + '</p>';
    var links = '';
    if (O.r) links += '<button type="button" class="link-btn" data-ta="open-session">Open session</button>';
    if (O.open.kind === 'need' && O.item && O.item.workIdentity) links += '<button type="button" class="link-btn" data-ta="open-card" data-id="' + esc(O.item.workIdentity) + '">Open card in Work</button>';
    if (links) html += '<div class="ta-links">' + links + '</div>';
    if (!O.r && O.open.kind === 'need') html += '<p class="ta-sub">This handoff has no session to reply to. Open it in Work.</p>';
    box.innerHTML = html;
    // The reply box shows only where a reply can be the answer; what was typed stays in it, hidden.
    var foot = $('ta-foot');
    if (foot && O.open.kind === 'wait') { var w = waitWhere(); foot.hidden = w === 'failed' ? !!(O.r && O.r.provider === 'claude') : w !== 'reply'; }
  }
  // Where a waiting session's question is answered: 'here' (its cards in this sheet), 'answered' (on some screen just
  // now), 'mac' (a Claude session's own prompt, or a held question that went back to the Mac), or 'reply' (a Codex or
  // Cursor session asking in words).
  // W13: 'failed' when the last questions read failed and no card is drawn: a Claude reply still answers nothing, so the
  // reply box stays a Codex or Cursor one.
  function waitWhere() {
    if (O.qCount) return 'here';
    if (O.r && W.sessionQuestions && W.sessionQuestions.answeredFor && W.sessionQuestions.answeredFor(O.r.id)) return 'answered';
    if (!O.macCount && W.sessionQuestions && W.sessionQuestions.loadState && W.sessionQuestions.loadState() === 'failed') return 'failed';
    if (O.macCount || (O.r && O.r.provider === 'claude') || (O.wait && O.wait.where === 'mac')) return 'mac';
    return 'reply';
  }
  // The question in Today's own words (its Needs you row), unless the line above the sheet already reads exactly that.
  function waitAsk() {
    var a = O.wait && O.wait.ask ? String(O.wait.ask).trim() : '';
    return a && !(O.wait.why && String(O.wait.why).trim() === a) ? a : '';
  }
  function macLine() { return (W.sessionQuestions && W.sessionQuestions.macLine) || "Answer this at your Mac's prompt. It cannot be answered from here yet."; }
  function macNoWords() { return (W.sessionQuestions && W.sessionQuestions.macNoWords) || "COS cannot read this question's words from here. They show at the Mac's prompt."; }
  // W1 A5: the head line says the state once. At the Mac's prompt the line below says where; the head does not repeat it.
  var GENERIC_WAIT = /^Waiting for (you|your answer)(\. Paused until you answer\.)?$/;
  function waitWhy(where) {
    var why = O.wait ? String(O.wait.why || '') : '';
    if (!why) return 'Waiting for you';
    return where === 'mac' && GENERIC_WAIT.test(why) ? 'Waiting for your answer' : why;
  }
  // The head line already carries the question's words (the server named them in the waiting line).
  function askInWhy() { return !!(O.wait && O.wait.why && !GENERIC_WAIT.test(String(O.wait.why))); }

  // ═════════════ The pet's sessions ═════════════
  // The same sessions the pet's caption counts (app.js petPlay): waiting on you, running, then done today. Each row
  // opens that session's own sheet.
  var PET_DONE_SHOWN = 5;
  function openPet() {
    setHead('Sessions');
    var p = T.petPlay ? T.petPlay() : { waiting: [], running: [], done: [] };
    var row = function (s, kind, line) {
      var k = T.splitSessionId(s.provider, s.session_id || s.id);
      return '<button type="button" class="ta-pet-row" data-ta="pet-open" data-kind="' + kind + '" data-id="' + esc(k.provider + '|' + k.id) + '">' +
        '<span class="ta-pet-top">' + T.badge(k.provider) + '<span class="ta-pet-title">' + esc(T.sessionTitle(s)) + '</span></span>' +
        '<span class="ta-pet-line">' + esc(line) + '</span></button>';
    };
    var group = function (title, rows) { return rows.length ? '<section class="ta-pet-group"><h3 class="ta-pet-head">' + esc(title) + '</h3>' + rows.join('') + '</section>' : ''; };
    // 6.99.27: the questions this page holds come first, one row per session, each opening that session's cards.
    var asked = petAsked(), keyOf = function (s) { var k = T.splitSessionId(s.provider, s.session_id || s.id); return (k.provider + '|' + k.id).toLowerCase(); };
    var questions = asked.map(function (a) {
      var s = sessionRowFor(a.provider, a.id);
      var k = esc(a.provider + '|' + a.id);
      return '<button type="button" class="ta-pet-row" data-ta="pet-open" data-kind="wait" data-id="' + k + '">' +
        '<span class="ta-pet-top">' + T.badge(a.provider) + '<span class="ta-pet-title">' + esc(s ? T.sessionTitle(s) : a.title) + '</span></span>' +
        '<span class="ta-pet-line">' + esc(a.line) + '</span></button>';
    });
    var held = {}; asked.forEach(function (a) { held[(a.provider + '|' + a.id).toLowerCase()] = 1; });
    var waiting = p.waiting.filter(function (s) { return !held[keyOf(s)]; }).map(function (s) { return row(s, 'wait', stateWords(s)); });
    // The pet counts a session as running from the Running card's test; one of those paused on you opens as waiting.
    var running = p.running.filter(function (s) { return !held[keyOf(s)]; }).map(function (s) { return row(s, K.stateOf(s) === 'waiting' ? 'wait' : 'run', stateWords(s)); });
    var done = p.done.slice(0, PET_DONE_SHOWN).map(function (s) { return row(s, 'run', 'Last active ' + doneWhen(s)); });
    var body = $('ta-body');
    if (body) body.innerHTML = group(questions.length === 1 ? 'A question for you' : 'Questions for you', questions) + group('Waiting on you', waiting) + group('Running', running) + group('Done today', done) +
      (!questions.length && !waiting.length && !running.length ? '<p class="ta-note">Nothing is running or waiting on you now.</p>' : '') +
      '<div class="ta-links"><button type="button" class="link-btn" data-ta="open-sessions">All sessions</button></div>';
    var foot = $('ta-foot'); if (foot) { foot.innerHTML = ''; foot.hidden = false; }
  }
  // The held questions by session (panes/questions.js), oldest first: the words of each session's first question.
  function petAsked() {
    var q = W.sessionQuestions, items = q && q.itemsFor ? q.itemsFor('') : [], out = [], at = {};
    (items || []).forEach(function (it) {
      if (!it || !it.sessionId) return;
      var k = T.splitSessionId(it.provider, it.sessionId), key = (k.provider + '|' + k.id).toLowerCase();
      if (at[key] !== undefined) { out[at[key]].n++; return; }
      var first = it.kind === 'approval' ? (it.approval && it.approval.summary ? 'Wants to run ' + it.approval.summary : 'Wants your permission')
        : String(((it.questions || [])[0] || {}).question || 'Asked you a question');
      at[key] = out.length;
      out.push({ provider: k.provider, id: k.id, n: 1, line: clip(first, 160), title: it.kind === 'approval' ? 'A session wants your permission' : 'A session asked you a question' });
    });
    out.forEach(function (a) { if (a.n > 1) a.line = a.n + ' questions. ' + a.line; });
    return out;
  }
  function doneWhen(s) {
    var a = W.ago(s.last_activity_at || s.state_since);
    if (!a || a === 'now') return 'just now';
    return /( min| h)$/.test(a) ? a + ' ago' : a;
  }

  // The session's last reply, from the same read the reader makes (?turns=N, lib/agent-session-turns.ts).
  function loadLast(r) {
    var request = r.lastRead = {};
    O.lastState = 'loading'; O.lastWhy = ''; paintLast();
    return K.answer(K.path(r.provider, r.id, '?turns=6&cards=1'), { timeoutMs: 20000 }).then(function (a) {
      if (O.r !== r || r.lastRead !== request) return;
      if (a.status === 404) { O.lastState = 'none'; O.lastWhy = 'This session is not on your Mac any more.'; paintLast(); return; }
      if (a.status !== 200) { O.lastState = 'error'; paintLast(); return; }
      var d = a.body || {};
      if (!O.row) { O.row = d; paintMeta(); if (O.open && O.open.kind === 'run') setHead(K.title(d)); }
      var turns = Array.isArray(d.recent_turns) ? d.recent_turns : [];
      var lastA = turns.filter(function (t) { return lower(t.role) !== 'user' && (String(t.text || t.content || '').trim() || (K.imageHtml && K.imageHtml(t))); }).pop();
      O.last = lastA ? { text: String(lastA.text || lastA.content || '').trim(), at: lastA.at, toolImages: lastA.toolImages, toolImagesMore: lastA.toolImagesMore, outputLinks: lastA.outputLinks,
        outputImages: lastA.outputImages, outputFiles: lastA.outputFiles, previewsOff: lastA.previewsOff } : null;
      O.lastState = O.last ? 'ready' : 'none';
      O.lastWhy = '';
      paintLast();
    }, function () { if (O.r === r && r.lastRead === request) { O.lastState = 'error'; paintLast(); } });
  }
  function paintLast() {
    var box = $('ta-last'); if (!box) return;
    // Retain the actual reply nodes (and its open image) during refreshes and transient errors.
    // Only a successful changed reply replaces them. Metadata changes count as changed too.
    var signature = O.last ? JSON.stringify([O.last.text, O.last.at, K.imageHtml ? K.imageHtml(O.last) : '', K.linksAttr ? K.linksAttr(O.last) : '']) : '';
    if (signature && box.__taLastSignature === signature) {
      var refresh = $('ta-last-refresh');
      if (refresh) refresh.textContent = O.lastState === 'loading' ? 'Checking for a newer reply…'
        : O.lastState === 'error' ? 'The latest reply could not load. Showing the previous reply.'
        : O.lastState === 'none' ? (O.lastWhy || '') : '';
      return;
    }
    box.__taLastSignature = signature;
    if (K.imagesStop) K.imagesStop(box);
    if (O.lastState === 'loading') { box.innerHTML = '<div class="ta-last"><div class="skeleton" style="width:74%"></div><div class="skeleton" style="width:52%;margin-top:8px"></div></div>'; return; }
    if (O.lastState === 'error') { box.innerHTML = '<p class="ta-sub">The last reply did not load. Open the session to read it.</p>'; return; }
    if (O.lastState === 'none') { box.innerHTML = O.lastWhy ? '<p class="ta-sub">' + esc(O.lastWhy) + '</p>' : ''; return; }
    if (!O.last) { box.innerHTML = ''; return; }
    var at = W.toDate(O.last.at), long = O.last.text.length > 700;
    box.innerHTML = '<section class="ta-last" aria-label="Last reply"><p class="ta-last-head">' + esc('Last reply' + (at ? ', ' + W.clock(at) : '')) + '</p>' +
      (K.imageHtml ? K.imageHtml(O.last, { part: 'before' }) : '') +
      // Preview engine phase 1: the reply's link cards, as in the reader.
      '<div class="sx-md ta-last-text' + (long ? ' clamped' : '') + '" id="ta-last-text"' + (K.linksAttr ? K.linksAttr(O.last) : '') + '>' + K.markdown(O.last.text.slice(0, 12000), O.last.outputLinks) + '</div>' +
      (long ? '<button type="button" class="link-btn" data-ta="more">Show all of it</button>' : '') + (K.imageHtml ? K.imageHtml(O.last, { part: 'after' }) : '') + '<p id="ta-last-refresh" class="ta-sub" role="status"></p></section>';
    if (K.imagesMount) K.imagesMount(box, O.r);
  }

  // Running: the same live stream the reader follows, read with its own reducer (applyFeed, sxFeedWord and friends).
  function watchStream(r) {
    if (typeof EventSource !== 'function') { r.feed.fallback = 'unsupported'; paintLive(); return; }
    var es;
    try { es = new EventSource(K.path(r.provider, r.id, '/stream?seed=turn')); } catch (_e) { r.feed.fallback = 'unsupported'; paintLive(); return; }
    O.stream = es;
    es.onmessage = function (ev) {
      var e; try { e = JSON.parse(ev.data); } catch (_e) { return; }
      if (O.r !== r) return;
      K.feed.apply(r, e);
      r.live = r.live || {};
      if (e.kind === 'status') {
        // 6.99.29: the card's one state (app.js sxTruth) decides working and waiting: the agent's own
        // waiting still wins over a busy file (W4-r2), and the stream's echo of a Stop still cannot
        // reopen it, but a stale idle no longer outranks fresher working evidence.
        var wasWorking = !!r.live.working, wasWaiting = !!r.live.waiting;
        K.feed.settle(r);
        if (wasWorking && !r.live.working) loadLast(r);
        // Gone to waiting: its question may be parked for this page now, so the card reads at once (6.99.27).
        if (r.live.waiting && !wasWaiting && W.sessionQuestions && W.sessionQuestions.nudge) W.sessionQuestions.nudge();
      } else if (e.kind === 'prose' && e.text) r.live.prose = String(e.text);
      paintLive();
      paintVerdict();
    };
    es.onerror = function () {
      if (O.r !== r || O.stream !== es) return;
      if (es.readyState === 2) {
        if (r.feed.lastSeq > 0) { r.feed.connected = false; r.feed.fallback = 'stream_lost'; paintLive(); }
        else probeStream(r);
      } else { r.feed.fallback = 'reconnecting'; paintLive(); }
    };
  }
  // EventSource hides why a stream was refused: one GET reads the status for the fallback line (the reader's sxProbeStream).
  function probeStream(r) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    fetch(K.path(r.provider, r.id, '/stream?seed=turn'), { headers: { 'X-COS-Web': '1' }, credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) { var code = res.status; if (ctrl) ctrl.abort(); return code; }, function () { return 0; })
      .then(function (code) {
        if (O.r !== r || r.feed.lastSeq > 0) return;
        r.feed.fallback = code === 200 ? 'stream_lost' : code ? 'http_' + code : 'unreachable';
        paintLive();
      });
  }
  function paintLive() {
    var box = $('ta-live'); if (!box || !O.r || !O.open || O.open.kind !== 'run') return;
    var r = O.r, f = r.feed, live = r.live || {};
    var on = f.connected || f.lastSeq > 0 || live.working;
    var html;
    if (on) {
      // Idle: the reader's line repeats the last reply, which the peek shows in full just below.
      var word = K.feed.word(r), detail = word === 'Idle' ? '' : K.feed.detail(f, word);
      html = '<div class="sx-act-state"><span class="sx-dot ' + word.toLowerCase() + '" aria-hidden="true"></span><strong>' + esc(word) + '</strong>' +
        '<span class="sx-act-detail">' + esc(detail) + '</span><span class="sx-act-clock" id="ta-clock">' + esc(K.feed.elapsed(f, r)) + '</span>' +
        (live.working || O.stopping ? '<button type="button" class="cx-btn quiet sx-act-stop' + (O.armedAt.stop != null ? ' danger' : '') + '" data-ta="stop"' + (O.stopping ? ' disabled' : '') + '>' +
          (O.stopping ? 'Stopping' : O.armedAt.stop != null ? 'Tap again to stop' : 'Stop') + '</button>' : '') + '</div>' +
        (f.prompt ? '<p class="ta-act-prompt">' + esc(K.feed.promptLine(r, clip(f.prompt, 240))) + '</p>' : '') +
        '<div class="ta-act-tail">' + f.tools.slice(-5).map(function (t) { return '<div class="sx-act-tool">' + esc(K.feed.tool(t)) + '</div>'; }).join('') +
        (live.working && live.prose ? '<div class="sx-act-prose">' + esc(String(live.prose).slice(-500)) + '</div>' : '') + '</div>';
      // The feed stopped or was refused: say why under the last state it showed.
      if (f.fallback && !f.connected) html += '<p class="ta-sub ta-feed-note">' + esc(K.feed.fallback(f.fallback)) + '</p>';
    } else html = '<p class="ta-sub">' + esc(f.fallback ? K.feed.fallback(f.fallback) : 'Connecting to the live feed\u2026') + '</p>';
    box.innerHTML = '<div class="sx-activity ta-activity" aria-live="polite">' + html + '</div>';
    var rs = $('ta-run-state'); if (rs) rs.textContent = runWords();
    clearInterval(O.clock); O.clock = null;
    var w = on ? K.feed.word(r) : '';
    if (w === 'Working' || w === 'Waiting') {
      O.clock = setInterval(function () {
        if (O.r !== r) { clearInterval(O.clock); return; }
        if (document.hidden) return;   // a hidden page spends nothing; coming back repaints at once (visibilitychange)
        var c = $('ta-clock'); if (c) c.textContent = K.feed.elapsed(r.feed, r);
        if (K.feed.gateStale(r)) K.probe(r);
        var rs = $('ta-run-state'); if (rs) rs.textContent = runWords();
      }, 1000);
    }
  }

  // ── sending: the reader's attach, turn and queue path ──
  // continueSession and parkTurn run as they do in the reader and report through this view (app.js READER_VIEW's
  // methods). The gates in sendReply, watchTurn and paintVerdict below are this file's copies of the reader's (see the
  // header). The overlay never holds a message for later: when COS's own reply is still running it says so, and the
  // words stay in the box, under the same key, so Send again cannot post twice.
  var VIEW = {
    status: function (r, text, kind, actionHtml) { if (r !== O.r) return; O.note = { text: text || '', kind: kind || '' }; paintNote(); },
    pending: function (r, text, note) {
      if (r !== O.r) return;
      O.dirty = true;
      O.note = { text: note === 'waiting in line' ? 'Waiting in line. It sends on its own when the session is free.' : note === 'already sent' ? 'Already sent.' : 'Sent.', kind: '' };
      paintNote();
    },
    clear: function (r, text) {
      // The Mac took it: the send is settled, and the kept draft goes with the words that were sent. So do the files
      // that went with them; any added since stay for the next message.
      var sent = r.draft && r.draft.text === text ? r.draft.ids || [] : [];
      if (r.draft && r.draft.text === text) r.draft = null;
      var fb = sent.length ? filesBox(r) : null, kit = KIT();
      if (fb && kit) fb.atts.filter(function (t) { return sent.indexOf(t.mediaId) >= 0; }).forEach(function (t) { kit.remove(fb, t.id); });
      var box = r === O.r ? $('ta-input') : null;
      var left = box ? (box.value.trim() === String(text).trim() ? '' : box.value) : '';
      if (box && !left) { box.value = ''; W.autoGrow(box); }
      keepDraft(r, left, null);
    },
    verdict: function (r) { if (r === O.r) paintVerdict(); },
    // 6.99.29: the card's one state moved (a gate answer, a parked send, a live delivery): repaint all of it.
    stateChanged: function (r) {
      if (r !== O.r) return;
      var wasWorking = !!r.live && !!r.live.working;
      K.feed.settle(r);
      if (wasWorking && !r.live.working) loadLast(r);
      paintLive(); paintVerdict();
    },
    hold: function (r) {
      if (r !== O.r) return;
      O.note = { text: 'COS is still answering in this session. Send again when it finishes; it will not post twice. Or open the session, where it sends on its own.', kind: 'error' };
      paintNote();
    },
    watch: function (r, bindingId, key) { watchTurn(r, bindingId, key); },
    queue: function () {}
  };
  function paintNote() { W.setStatus($('ta-status'), O.note.text, O.note.kind === 'error'); if (KB.on) fit(); }
  // A copy of the reader's renderVerdict (app.js): the same boxes and words, with Open session where the reader offers
  // Fork and Refresh, which live only in the reader.
  function paintVerdict() {
    var box = $('ta-verdict'), r = O.r; if (!box || !r) return;
    var v = r.verdict, html = '';
    if (O.cautionAsk) {
      html = '<div class="sx-box confirm" role="alertdialog" aria-labelledby="ta-caution-title"><strong id="ta-caution-title">Send into an open session?</strong>' +
        '<p>Another app on this Mac has this session open. It looks idle right now, but a reply will run with that session\u2019s own permissions.</p>' +
        '<div class="sx-box-actions"><button type="button" class="cx-btn danger" data-ta="caution-send">Send anyway</button><button type="button" class="cx-btn quiet" data-ta="caution-cancel">Cancel</button></div></div>';
    } else if (r.refusal) {
      var f = r.refusal;
      html = '<div class="sx-box refusal" role="status"><p>' + esc(f.copy) + '</p>' + (f.supplement ? '<p class="sx-box-sub">' + esc(f.supplement) + '</p>' : '') +
        '<div class="sx-box-actions">' +
        (f.changed ? '<button type="button" class="cx-btn quiet" data-ta="send-anyway">Continue anyway</button>' : '') +
        (f.retry ? '<button type="button" class="cx-btn quiet" data-ta="retry">Try again</button>' : '') +
        ((f.changed || f.fork) ? '<button type="button" class="cx-btn quiet" data-ta="open-session">' + (f.fork ? 'Open session to fork it' : 'Open session') + '</button>' : '') +
        '</div></div>';
    } else if (v && v.attachable === false && /^(native_thread_working|native_target_busy)$/.test(v.reason)) {
      // 6.99.29: "Working right now" only while the card's one state says so.
      // QA 7.0.0: files in this sheet's box wait for the turn end, so the note says so (app.js sxParkLine).
      if (K.feed.parkNoteShows(r)) html = '<p class="sx-park">' + esc(K.parkCopy(r.provider, r, !!(filesOn() && filesState(filesBox(r)) !== 'none'))) + '</p>';
    } else if (v && v.attachable === false && v.reasonCopy) {
      html = '<div class="sx-box refusal" role="status"><p>' + esc(v.reasonCopy) + '</p></div>';
    } else if (v && v.caution) {
      html = '<p class="sx-park">' + esc(r.provider === 'codex' ? 'The Codex app has this thread open. COS asks before the first send, then hands your message to the app\u2019s own queue.'
        : 'Another app on this Mac has this session open. COS asks before the first send.') + '</p>';
    }
    box.innerHTML = html;
    if (KB.on) fit();   // the reply box's height changed: the conversation's room is measured again
  }
  function setSending(on) {
    var input = $('ta-input');
    if (input) input.readOnly = on;
    paintSendButton(); paintClip();
  }
  function sendReply(opts) {
    var r = O.r; if (!r) return;
    var input = $('ta-input'), text = input ? input.value.trim() : '';
    if (!text) { O.note = { text: 'Write a message first.', kind: 'error' }; paintNote(); return; }
    // Files: never before every upload has finished, and never with one that failed.
    var box = filesOn() ? filesBox(r) : null, st = filesState(box);
    if (st === 'waiting') { O.note = { text: 'A file is still uploading. Send when it finishes.', kind: '' }; paintNote(); return; }
    if (st === 'failed') { O.note = { text: 'A file did not upload. Retry it or remove it.', kind: 'error' }; paintNote(); return; }
    var ids = st === 'ready' ? KIT().ids(box) : [];
    // A send with files cut off by a reload: the chips are gone, the draft kept their ids. The same words go again with
    // the same files under the same key, so a send that did land is answered, never repeated.
    if (!ids.length && r.draft && r.draft.restored && r.draft.text === text && r.draft.ids && r.draft.ids.length) ids = r.draft.ids.slice();
    if (ids.length) opts = Object.assign({}, opts || {}, { attachmentIds: ids });
    // Control's caution: another app holds this session and looks idle, so the first send asks.
    if (r.verdict && r.verdict.caution && !r.cautionAck) { O.cautionAsk = true; O.armedAt = { caution: Date.now() }; paintVerdict(); return; }
    if (r.sending) return;
    if (r.refusal || O.cautionAsk) { r.refusal = null; O.cautionAsk = false; paintVerdict(); }
    r.sending = true; setSending(true);
    var done = function () { r.sending = false; if (O.r === r) setSending(false); };
    var sending = K.send(r, text, opts || {});
    // continueSession picks the key at once (draftFor): keep it until the Mac takes the words.
    if (r.draft) keepDraft(r, text, r.draft);
    return sending.then(function () { done(); }, function (err) {
      done();
      if (O.r !== r) return;
      var why = err && err.name === 'AbortError'
        ? 'No answer from your Mac yet. It may still land. Sending again is safe; it will not post twice.'
        : (err && err.message) || 'Could not reach your Mac.';
      O.note = { text: '', kind: '' }; paintNote();
      r.refusal = { copy: why, retry: true };
      paintVerdict();
    });
  }
  // Stop, as the reader's Stop sends it (app.js stopSession): POST .../cancel with one clientCancelId per attempt, so a
  // retry after a lost answer replays instead of stopping twice. The server's own words say what happened.
  function stopRun() {
    var r = O.r; if (!r || O.stopping) return;
    O.stopping = true; O.armedAt = {};
    if (!O.stopKey) O.stopKey = K.newKey();
    O.note = { text: 'Stopping', kind: '' }; paintNote(); paintLive();
    return K.answer(K.path(r.provider, r.id, '/cancel'), { method: 'POST', timeoutMs: 15000, body: { clientCancelId: O.stopKey } }).then(function (c) {
      O.stopping = false;
      if (O.r !== r) return;
      var b = c.body || {};
      O.stopKey = '';
      O.note = { text: b.reasonCopy || (b.cancelled ? 'Stopped.' : 'COS could not stop it.'), kind: b.cancelled ? '' : 'error' };
      if (b.cancelled) { r.stoppedAt = Date.now(); K.feed.settle(r); O.dirty = true; paintLive(); paintVerdict(); setTimeout(function () { if (O.r === r) loadLast(r); }, 1500); }
      paintNote(); paintLive();
    }, function (err) {
      O.stopping = false;
      if (O.r !== r) return;
      O.note = { text: 'No answer from your Mac' + (err && err.message ? ': ' + err.message : '') + '. Stopping again is safe; it will not stop twice.', kind: 'error' };
      paintNote(); paintLive();
    });
  }
  // A copy of the reader's watchTurn (app.js): the same route, outcomes and three minutes, for as long as the overlay
  // shows this session. The reader's own watch is tied to its page, so it cannot be reused here.
  function watchTurn(r, bindingId, key) {
    clearInterval(O.watch);
    var started = Date.now();
    O.watch = setInterval(function () {
      // Hidden: no reads, and the three minutes count only while the page is in view (6.99.30).
      if (document.hidden) { started += 3000; return; }
      if (O.r !== r || Date.now() - started > WATCH_MS) { clearInterval(O.watch); return; }
      K.answer('/api/agent-sessions/bindings/' + encodeURIComponent(bindingId) + '/turns/' + encodeURIComponent(key)).then(function (s) {
        if (O.r !== r) return;
        var o = s.body && s.body.outcome;
        if (o === 'completed') {
          clearInterval(O.watch);
          // 6.99.29: a turn delivered LIVE is in the open session, which now works on it; it is not done.
          if (s.body.via === 'live') { K.feed.noteGate(r, true); O.note = { text: 'Sent into the open session. It is working on it now.', kind: '' }; }
          else { O.note = { text: 'Done. The reply is below.', kind: '' }; loadLast(r); }
          paintNote(); VIEW.stateChanged(r);
        }
        else if (o === 'refused') { clearInterval(O.watch); O.note = { text: s.body.reasonCopy || 'The session refused that message.', kind: 'error' }; paintNote(); }
        else if (o === 'ambiguous') { clearInterval(O.watch); O.note = { text: s.body.reasonCopy || 'COS cannot tell whether that landed. Look at the session before sending it again.', kind: 'error' }; paintNote(); }
      }).catch(function () {});
    }, 3000);
  }

  // ═════════════ what COS is told about Today ═════════════
  // A short plain summary of what the Today cards show, for an Ask made from Today (app.js askCos). Titles and words
  // only: no ids, no tokens. At most SUMMARY_MAX characters, the left-out marker included.
  function end(s) { s = String(s || '').trim(); return /[.!?\u2026]$/.test(s) ? s : s + '.'; }
  function summary() {
    var d = T.data();
    if (!d.at) return '';
    var lines = [], now = new Date();
    lines.push('Today, ' + now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) + ', ' + W.clock(now) + '.');
    // Needs you as Today lists it (app.js needsModel: waiting sessions, Work handoffs, voices, memories), and what it
    // could not read. Before that model exists, the Work handoffs alone.
    var m = T.needs ? T.needs() : null;
    var rows = m ? m.rows : (d.needs || []).map(function (it) { return { kind: 'work', item: it }; });
    var later = m ? m.later.length : 0;
    lines.push(rows.length ? 'Needs you (' + rows.length + (later ? ', ' + later + ' of them can wait until tomorrow' : '') + '):'
      : m && !m.settled ? 'Needs you: nothing found so far.' : 'Needs you: nothing.');
    rows.slice(0, 6).forEach(function (r) {
      // 6.99.26: where a waiting session can be answered, as the row says it.
      var where = r.where === 'here' ? ' It can be answered from Today.' : r.where === 'mac' ? ' It waits on the Mac\u2019s own prompt.' : r.where === 'answered' ? ' It was just answered.' : '';
      if (r.kind !== 'work') { lines.push('- ' + end(clip(r.title, 140)) + (r.why ? ' ' + end(clip(r.why, 160)) : '') + where); return; }
      var it = r.item;
      var title = str(it.sessionTitle) || str(it.title) || 'Handoff';
      var bits = [end(clip(title, 120)) + ' ' + end(needLine(it))];
      if (str(it.title) && str(it.title) !== str(it.sessionTitle)) bits.push(end('Work card: ' + clip(it.title, 100)));
      var p = it.progress && !it.progress.unreadable ? it.progress : null;
      if (p && p.evidence) bits.push('The session said: "' + clip(p.evidence, 200) + '"');
      lines.push('- ' + bits.join(' '));
    });
    if (rows.length > 6) lines.push('- and ' + (rows.length - 6) + ' more.');
    if (m && m.failed.length) lines.push('Today could not read ' + m.failed.join(', ') + ', so this may not be everything.');
    var working = d.working || [], open = d.open || [];
    lines.push('Running: ' + working.length + ' working' + (open.length ? ', ' + open.length + ' more open and quiet' : '') + (working.length ? ':' : '.'));
    working.slice(0, 6).forEach(function (s) {
      var k = T.splitSessionId(s.provider, s.session_id);
      lines.push('- ' + K.providerLabel(k.provider) + ': ' + clip(T.sessionTitle(s), 120) + ', working for ' + T.span(s.state_since || s.last_activity_at) + '.');
    });
    var items = d.intake || [];
    if (items.length) {
      lines.push('From today\u2019s meetings: ' + items.length + (items.length === 1 ? ' suggestion' : ' suggestions') + ' waiting for a decision (they move to Work at midnight):');
      var groups = [], byTitle = {};
      items.forEach(function (it) { var t = str(it.meeting && it.meeting.title) || 'A meeting'; if (!byTitle[t]) { byTitle[t] = []; groups.push(t); } byTitle[t].push(it); });
      groups.slice(0, 8).forEach(function (t) {
        var list = byTitle[t];
        lines.push('- ' + clip(t, 100) + ' (' + list.length + '): ' + list.slice(0, 4).map(function (it) { return '"' + clip(textOf(it), 110) + '"' + (it.ownerIsMiles ? '' : str(it.owner) ? ' (' + clip(it.owner, 40) + '\u2019s)' : ''); }).join('; ') + (list.length > 4 ? '; and ' + (list.length - 4) + ' more' : '') + '.');
      });
      if (groups.length > 8) lines.push('- and ' + (groups.length - 8) + ' more meetings.');
    }
    var n = d.welcome && d.welcome.nextEvent, nd = n && W.toDate(n.time);
    if (nd && n.title) lines.push('Next up: ' + clip(n.title, 120) + ' at ' + W.clock(nd) + ' ' + W.dayWord(nd) + '.');
    var out = '', i;
    for (i = 0; i < lines.length; i++) {
      if (out.length + lines[i].length + 1 > SUMMARY_MAX - SUMMARY_MORE.length) { out += SUMMARY_MORE; break; }
      out += lines[i] + '\n';
    }
    return out.trim();
  }

  W.registerPane('todayActions', {
    load: function () {},
    open: open, close: close, restore: restore, summary: summary, summaryMax: SUMMARY_MAX,
    isOpen: function () { return !!O.open; },
    _state: O, _decide: decide, _undo: undo, _intakeHtml: intakeHtml, _send: sendReply, _view: VIEW, _paintVerdict: paintVerdict,
    _paintLive: paintLive, _paintMeta: paintMeta, _onClick: onClick, _expire: expireLater, _kb: KB, _fitNow: applyFit, _revive: revive
  });
})();
