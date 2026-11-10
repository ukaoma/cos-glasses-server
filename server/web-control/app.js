/* COS Control Web. One script, no framework, no inline handlers (the page CSP is script-src 'self').
   Auth is the HttpOnly cos_web_session cookie only: this page never holds the pairing token.
   Every server string reaches the DOM through esc(). Routes live in location.hash so the
   phone's back gesture and the browser's back button both work. */
(function () {
  'use strict';

  // ── utilities ───────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Agent turns and task text are markdown. Escape first, then style a small subset, so the
  // result can never contain markup the server sent.
  function md(text) {
    return esc(text).split('\n').map(function (line) {
      var l = line
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      if (/^#{1,4}\s+/.test(l)) return '<strong>' + l.replace(/^#{1,4}\s+/, '') + '</strong>';
      if (/^&gt;\s?/.test(l)) return '<span class="quote">' + l.replace(/^&gt;\s?/, '') + '</span>';
      if (/^\s*[-*]\s+/.test(l)) return l.replace(/^(\s*)[-*]\s+/, '$1• ');
      return l;
    }).join('\n');
  }
  function plain(text) { return String(text == null ? '' : text).replace(/\*\*|`/g, '').replace(/^#{1,4}\s+/, ''); }
  // 7.0.5: a COS answer is written for the G2 lens as plain text, so a numbered list arrives inline ("...for me: 1. Prep
  // before each meeting. 2. Catching conflicts early. 3. ..."), one long paragraph on the phone. Before md() draws a COS
  // answer (the chat card, the Messages reader), each run of inline items 1, 2, 3 in order goes on its own line under
  // its lead-in. Only whitespace changes: every character of the answer stays. The lens and the stored text never see it.
  // Conservative: text with any Markdown structure is left alone; a marker counts only after a sentence end (". " ": "
  // "? " "! ") and never inside a code, bold or italic span; fewer than two items, or numbers out of order, are not a list;
  // words after the last item stay in it, except a short "Label:" sentence followed by a new 1, which starts the next list.
  // 7.0.7 (final QA W1): a new line never starts with what a renderer reads as a block. A "Label:" that starts with one
  // stays on the line before it, and a list whose item starts with one is left as it is (never half a list).
  var LA_STRUCTURED = /^[ \t]*(?:[-*+][ \t]|\d{1,3}[.)][ \t]|#|>|\|)|\n[ \t]*\n|```|~~~/m;
  var LA_MARK = /([.:?!]["'”’)]?)([ \t]+)([1-9]\d?)\.(?=[ \t]+\S)/g;
  var LA_END = /[.?!]["'”’)]?([ \t]+)/g;
  // Spans no cut may enter. Each kind is found on its own, as its renderer finds it, and a cut is refused inside any of
  // them: md()'s own `code` and **bold** (never empty, no star inside bold), and for the Mac's inline Markdown *italic*,
  // __bold__ and _italic_, each opening on a non-space and closing after one, on one line ("2 * 3" and a lone "*" are
  // not spans). A word's own underscores (max_tokens, top_p) are matched first, so they never open a span. A link holds
  // no whitespace, and only whitespace is ever replaced, so a link is never cut.
  var LA_GUARD = /`[^`\n]+`/g;
  var LA_BOLD = /\*\*[^*\n]+\*\*/g;
  var LA_STAR = /\*(?!\*)\S(?:[^*\n]*(?!\*)\S)?\*/g;
  var LA_UNDER = /[A-Za-z0-9]_+|__(?!_)\S(?:[^_\n]*(?!_)\S)?__(?![A-Za-z0-9])|_(?!_)\S(?:[^_\n]*(?!_)\S)?_(?![A-Za-z0-9])/g;
  var LA_SPANS = [LA_GUARD, LA_BOLD, LA_STAR, LA_UNDER];
  // What a line may not start with when a cut makes it start (md() here; the Mac's COSMarkdownParser also reads
  // "[Speaker]:" lines and "<details>"): a heading, quote, bullet or table row, a "[" or "<", or a number list marker.
  var LA_BLOCK_START = /[ \t]*(?:[\-#>*+|<\[]|\d+[.)])/y;
  // What an item's own words may not start with: a heading, a quote, or a Mac task box ("1. [x] done").
  var LA_ITEM_START = /[ \t]*(?:[#>]|\[[ xX]\])/y;
  var LA_LABEL_MAX = 100;
  // Does `re` (sticky) match at `at` in `line`?
  function laAt(re, line, at) { re.lastIndex = at; return re.test(line); }
  function structureLensAnswer(text) {
    var s = text == null ? '' : String(text);
    if (s.indexOf('. ') < 0 || LA_STRUCTURED.test(s)) return s;
    var lines = s.split('\n'), out = [], changed = false;
    for (var i = 0; i < lines.length; i++) {
      var r = laLine(lines[i]);
      if (r !== lines[i]) changed = true;
      // A line that became a list ends with a blank line before whatever follows it.
      out.push(r !== lines[i] && i < lines.length - 1 ? r + '\n' : r);
    }
    return changed ? out.join('\n') : s;
  }
  function laLine(line) {
    var kinds = [], m;
    for (var g = 0; g < LA_SPANS.length; g++) {
      var re = LA_SPANS[g], starts = [], ends = [];
      re.lastIndex = 0;
      while ((m = re.exec(line))) { starts.push(m.index); ends.push(m.index + m[0].length); }
      if (starts.length) kinds.push([starts, ends]);
    }
    // Inside a span of any kind? One kind's spans are in order and never overlap: binary search each.
    var guarded = function (at) {
      for (var k = 0; k < kinds.length; k++) {
        var st = kinds[k][0], en = kinds[k][1], lo = 0, hi = st.length - 1;
        while (lo <= hi) { var mid = (lo + hi) >> 1; if (st[mid] > at) hi = mid - 1; else if (en[mid] <= at) lo = mid + 1; else return true; }
      }
      return false;
    };
    var marks = [];
    LA_MARK.lastIndex = 0;
    while ((m = LA_MARK.exec(line))) {
      var ws = m.index + m[1].length, at = ws + m[2].length;
      if (guarded(m.index) || guarded(at)) continue;
      marks.push({ colon: m[1].charAt(0) === ':', ws: ws, at: at, body: at + m[3].length + 1, n: Number(m[3]) });
    }
    // Runs of 1, 2, 3 in order; two items or more make a list.
    var runs = [], cur = [];
    for (var k = 0; k < marks.length; k++) {
      var c = marks[k];
      if (cur.length && c.n === cur[cur.length - 1].n + 1) { cur.push(c); continue; }
      if (cur.length >= 2) runs.push(cur);
      cur = c.n === 1 ? [c] : [];
    }
    if (cur.length >= 2) runs.push(cur);
    var cuts = [], prevEnd = 0, lists = 0;
    for (var q = 0; q < runs.length; q++) {
      var run = runs[q], first = run[0];
      // After a list, only a "Label:" lead-in starts another; anything else stays in the last item.
      if (lists && !first.colon) continue;
      // An item whose words start a block leaves its whole list as it is; it still counts as a list, so the words after
      // it stay in its last item.
      var clean = true;
      for (var j = 0; j < run.length; j++) if (laAt(LA_ITEM_START, line, run[j].body)) { clean = false; break; }
      if (clean) {
        if (first.colon) {
          // The lead-in is the "Label:" sentence: it gets its own line when it is short and does not start a block.
          var from = -1, to = -1, e;
          LA_END.lastIndex = prevEnd;
          while ((e = LA_END.exec(line)) && e.index + e[0].length < first.ws) {
            if (!guarded(e.index)) { to = e.index + e[0].length; from = to - e[1].length; }
          }
          if (from >= 0 && first.ws - to <= LA_LABEL_MAX && !laAt(LA_BLOCK_START, line, to)) cuts.push([from, to, '\n\n']);
        }
        cuts.push([first.ws, first.at, '\n\n']);
        for (var r2 = 1; r2 < run.length; r2++) cuts.push([run[r2].ws, run[r2].at, '\n']);
      }
      prevEnd = run[run.length - 1].body;   // after the last item's own "5.", which is not a sentence end
      lists++;
    }
    if (!cuts.length) return line;
    var res = '', pos = 0;
    for (var x = 0; x < cuts.length; x++) { res += line.slice(pos, cuts[x][0]) + cuts[x][2]; pos = cuts[x][1]; }
    return res + line.slice(pos);
  }
  // Markdown pipe tables (Duo tables). Every pane that draws one asks tableFit how far each column may shrink. Cells
  // wrap only at spaces (CSS: overflow-wrap break-word, so a column is never narrower than its longest word), a column
  // whose text is longer than TF_MIN_CH keeps at least that many characters, a first column of short labels stays on
  // one line, and a long first column gets a fixed width and wraps at words. Only a token of TF_LONG or more characters
  // (a URL, a hash) may break inside. A table wider than its box scrolls inside it (CSS .tf-wrap), first column sticky.
  var TF_LONG = 25, TF_MIN_CH = 10, TF_KEY_WORDS = 3, TF_KEY_CHARS = 28, TF_FIRST_MIN = 14, TF_FIRST_MAX = 26;
  var TF_LONG_RE = new RegExp('[^\\s<>]{' + TF_LONG + ',}', 'g');
  function tfText(cell) {
    return String(cell == null ? '' : cell).replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, '_')
      .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1').replace(/\*\*|__|~~|`/g, '').replace(/\s+/g, ' ').trim();
  }
  function tfLong(html) {
    return String(html).split(/(<[^>]*>)/).map(function (part) {
      return part.charAt(0) === '<' ? part : part.replace(TF_LONG_RE, function (t) { return '<span class="tf-long">' + t + '</span>'; });
    }).join('');
  }
  // rows: every row of raw cell text, the header row first when there is one.
  function tableFit(rows) {
    rows = (rows || []).filter(Array.isArray);
    var n = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    var key = n > 1 && rows.length > 0 && rows.every(function (r) {
      var t = tfText(r[0]);
      return t.length <= TF_KEY_CHARS && (t ? t.split(' ').length : 0) <= TF_KEY_WORDS;
    });
    var cols = [];
    for (var k = 0; k < n; k++) {
      var len = rows.reduce(function (m, r) { return Math.max(m, tfText(r[k]).length); }, 0);
      if (k === 0 && key) cols.push({ min: 0, width: 0 });
      else if (k === 0 && n > 1) cols.push({ min: Math.min(len, TF_FIRST_MIN), width: Math.min(len, TF_FIRST_MAX) });
      else cols.push({ min: Math.min(len, TF_MIN_CH), width: 0 });
    }
    return {
      key: key, cols: cols,
      tableClass: 'tf' + (key ? ' tf-key' : ''),
      // The first row's cells carry each column's floor (an inner block's min-width counts in every engine's table
      // sizing) and the first column's width; later rows only get their long tokens marked.
      width: function (k, first) { var c = cols[k]; return first && c && c.width ? 'width:' + c.width + 'ch' : ''; },
      cell: function (k, html, first) {
        var c = cols[k], body = tfLong(html);
        return first && c && c.min >= 3 ? '<span class="tf-min" style="min-width:' + c.min + 'ch">' + body + '</span>' : body;
      }
    };
  }
  var WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  function countWord(n, lower) { var w = n >= 0 && n <= 10 ? WORDS[n] : String(n); return lower ? w.toLowerCase() : w; }
  function plural(n, one, many) { return n === 1 ? one : many; }
  function toDate(v) {
    if (v == null || v === '') return null;
    var d = typeof v === 'number' || /^\d{10,}$/.test(String(v)) ? new Date(Number(v)) : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function ago(v) {
    var d = toDate(v); if (!d) return '';
    var s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.round(s / 60) + ' min';
    if (s < 86400) return Math.round(s / 3600) + ' h';
    if (s < 172800) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function span(v) {
    var d = toDate(v); if (!d) return '';
    var m = Math.max(1, Math.round((Date.now() - d.getTime()) / 60000));
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h < 48 ? h + ' h' : Math.round(h / 24) + ' days';
  }
  function clock(d) { return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function dayWord(d) {
    var today = new Date(); var t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    var diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t0) / 86400000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  }
  // 6.99.30 (design QA): a day in a row, in plain words: "Today", else "Nov 7" ("Nov 7, 2025" in another year). Takes
  // a YYYY-MM-DD (a meeting's date, read as that calendar day, never shifted by time zone) or a Date. Anything else comes
  // back as it was.
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function plainDay(v, now) {
    var y, m, d;
    if (v instanceof Date && isFinite(v.getTime())) { y = v.getFullYear(); m = v.getMonth(); d = v.getDate(); }
    else { var p = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? '' : v)); if (!p) return v == null ? '' : String(v); y = +p[1]; m = +p[2] - 1; d = +p[3]; }
    if (m < 0 || m > 11 || d < 1 || d > 31) return String(v);
    var n = now || new Date();
    if (y === n.getFullYear() && m === n.getMonth() && d === n.getDate()) return 'Today';
    return MONTHS[m] + ' ' + d + (y === n.getFullYear() ? '' : ', ' + y);
  }
  var PROVIDERS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', glasses: 'Glasses', cos: 'COS' };
  function providerLabel(p) { return PROVIDERS[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Session'); }
  function badge(p) { var cls = PROVIDERS[p] ? (p === 'cos' ? 'glasses' : p) : 'work'; return '<span class="badge ' + esc(cls) + '">' + esc(providerLabel(p)) + '</span>'; }
  var DOMAINS = { quilt: 'Quilt', sprocket_rocket: 'Sprocket Rocket', hermit_crabs: 'Hermit Crabs', personal: 'Personal' };
  function domainLabel(d) { return DOMAINS[d] || d || ''; }
  function sessionTitle(s) {
    var t = s.display_label || s.custom_title || s.title || s.first_prompt || '';
    t = plain(t).replace(/\s+/g, ' ').trim();
    return t || 'Untitled session';
  }
  function splitSessionId(provider, id) {
    var raw = String(id || '');
    var m = /^(claude|codex|cursor):(.+)$/.exec(raw);
    return m ? { provider: m[1], id: m[2] } : { provider: provider || 'claude', id: raw };
  }
  function skeletonRows(n) {
    var out = '';
    for (var i = 0; i < n; i++) out += '<div class="skel-row"><div class="skeleton" style="width:' + (62 + (i * 13) % 30) + '%"></div><div class="skeleton" style="width:' + (30 + (i * 7) % 25) + '%"></div></div>';
    return '<div class="list">' + out + '</div>';
  }
  function emptyBox(title, body) { return '<div class="list"><p class="empty"><strong>' + esc(title) + '</strong>' + esc(body || '') + '</p></div>'; }
  var toastTimer = null;
  function toast(text) {
    var el = $('toast'); el.textContent = text; el.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 3200);
  }
  function setStatus(el, text, isError) { if (!el) return; el.textContent = text || ''; el.classList.toggle('error', !!isError); }
  function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; }

  // ── API ─────────────────────────────────────────────────
  function api(path, opts) {
    var o = opts || {};
    var headers = { 'X-COS-Web': '1' };
    var body;
    if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
    // Reads give up after 20 s (a sleeping or busy Mac must not leave a reader on its skeleton
    // forever); a caller can pass timeoutMs. Writes wait unless they ask, so a slow save is not
    // reported as failed while it may still land.
    var method = o.method || 'GET';
    var limit = o.timeoutMs != null ? o.timeoutMs : (method === 'GET' ? API_READ_TIMEOUT_MS : 0);
    var ctrl = limit && window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, limit) : null;
    var sentAt = Date.now();
    return fetch(path, { method: method, headers: headers, credentials: 'same-origin', body: body, signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
      // Blob bodies keep their deadline after headers: a stalled download must release its queue slot.
      if (timer && o.responseType !== 'blob') clearTimeout(timer);
      sxNoteClock(res, sentAt);
      noteServer(true);
      if (res.status === 401 && path.indexOf('/api/web-session/') !== 0) { showAuth(typeof signinLapsedCopy === 'function' && signedInOnce() ? signinLapsedCopy() : undefined); var gone = new Error('Signed out. Connect this browser again.'); gone.status = 401; throw gone; }
      if (o.responseType === 'blob' && res.ok) return res.blob();
      return res.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_e) { data = {}; }
        if (!res.ok) {
          var msg = (data && (data.message || (data.error && data.error.message) || data.error)) || ('The server answered ' + res.status + '.');
          var err = new Error(typeof msg === 'string' ? msg : 'The server answered ' + res.status + '.');
          err.status = res.status;
          // The machine-readable reason, so a pane can say the right thing for a refusal whose
          // body carries a code and no sentence (for example work-intake's {error: {code}}).
          var code = data && ((data.error && typeof data.error === 'object' && data.error.code) || data.code || data.reason || (typeof data.error === 'string' ? data.error : ''));
          if (code) err.code = String(code);
          throw err;
        }
        return data;
      });
    }).then(function (value) {
      if (timer) clearTimeout(timer);
      return value;
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError' && ctrl && ctrl.signal.aborted) {
        // 6.99.32 (QA 6.99.30 canary W1): a read the Mac never answered in time means it is not answering. A write has
        // no deadline unless its caller set one, and a slow save is not a Mac that went away, so only reads say so.
        if (method === 'GET' && !(SERVER.lastUpAt >= sentAt)) noteServer(false);
        var late = new Error('Your Mac did not answer in ' + Math.round(limit / 1000) + ' seconds. Check that it is awake, then try again.');
        late.code = 'timeout'; throw late;
      }
      // 6.99.30: the browser's own words for a request that never reached the Mac ("Failed to fetch" in Chrome and
      // Comet, "Load failed" in Safari, "NetworkError..." in Firefox) never reach the page. Anything with no status
      // that is not a timeout or an abort the caller asked for is the Mac out of reach, said once, here.
      if (err && err.status == null && !err.code && err.name !== 'AbortError') { noteServer(false); throw unreachableError(err); }
      throw err;
    });
  }
  var API_READ_TIMEOUT_MS = 20000;

  // ── what every request learns about the Mac (6.99.30) ──
  // api() above and apiAnswer() (the Sessions reader's transport) share these; they sit here, between api() and the
  // state, so a test that loads api() alone has them.
  // 6.99.30: the one sentence for a request that never reached the Mac (api() and apiAnswer() below, and the panes with
  // their own fetch: COSWeb.unreachableCopy). Never the browser's own "Failed to fetch" or "Load failed".
  var UNREACHABLE_COPY = 'Could not reach COS on your Mac. Check that it is awake and on Tailscale, then try again.';
  function unreachableError(cause) { var e = new Error(UNREACHABLE_COPY); e.code = 'unreachable'; e.cause = cause; return e; }

  // 6.99.30 (QA: clock skew): the Mac's clock, as this page's offset from it. The session card's one state (sxTruth)
  // weighs the Mac's own times (state_since, a row's activity) against moments this page stamped with its own clock (a
  // gate answer, a Stop). A phone a minute behind made every Mac time look a minute newer, so a stale Idle beat a
  // Working the page had just been told about. Each answer's Date header (whole seconds, read at the midpoint of the
  // request) gives the offset; the answer with the shortest round trip in the last ten minutes wins, so one slow answer
  // never moves it. Zero until the first answer. A missing or unreadable header changes nothing.
  var SX_CLOCK = { skew: 0, rtt: Infinity, at: 0 };
  var SX_CLOCK_KEEP_MS = 600000;
  function sxNoteClock(res, sentAt) {
    var got = Date.now(), h = null;
    try { h = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('date') : null; } catch (_e) { h = null; }
    var server = h ? Date.parse(h) : NaN;
    if (!isFinite(server) || typeof sentAt !== 'number') return;
    var rtt = Math.max(0, got - sentAt);
    // The header drops the milliseconds: on average the Mac's moment is half a second after the stamped second.
    var skew = Math.round(server + 500 - (sentAt + rtt / 2));
    if (rtt <= SX_CLOCK.rtt || got - SX_CLOCK.at > SX_CLOCK_KEEP_MS) { SX_CLOCK.skew = skew; SX_CLOCK.rtt = rtt; SX_CLOCK.at = got; }
  }
  // 6.99.30 (QA: "Server connected" stayed green for five minutes after the Mac went away): every request says whether
  // the Mac answered. A request that never reached it marks it down; any HTTP answer, whatever its status, marks it up.
  // QA 6.99.30 (Skeptic): never a 502. Nothing sits in front of the Mac (direct HTTPS over Tailscale) and COS sends its
  // own 502s (an unsupported Memories workspace, a bad Meetings Ask answer), so a 502 flapped the rail, the question
  // cards and an open sheet down and up again. The rail's server line, Today's sheet and the question cards hear each change at once
  // (COSWeb.onServer). null until the first answer.
  // lastUpAt (6.99.32, QA Skeptic W-2): when the Mac last answered anything, on this page's clock. A read that timed out
  // marks it down only if nothing has answered since that read went out (a slow image whose headers already came, a busy
  // Mac whose question poll keeps answering), so a slow but alive Mac never flaps.
  var SERVER = { up: null, hooks: [], lastUpAt: 0 };
  function noteServer(up) {
    up = !!up;
    if (up) SERVER.lastUpAt = Date.now();
    if (SERVER.up === up) return;
    SERVER.up = up;
    SERVER.hooks.slice().forEach(function (fn) { try { fn(up); } catch (err) { console.error(err); } });
  }

  /** This page's moment `t` (its own Date.now()) on the Mac's clock. */
  function sxServerTime(t) { return t == null ? t : t + SX_CLOCK.skew; }

  // ── state ───────────────────────────────────────────────
  var state = {
    pane: 'today', serverName: '', tailnetUrl: '',
    sessions: [], sessionsMode: 'words', workTasks: [], workOpenStages: { complete: false },
    stream: null, lastLoad: {}, livePoll: null
  };
  // ── Mac reachability and sign-in lifetime (W1, 7.0.x): audit 02 F2, F3, F23 ──
  // F3: with no offline shell (that needs a service worker, so HTTPS), an open page says plainly when the Mac stops answering,
  // when it last heard from it, and offers Retry, instead of spinners. Retry asks GET /api/health (public, no state) and then
  // reloads the pane on screen. While the Mac is down it asks again every 30 s, only while the page is visible.
  // F2: the sign-in cookie lasts 7 days and is not renewed (lib/web-session-auth.ts). GET /api/web-session/status and the
  // login answer carry this browser's own expiresAt; within a day of it the page says when it ends and how to sign in again.
  var CONN = { timer: null, retrying: false, signinEnds: 0, hideFor: 0, lapsed: false };
  var CONN_RETRY_MS = 30000, SIGNIN_WARN_MS = 24 * 3600000, SIGNIN_STORE = 'cos.web.signinEnds';
  var SIGNIN_HOW = 'On your Mac, open COS Control, then Settings, Glasses and iPhone, Open COS on your phone. Or get a code from another signed-in browser, or from the COS Glasses app.';
  function connWhen(ms) {
    if (!ms) return '';
    var d = new Date(ms), same = new Date().toDateString() === d.toDateString();
    return same ? clock(d) : d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + clock(d);
  }
  function signinRemember(info) {
    var at = info && info.expiresAt ? Date.parse(info.expiresAt) : NaN;
    if (!isFinite(at) || at <= 0) return;
    CONN.signinEnds = at;
    try { localStorage.setItem(SIGNIN_STORE, String(at)); } catch (e) { /* the notice still works for this page */ }
  }
  function signinEndsAt() {
    if (CONN.signinEnds) return CONN.signinEnds;
    try { var v = Number(localStorage.getItem(SIGNIN_STORE)); return isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; }
  }
  // Why the sign-in gate opened after this page had been signed in: the 7 days ran out, or the browser was signed out.
  function signinLapsedCopy() {
    var ends = signinEndsAt();
    return ends && ends <= Date.now() + 60000
      ? 'Your sign-in on this browser ended. Sign-ins last 7 days. ' + SIGNIN_HOW
      : 'This browser is signed out. ' + SIGNIN_HOW;
  }
  function connHtml() {
    var html = '';
    if (SERVER.up === false) {
      html += '<div class="conn-line" role="status"><strong>Your Mac is not answering.</strong><span class="conn-sub">' +
        esc((SERVER.lastUpAt ? 'Last updated ' + connWhen(SERVER.lastUpAt) + '. ' : '') + 'What is on screen may be out of date. Check that the Mac is awake and on Tailscale.') + '</span>' +
        '<button type="button" class="btn small" data-action="conn-retry"' + (CONN.retrying ? ' disabled' : '') + '>' + (CONN.retrying ? 'Checking' : 'Retry') + '</button></div>';
    }
    var ends = signinEndsAt(), left = ends - Date.now();
    if (ends && left > 0 && left <= SIGNIN_WARN_MS && CONN.hideFor !== ends) {
      html += '<div class="conn-line" role="status"><strong>Sign-in here ends ' + esc(connWhen(ends)) + '.</strong><span class="conn-sub">' +
        esc('Sign in again before then from COS Control on your Mac: Open COS on your phone.') + '</span>' +
        '<button type="button" class="btn small" data-action="conn-hide-signin">Hide</button></div>';
    }
    return html;
  }
  function connPaint() {
    var box = $('conn-notice'); if (!box) return;
    var html = connHtml();
    if (box.innerHTML !== html) box.innerHTML = html;
    box.hidden = !html;
  }
  function connSchedule() {
    if (CONN.timer) { clearTimeout(CONN.timer); CONN.timer = null; }
    if (SERVER.up !== false) return;
    CONN.timer = setTimeout(function () { CONN.timer = null; if (!document.hidden) connRetry(false); else connSchedule(); }, CONN_RETRY_MS);
  }
  function connRetry(byHand) {
    if (CONN.retrying) return Promise.resolve(false);
    CONN.retrying = true; connPaint();
    return api('/api/health', { timeoutMs: 10000 }).then(function () { return true; }, function () { return false; }).then(function (up) {
      CONN.retrying = false;
      if (up) { connPaint(); if (typeof route === 'function') route(); }
      else { if (byHand) noteServer(false); connPaint(); connSchedule(); }
      return up;
    });
  }
  SERVER.hooks.push(function () { connPaint(); connSchedule(); });
  // ── end Mac reachability and sign-in lifetime

  // Control's order (ActivitySection.visibleSections): Today, then Messages to Dictation. Usage is a
  // view inside Sessions on the Mac; its route stays so old links work, and the rail marks Sessions.
  var ROOT_PANES = ['today', 'messages', 'speakers', 'meetings', 'memories', 'threads', 'sessions', 'work', 'dictation', 'usage', 'settings'];
  var TITLES = { today: 'Today', messages: 'Messages', speakers: 'Speakers', meetings: 'Meetings', memories: 'Memories', threads: 'Threads', sessions: 'Sessions', work: 'Work', dictation: 'Dictation', usage: 'Usage', settings: 'Settings' };
  // Pane modules (panes/*.js) register here: { load(args, ctx), leave(), up(args) }. A registered
  // pane owns its section; route() only shows it and hands it the hash arguments.
  var PANES = {};
  // Heavy panes load when first opened, then the rest load quietly once the page is idle.
  // index.html lists them in #lazy-panes so the server can version each URL (?v=<hash>).
  // Read on first use, not at parse time: #lazy-panes sits after this script in index.html.
  var lazyList = null;
  function LAZY() {
    if (lazyList) return lazyList;
    var el = document.getElementById('lazy-panes');
    if (!el) return {};
    try { lazyList = JSON.parse(el.textContent || '{}'); } catch (_e) { lazyList = {}; }
    return lazyList;
  }
  var lazyLoads = {};
  // ensurePane(name, waitMs): the pane's script, loaded once. With waitMs, this caller stops waiting after that
  // long (the load itself carries on, and a later call reuses it), so a stalled download can never hang a tap.
  function ensurePane(name, waitMs) {
    var load = loadPane(name);
    if (!waitMs) return load;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        var late = new Error('The ' + (TITLES[name] || name) + ' section is taking too long to load. Check the connection to your Mac.');
        late.code = 'pane_timeout'; reject(late);
      }, waitMs);
      load.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }
  function loadPane(name) {
    if (PANES[name] || !LAZY()[name]) return Promise.resolve(PANES[name] || null);
    if (lazyLoads[name]) return lazyLoads[name];
    lazyLoads[name] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = LAZY()[name];
      s.async = true;
      s.onload = function () { if (PANES[name]) resolve(PANES[name]); else { delete lazyLoads[name]; reject(new Error('The ' + (TITLES[name] || name) + ' section did not start.')); } };
      s.onerror = function () { delete lazyLoads[name]; s.remove(); reject(new Error('Could not load the ' + (TITLES[name] || name) + ' section. Check the connection to your Mac.')); };
      document.body.appendChild(s);
    });
    return lazyLoads[name];
  }
  function prefetchPanes() {
    var names = Object.keys(LAZY()).filter(function (n) { return !PANES[n]; });
    var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 200); };
    (function next() {
      var n = names.shift();
      if (!n) return;
      idle(function () { ensurePane(n).then(next, next); });
    })();
  }
  var routeHooks = [];
  var shellHooks = [];
  var crumbDetail = '';

  // ── routing ─────────────────────────────────────────────
  function parseRoute() {
    var parts = (location.hash || '').replace(/^#\/?/, '').split('/').map(function (p) { try { return decodeURIComponent(p); } catch (_e) { return p; } });
    var pane = ROOT_PANES.indexOf(parts[0]) >= 0 ? parts[0] : 'today';
    return { pane: pane, args: parts.slice(1).filter(function (p) { return p !== ''; }) };
  }
  function go(pane, args) {
    var hash = '#/' + [pane].concat(args || []).map(encodeURIComponent).join('/');
    if (location.hash === hash) route(); else location.hash = hash;
  }
  // 7.0.2 (A8): a phone is under 600 px wide, or a short touch screen at any width (the unfolded Duo is 951x539 in
  // Comet): height is its scarce axis, so it gets the phone Ask sheet and the 44 px tap floor (app.css), as folded does.
  var SHORT_TOUCH_MQ = '(pointer: coarse) and (max-height: 720px)';
  function isPhone() { return !window.matchMedia('(min-width: 600px)').matches || window.matchMedia(SHORT_TOUCH_MQ).matches; }
  /** A keyboard and a fine pointer are the way in (a Mac, a PC): Return sends. Touch screens type a new line. */
  function keyboardFirst() { return !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches); }
  // Return in a text box sends only where a keyboard and a pointer are the way in (cos-chat.js keyboardFirst): never on
  // a touch screen, whatever its width (6.99.30: the unfolded Duo's on-screen keyboard sent on Return), and never
  // mid-composition (an IME's Return picks the word; keyCode 229 is Safari's composing key). Shift-Return is a new line.
  // QA 6.99.30 (Skeptic): Cmd-Return or Ctrl-Return sends on every device, so a Bluetooth keyboard on the Duo or an iPad
  // (a coarse pointer, so plain Return is a new line there) still has a send key.
  function returnSends(e) {
    if (!e || e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229 || !e.target || e.target.tagName !== 'TEXTAREA') return false;
    return !!(e.metaKey || e.ctrlKey || keyboardFirst());
  }
  function route(forceChanged) {
    var r = parseRoute();
    var changedPane = forceChanged === true || r.pane !== state.pane || !document.querySelector('#pane-' + r.pane + ':not(.hidden)');
    if (state.pane !== r.pane && PANES[state.pane] && PANES[state.pane].leave) { try { PANES[state.pane].leave(); } catch (err) { console.error(err); } }
    state.pane = r.pane;
    crumbDetail = '';
    document.querySelectorAll('.pane').forEach(function (sec) { sec.classList.toggle('hidden', sec.id !== 'pane-' + r.pane); });
    document.querySelectorAll('#section-menu [data-goto]').forEach(function (b) { if (b.getAttribute('data-goto') === r.pane) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var railPane = r.pane === 'usage' ? 'sessions' : r.pane;
    document.querySelectorAll('.rail-btn,.rail-settings').forEach(function (b) { if (b.getAttribute('data-pane') === railPane) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (state.stream && !(r.pane === 'sessions' && r.args.length === 2)) { state.stream.close(); state.stream = null; }
    if (!(r.pane === 'sessions' && r.args.length === 2)) { readerImagesStop($('session-turns')); clearInterval(state.turnPoll); if (state.reading) clearInterval(state.reading.heldTimer); state.reading = null; }
    if (r.pane !== 'meetings' && state.livePoll) { clearInterval(state.livePoll); state.livePoll = null; }

    var reading = r.args.length > 0 && !isTabRoute(r.args);
    var paneEl = $('pane-' + r.pane);
    if (paneEl) paneEl.classList.toggle('reading', reading);
    var split = paneEl && paneEl.querySelector('.split');
    if (split) split.classList.toggle('reading', reading);

    // Top bar (phone): the section switcher at a list, a back button on a reader.
    $('topbar-back').classList.toggle('hidden', !reading);
    $('section-btn').classList.toggle('hidden', reading);
    $('topbar-back-label').textContent = TITLES[r.pane] || 'Back';
    $('section-name').textContent = TITLES[r.pane] || 'Today';
    closeMenu();
    if (changedPane) window.scrollTo(0, 0);
    $('topbar').classList.remove('tucked');
    onScroll();

    if (!PANES[r.pane] && LAZY()[r.pane]) {
      var lazyPane = r.pane, lazyEl = $('pane-' + lazyPane), wasEmpty = lazyEl && !lazyEl.getAttribute('data-lazy-ready');
      if (wasEmpty && lazyEl && !lazyEl.querySelector('.lazy-wait')) lazyEl.insertAdjacentHTML('afterbegin', '<div class="lazy-wait">' + skeletonRows(4) + '</div>');
      ensurePane(lazyPane, 15000).then(function () {
        if (lazyEl) { lazyEl.setAttribute('data-lazy-ready', '1'); lazyEl.querySelectorAll('.lazy-wait').forEach(function (n) { n.remove(); }); }
        // Pass changed=true, the value this pane got on its first open when it loaded at boot. Headless Chrome
        // probes on 11/06 rendered Work, Meetings, Settings and Speakers with either value; this keeps the old contract.
        if (state.pane === lazyPane) route(true);
      }, function (err) {
        if (!lazyEl) return;
        lazyEl.querySelectorAll('.lazy-wait').forEach(function (n) { n.remove(); });
        lazyEl.insertAdjacentHTML('afterbegin', '<div class="lazy-wait"><div class="list"><p class="empty"><strong>' + esc(err.message) + '</strong></p><button type="button" class="btn" data-lazy-retry="' + esc(lazyPane) + '">Try again</button></div></div>');
        // Only the wait ran out: if the load still finishes, the card clears itself and the pane shows.
        if (err && err.code === 'pane_timeout') loadPane(lazyPane).then(function () {
          lazyEl.querySelectorAll('.lazy-wait').forEach(function (n) { n.remove(); });
          lazyEl.setAttribute('data-lazy-ready', '1');
          if (state.pane === lazyPane) route(true);
        }, function () {});
      });
      runHooks(routeHooks, r);
      return;
    }
    if (PANES[r.pane]) { try { PANES[r.pane].load(r.args, { changed: changedPane }); } catch (err) { console.error(err); } }
    else if (r.pane === 'today') loadToday();
    else if (r.pane === 'sessions') { if (!reading || !state.sessions.length || changedPane) loadSessions(); if (reading) openSession(r.args[0], r.args[1]); }
    else if (r.pane === 'usage') loadUsage(false);
    state.lastLoad[r.pane] = Date.now();
    runHooks(routeHooks, r);
  }
  function runHooks(list, arg) { list.forEach(function (fn) { try { fn(arg); } catch (err) { console.error(err); } }); }
  // Back unwinds one step, the way Control's Back does: a pane module may name the step above a
  // nested reader (an archive chat goes back to its day, not to the list).
  function goBack() {
    var r = parseRoute();
    var up = PANES[r.pane] && PANES[r.pane].up ? PANES[r.pane].up(r.args) : null;
    if (up) go(r.pane, up);
    else if (r.args.length && !isTabRoute(r.args)) go(r.pane);
    else go('today');
  }
  // '#/<pane>/t/<tab>' is the pane's list on one of its tabs, not a reader: the phone keeps the section switcher and Back
  // leaves the pane. Memories keeps its tab in the address this way, so a reload or a new browser lands on the same tab.
  function isTabRoute(args) { return args.length === 2 && args[0] === 't'; }
  // On the closed Duo every vertical pixel counts: the top bar slides away while you scroll
  // down and comes back the moment you scroll up.
  var lastY = 0;
  function onScroll() {
    var y = Math.max(0, window.scrollY || 0);
    var bar = $('topbar');
    bar.classList.toggle('scrolled', y > 8);
    if (y < 60 || y < lastY - 4) bar.classList.remove('tucked');
    else if (y > lastY + 4 && isPhone()) bar.classList.add('tucked');
    lastY = y;
  }
  function openMenu() { $('section-menu').classList.remove('hidden'); var cur = document.querySelector('#section-menu [aria-current="page"]') || document.querySelector('#section-menu [data-goto]'); if (cur) cur.focus(); }
  function closeMenu() { $('section-menu').classList.add('hidden'); }

  // ── auth ────────────────────────────────────────────────
  function showAuth(message) {
    readerImagesStop($('session-turns')); readerImagesStop($('ta-last'));
    if (typeof liveHide === 'function') { liveHide(); liveStopWatch(); LIVE.mode = 'idle'; }
    var alreadyOpen = !$('auth-gate').classList.contains('hidden');
    if (typeof CONN === 'object' && !$('app-shell').classList.contains('hidden')) CONN.lapsed = true;
    if (typeof authOffline === 'function') authOffline(false);
    $('app-shell').classList.add('hidden');
    $('auth-gate').classList.remove('hidden');
    // A later 401 from a pane still polling (W.api passes no message) must not blank what the gate already says:
    // the reason it opened, or "That code did not match" while the person retypes.
    if (!message && alreadyOpen) return;
    setStatus($('auth-error'), message || '', true);
    $('auth-error').classList.toggle('hidden', !message);
  }
  function signedInOnce() { var shell = typeof $ === 'function' ? $('app-shell') : null; return !!(shell && !shell.classList.contains('hidden')) || CONN.lapsed; }
  function showShell(info) {
    if (typeof signinRemember === 'function') signinRemember(info);
    if (typeof authOffline === 'function') authOffline(false);
    $('auth-gate').classList.add('hidden');
    $('app-shell').classList.remove('hidden');
    state.serverName = (info && info.serverName) || 'Your Mac';
    $('host-name').textContent = state.serverName.replace(/-/g, ' ');
    loadTailnetUrl();
    runHooks(shellHooks, info);
    if (typeof connPaint === 'function') connPaint();
    route();
    if (typeof liveStart === 'function') liveStart();   // 7.0.1: the one live stream for this page (a no-op if it is already open)
    // Reloaded with Today's overlay open: its history entry is still current. The overlay opens the same thing again
    // (panes/today-actions.js restore), so Back closes it; if it cannot load, the entry is unmarked.
    var held = history.state;
    if (held && held.cosTodayOverlay) {
      ensurePane('todayActions', 4000).then(function (m) { if (m && m.restore) m.restore(held); },
        function () { try { history.replaceState(null, ''); } catch (_e) {} });
    }
    setTimeout(prefetchPanes, 1500);
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-lazy-retry]');
    if (!b) return;
    var el = $('pane-' + b.getAttribute('data-lazy-retry'));
    if (el) el.querySelectorAll('.lazy-wait').forEach(function (n) { n.remove(); });
    route(true);
  });

  // ── one session list for every pane ────────────────────
  // /api/agent-sessions walks every session folder and runs a 2-3 s lock probe on the Mac (measured
  // 11/06 in the browser: 5.1 s on Sessions, 2.1 s on Work). Today, Sessions, Work and the section
  // stories all asked for it separately. Now there is one copy: a request younger than maxAgeMs is
  // answered from it, a request already on the wire is shared, and panes can paint the last copy at
  // once while a fresh one loads (sessionListCached).
  var SL = { data: null, at: 0, inflight: null, waiting: null, failed: false };
  function sessionList(maxAgeMs) {
    if (SL.data && Date.now() - SL.at < (maxAgeMs || 0)) return Promise.resolve(SL.data);
    if (SL.inflight) return SL.inflight;
    SL.inflight = api('/api/agent-sessions?limit=80&sort=updated').then(function (d) {
      // 7.0.5: a sessions read (Sessions pane or Today) that follows a failed one is a reconnect: Today's next summary
      // ask says so (requestBrief), once.
      if (SL.failed) { SL.failed = false; if (typeof BRIEF === 'object' && BRIEF) BRIEF.reconnect = true; }
      SL.data = d; SL.at = Date.now(); SL.inflight = null;
      // 7.0.1: a fresh list is corrected by the live model at once, so it never paints a state the stream already moved.
      // Only while a stream is open and live (review W1): reconnecting, busy or hidden, the list is the newest truth.
      if (typeof liveCanOverlay === 'function' && d && Array.isArray(d.sessions)) {
        if (liveCanOverlay()) liveOverlay(d.sessions, { placeholders: true, unknown: true });
        else if (liveOn()) LIVE.freshAt = SL.at;
      }
      noteWaiting(d);
      return d;
    }, function (err) { SL.inflight = null; SL.failed = true; throw err; });
    return SL.inflight;
  }
  function sessionListCached() { return SL.data ? { data: SL.data, at: SL.at } : null; }
  // 6.99.27 (Miles 11/07 09:29, "a big delay to see the questions"): a session that has just gone to waiting may have
  // parked a question for this page. The question poll (panes/questions.js) reads at once rather than at its next turn.
  function questionsNudge() {
    var q = window.COSWeb && window.COSWeb.sessionQuestions;
    if (q && typeof q.nudge === 'function') { try { q.nudge(); } catch (_e) {} }
  }
  function noteWaiting(d) {
    var now = {}, fresh = false;
    ((d && d.sessions) || []).forEach(function (s) {
      if (!s || sxState(s) !== 'waiting') return;
      var k = splitSessionId(s.provider, s.session_id || s.id), key = k.provider + '|' + String(k.id).toLowerCase();
      now[key] = 1;
      if (!SL.waiting || !SL.waiting[key]) fresh = true;
    });
    SL.waiting = now;
    if (fresh) questionsNudge();
  }

  // ── live state (7.0.1) ──────────────────────────────────
  // Miles 11/07: the pet, the session rows, Today's counts and the running clocks showed the last fetch, not now. One
  // EventSource('/api/events') per page (docs/live-events-contract.md) tells the page when the server's own session
  // state moves: ids, states, counts and times only. The list (/api/agent-sessions) still carries every word; the
  // stream corrects its rows in place and asks for a fresh list when a session appears, leaves or replies.
  //   mode  'idle'         not started (signed out)
  //         'connecting'   a stream is opening; nothing painted differently yet
  //         'live'         a frame arrived inside the last 30 s: counts are live
  //         'reconnecting' the stream dropped or went quiet: "Reconnecting", the list read every 5 s until it is back
  //         'busy'         the server has no room for another stream (503): retried in 30 s, no fast polling
  //         'absent'       no /api/events (an older server, or COS_WEB_LIVE_EVENTS=0): exactly what 7.0.0 did
  // A hidden page holds no stream and runs no timer; coming back re-reads the list at once and resumes from the last
  // id (`?after=<epoch>.<seq>`, the contract's manual resume, since new EventSource cannot set Last-Event-ID).
  var LIVE_SILENT_MS = 30000, LIVE_POLL_MS = 5000, LIVE_WATCH_MS = 5000, LIVE_RETRY_MS = 3000, LIVE_RETRY_MAX_MS = 30000;
  var LIVE_BUSY_MS = 30000, LIVE_ABSENT_RECHECK_MS = 10 * 60000, LIVE_LIST_DEBOUNCE_MS = 1000, LIVE_STALE_MS = 30000, LIVE_REPLY_LIST_GAP_MS = 12000;
  var LIVE = {
    mode: 'idle', es: null, lastId: '', epoch: null, seq: -1, frameAt: 0, skew: 0, gotFrame: false,
    sessions: {},        // key (provider:sessionid, lowercase) -> LiveSession
    questions: null, queue: null, degraded: {},
    freshAt: 0,          // when the counts on screen were last confirmed: a frame on a live stream, or a list read
    retryMs: LIVE_RETRY_MS, retry: null, poll: null, watch: null, listTimer: null, paintTimer: null,
    absentAt: 0, hooks: [], gen: 0, pendingRows: [], pendingStructural: false, listAt: 0, listDue: 0, noteSaid: null
  };
  function liveOnMode(m) { return m === 'live' || m === 'reconnecting' || m === 'busy'; }
  function liveOn() { return liveOnMode(LIVE.mode); }
  /** The live model corrects list rows only while a stream is open and live. Reconnecting, busy or hidden, the list
   *  read is newer than the model (review W1). The model is kept only as the base a resume applies to. */
  function liveCanOverlay() { return LIVE.mode === 'live' && !!LIVE.es && LIVE.gotFrame; }
  function liveKey(provider, id) { return String(provider || 'claude').toLowerCase() + ':' + String(id || '').toLowerCase(); }
  function liveRowKey(s) { var k = splitSessionId(s.provider, s.session_id || s.id); return liveKey(k.provider, k.id); }
  // The contract's join (review B1): the full id, lowercase. The 8-character prefix joins only when one side is
  // exactly 8 characters (the list may carry a Claude tab under the registry's short id until it finds the
  // transcript) and only one candidate matches, the rule countFor uses on the server. Codex ids are UUIDv7: their
  // first 8 characters are a timestamp and stay the same for about 65 s, so a prefix alone joins parallel sessions.
  function liveSame(a, b) {
    if (a === b) return true;
    var ia = a.slice(a.indexOf(':') + 1), ib = b.slice(b.indexOf(':') + 1);
    if (a.slice(0, a.length - ia.length) !== b.slice(0, b.length - ib.length)) return false;
    // One side must BE the other's first 8 characters, so it is exactly 8 long: two full ids never join here.
    return ia.length === 8 ? ib.slice(0, 8) === ia : ia.slice(0, 8) === ib;
  }
  /** The one key in `keys` this key joins, or '' (none, or more than one by prefix). */
  function liveMatch(key, keys) {
    if (keys.indexOf(key) >= 0) return key;
    var hits = keys.filter(function (k) { return liveSame(key, k); });
    return hits.length === 1 ? hits[0] : '';
  }
  function liveIso(ms) { return typeof ms === 'number' && isFinite(ms) ? new Date(ms).toISOString() : null; }
  /** The list arrays on this page (usually one array, shared): every row a live frame must correct. */
  function liveLists() {
    var out = [];
    [SL.data && SL.data.sessions, state.sessions, typeof SX !== 'undefined' && SX ? SX.rows : null].forEach(function (a) { if (Array.isArray(a) && out.indexOf(a) < 0) out.push(a); });
    return out;
  }
  /** Write one LiveSession onto a list row, in the list's own fields (sxState, running_active, running). */
  // Claude: the registry and the hooks know whether the tab is open, so the stream decides open or closed too. Codex
  // and Cursor (review W2): the stream's "open" is only a 30-minute hook window, while the list reads the process
  // itself, so the list decides open or closed and alive; the stream moves working, waiting or idle and the times.
  function liveOwnsOpen(provider) { return String(provider || 'claude').toLowerCase() === 'claude'; }
  function liveWrite(row, ls) {
    var st = ls.state;
    row._live = true;
    row._liveTurnAt = (st === 'working' || st === 'waiting') && typeof ls.turnStartedAt === 'number' ? ls.turnStartedAt : null;
    row.state_source = ls.source === 'registry' ? 'registry' : 'hook';
    row.running_active = st === 'working';
    if (liveOwnsOpen(ls.provider)) {
      row.running = st !== 'ended';
      row.alive = st !== 'ended';
      row.agent_state = st === 'working' ? 'running' : st === 'waiting' ? 'waiting' : st === 'ended' ? 'ended' : ls.failed ? 'failed' : 'idle';
    } else if (st === 'working' || st === 'waiting') {
      row.agent_state = st === 'working' ? 'running' : 'waiting';
    } else if (row.agent_state === 'running' || row.agent_state === 'waiting' || row.agent_state === 'idle' || row.agent_state === 'failed' || !row.agent_state) {
      row.agent_state = row.running === false ? 'ended' : ls.failed && st !== 'ended' ? 'failed' : 'idle';
    }
    if (row._liveTurnAt != null) row.state_since = liveIso(row._liveTurnAt);
    else if (typeof ls.updatedAt === 'number' && row._liveState !== st) row.state_since = liveIso(ls.updatedAt);
    if (typeof ls.updatedAt === 'number') row.last_activity_at = liveIso(ls.updatedAt);
    if (typeof ls.queued === 'number') row.queued_turns = ls.queued;
    row._liveState = st;
  }
  /** A session the stream says left the live model: no longer working or open (it may stay in the list as recent). */
  function liveForget(row) {
    row._live = false; row._liveTurnAt = null; row._liveState = '';
    row.running_active = false;
    if (!liveOwnsOpen(splitSessionId(row.provider, row.session_id || row.id).provider)) {
      // Codex and Cursor: still open or closed as the list says; only no longer working or waiting.
      if (row.agent_state === 'running' || row.agent_state === 'waiting') row.agent_state = row.running === false ? 'ended' : 'idle';
      return;
    }
    row.running = false;
    if (row.agent_state === 'running' || row.agent_state === 'waiting' || row.agent_state === 'idle') row.agent_state = 'ended';
  }
  /** Overlay the live model on the list rows. Returns what moved: { changed: [rows], added: n, unknown: n }. */
  function liveOverlay(rows, opts) {
    var o = opts || {}, out = { changed: [], added: 0, unknown: [] }, byJoin = {};
    Object.keys(LIVE.sessions).forEach(function (k) { var ls = LIVE.sessions[k]; byJoin[liveKey(ls.provider, ls.sessionId)] = ls; });
    var keys = Object.keys(byJoin), seen = {};
    (rows || []).forEach(function (row) {
      if (!row) return;
      var j = liveMatch(liveRowKey(row), keys), ls = j ? byJoin[j] : null;
      if (ls) { seen[j] = 1; var before = row._liveState + '|' + row._liveTurnAt + '|' + row.queued_turns; liveWrite(row, ls); if (before !== row._liveState + '|' + row._liveTurnAt + '|' + row.queued_turns) out.changed.push(row); }
      // A row this page corrected before, now missing from a whole snapshot: it left. Never a row the stream never
      // spoke for (a Codex or Cursor session whose hooks never reach the server stays as the list says), and never
      // while the server says it could not read its registry (degraded: absence is not "nothing running").
      else if (o.whole && row._live && !LIVE.degraded.registry) { liveForget(row); out.changed.push(row); }
    });
    // A session the list has not caught up with yet: a placeholder row while it works or waits, so the pet and the
    // Running count move now, and a fresh list (debounced) brings its title.
    if (o.placeholders || o.unknown) {
      Object.keys(byJoin).forEach(function (j) {
        if (seen[j]) return;
        var ls = byJoin[j];
        out.unknown.push(j);
        if (!o.placeholders || (ls.state !== 'working' && ls.state !== 'waiting')) return;
        var row = { provider: ls.provider, session_id: ls.sessionId, id: ls.sessionId, title: 'New ' + providerLabel(ls.provider) + ' session', _placeholder: true, running: true, alive: true };
        liveWrite(row, ls);
        rows.unshift(row); out.added++; out.changed.push(row);
      });
    }
    return out;
  }
  /** Apply the live model to every list on the page, then repaint what shows. */
  function liveApply(whole) {
    if (!liveCanOverlay()) return { changed: 0, added: 0, unknown: 0 };
    var lists = liveLists(), changed = [], added = 0, unknown = [];
    lists.forEach(function (rows, i) {
      var r = liveOverlay(rows, { whole: whole, placeholders: i === 0, unknown: i === 0 });
      changed = changed.concat(r.changed); added += r.added; if (i === 0) unknown = r.unknown;
    });
    // A session the list has not shown yet: the snapshot and each new session already ask for one fresh list
    // (liveListSoon in liveFrame), so nothing more here.
    if (changed.length || added) livePaint(changed, added > 0);
    return { changed: changed.length, added: added, unknown: unknown.length };
  }
  function liveRunHooks(ev) { LIVE.hooks.slice().forEach(function (fn) { try { fn(ev); } catch (err) { console.error(err); } }); }
  // One frame. Returns false when the stream must be reopened (a gap or a server restart).
  function liveFrame(f) {
    if (!f || typeof f !== 'object' || typeof f.kind !== 'string') return true;
    var now = Date.now(), couldOverlay = liveCanOverlay();
    LIVE.frameAt = now;
    if (typeof f.at === 'number' && isFinite(f.at)) LIVE.skew = now - f.at;
    var stateFrame = f.kind === 'snapshot' || f.kind === 'session' || f.kind === 'session.removed' || f.kind === 'questions' || f.kind === 'queue';
    if (f.kind === 'snapshot') {
      LIVE.epoch = f.epoch; LIVE.seq = typeof f.seq === 'number' ? f.seq : -1;
      LIVE.sessions = {};
      (Array.isArray(f.sessions) ? f.sessions : []).forEach(function (ls) { if (ls && ls.sessionId) LIVE.sessions[liveKey(ls.provider, ls.sessionId)] = ls; });
      LIVE.questions = f.questions || null; LIVE.queue = f.queue || null;
      LIVE.degraded = f.degraded && typeof f.degraded === 'object' ? f.degraded : {};
    } else if (typeof f.seq === 'number') {
      if (LIVE.epoch !== null && f.epoch != null && f.epoch !== LIVE.epoch) return false;   // a new server life
      if (stateFrame ? f.seq > LIVE.seq + 1 : f.seq > LIVE.seq) return false;              // missed a frame
      if (stateFrame && f.seq <= LIVE.seq) return true;                                     // already applied
    }
    if (stateFrame && typeof f.seq === 'number') { LIVE.seq = f.seq; if (f.epoch != null) LIVE.epoch = f.epoch; LIVE.lastId = LIVE.epoch + '.' + LIVE.seq; }
    if (!LIVE.gotFrame) { LIVE.gotFrame = true; LIVE.retryMs = LIVE_RETRY_MS; }
    var wasMode = LIVE.mode;
    LIVE.mode = 'live';
    if (!LIVE.degraded.registry) LIVE.freshAt = now;
    liveStopPoll();
    // The first frame on a (re)opened stream, after a list read won (Reconnecting, busy, or hidden and back): the
    // resumed model corrects the rows again, including a resume that replayed nothing.
    if (!couldOverlay && f.kind !== 'snapshot') liveApply(false);
    if (f.kind === 'snapshot') {
      liveApply(true);
      liveListSoon();
      questionsNudge();
      liveRunHooks({ kind: 'snapshot' });
    } else if (f.kind === 'session' && f.session && f.session.sessionId) {
      var k = liveKey(f.session.provider, f.session.sessionId), was = LIVE.sessions[k];
      LIVE.sessions[k] = f.session;
      var r = liveApply(false);
      // New: the words come from the list now. A reply landed (`replies` went up): the words come from the list, at
      // most one read per LIVE_REPLY_LIST_GAP_MS (ghost W7: dozens of sessions ending turns would poll the list).
      if (f.change === 'added' || !was) liveListSoon();
      else if (typeof f.session.replies === 'number' && f.session.replies > (was.replies || 0)) liveListSoon(LIVE_REPLY_LIST_GAP_MS);
      if (f.session.state === 'waiting' && (!was || was.state !== 'waiting')) questionsNudge();
      liveRunHooks({ kind: 'session', key: k, session: f.session, previous: was || null, moved: r.changed });
    } else if (f.kind === 'session.removed') {
      var j = liveKey(f.provider, f.sessionId), gone = [];
      delete LIVE.sessions[j];
      var others = Object.keys(LIVE.sessions).map(function (k) { return liveKey(LIVE.sessions[k].provider, LIVE.sessions[k].sessionId); });
      liveLists().forEach(function (rows) {
        for (var i = rows.length - 1; i >= 0; i--) {
          var row = rows[i]; if (!row) continue;
          var rk = liveRowKey(row);
          // This row is the removed session's (by the same join), and no remaining live session claims it.
          if (liveMatch(rk, others.concat([j])) !== j) continue;
          if (row._placeholder) { rows.splice(i, 1); gone.push(row); } else if (row._live) { liveForget(row); gone.push(row); }
        }
      });
      if (gone.length) livePaint(gone, true);
      liveListSoon();
      liveRunHooks({ kind: 'session.removed', key: liveKey(f.provider, f.sessionId) });
    } else if (f.kind === 'questions') {
      LIVE.questions = { total: f.total, approvals: f.approvals, bySession: f.bySession };
      questionsNudge();   // the cards come from /api/session-questions (questions.js keeps its own poll as the fallback)
      liveRunHooks({ kind: 'questions' });
    } else if (f.kind === 'queue') {
      LIVE.queue = { total: f.total, bySession: f.bySession };
      liveRunHooks({ kind: 'queue' });
    }
    if (wasMode !== 'live') livePaint([], true);
    return true;
  }
  function liveUrl() { return '/api/events' + (LIVE.lastId ? '?after=' + encodeURIComponent(LIVE.lastId) : ''); }
  function liveVisible() { return !document.hidden; }
  function liveSignedIn() { var sh = $('app-shell'); return !!(sh && !sh.classList.contains('hidden')); }
  /** Open the one stream (never a second while one is open). */
  function liveOpen() {
    clearTimeout(LIVE.retry); LIVE.retry = null;
    if (LIVE.es || !liveVisible() || !liveSignedIn()) return;
    if (typeof EventSource !== 'function') { liveSetMode('absent'); return; }
    var es, gen = ++LIVE.gen;
    try { es = new EventSource(liveUrl()); } catch (_e) { liveSetMode('absent'); return; }
    LIVE.es = es; LIVE.gotFrame = false;
    if (LIVE.mode !== 'live' && LIVE.mode !== 'reconnecting' && LIVE.mode !== 'busy') LIVE.mode = 'connecting';
    LIVE.frameAt = Date.now();
    es.onmessage = function (ev) {
      if (LIVE.es !== es || gen !== LIVE.gen) return;
      var f; try { f = JSON.parse(ev.data); } catch (_e) { return; }
      if (liveFrame(f) === false) {
        // A gap or a new server life: reopen. A gap resumes from the last applied id; a new life starts fresh.
        if (f && f.epoch != null && LIVE.epoch !== null && f.epoch !== LIVE.epoch) { LIVE.lastId = ''; LIVE.epoch = null; LIVE.seq = -1; }
        liveClose(); liveOpen();
      }
    };
    es.onerror = function () {
      if (LIVE.es !== es || gen !== LIVE.gen) return;
      if (!LIVE.gotFrame) {
        // Never got a frame: EventSource hides the status, so one GET reads it (the readers' fallback-status pattern).
        liveClose();
        liveProbe(gen);
        return;
      }
      // The stream had been live. The browser reconnects on its own with Last-Event-ID while readyState is 0; a closed
      // stream (2) is reopened here with ?after. Either way the page says so and reads the list until a frame lands.
      LIVE.gotFrame = false;
      if (es.readyState === 2) { liveClose(); liveReconnect(); }
      else liveSetMode('reconnecting');
    };
    liveStartWatch();
  }
  function liveClose() {
    if (LIVE.es) { try { LIVE.es.close(); } catch (_e) {} }
    LIVE.es = null; LIVE.gen++;
  }
  // What the route answered, read once without signing the page out: 404 (no route, or the switch off) and 401 or 403
  // mean no live stream here, so the page does exactly what 7.0.0 did. 503 is a full server. Anything else (a
  // network failure, a 200 that dropped) is a stream to reopen.
  function liveProbe(gen) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 10000) : null;
    fetch(liveUrl(), { headers: { 'X-COS-Web': '1', Accept: 'text/event-stream' }, credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        var code = res.status, type = '';
        try { type = String((res.headers && res.headers.get && res.headers.get('content-type')) || ''); } catch (_e) { type = ''; }
        if (ctrl) ctrl.abort();
        return { code: code, stream: type.indexOf('text/event-stream') === 0 };
      }, function () { return { code: 0, stream: false }; })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        if (LIVE.es || LIVE.mode === 'idle') return;
        if (r.code === 503) { liveSetMode('busy'); LIVE.retry = setTimeout(liveOpen, LIVE_BUSY_MS); return; }
        if (r.code === 0 || (r.code === 200 && r.stream)) { liveReconnect(); return; }
        // 404, 401, 403, any other status, or a 200 that is not a stream: polling as today.
        liveSetMode('absent');
      });
  }
  function liveReconnect() {
    liveSetMode('reconnecting');
    clearTimeout(LIVE.retry);
    var wait = LIVE.retryMs;
    LIVE.retryMs = Math.min(LIVE.retryMs * 2, LIVE_RETRY_MAX_MS);
    LIVE.retry = setTimeout(liveOpen, wait);
  }
  function liveSetMode(m) {
    var was = LIVE.mode;
    LIVE.mode = m;
    if (m === 'absent') {
      // Exactly 7.0.0: no stream, no extra timer, no label. Rows this page corrected keep their last values until the
      // next list read replaces them, as 7.0.0's rows did.
      liveClose(); liveStopPoll(); liveStopWatch(); clearTimeout(LIVE.retry); LIVE.retry = null;
      LIVE.absentAt = Date.now(); LIVE.sessions = {};
    }
    if (m === 'reconnecting') liveStartPoll(); else if (m !== 'live') liveStopPoll();
    if (was === 'live' && m !== 'live') liveLetGo();
    if (was !== m && (liveOnMode(was) || liveOnMode(m))) livePaint([], true);
  }
  /** Leaving live (review W1): placeholder rows go, and no row keeps a live mark the next list read would not
   *  replace. The model stays only as the base a resume applies to; nothing overlays it until a frame lands. */
  function liveLetGo() {
    liveLists().forEach(function (rows) {
      for (var i = rows.length - 1; i >= 0; i--) {
        var row = rows[i]; if (!row) continue;
        if (row._placeholder) rows.splice(i, 1); else if (row._live) { row._live = false; row._liveTurnAt = null; row._liveState = ''; }
      }
    });
  }
  // ── the fallbacks: a watchdog for a quiet stream, and the 5 s list read while reconnecting ──
  function liveStartWatch() {
    if (LIVE.watch) return;
    LIVE.watch = setInterval(function () {
      if (!liveVisible()) return;
      if ((LIVE.mode === 'live' || LIVE.mode === 'connecting' || LIVE.mode === 'reconnecting') && LIVE.es && Date.now() - LIVE.frameAt > LIVE_SILENT_MS) {
        // No frame of any kind for 30 s (the heartbeat is every 15 s): the stream is dead whatever readyState says.
        liveClose(); liveReconnect();
      }
      if (liveOn() || LIVE.mode === 'connecting') liveNoteTick();
    }, LIVE_WATCH_MS);
  }
  function liveStopWatch() { clearInterval(LIVE.watch); LIVE.watch = null; }
  function liveStartPoll() {
    if (LIVE.poll) return;
    LIVE.poll = setInterval(function () { if (liveVisible() && LIVE.mode === 'reconnecting') livePollOnce(); }, LIVE_POLL_MS);
  }
  function liveStopPoll() { clearInterval(LIVE.poll); LIVE.poll = null; }
  /** Read the list now, and swap it in on every pane that shows it. Resolves when it landed (or failed). */
  function livePollOnce() {
    var before = SL.data && SL.data.sessions;
    LIVE.listAt = Date.now();
    var keysOf = function (a) { return (a || []).map(function (s) { return s ? liveRowKey(s) : ''; }).join(','); };
    return sessionList(0).then(function (d) {
      var rows = (d && d.sessions) || [];
      var moved = keysOf(before) !== keysOf(rows);
      if (state.sessions === before || !state.sessions || !state.sessions.length) state.sessions = rows;
      if (typeof SX !== 'undefined' && SX && SX.rows === before) { SX.rows = rows; SX.loadedAt = Date.now(); }
      LIVE.freshAt = Date.now();
      if (liveOn()) livePaint(rows, moved);
      return true;
    }, function () { if (liveOn()) livePaint([], false); return false; });
  }
  /** A fresh list soon (debounced), for the words of a session that appeared, left or replied. With `gapMs` (a reply),
   *  no sooner than gapMs after the last list read, and never later than a read already due. */
  function liveListSoon(gapMs) {
    var now = Date.now(), due = now + LIVE_LIST_DEBOUNCE_MS;
    if (gapMs) {
      if (LIVE.listTimer) return;   // a read is already due; it brings this reply's words too
      due = Math.max(due, (LIVE.listAt || 0) + gapMs);
    }
    clearTimeout(LIVE.listTimer);
    LIVE.listDue = due;
    LIVE.listTimer = setTimeout(function () { LIVE.listTimer = null; if (liveVisible()) livePollOnce(); }, due - now);
  }
  // ── coming back: visible, back from the back-forward cache, back online ──
  function liveResume() {
    if (!liveSignedIn()) return;
    var wasOn = liveOn();
    if (LIVE.mode === 'absent') {
      // 7.0.0 behaviour; look again only after a long while (a server updated or switched on since). That look is one
      // stream attempt, nothing else: the panes read what 7.0.0 read.
      if (Date.now() - LIVE.absentAt < LIVE_ABSENT_RECHECK_MS) return;
      LIVE.mode = 'connecting';
    }
    if (LIVE.mode === 'idle') return;
    if (wasOn) livePollOnce();
    if (!LIVE.es) { clearTimeout(LIVE.retry); LIVE.retry = null; LIVE.retryMs = LIVE_RETRY_MS; liveOpen(); }
    liveStartWatch();
    liveTickStart();   // stops itself at once when nothing on screen ticks
    liveNoteTick();
  }
  function liveHide() {
    // A hidden page holds no stream (a locked phone drops it anyway) and runs no live timer: not the stream, the list
    // read, the retry, the watchdog or the 1 s clock (ghost note 1).
    liveClose(); liveStopPoll(); liveStopWatch(); liveTickStop(); clearTimeout(LIVE.retry); LIVE.retry = null; clearTimeout(LIVE.listTimer); LIVE.listTimer = null;
  }
  function liveStart() {
    if (LIVE.mode !== 'idle') return;
    LIVE.mode = 'connecting';
    liveOpen();
  }
  // ── honesty: how old the counts on screen are ──
  /** "As of 2 min ago" when the counts are older than 30 s and the page is not live; '' when live, or with no stream
   *  at all (7.0.0 showed none). */
  function liveAge(now) {
    if (LIVE.mode === 'idle' || LIVE.mode === 'absent' || LIVE.mode === 'connecting') return '';
    var at = Math.max(LIVE.freshAt || 0, LIVE.mode === 'live' && !LIVE.degraded.registry ? LIVE.frameAt : 0);
    if (!at) return '';
    var s = Math.max(0, ((now || Date.now()) - at) / 1000);
    if (s * 1000 < LIVE_STALE_MS) return '';
    if (s < 60) return 'As of ' + Math.floor(s) + ' s ago';
    if (s < 3600) return 'As of ' + Math.floor(s / 60) + ' min ago';
    return 'As of ' + Math.floor(s / 3600) + ' h ago';
  }
  /** The running clock: "12s", "4m 12s", "1h 5m". */
  function liveClock(sec) {
    var s = Math.max(0, Math.floor(sec));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }
  /** Seconds a working row has run: from the stream's turnStartedAt (skew from the frame's `at`), else the row's own
   *  state_since on the Mac's clock. */
  function liveElapsed(row, now) {
    var t = now || Date.now();
    if (row && typeof row._liveTurnAt === 'number') return (t - LIVE.skew - row._liveTurnAt) / 1000;
    var d = row ? toDate(row.state_since || row.last_activity_at) : null;
    return d ? (sxServerTime(t) - d.getTime()) / 1000 : 0;
  }
  /** Server ms a row's clock counts from, for the data attribute the 1 s tick reads. */
  function liveSince(row) {
    if (row && typeof row._liveTurnAt === 'number') return row._liveTurnAt;
    var d = row ? toDate(row.state_since || row.last_activity_at) : null;
    return d ? d.getTime() - SX_CLOCK.skew - LIVE.skew : null;
  }
  // ── the 1 s tick: every running clock on screen, never on a hidden page ──
  var LIVE_TICK = { timer: null };
  function liveTickStart() {
    if (LIVE_TICK.timer) return;
    LIVE_TICK.timer = setInterval(liveTickOnce, 1000);
  }
  function liveTickStop() { clearInterval(LIVE_TICK.timer); LIVE_TICK.timer = null; }
  function liveTickOnce() {
    if (document.hidden) return;   // paused while hidden; visible again paints at once (liveResume, liveNoteTick)
    var els = document.querySelectorAll('[data-live-since]'), now = Date.now();
    if (!els.length && !liveNoteBusy()) { liveTickStop(); return; }
    for (var i = 0; i < els.length; i++) {
      var since = Number(els[i].getAttribute('data-live-since'));
      if (isFinite(since)) els[i].textContent = liveClock((now - LIVE.skew - since) / 1000);
    }
    liveNoteTick();
  }
  // Repaints are batched: a burst of frames paints once.
  function livePaint(rows, structural) {
    LIVE.pendingRows = (LIVE.pendingRows || []).concat(rows || []);
    LIVE.pendingStructural = LIVE.pendingStructural || !!structural;
    if (LIVE.paintTimer) return;
    LIVE.paintTimer = setTimeout(function () {
      var r = LIVE.pendingRows || [], st = LIVE.pendingStructural;
      LIVE.paintTimer = null; LIVE.pendingRows = []; LIVE.pendingStructural = false;
      try { liveRepaint(r, st); } catch (err) { console.error(err); }
    }, 30);
  }
  // ── the session pet (Today) ─────────────────────────────
  // Same pet and the same pose rule as COS Control (PetSpritePose.resolve): waiting with nothing running
  // is "waiting", then one, two, three, four or more sessions in play are working, duel, trio, swarm, an open
  // quiet session is "patrol", none is "idle". Strips come from /api/web-pet, resized and cut for a phone.
  var PET = { manifest: null, fetchedAt: 0, pose: null, timer: null, frame: 0, token: 0 };
  // This browser's pet settings (Settings > Pet): which pet, and whether Today shows it. Per browser, like the theme.
  var PET_KEY = 'cos-web-pet';
  function petPrefs() {
    var p = readStore(PET_KEY);
    var pet = typeof p.pet === 'string' && /^(mac|(shipped|gallery):[a-z0-9][a-z0-9-]{0,80})$/.test(p.pet) ? p.pet : 'mac';
    return { pet: pet, show: p.show !== false };
  }
  function setPetPrefs(next) {
    var cur = petPrefs();
    var merged = { pet: next.pet != null ? next.pet : cur.pet, show: next.show != null ? !!next.show : cur.show };
    writeStore(PET_KEY, merged);
    // Forget the old pet's manifest and loop; Today repaints with the new choice next time it shows.
    PET.manifest = null; PET.fetchedAt = 0; PET.pose = null; PET.token++; petStop();
    var box = $('today-pet');
    if (box) { box.innerHTML = ''; box.classList.add('hidden'); }
    if (state.pane === 'today' && state.sessions) renderPet(state.sessions);
    return merged;
  }
  var PET_HEIGHT = 140;
  // 6.99.27 (Miles 11/07 09:29, "there wasn't an option for the pet to interact with the questions"): the questions
  // this page holds (panes/questions.js), the ones that can be answered here. One key per session, as Needs you keys
  // them.
  function petQuestions() {
    var q = window.COSWeb && window.COSWeb.sessionQuestions;
    var items = q && typeof q.itemsFor === 'function' ? q.itemsFor('') : [];
    return (items || []).filter(function (it) { return it && it.sessionId; });
  }
  function petQKey(it) { var k = splitSessionId(it.provider, it.sessionId); return k.provider + '|' + k.id; }
  function petPose(sessions, questions) {
    var working = 0, waiting = 0, alive = 0, asked = {};
    var qs = questions || [];
    qs.forEach(function (it) { asked[petQKey(it).toLowerCase()] = 1; });
    sessions.forEach(function (s) {
      var st = sxState(s);
      // Working is the Running card's own test (running_active), so the caption under the pet never
      // disagrees with the Running count beside it (11/06: the pet said 3 while the card said 2).
      if (s.running_active) working++;
      // A session whose question the caption already leads with is not counted again as waiting on you.
      else if (st === 'waiting' && !asked[petKey(s).toLowerCase()]) waiting++;
      if (s.running || s.running_active) alive++;
    });
    var pose;
    // COS Control's rule (PetSpritePose.resolve): attention outranks every count pose. A question waiting here is the
    // web's attention: it needs you, and this page can answer it.
    if (qs.length) pose = 'attention';
    else if (waiting > 0 && working === 0) pose = 'waiting';
    else if (working + waiting >= 4) pose = 'swarm';
    else if (working + waiting === 3) pose = 'trio';
    else if (working + waiting === 2) pose = 'duel';
    else if (working + waiting === 1) pose = 'working';
    else pose = alive > 0 ? 'patrol' : 'idle';
    // QA 6.99.27 (User 6): a permission request is an approval, counted apart from the questions.
    var approvals = qs.filter(function (it) { return it.kind === 'approval'; }).length;
    return { pose: pose, working: working, waiting: waiting, questions: qs.length - approvals, approvals: approvals };
  }
  // COS Control's fallbacks (PetSpritePose.fallbackPoses) for a pet that has no strip for the pose.
  var PET_FALLBACK = { attention: ['error', 'waiting', 'idle'], patrol: ['idle'], duel: ['swarm', 'working', 'idle'], trio: ['swarm', 'duel', 'working', 'idle'],
    swarm: ['duel', 'trio', 'working', 'idle'], working: ['idle'], waiting: ['idle'] };
  function petPoseIn(poses, want) {
    if (poses[want]) return want;
    var chain = PET_FALLBACK[want] || [];
    for (var i = 0; i < chain.length; i++) if (poses[chain[i]]) return chain[i];
    return poses.idle ? 'idle' : Object.keys(poses)[0];
  }
  // 6.99.26 (Miles 11/07, "Open what matters"): the sessions behind the pet's caption, by the same test petPose
  // counts with, so a tap opens what the caption says. In play: waiting on you, then running. Done today rides along in
  // the list, never in the count.
  function petPlay(sessions) {
    var waiting = [], running = [], done = [], today = new Date().toDateString();
    (sessions || []).forEach(function (s) {
      var st = sxState(s);
      if (s.running_active) running.push(s);
      else if (st === 'waiting') waiting.push(s);
      else if ((st === 'recent' || st === 'stale') && !sxKeepWarm(s)) {
        var d = toDate(s.last_activity_at || s.state_since);
        if (d && d.toDateString() === today) done.push(s);
      }
    });
    return { waiting: waiting, running: running, done: done };
  }
  function petKey(s) { var k = splitSessionId(s.provider, s.session_id || s.id); return k.provider + '|' + k.id; }
  // One session in play opens its own sheet (waiting: the question card or reply box; else the Running peek); several
  // open the short list; none does nothing.
  function petTap(t) {
    // A question waiting here comes first: one session's question opens its card in the overlay; questions from
    // several sessions open the list, question rows first.
    var qs = petQuestions(), qkeys = {};
    qs.forEach(function (it) { qkeys[petQKey(it)] = 1; });
    var qk = Object.keys(qkeys);
    if (qk.length === 1) return openTodayAction(t, 'wait', qk[0]);
    if (qk.length > 1) return openTodayAction(t, 'pet', '');
    var p = petPlay(state.sessions || []), n = p.waiting.length + p.running.length;
    if (!n) return;
    if (n > 1) return openTodayAction(t, 'pet', '');
    var s = p.waiting[0] || p.running[0];
    openTodayAction(t, sxState(s) === 'waiting' ? 'wait' : 'run', petKey(s));
  }
  function petButtonState(box, c, label) {
    var btn = box.querySelector('.pet-btn');
    if (!btn) return;
    var any = c.working + c.waiting + (c.questions || 0) + (c.approvals || 0) > 0;
    btn.setAttribute('aria-label', any ? label + '. Open' : label);
    btn.setAttribute('aria-disabled', any ? 'false' : 'true');
  }
  function petCaption(c) {
    var parts = [];
    // A question or an approval waiting here leads (6.99.27): "1 question for you", "1 approval for you", or
    // "1 question and 1 approval for you" (QA 6.99.27, User 6: approvals were counted as questions).
    var asks = [];
    if (c.questions) asks.push(c.questions === 1 ? '1 question' : c.questions + ' questions');
    if (c.approvals) asks.push(c.approvals === 1 ? '1 approval' : c.approvals + ' approvals');
    if (asks.length) parts.push(asks.join(' and ') + ' for you');
    if (c.working) parts.push(c.working + ' running');
    if (c.waiting) parts.push(c.waiting + ' waiting on you');
    return parts.length ? parts.join(', ') : 'Nothing running';
  }
  function petStop() { clearTimeout(PET.timer); PET.timer = null; }
  function petPaint(el, spec, frame, scale) {
    var chunk = Math.floor(frame / spec.perChunk), inChunk = frame % spec.perChunk;
    var count = Math.min(spec.perChunk, spec.frames - chunk * spec.perChunk);
    el.style.backgroundImage = 'url("' + spec.chunks[chunk] + '")';
    el.style.backgroundSize = Math.round(count * spec.frameWidth * scale) + 'px ' + PET_HEIGHT + 'px';
    el.style.backgroundPosition = '-' + Math.round(inChunk * spec.frameWidth * scale) + 'px 0';
  }
  function petLoadImages(spec) {
    return Promise.all(spec.chunks.map(function (url) {
      return new Promise(function (resolve, reject) { var im = new Image(); im.onload = function () { resolve(im); }; im.onerror = reject; im.src = url; });
    }));
  }
  // Folded (one column) the pet sits above the story. Unfolded (two columns, the same 760px line as
  // .today-cols in app.css) it moves to the top of the right-hand column, above Needs you (Miles 11/06).
  var PET_WIDE = window.matchMedia ? window.matchMedia('(min-width: 760px)') : null;
  function placePet() {
    var box = $('today-pet'), side = document.querySelector('#pane-today .today-side'), rec = $('today-rec');
    if (!box || !side || !rec) return;
    if (PET_WIDE && PET_WIDE.matches) { if (side.firstElementChild !== box) side.insertBefore(box, side.firstElementChild); }
    else if (rec.previousElementSibling !== box) rec.parentNode.insertBefore(box, rec);
  }
  if (PET_WIDE) { if (PET_WIDE.addEventListener) PET_WIDE.addEventListener('change', placePet); else if (PET_WIDE.addListener) PET_WIDE.addListener(placePet); }
  var PET_CHANGE = '<button type="button" class="pet-change" data-goto="settings/pet">Change pet</button>';
  // A still pet (a gallery pick, Cloud Puff, or a single image on the Mac): one picture for every state.
  function renderPetStill(box, m, sessions) {
    var c = petPose(sessions, petQuestions()), label = petCaption(c);
    petStop(); PET.pose = 'still:' + m.still;
    var img = box.querySelector('.pet-still');
    if (!img || img.getAttribute('src') !== m.still) {
      box.innerHTML = '<button type="button" class="pet-btn" data-today="pet"><img class="pet-still" alt="" src="' + esc(m.still) + '"><span class="pet-caption"></span></button>' + PET_CHANGE;
      img = box.querySelector('.pet-still');
      img.addEventListener('error', function () { box.classList.add('hidden'); });
      img.addEventListener('load', function () { img.classList.toggle('pixel', img.naturalHeight > 0 && img.naturalHeight < 140); });
    }
    box.querySelector('.pet-caption').textContent = label;
    petButtonState(box, c, label);
    box.classList.remove('hidden');
  }
  function renderPet(sessions) {
    var box = $('today-pet');
    if (!box) return;
    placePet();
    var prefs = petPrefs();
    if (!prefs.show) { box.classList.add('hidden'); box.innerHTML = ''; petStop(); PET.pose = null; return; }
    // The session list could not be read: the pet would say "Nothing running" about sessions nobody saw. Hide it.
    if (state.sessionsUnread) { box.classList.add('hidden'); petStop(); PET.pose = null; return; }
    var fresh = PET.manifest && PET.manifest.pet === prefs.pet && Date.now() - PET.fetchedAt < 10 * 60000;
    (fresh ? Promise.resolve(PET.manifest) : api('/api/web-pet?pet=' + encodeURIComponent(prefs.pet)).then(function (m) { PET.manifest = m; PET.fetchedAt = Date.now(); return m; }))
      .catch(function () { return PET.manifest && PET.manifest.pet === prefs.pet ? PET.manifest : null; })
      .then(function (m) {
        // A slow answer for a pet that is no longer chosen (or a pet now switched off) paints nothing.
        var now = petPrefs();
        if (!now.show || now.pet !== prefs.pet) return;
        if (!m || !m.available) { box.classList.add('hidden'); petStop(); return; }
        if (m.kind === 'still') { renderPetStill(box, m, sessions); return; }
        var c = petPose(sessions, petQuestions());
        var pose = petPoseIn(m.poses, c.pose);
        var spec = m.poses[pose];
        var label = petCaption(c);
        box.classList.remove('hidden');
        var cap = box.querySelector('.pet-caption');
        if (cap) cap.textContent = label;
        petButtonState(box, c, label);
        if (PET.pose === pose && PET.timer) return;
        var token = ++PET.token;
        petLoadImages(spec).then(function () {
          if (token !== PET.token) return;
          petStop();
          PET.pose = pose; PET.frame = 0;
          if (!box.querySelector('.pet-sprite')) {
            box.innerHTML = '<button type="button" class="pet-btn" data-today="pet"><span class="pet-sprite" aria-hidden="true"></span><span class="pet-caption"></span></button>' + PET_CHANGE;
          }
          box.querySelector('.pet-caption').textContent = label;
          petButtonState(box, c, label);
          var el = box.querySelector('.pet-sprite'), scale = PET_HEIGHT / spec.height;
          el.style.width = Math.round(spec.frameWidth * scale) + 'px';
          petPaint(el, spec, 0, scale);
          var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          if (still || spec.frames < 2) return;
          var step = function () {
            // Runs only while Today is on screen: leaving the pane or hiding the page stops the loop.
            if (token !== PET.token || document.hidden || state.pane !== 'today') { PET.timer = null; return; }
            PET.frame = (PET.frame + 1) % spec.frames;
            petPaint(el, spec, PET.frame, scale);
            PET.timer = setTimeout(step, Math.max(20, spec.interval * 1000));
          };
          PET.timer = setTimeout(step, Math.max(20, spec.interval * 1000));
        }, function () {
          if (token === PET.token && !box.querySelector('.pet-sprite')) box.classList.add('hidden');
        });
      });
  }

  // ── Today ───────────────────────────────────────────────
  // force (7.0.1, Today's Refresh): every source read again now, none from a cache. Resolves when the sessions, Work,
  // welcome and recording reads have painted.
  function loadToday(force) {
    var now = new Date();
    $('today-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) + ', ' + clock(now);
    var gen = ++TODAY.gen;
    // Voices and memories answer on their own time (the memories status runs a CLI on the Mac): Today paints what it
    // has and says it is still reading, then repaints as each one lands.
    var extras = [];
    if (force === true || Date.now() - TODAY.extraAt > 60000 || TODAY.voices.state === 'failed' || TODAY.memories.state === 'failed') {
      TODAY.extraAt = Date.now();
      TODAY.voices = { state: 'pending', groups: [] }; TODAY.memories = { state: 'pending', n: 0 };
      extras.push(api('/api/voice/held-groups').then(function (d) {
        TODAY.voices = { state: 'answered', groups: (d && Array.isArray(d.groups)) ? d.groups : [] };
      }, function () { TODAY.voices = { state: 'failed', groups: [] }; }).then(function () { paintNeeds(); }));
      extras.push(api('/api/web-bridge/memories', { method: 'POST', body: { id: 'today-status', op: 'status', args: {} } }).then(function (d) {
        var n = d && d.details ? d.details.learningToReview : null;
        TODAY.memories = typeof n === 'number' ? { state: 'answered', n: Math.max(0, n) } : { state: 'failed', n: 0 };
      }, function () { TODAY.memories = { state: 'failed', n: 0 }; }).then(function () { paintNeeds(); }));
    }
    var main = Promise.all([
      sessionList(force === true ? 0 : 15000).catch(function () { return null; }),
      api('/api/work-board/your-move').catch(function () { return null; }),
      api('/api/welcome-context').catch(function () { return null; }),
      api('/api/meetings/live-chunks').catch(function () { return null; }),
      loadRunJobs()
    ]).then(function (res) {
      if (gen !== TODAY.gen) return;
      var sessions = (res[0] && res[0].sessions) || [];
      state.sessions = sessions;
      var needs = (res[1] && res[1].items) || [];
      var welcome = res[2] || {};
      var live = (res[3] && res[3].sessions) || [];
      var working = sessions.filter(function (s) { return s.running_active; });
      var open = sessions.filter(function (s) { return s.running && !s.running_active; });
      var recent = live.filter(function (s) { return Date.now() - (s.mtimeMs || 0) < LIVE_FRESH_MS; });
      var offline = !res[0] && !res[1];
      // 7.0.5: the sessions or Today read recovered from a failed one, so the next summary ask says "reconnect" (the
      // server lets that one start skip its 10-minute spacing, at most once per 10 minutes).
      if ((TODAY.sessionsState === 'failed' || TODAY.offline === true) && res[0] && !offline) BRIEF.reconnect = true;
      TODAY.needs = needs; TODAY.working = working; TODAY.open = open; TODAY.welcome = welcome; TODAY.offline = offline; TODAY.at = Date.now();
      // your-move answers {available:false} when the board cannot be read: that is a failed read, not "nothing".
      TODAY.sessionsState = res[0] ? 'answered' : 'failed';
      state.sessionsUnread = !res[0];   // the pet reads this (renderPet)
      TODAY.workState = res[1] && res[1].available !== false ? 'answered' : 'failed';
      TODAY.recording = false;

      renderRunning(working, open);
      runJobsSchedule();
      if (!offline) renderPet(sessions);
      paintNeeds();
      renderWeather(welcome);
      renderNext(welcome);
      // PH plan P1: the rest of today under Next up. Kept out of renderNext so that stays a pure render.
      var nx = welcome && welcome.nextEvent;
      loadCalendarLater(nx, nx && toDate(nx.time));
      loadTodayIntake();
      setBadge('sessions', working.length > 0);
      return liveSession(recent).then(function (rec) {
        if (gen !== TODAY.gen) return;
        renderRecording(rec);
        setBadge('meetings', !!rec);
        if (rec) { TODAY.recording = true; paintNeeds(); }
      });
    });
    // A forced read waits for the voices and memories too, so the summary it asks for sees every source.
    return force === true ? Promise.all([main].concat(extras)) : main;
  }
  // A capture counts as live only while it is still being written: an abandoned
  // active-sessions file must never read as "Recording now".
  var LIVE_FRESH_MS = 5 * 60000;
  var SOURCES = { mac: 'Mac recording', phone: 'iPhone recording', meeting: 'Glasses recording' };
  function liveSession(list) {
    if (!list || !list.length) return Promise.resolve(null);
    var top = list[0];
    return api('/api/meetings/live-chunks?sessionId=' + encodeURIComponent(top.sessionId) + '&since=1000000').then(function (r) {
      var read = r && r.read;
      if (!read || read.ended || Date.now() - Number(read.lastActivityAt || 0) > LIVE_FRESH_MS) return null;
      var prefix = String(top.sessionId).split('_')[0];
      return { sessionId: top.sessionId, source: SOURCES[prefix] || 'Recording', startTime: read.startTime, lines: (read.maxIndex || 0) + 1 };
    }).catch(function () { return null; });
  }
  function renderRecording(rec) {
    var box = $('today-rec');
    if (!rec) { box.innerHTML = ''; return; }
    box.innerHTML = '<button type="button" class="rec-banner" data-goto="meetings"><span class="rec-dot"></span>' +
      '<span class="rec-copy"><strong>Recording now</strong><span>' + esc(rec.source + (rec.startTime ? ', ' + span(rec.startTime) + ' so far' : '') + (rec.source === SOURCES.mac ? '. Stop it in COS Control on your Mac.' : '')) + '</span></span>' +
      '<span class="btn small">Live view</span></button>';
  }
  // ── The Today summary (6.99.26 candidate) ───────────────
  // "The orchestrator's eyes" (Miles, 11/07): two or three sentences on what the sessions add up to, written by Sonnet on
  // the server (lib/today-brief.ts). Today sends what it already read: session titles, states, how long, each session's
  // latest line and what needs you. The server decides whether a new one is written (off unless switched on, only when
  // the inputs changed, 10 minutes apart, the Summaries per day cap, a breaker). Today never waits for it: the counts line paints at once
  // and the summary replaces it when one arrives. Never shown over a session list that was not read.
  var BRIEF = { view: null, inflight: false, sentKey: '', sentAt: 0, reconnect: false };
  // 6.99.26 QA: the same rows are asked about again only after five minutes (a Today that sits open still learns what
  // the server reads itself: sub-agents and Work cards); changed rows are asked about at once, one ask at a time.
  var BRIEF_RESEND_MS = 5 * 60000, BRIEF_OFF_RECHECK_MS = 5 * 60000, BRIEF_TICK_MS = 60000, BRIEF_LIVE_GAP_MS = 60000;
  function briefMinutes(v) { var d = toDate(v); return d ? Math.max(0, Math.round((Date.now() - d.getTime()) / 60000)) : 0; }
  function briefInputs(m) {
    var sessions = [];
    (state.sessions || []).forEach(function (s) {
      if (sxKeepWarm(s)) return;
      var kind = sxState(s) === 'waiting' ? 'waiting' : s.running_active ? 'working' : s.running ? 'open' : '';
      if (!kind) return;   // only what Today counts: waiting, working and open
      var k = splitSessionId(s.provider, s.session_id || s.id);
      sessions.push({ title: sessionTitle(s), provider: k.provider, state: kind,
        minutes: briefMinutes(kind === 'open' ? (s.last_activity_at || s.state_since) : (s.state_since || s.last_activity_at)),
        line: String(s.discussion_summary || '').slice(0, 400), waiting: kind === 'waiting' ? askedWhy(s) : '',
        // Only so the server can read this session's sub-agents (names, tasks, status); it never reaches the model.
        key: k.provider + '|' + k.id,
        agents: s.subagent_activity ? { active: s.subagent_activity.active, completed: s.subagent_activity.completed, total: s.subagent_activity.total } : undefined });
    });
    var needs = m.rows.filter(function (r) { return r.kind !== 'session'; }).slice(0, 12).map(function (r) {
      if (r.kind === 'work') return { title: r.item.sessionTitle || r.item.title || 'Handoff', why: needWhy(r.item) };
      return { title: r.title, why: r.why || '' };
    });
    // Today folds all but waiting sessions under "can wait until tomorrow" in quiet hours; the summary says the same.
    var later = m.later.filter(function (r) { return r.kind !== 'session'; }).length;
    return { sessions: sessions.slice(0, 40), needs: needs, later: Math.min(later, needs.length), sessionsRead: TODAY.sessionsState === 'answered', needsComplete: !!m.settled,
      unread: m.failed.slice(), recording: !!TODAY.recording };
  }
  // Asked once every source answered or failed: at once when what Today read changed, else at most every five minutes
  // (the server gates the spend; this only saves requests). When the switch is off, every five minutes.
  function requestBrief(m) {
    if (BRIEF.inflight || state.pane !== 'today') return;   // renderStory already answered an offline Today
    if (Object.keys(m.states).some(function (k) { return m.states[k] === 'pending'; })) return;
    var body = briefInputs(m);
    var key = JSON.stringify([body.sessions.map(function (s) { return [s.title, s.state, s.line, s.waiting, s.agents]; }), body.needs, body.later, body.sessionsRead, body.needsComplete, body.unread, body.recording]);
    var since = Date.now() - BRIEF.sentAt;
    // 7.0.5: right after a read recovered, ask at once (the server still holds its own gates).
    var reconnect = BRIEF.reconnect && !(BRIEF.view && BRIEF.view.state === 'off');
    if (!reconnect) {
      if (BRIEF.view && BRIEF.view.state === 'off' ? since < BRIEF_OFF_RECHECK_MS : key === BRIEF.sentKey && since < BRIEF_RESEND_MS) return;
      // 7.0.1: with the live stream Today repaints on every session move, so a changed Today asks at most once a minute
      // (Refresh asks at once). Without it, 7.0.0's rule above is the only one.
      if (typeof liveOn === 'function' && liveOn() && since < BRIEF_LIVE_GAP_MS) return;
    }
    BRIEF.reconnect = false;
    if (reconnect) body.reason = 'reconnect';
    BRIEF.inflight = true; BRIEF.sentKey = key; BRIEF.sentAt = Date.now();
    var ask = function (b) { return api('/api/today/brief', { method: 'POST', body: b, timeoutMs: 45000 }); };
    ask(body).catch(function (err) {
      // A server before 7.0.5 refuses the unknown `reason` (400 invalid_today_brief): ask it the ordinary way.
      if (!(reconnect && err && err.status === 400 && err.code === 'invalid_today_brief')) throw err;
      var again = {};
      Object.keys(body).forEach(function (k) { if (k !== 'reason') again[k] = body[k]; });
      return ask(again);
    }).then(function (v) {
      BRIEF.view = v && typeof v === 'object' ? v : null;
    }, function () { /* keep what was shown: the counts line or the last summary */ }).then(function () {
      BRIEF.inflight = false;
      if (TODAY.model && state.pane === 'today') renderStory(TODAY.model);
    });
  }
  /** The summary to show, or null: only with text, only over a session list that was read. */
  function briefShown() {
    var v = BRIEF.view;
    if (!v || !v.text || (v.state !== 'fresh' && v.state !== 'stale') || TODAY.sessionsState !== 'answered') return null;
    return v;
  }
  // Forget the summary (Settings turned it on or off): the next Today paint asks at once.
  function resetBrief() { BRIEF.view = null; BRIEF.sentKey = ''; BRIEF.sentAt = 0; }
  // Every minute while Today is on screen: "Updated N min ago" moves on, and an unchanged Today asks again once its
  // five minutes are up (requestBrief's own throttle). Hidden or another pane: nothing.
  setInterval(function () {
    if (document.hidden || state.pane !== 'today' || !TODAY.model || TODAY.offline) return;
    requestBrief(TODAY.model);
    var v = briefShown(), when = document.querySelector('#today-story .story-when');
    if (v && when) when.textContent = briefWhen(v, TODAY.model);
  }, BRIEF_TICK_MS);
  function briefWhen(v, m) {
    var mins = briefMinutes(v.at);
    var out = 'Updated ' + (mins < 1 ? 'just now' : span(v.at) + ' ago');
    // Stale says so once it is five minutes old: a summary from a minute ago over one new reply is still the picture.
    if (v.state === 'stale' && mins >= 5) out += '. Things have moved since';
    if (m.failed.length) out += '. Couldn’t read ' + listWords(m.failed) + ', so this may not be everything';
    return out + '.';
  }

  // The headline: COS Control's brief (Models.swift TodayHome.brief) over the same rows Needs you lists.
  function renderStory(m) {
    var el = $('today-story');
    el.className = 'story';
    // Today round 2: "Ask about this" shows under a model summary only (paintTodayAsk, below the Today block). The test
    // harnesses that run this block alone do not have it, so it is looked up, never assumed.
    var askBox = typeof paintTodayAsk === 'function' ? paintTodayAsk : function () {};
    if (TODAY.offline) { askBox(null); el.textContent = 'COS on ' + state.serverName + ' is not answering right now. Today fills in when it does.'; return; }
    // The model's summary when there is one (it never blocks: the counts line below shows until it lands). The test
    // harnesses that run this block alone have no requestBrief, so it is looked up, never assumed.
    askBox(null);
    if (typeof requestBrief === 'function') {
      requestBrief(m);
      var brief = briefShown();
      askBox(brief);
      if (brief) { el.innerHTML = esc(brief.text) + '<span class="story-when">' + esc(briefWhen(brief, m)) + '</span>'; return; }
    }
    var first = '';
    if (m.sessionsWaiting > 0) first = countWord(m.sessionsWaiting) + ' ' + plural(m.sessionsWaiting, 'session is', 'sessions are') + ' waiting on you';
    else if (m.now.length > 0) first = countWord(m.now.length) + ' ' + plural(m.now.length, 'thing needs', 'things need') + ' you' + (m.settled ? '' : ' so far');
    else if (m.later.length > 0) first = countWord(m.later.length) + ' ' + plural(m.later.length, 'thing', 'things') + ' can wait until tomorrow' + (m.settled ? '' : ' so far');
    else if (m.settled) first = 'Nothing is waiting on you';
    var next = TODAY.welcome && TODAY.welcome.nextEvent, nd = next && toDate(next.time);
    if (nd && next.title && (nd.getTime() - Date.now()) < 18 * 3600000 && nd.getTime() > Date.now() - 600000) {
      var dw = dayWord(nd), words = next.title + ' is at ' + clock(nd) + (dw === 'today' ? '' : ' ' + dw);
      first = first ? first + ', and ' + words : words.charAt(0).toUpperCase() + words.slice(1);
    }
    var working = TODAY.working.length, open = TODAY.open.length, second;
    var unread = TODAY.sessionsState === 'failed';
    // The sessions sentence speaks only about a list that was read (W3-r2: "No agents are running" while two worked).
    if (unread) second = 'Couldn\u2019t read your sessions';
    else if (working > 0) second = countWord(working) + ' ' + plural(working, 'agent is', 'agents are') + ' working' + (open > 0 ? ', with ' + countWord(open, true) + ' more ' + plural(open, 'session', 'sessions') + ' open' : '');
    else if (open > 0) second = countWord(open) + ' ' + plural(open, 'session is', 'sessions are') + ' open and quiet';
    else second = 'No agents are running';
    if (TODAY.recording) second += (unread || working > 0 || open > 0 ? ', and ' : '. ') + 'COS is recording a meeting';
    var out = (first ? first + '. ' : '') + second + '.';
    var others = m.failed.filter(function (n) { return n !== 'sessions'; });
    if (!m.settled && !m.now.length && !m.later.length) out += (unread ? others : m.failed).length ? ' Couldn\u2019t read ' + listWords(unread ? others : m.failed) + ', so this may not be everything.' : unread ? ' This may not be everything that needs you.' : ' Still reading what needs you.';
    else if (unread) out += ' This may not be everything that needs you.';
    el.textContent = out;
  }
  function listWords(names) { return names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]; }
  function runRow(s, activeNow) {
    var key = splitSessionId(s.provider, s.session_id);
    // 7.0.1: with the live stream, a working row's clock ticks every second from the turn's start (liveTickOnce).
    // Without it (an older server, the switch off), the minute line 7.0.0 showed.
    var since = activeNow && typeof liveOn === 'function' && liveOn() ? liveSince(s) : null;
    var meta = activeNow
      ? 'Working for ' + (since != null ? '\u0000' : span(s.state_since || s.last_activity_at))
      : 'Open, quiet for ' + span(s.last_activity_at || s.state_since);
    if (s.project && s.project !== usualProject()) meta += ', in ' + String(s.project).replace(/^-Users-[^-]+-/, '');
    var metaHtml = since != null
      ? esc(meta).replace('\u0000', '<span class="run-clock" data-live-since="' + esc(String(since)) + '">' + esc(liveClock(liveElapsed(s))) + '</span>')
      : esc(meta);
    // A tap opens the peek on Today (panes/today-actions.js); it falls back to the reader if the peek cannot load.
    return '<button type="button" class="run-row" data-today="run" data-key="' + esc(key.provider) + '|' + esc(key.id) + '">' +
      '<span class="run-who">' + badge(key.provider) + (activeNow ? '<span class="pulse" aria-label="working"></span>' : '') + '</span>' +
      '<span class="run-title">' + esc(sessionTitle(s)) + '</span>' +
      '<span class="run-meta">' + metaHtml + '</span></button>';
  }
  function renderRunning(working, open) {
    // W1: COS's own jobs (questions it is answering, routines, Work runs) count as running too, as on the Mac.
    var jobs = typeof runJobsHtml === 'function' ? runJobsHtml() : { html: '', n: 0 };
    $('run-count').textContent = working.length + jobs.n ? String(working.length + jobs.n) : '';
    var list = $('run-list');
    // Never "Nothing running" about a list that was not read.
    if (TODAY.sessionsState === 'failed') { list.innerHTML = jobs.html + '<button type="button" class="run-more run-failed" data-today-needs="retry">Couldn\u2019t read sessions. Try again</button>'; return; }
    var shown = working.slice(0, 3);
    var html = jobs.html + shown.map(function (s) { return runRow(s, true); }).join('');
    if (!shown.length) {
      html = jobs.html + open.slice(0, 2).map(function (s) { return runRow(s, false); }).join('');
      if (!html) html = '<div class="run-empty">Nothing running. Start a session on your Mac and it shows here.</div>';
    }
    var more = (working.length - shown.length) + (shown.length ? open.length : Math.max(0, open.length - 2));
    if (more > 0) html += '<button type="button" class="run-more" data-goto="sessions">' + countWord(more) + ' more open. All sessions</button>';
    list.innerHTML = html;
    if (typeof liveTickStart === 'function' && list.querySelector && list.querySelector('[data-live-since]')) liveTickStart();
  }
  // ── Running beyond sessions (W1, 7.0.x): audit 02 F10. COS Control's Running lists Work runs, questions COS is answering
  // and routine runs next to sessions (Models.swift TodayHome, M:14116). The web reads the same server list Control does,
  // GET /api/query-jobs/active (docs/active-query-jobs.md; titles only, never a prompt or an answer). Stop uses the existing
  // POST /api/query-jobs/:id/cancel and is offered only where Control offers it: a Work run (origin task, or other, which is a
  // COS Control Work session or a meeting review). A question being answered stops from Messages; a routine is not stopped here.
  var RUN_JOB_WORD = { person: 'COS is answering', routine: 'Routine', task: 'Work run', other: 'Work run or review' };
  var RUN_JOB_STOPPABLE = { task: true, other: true };
  var RUN_JOBS = { items: null, armed: '', stopping: {}, note: {}, timer: null };
  var RUN_JOBS_POLL_MS = 15000;
  function runJobValid(j) { return j && typeof j.jobId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(j.jobId) && Number.isInteger(j.generation) && j.generation > 0; }
  function loadRunJobs() {
    return api('/api/query-jobs/active').then(function (d) {
      // An older server answers 400 or no protocol: no jobs row, never an error line (Control keys off the field, not the status).
      RUN_JOBS.items = d && d.protocolVersion === 1 && d.enabled !== false && Array.isArray(d.items) ? d.items.filter(runJobValid).slice(0, 8) : [];
    }, function () { RUN_JOBS.items = null; });
  }
  function runJobsSchedule() {
    if (RUN_JOBS.timer) { clearTimeout(RUN_JOBS.timer); RUN_JOBS.timer = null; }
    if (!RUN_JOBS.items || !RUN_JOBS.items.length) return;
    RUN_JOBS.timer = setTimeout(function () {
      RUN_JOBS.timer = null;
      if (state.pane !== 'today' || document.hidden) return;
      loadRunJobs().then(function () { renderRunning(TODAY.working || [], TODAY.open || []); runJobsSchedule(); });
    }, RUN_JOBS_POLL_MS);
  }
  function runJobRow(j) {
    var word = RUN_JOB_WORD[j.origin] || RUN_JOB_WORD.other;
    var mins = Math.max(0, Math.round((Number(j.elapsedMs) || 0) / 60000));
    var meta = (j.state === 'queued' ? 'Waiting to start' : j.state === 'finishing' ? 'Finishing' : 'Running') + (mins ? ', ' + mins + ' min' : '');
    var stop = '';
    if (RUN_JOB_STOPPABLE[j.origin]) {
      var id = j.jobId + ':' + j.generation;
      stop = RUN_JOBS.stopping[id] ? '<span class="run-meta">Stopping</span>'
        : '<button type="button" class="link-btn" data-action="run-job-stop" data-job="' + esc(id) + '" aria-label="' + esc('Stop ' + (j.title || word)) + '">' + (RUN_JOBS.armed === id ? 'Tap again to stop' : 'Stop') + '</button>';
      if (RUN_JOBS.note[id]) stop += '<span class="run-meta">' + esc(RUN_JOBS.note[id]) + '</span>';
    }
    return '<div class="run-row run-job"><span class="run-who"><span class="badge work">' + esc(word) + '</span></span>' +
      '<span class="run-title">' + esc(plain(j.title || '').trim() || word) + '</span>' +
      '<span class="run-meta">' + esc(meta) + '</span>' + (stop ? '<span class="row-actions">' + stop + '</span>' : '') + '</div>';
  }
  function runJobsHtml() {
    var items = RUN_JOBS.items || [];
    return { html: items.map(runJobRow).join(''), n: items.length };
  }
  function stopRunJob(t) {
    var id = t.getAttribute('data-job') || '', cut = id.lastIndexOf(':');
    if (cut < 1 || RUN_JOBS.stopping[id]) return;
    if (RUN_JOBS.armed !== id) { RUN_JOBS.armed = id; renderRunning(TODAY.working || [], TODAY.open || []); return; }
    RUN_JOBS.armed = ''; RUN_JOBS.stopping[id] = true; delete RUN_JOBS.note[id];
    renderRunning(TODAY.working || [], TODAY.open || []);
    api('/api/query-jobs/' + encodeURIComponent(id.slice(0, cut)) + '/cancel', { method: 'POST', body: { generation: Number(id.slice(cut + 1)) }, timeoutMs: 20000 }).then(function () {
      return loadRunJobs();
    }, function (err) { RUN_JOBS.note[id] = (err && err.message) || 'Stop did not go through.'; }).then(function () {
      delete RUN_JOBS.stopping[id];
      renderRunning(TODAY.working || [], TODAY.open || []);
    });
  }
  // ── end running beyond sessions

  // ── live state on screen (7.0.1): Today's counts and rows, the pet, the Sessions rows, the header line ──
  // The live model (above) calls this, batched, after a frame or a list read moved something.
  function liveRepaint(rows, structural) {
    if (!liveSignedIn()) return;
    if (state.pane === 'today' && TODAY.at && !TODAY.offline && TODAY.sessionsState === 'answered') {
      var sessions = state.sessions || [];
      TODAY.working = sessions.filter(function (s) { return s.running_active; });
      TODAY.open = sessions.filter(function (s) { return s.running && !s.running_active; });
      renderRunning(TODAY.working, TODAY.open);
      renderPet(sessions);
      paintNeeds();
      setBadge('sessions', TODAY.working.length > 0);
    }
    if (state.pane === 'sessions' && SX.rows && SX.view === 'sessions') liveSessionRows(rows, structural);
    liveNoteTick();
  }
  // Sessions: a row whose state moved is redrawn where it stands (the list never jumps under a finger); a session that
  // appeared or left redraws the list. A search on screen keeps its hits; only the hero's counts move.
  function liveSessionRows(rows, structural) {
    var list = $('sessions-list');
    if (!list) return;
    if (sxQueryActive()) { paintSessionsHero(); return; }
    if (structural) { renderSessionGroups(); return; }
    var amb = sxAmbiguous(sxVisible());
    (rows || []).forEach(function (s) {
      if (!s || sxKeepWarm(s)) return;
      var k = splitSessionId(s.provider, s.session_id || s.id), want = k.provider + '|' + k.id;
      var els = list.querySelectorAll('[data-session]');
      for (var i = 0; i < els.length; i++) {
        if (els[i].getAttribute('data-session') !== want) continue;
        var html = sxRow(s, null, amb);
        if (els[i].__liveHtml !== html) {
          var tmp = document.createElement('div'); tmp.innerHTML = html;
          var next = tmp.firstElementChild || tmp.firstChild;
          if (next) { next.__liveHtml = html; els[i].parentNode.replaceChild(next, els[i]); }
        }
        break;
      }
    });
    paintSessionsHero();
  }
  // ── Today's header line and Refresh ──
  // Refresh (Miles 11/07: "a 'refresh' button to the home 'today' tab that allows the user to get the latest state and
  // to update the summary"): every Today source read again now, then a new summary asked for with force (the server
  // still holds its switch, its one-per-30-s refresh limit and its daily cap, and says which in `reason`).
  var TR = { busy: false, doneAt: 0, msg: '', retryAt: 0 };
  var TR_REASONS = {
    daily_cap: 'Daily summary limit reached',
    recording: 'No new summary while a meeting records',
    maintenance: 'No new summary while COS updates',
    paused: 'The summary is paused for now. Try again later',
    failed: 'The summary did not update',
    interval: 'The summary updated recently. Try again in a few minutes'
  };
  /** The words for a refresh answer, or '' when the summary updated (or is switched off). */
  function refreshWords(v) {
    if (!v || typeof v !== 'object') return '';
    if (typeof v.message === 'string' && v.message.trim()) return v.message.trim();
    if (v.state === 'off') return '';
    if (v.reason === 'refresh_throttled') return '';
    return v.state === 'fresh' && !v.reason ? '' : (TR_REASONS[v.reason] || '');
  }
  function todayRefresh() {
    if (TR.busy) return Promise.resolve(false);
    TR.busy = true; TR.msg = ''; TR.retryAt = 0;
    var btn = $('today-refresh'); if (btn) btn.disabled = true;
    liveNoteTick();
    var done = function (msg) {
      TR.busy = false; TR.doneAt = Date.now(); TR.msg = msg || '';
      var b = $('today-refresh'); if (b) b.disabled = false;
      liveNoteTick(); liveTickStart();
      return true;
    };
    return Promise.resolve(loadToday(true)).then(function () {
      if (typeof liveOn === 'function' && liveOn()) LIVE.freshAt = Date.now();
      if (!TODAY.model || TODAY.offline) return done('');
      // The summary switched off: the state only.
      if (BRIEF.view && (BRIEF.view.state === 'off' || BRIEF.view.enabled === false)) return done('');
      var body = briefInputs(TODAY.model);
      body.force = true;
      BRIEF.inflight = true;
      // A 7.0.0 server refuses the unknown `force` (400 invalid_today_brief): ask it the ordinary way instead.
      var ask = function (b) { return api('/api/today/brief', { method: 'POST', body: b, timeoutMs: 45000 }); };
      return ask(body).catch(function (err) {
        if (!(err && err.status === 400 && err.code === 'invalid_today_brief')) throw err;
        delete body.force;
        return ask(body);
      }).then(function (v) {
        BRIEF.inflight = false;
        if (v && typeof v === 'object') { BRIEF.view = v; BRIEF.sentAt = Date.now(); }
        if (v && v.reason === 'refresh_throttled') TR.retryAt = Date.now() + Math.max(1000, Number(v.retryAfterMs) || 30000);
        if (TODAY.model && state.pane === 'today') renderStory(TODAY.model);
        return done(refreshWords(v));
      }, function (err) {
        BRIEF.inflight = false;
        return done(err && err.code === 'unreachable' ? err.message : 'The summary did not update');
      });
    }, function () { return done('Could not read everything. Try again'); });
  }
  function liveNoteBusy() {
    var now = Date.now();
    return TR.busy || TR.retryAt > now || (TR.doneAt && now - TR.doneAt < 10 * 60000) || !!liveAge(now) || LIVE.mode === 'reconnecting';
  }
  /** The line beside Refresh: Updating, Reconnecting, the counts' age, when Today was refreshed, the server's limit. */
  function liveNoteText(now) {
    now = now || Date.now();
    if (TR.busy) return 'Updating';
    var parts = [];
    if (LIVE.mode === 'reconnecting') parts.push('Reconnecting');
    var age = liveAge(now);
    if (age) parts.push(age);
    if (TR.doneAt && !age) {
      var m = Math.floor((now - TR.doneAt) / 60000);
      if (m < 10) parts.push(m < 1 ? 'Updated just now' : 'Updated ' + m + ' min ago');
    }
    if (TR.retryAt > now) parts.push('Try again in ' + Math.ceil((TR.retryAt - now) / 1000) + ' s');
    else if (TR.msg && TR.doneAt && now - TR.doneAt < 10 * 60000) parts.push(TR.msg);
    return parts.join('. ');
  }
  /** What the line says, without its numbers: the polite status line speaks only when this changes (review N10). */
  function liveNoteState(now) {
    now = now || Date.now();
    var age = liveAge(now);
    return [TR.busy ? 'busy' : '', LIVE.mode === 'reconnecting' ? 'reconnecting' : '', age ? 'age' : '',
      TR.doneAt && !age && now - TR.doneAt < 10 * 60000 ? 'done' : '', TR.retryAt > now ? 'retry' : '',
      TR.msg && TR.doneAt && now - TR.doneAt < 10 * 60000 ? TR.msg : ''].join('|');
  }
  function liveNoteTick() {
    var el = $('today-live-note'), t = liveNoteText();
    if (el) { if (el.textContent !== t) el.textContent = t; el.classList.toggle('warn', LIVE.mode === 'reconnecting'); }
    var said = $('today-live-status'), key = liveNoteState();
    if (said && LIVE.noteSaid !== key) { LIVE.noteSaid = key; said.textContent = t; }
    var sx = document.querySelector('#sessions-hero .sx-live-note');
    if (sx) { var n = liveSessionsNote(); sx.textContent = n ? ' · ' + n : ''; }
  }
  /** The Sessions hero's honesty suffix: "Reconnecting" and the counts' age, or ''. */
  function liveSessionsNote() {
    var bits = [];
    if (LIVE.mode === 'reconnecting') bits.push('Reconnecting');
    var age = liveAge();
    if (age) bits.push(age.charAt(0).toLowerCase() + age.slice(1));
    return bits.join(' · ');
  }
  function needWhy(item) {
    var p = item.progress || {};
    if (p.reported === 'needsInput' || item.waitingInApp) return 'Waiting for your reply';
    if (p.reported === 'blocked') return 'Blocked';
    if (item.status === 'delivered') return 'Handed to you';
    return 'Needs a look';
  }
  // ── Needs you (COS Control's TodayHome.things, sourceStates and fold; Models.swift 14291, 14512, 14474) ──
  // Every source Control's Today reads that the web can: sessions waiting on you (the session list), Work handoffs
  // (your-move), voices to name (/api/voice/held-groups) and memories to review (the memories bridge's status). One row
  // per thing. The card's count, the headline and the rail say the same number, from the same rows. "Nothing is
  // waiting on you" only once every source answered; a source that failed is named instead. Under quiet hours (after
  // 6 PM, before 6 AM, weekends) everything but a waiting session folds under "can wait until tomorrow".
  var NEEDS_SHOWN = 6;
  var NEED_NAMES = { sessions: 'sessions', work: 'Work', voices: 'voices', memories: 'memories' };
  function quietNowToday(d) { var h = d.getHours(), day = d.getDay(); return day === 0 || day === 6 || h >= 18 || h < 6; }
  // Control's askedTitle and askedWhy for a session waiting on you.
  // Control's TodayHome: guarded(title) ?? "A session". Never the workspace path or the session id: this line is shown
  // on Today and goes into the Today summary sent to the model, which carries no ids.
  function askedTitle(s) {
    var t = plain(s.display_label || s.custom_title || '').replace(/\s+/g, ' ').trim() || 'A session';
    if (sxProvider(s.provider) !== 'claude') return t + ' is waiting for your reply';
    if (s.waiting_kind === 'plan') return t + ' has a plan for you to approve';
    if (s.waiting_kind === 'permission') return t + ' wants your permission';
    if (s.waiting_kind === 'mcp_input') return t + ' needs your input';
    return t + ' asked you a question';
  }
  // Control never shows a bare tool name (TodayHome.toolNames): "AskUserQuestion" says nothing to a person.
  var TOOL_NAMES = ['AskUserQuestion', 'ExitPlanMode', 'Bash', 'BashOutput', 'KillShell', 'Edit', 'Write', 'Read', 'Grep', 'Glob', 'LS', 'Task', 'Agent',
    'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookEdit', 'MultiEdit', 'SlashCommand', 'Skill', 'ToolSearch'];
  function askedWhy(s) {
    if (s.waiting_kind === 'plan') return 'Has a plan for you to approve';
    var d = String(s.waiting_detail || '').trim();
    if (TOOL_NAMES.indexOf(d) >= 0) d = '';
    // 7.0.4 W5: the server shows the home folder in this command as "[home]" (lib/local-path-redact.ts COMMAND_KEYS), so
    // the line is a display, labelled as one. The exact command is on the approval card, which is not redacted.
    if (s.waiting_kind === 'permission' && d) {
      var shown = d.length > 80 ? d.slice(0, 79) + '…' : d;
      return d.indexOf('[home]') >= 0 ? 'Wants to run (home folder hidden) ' + shown : 'Wants to run ' + shown;
    }
    if (s.waiting_kind === 'question' && d) return d.length > 160 ? d.slice(0, 159) + '…' : d;
    // W1 A5: a Claude session waits on its own prompt; the card under it says where, once.
    return sxProvider(s.provider) === 'claude' ? 'Waiting for your answer' : 'Waiting for you';
  }
  // 6.99.26: where a waiting session's question can be answered. 'here': this page holds it (panes/questions.js), as
  // cards in its waiting sheet. 'mac': a Claude session's own prompt (or a held one that went back to the Mac), which
  // only the Mac can answer, in person or through Screens. 'answered': answered on some screen in the last two minutes,
  // the list not caught up yet. '': a reply answers it (a Codex or Cursor session).
  function sessionQs() { var q = window.COSWeb && window.COSWeb.sessionQuestions; return q && q.itemsFor ? q : null; }
  function askedHere(items) {
    var it = items[0];
    if (!it) return '';
    if (it.kind === 'approval') return it.approval && it.approval.summary ? 'Wants to run ' + clipWords(it.approval.summary, 80) : '';
    var q = (it.questions || [])[0];
    return q && q.question ? clipWords(q.question, 160) : '';
  }
  function clipWords(text, n) { var t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function whereFor(provider, id) {
    var q = sessionQs();
    var held = q ? q.itemsFor(id) : [], mac = q && q.atMacFor ? q.atMacFor(id) : [];
    if (held.length) return { where: 'here', ask: askedHere(held) };
    if (q && q.answeredFor && q.answeredFor(id)) return { where: 'answered', ask: '' };
    var words = mac.length && q.wordsOf ? q.wordsOf(mac[0].id) : null;
    var ask = words ? clipWords(words.questions[0] || (words.summary ? 'Wants to run ' + words.summary : ''), 160) : '';
    if (mac.length || sxProvider(provider) === 'claude') return { where: 'mac', ask: ask };
    return { where: '', ask: '' };
  }
  // ── At the Mac's prompt, in the session reader (W1 A5) ──
  // Miles 11/09: "when I actually navigate to the session, there is no ability to answer the question." The reader cannot
  // answer a question that waits on the Mac's own prompt either, so it says so at the top, with the words when this page
  // has them (a held question it saw, or the server's waiting line) and plainly when it does not. Nothing here sends.
  var MAC_Q = { line: "Answer this at your Mac's prompt. It cannot be answered from here yet.", none: "COS cannot read this question's words from here. They show at the Mac's prompt." };
  function readerMacHtml(provider, id, row) {
    var w = whereFor(provider, id);
    if (w.where !== 'mac') return '';
    var q = sessionQs();
    var why = row ? askedWhy(row) : '';
    var words = w.ask || (why && !/^Waiting for (you|your answer)/.test(why) ? why : '');
    return '<p class="sx-mac-q-title"><strong>Waiting for your answer at the Mac</strong></p>' +
      (words ? '<blockquote class="ta-quote sx-mac-q-words">' + esc(words) + '</blockquote>' : '<p class="sx-note sx-mac-q-none">' + esc((q && q.macNoWords) || MAC_Q.none) + '</p>') +
      '<p class="sx-note sx-mac-q-line">' + esc((q && q.macLine) || MAC_Q.line) + '</p>';
  }
  function readerMacPaint(r, waiting) {
    var el = $('session-mac-q');
    if (!el || !r) return;
    var row = (state.sessions || []).filter(function (s) { var k = splitSessionId(s.provider, s.session_id || s.id); return k.provider === r.provider && String(k.id).toLowerCase() === String(r.id).toLowerCase(); })[0] || null;
    var html = waiting ? readerMacHtml(r.provider, r.id, row) : '';
    if (el.innerHTML !== html) el.innerHTML = html;
    el.hidden = !html;
  }
  // ── end at the Mac's prompt

  function needsModel() {
    var states = { sessions: TODAY.sessionsState, work: TODAY.workState, voices: TODAY.voices.state, memories: TODAY.memories.state };
    var rows = [], seen = {};
    (state.sessions || []).forEach(function (s) {
      if (sxKeepWarm(s) || sxState(s) !== 'waiting') return;
      var k = splitSessionId(s.provider, s.session_id || s.id);
      seen[k.provider + '|' + String(k.id).toLowerCase()] = 1;
      var w = whereFor(k.provider, k.id);
      rows.push({ kind: 'session', tier: 1, title: askedTitle(s), why: askedWhy(s), since: s.state_since || s.last_activity_at, key: k.provider + '|' + k.id, where: w.where, ask: w.ask });
    });
    // A question this page holds for a session the list has not shown waiting yet: its own row, so every held
    // question is in front of you (two at once each get one).
    var qs = sessionQs();
    (qs ? qs.itemsFor('') : []).forEach(function (it) {
      var k = splitSessionId(it.provider, it.sessionId), sk = k.provider + '|' + String(k.id).toLowerCase();
      if (!k.id || seen[sk]) return;
      seen[sk] = 1;
      var s = (state.sessions || []).filter(function (x) { var xk = splitSessionId(x.provider, x.session_id || x.id); return xk.provider === k.provider && String(xk.id).toLowerCase() === String(k.id).toLowerCase(); })[0];
      var title = s ? askedTitle(s) : it.kind === 'approval' ? 'A session wants your permission' : 'A session asked you a question';
      rows.push({ kind: 'session', tier: 1, title: title, why: 'Waiting for you. Paused until you answer.', since: it.createdAt, key: k.provider + '|' + k.id, where: 'here', ask: askedHere([it]) });
    });
    (TODAY.needs || []).forEach(function (it) {
      var k = splitSessionId(it.provider, it.sessionId);
      if (k.id && seen[k.provider + '|' + String(k.id).toLowerCase()]) return;   // Control: a Work row for a waiting session is the session's row
      // 7.0.1 (Miles 11/07): the server saw you start a turn in the session after its needs-input or blocked report
      // (work-activity.ts supersededBy). That report is history, not something waiting on you. Only the item that
      // regrouped to running leaves: a superseded completed handoff regroups to "Needs a look", which the Messages
      // badge counts, so it stays here too (review N6).
      if (it.supersededAt && it.group === 'running') return;
      rows.push({ kind: 'work', tier: 3, item: it, key: k.id ? k.provider + '|' + k.id : '' });
    });
    var groups = TODAY.voices.groups || [];
    if (groups.length) {
      var named = groups.filter(function (g) { return g && g.suggestion && g.suggestion.name; })[0];
      rows.push({ kind: 'voices', tier: 2, title: groups.length === 1 ? 'Name a held voice' : 'Name ' + groups.length + ' held voices',
        why: named ? 'One sounds like ' + named.suggestion.name + '.' : 'Held from your recordings until they have a name.' });
    }
    if (TODAY.memories.n > 0) {
      var n = TODAY.memories.n;
      rows.push({ kind: 'memories', tier: 4, title: n === 1 ? 'Review a memory' : 'Review ' + n + ' memories', why: 'Learned from your meetings and sessions, waiting for a yes or no.' });
    }
    var quiet = quietNowToday(new Date());
    var nowRows = rows.filter(function (r) { return !quiet || r.tier === 1; }), later = rows.filter(function (r) { return quiet && r.tier !== 1; });
    var failed = Object.keys(states).filter(function (k) { return states[k] === 'failed'; }).map(function (k) { return NEED_NAMES[k]; });
    var settled = Object.keys(states).every(function (k) { return states[k] === 'answered'; });
    return { rows: rows, now: nowRows, later: later, failed: failed, settled: settled, states: states,
      sessionsWaiting: rows.filter(function (r) { return r.kind === 'session'; }).length };
  }
  function paintNeeds() {
    if (!TODAY.at) return;
    var m = TODAY.model = needsModel();
    renderStory(m);
    renderNeeds(m);
    setBadge('today', m.now.length > 0);
    if (window.COSWeb && window.COSWeb.setStory) window.COSWeb.setStory('today', todayRailLine(m), m.now.length > 0);
  }
  // The rail's Today line, from the same rows (shell.js keeps its own count off Today).
  function todayRailLine(m) {
    var n = m.now.length, bits = [];
    if (n > 0) bits.push(n === 1 ? '1 needs you' : n + ' need you');
    else if (m.later.length) bits.push(m.later.length + ' can wait until tomorrow');
    else if (m.settled) bits.push('Nothing needs you');
    else if (m.failed.length) bits.push('Couldn’t read ' + listWords(m.failed));
    else bits.push('Reading');
    if (TODAY.working.length) bits.push(TODAY.working.length + ' running');
    return bits.join(', ');
  }
  function needRowHtml(r, i) {
    // A Work row is dated by when it started waiting (7.0.1), not by the card's newest event.
    var age = r.since ? ago(r.since) : r.item ? ago(r.item.waitingSince || r.item.updatedAt || r.item.createdAt) : '';
    var top = function (title) { return '<span class="need-top"><span class="need-title">' + esc(title) + '</span>' + (age ? '<span class="need-age">' + esc(age) + '</span>' : '') + '</span>'; };
    if (r.kind === 'work') {
      var it = r.item, k = splitSessionId(it.provider, it.sessionId);
      var why = needWhy(it) + (it.domain ? ' in ' + domainLabel(it.domain) : '');
      // The row opens it in an overlay on Today (panes/today-actions.js); Open session still goes to the reader.
      return '<div class="need-row">' +
        '<button type="button" class="need-open" data-today="need" data-key="' + esc(it.id) + '"' + (k.id ? ' data-session-key="' + esc(k.provider) + '|' + esc(k.id) + '"' : '') + '>' +
        top(it.sessionTitle || it.title || 'Handoff') + '<span class="need-foot">' + esc(why) + '</span></button>' +
        (k.id ? '<div class="need-actions"><button type="button" class="btn small' + (i === 0 ? ' primary' : '') + '" data-session="' + esc(k.provider) + '|' + esc(k.id) + '">Open session</button></div>' : '') + '</div>';
    }
    if (r.kind === 'session') {
      // The session's question shows in the overlay's peek, with its cards to answer. Under it, where it can be answered.
      var q = sessionQs(), whereLine = r.where === 'here' ? 'Answer it here.' : r.where === 'mac' ? (q && q.macLine) || '' : r.where === 'answered' ? (q && q.answeredLine) || '' : '';
      return '<div class="need-row">' +
        '<button type="button" class="need-open" data-today="wait" data-key="' + esc(r.key) + '">' + top(r.title) + '<span class="need-foot">' + esc(r.ask || r.why) + '</span>' +
        (whereLine ? '<span class="need-foot need-where" data-where="' + esc(r.where) + '">' + esc(whereLine) + '</span>' : '') + '</button>' +
        '<div class="need-actions"><button type="button" class="btn small' + (i === 0 ? ' primary' : '') + '" data-session="' + esc(r.key) + '">Open session</button></div></div>';
    }
    var go2 = r.kind === 'voices' ? 'speakers' : 'memories/view/review', label = r.kind === 'voices' ? 'Name' : 'Review';
    return '<div class="need-row">' +
      '<button type="button" class="need-open" data-goto="' + go2 + '">' + top(r.title) + '<span class="need-foot">' + esc(r.why) + '</span></button>' +
      '<div class="need-actions"><button type="button" class="btn small' + (i === 0 ? ' primary' : '') + '" data-goto="' + go2 + '">' + label + '</button></div></div>';
  }
  function renderNeeds(m) {
    var shown = TODAY.showLater ? m.now.concat(m.later) : m.now;
    $('needs-count').textContent = m.now.length ? String(m.now.length) : '';
    var list = $('needs-list');
    var visible = TODAY.showAllNeeds ? shown : shown.slice(0, NEEDS_SHOWN);
    var html = visible.map(needRowHtml).join('');
    if (shown.length > visible.length) html += '<button type="button" class="need-more" data-today-needs="all">Show ' + (shown.length - visible.length) + ' more</button>';
    if (m.later.length && !TODAY.showLater) html += '<button type="button" class="need-more" data-today-needs="later">' + esc(m.later.length + (m.later.length === 1 ? ' thing can' : ' things can') + ' wait until tomorrow. Show') + '</button>';
    // 6.99.30 (design QA): no empty line above a failed read (it left a 45 px gap), and one retry row, never one per
    // source: with the Mac not answering (sessions and Work both unread, or more than two sources) it says so once.
    if (!m.rows.length) html = m.failed.length ? '' : '<p class="card-empty">' + esc(m.settled ? 'Nothing is waiting on you.' : 'Reading sessions, Work, voices and memories.') + '</p>';
    if (m.failed.length) {
      var silent = TODAY.offline || m.failed.length > 2;
      html += '<button type="button" class="need-more need-failed" data-today-needs="retry">' + esc(silent ? 'Your Mac is not answering. Try again.' : 'Couldn’t read ' + listWords(m.failed) + '. Try again') + '</button>';
    }
    list.innerHTML = html;
  }
  // Weather sits under the date at the top left (Miles, 11/07), where the eye starts, not inside Next up.
  // It shows whether or not a meeting is next.
  function renderWeather(w) {
    var el = $('today-weather'); if (!el) return;
    var x = w && w.weather;
    if (!x || !x.temp) { el.classList.add('hidden'); el.textContent = ''; return; }
    var desc = String(x.desc || '').toLowerCase(), place = x.location ? String(x.location).split(',')[0] : '';
    el.textContent = x.temp + (desc ? ' and ' + desc : '') + (place ? ' in ' + place : '');
    el.classList.remove('hidden');
  }
  function renderNext(w) {
    var card = $('next-card');
    var n = w && w.nextEvent; var d = n && toDate(n.time);
    if (!d || !n.title) { card.classList.add('hidden'); return; }
    var dw = dayWord(d);
    $('next-body').innerHTML = '<span class="when">' + esc(clock(d)) + '</span><span><span class="what">' + esc(n.title) + '</span>' +
      '<span class="sub" style="display:block">' + esc(dw.charAt(0).toUpperCase() + dw.slice(1)) + '</span></span>';
    // Control's Next up (todayPrepButtons): Prep me opens the Prep composer in the COS chat (panes/cos-chat.js prepFor),
    // Open meeting opens Meetings. Without a server to answer, Prep me is not offered.
    var prep = !TODAY.offline && window.COSWeb && window.COSWeb.cosChat && window.COSWeb.cosChat.prepFor;
    // Prep on every row (Miles 11/09): "Add context" opens the same inline panel the later rows' Prep opens, for this
    // meeting. Not on a hold (the server's nextEvent.hold), and not while neither Prep nor Ask is on the Mac.
    var key = nextPrepKey(n.title, d), ctx = !n.hold && nextPrepMode();
    if (ctx) NEXT_PREP.rows[key] = { title: n.title, start: d.toISOString() };
    $('next-actions').innerHTML = (prep ? '<button type="button" class="btn small primary" data-today-next="prep">Prep me</button>' : '') +
      (ctx ? '<button type="button" class="link-btn next-prep-open" data-next-prep="' + esc(key) + '" aria-expanded="' + (NEXT_PREP.open === key) + '">Add context</button>' : '') +
      '<button type="button" class="link-btn" data-goto="meetings">Open meeting</button>';
    NEXT_PREP.firstKey = ctx ? key : '';
    paintNextPrepSlot($('next-first-prep'), ctx && NEXT_PREP.open === key ? key : '');
    card.classList.remove('hidden');
  }
  // PH plan P1: the rest of today from GET /api/calendar/today (selected calendars), under Next up.
  // An aging snapshot says when it was read. Not connected or nothing more: the block stays hidden.
  // Today round 2 (Miles 11/09): Next up is 5 rows in all, the event above plus up to 4 more, then "+N more today"
  // (opens Meetings) when the calendar has more meetings left today than are shown. Desktop Control 0.5.384 matches.
  function loadCalendarLater(n, d) {
    var LATER_ROWS = 4;
    var box = $('next-later'); if (!box) return;
    if (!n || !n.title || !d) { NEXT_PREP.later = null; clearLater(box); return; }
    var gen = TODAY.gen;
    api('/api/calendar/today').then(function (c) {
      if (gen !== TODAY.gen) return;
      if (!c || !c.connected) { NEXT_PREP.later = null; clearLater(box); return; }
      var same = function (r) { var rd = toDate(r.start); return r.title === n.title && rd && d && Math.abs(rd.getTime() - d.getTime()) < 60000; };
      var list = c.next || [];
      var rows = list.filter(function (r) { return !r.allDay && !same(r); }).slice(0, LATER_ROWS);
      // What is left today past the rows on screen (the event above counts when it is one of today's).
      var shown = rows.length + (list.some(same) ? 1 : 0), more = (Number(c.remainingCount) || 0) - shown;
      NEXT_PREP.later = { rows: rows, more: more, asOf: c.stale && c.asOf ? toDate(c.asOf) : null };
      paintCalendarLater();
    }, function () { NEXT_PREP.later = null; clearLater(box); });
  }
  // Emptied, and its last write forgotten, so the next read that has rows writes them again (writeKeepingPrep skips a
  // write that matches the last one).
  function clearLater(box) { box.classList.add('hidden'); box.innerHTML = ''; box.cosPrepHtml = ''; }
  // The later rows from the last calendar read. Each meeting that is not a hold (the server's `hold`) gets a quiet
  // Prep, and the open row's panel sits under it. Written only when the markup changed, so a poll never takes the words
  // or the caret from the panel; when it is written, the words, the focus and the caret are put back.
  function paintCalendarLater() {
    var box = $('next-later'), L = NEXT_PREP.later; if (!box || !L) return;
    var mode = nextPrepMode(), openKey = '';
    var html = L.rows.map(function (r) {
      var rd = toDate(r.start), key = rd ? nextPrepKey(r.title, rd) : '', can = !!(mode && key && r.hold !== true);
      if (can) { NEXT_PREP.rows[key] = { title: r.title, start: rd.toISOString() }; if (NEXT_PREP.open === key) openKey = key; }
      return '<div class="later-row"><span class="later-when">' + esc(rd ? clock(rd) : '') + '</span><span class="later-what">' + esc(r.title) + '</span>' +
        (can ? '<button type="button" class="link-btn later-prep" data-next-prep="' + esc(key) + '" aria-expanded="' + (NEXT_PREP.open === key) + '">Prep</button>' : '') + '</div>' +
        (can && NEXT_PREP.open === key ? nextPrepPanelHtml(key, mode) : '');
    }).join('');
    if (L.more > 0) html += '<button type="button" class="link-btn later-more" data-goto="meetings">' + esc('+' + L.more + ' more today') + '</button>';
    if (L.asOf) html += '<div class="later-asof">' + esc('Calendar as of ' + clock(L.asOf)) + '</div>';
    // Shown before it is written: autoGrow measures the box, and a hidden one measures 0.
    box.classList.toggle('hidden', !html);
    writeKeepingPrep(box, html, openKey);
  }

  // ── Prep on every Next up row (Miles typed 2026-11-09 13:00 CST) ─────────
  // "Inline options to prep for a given meeting which starts the gotCOS ask and gives us the ability to add in more
  // context for the prep." Prep on a later row (or Add context beside the first row's Prep me) opens a small panel
  // under that row: the context box, Add files, Start prep and Cancel. One panel at a time; Escape closes it. The words
  // and files are kept per meeting (title plus start) while the page polls. Start prep goes to Messages, then COS, and
  // hands them to cos-chat.js prepStart: the Prep composer for that meeting (the context joins its notes, the files go
  // up through its own path, then Prep me runs), or, with Prep off on the Mac and Ask on, the plain Ask with the context
  // as its quoted reference. Neither on (or the Mac not answering): no Prep on any row.
  var NEXT_PREP = { open: '', rows: {}, drafts: {}, later: null, firstKey: '', busy: false, capsAsked: false };
  function nextPrepKey(title, d) { return String(title || '') + '|' + (d ? d.toISOString() : ''); }
  function nextPrepChat() { return typeof window !== 'undefined' && window.COSWeb && window.COSWeb.cosChat || null; }
  /** 'prep' (Prep on the Mac), 'ask' (Ask only), or '' (neither, the Mac not answering, or not known yet). */
  function nextPrepMode() {
    var chat = nextPrepChat();
    if (TODAY.offline || !chat || !chat.prepStart) return '';
    if (chat.known && !chat.known()) {
      // The chat reads /api/health once per page; paint the rows again when it lands.
      if (!NEXT_PREP.capsAsked && chat.ensureCaps) {
        NEXT_PREP.capsAsked = true;
        chat.ensureCaps().then(function () { if (TODAY.welcome) renderNext(TODAY.welcome); paintCalendarLater(); }, function () {});
      }
      return '';
    }
    if (chat.prepCaps && chat.prepCaps()) return 'prep';
    return chat.askOn && chat.askOn() ? 'ask' : '';
  }
  function nextPrepDraft(key) { return NEXT_PREP.drafts[key] || (NEXT_PREP.drafts[key] = { text: '', files: [] }); }
  function nextPrepMax() { var chat = nextPrepChat(), c = chat && chat.prepCaps && chat.prepCaps(); return c || { maxFiles: 10, steerChars: 4000 }; }
  function nextPrepPanelHtml(key, mode) {
    var row = NEXT_PREP.rows[key] || { title: '' }, dr = nextPrepDraft(key), chat = nextPrepChat();
    var label = 'Add context for this prep (goals, people, what you want out of it)';
    var files = mode === 'prep' && dr.files.length ? '<ul class="next-prep-files">' + dr.files.map(function (f, i) {
      return '<li><span class="next-prep-file">' + esc(f.name || 'File') + '</span><button type="button" class="link-btn" data-next-prep-remove="' + i + '" aria-label="' + esc('Remove ' + (f.name || 'file')) + '">Remove</button></li>';
    }).join('') + '</ul>' : '';
    var add = mode === 'prep' ? '<label class="cx-btn quiet next-prep-add" title="Add files to this prep"><svg class="icon" aria-hidden="true"><use href="#i-clip"/></svg><span>Add files</span>' +
      '<input type="file" class="cc-file" multiple accept="' + esc((chat && chat.prepAccept) || '') + '" data-next-prep-file aria-label="' + esc('Add files to the prep for ' + row.title) + '"></label>' : '';
    return '<form class="next-prep" data-next-prep-form data-key="' + esc(key) + '" autocomplete="off" aria-label="' + esc('Prep for ' + row.title) + '">' +
      '<textarea class="field next-prep-input" rows="2" maxlength="' + (mode === 'prep' ? nextPrepMax().steerChars : 2000) + '" data-next-prep-steer placeholder="' + esc(label) + '" aria-label="' + esc(label) + '"></textarea>' +
      files +
      '<div class="next-prep-acts">' + add + '<span class="next-prep-gap"></span>' +
        '<button type="button" class="link-btn next-prep-cancel" data-next-prep-cancel>Cancel</button>' +
        '<button type="submit" class="cx-btn primary next-prep-start"' + (NEXT_PREP.busy ? ' disabled' : '') + '>Start prep</button></div>' +
      '</form>';
  }
  // The first row's panel, in its own slot under Prep me and Open meeting.
  function paintNextPrepSlot(slot, key) {
    if (!slot) return;
    var mode = key ? nextPrepMode() : '';
    // Shown before it is written: autoGrow measures the box, and a hidden one measures 0.
    slot.classList.toggle('hidden', !(key && mode));
    writeKeepingPrep(slot, key && mode ? nextPrepPanelHtml(key, mode) : '', key);
  }
  /** Writes `html` into `el` unless it is already there, then puts the open panel's words back (and the focus and caret). */
  function writeKeepingPrep(el, html, key) {
    if (el.cosPrepHtml === html) return;
    var doc = typeof document !== 'undefined' ? document : null, active = doc && doc.activeElement;
    var had = !!(active && el.contains && el.contains(active) && active.hasAttribute && active.hasAttribute('data-next-prep-steer'));
    var a = had ? active.selectionStart : 0, b = had ? active.selectionEnd : 0;
    el.innerHTML = html;
    el.cosPrepHtml = html;
    var box = key && el.querySelector ? el.querySelector('[data-next-prep-steer]') : null;
    if (!box) return;
    box.value = nextPrepDraft(key).text;
    autoGrow(box);
    if (had) { box.focus(); try { box.setSelectionRange(a, b); } catch (_e) {} }
  }
  function repaintNextPrep() {
    if (TODAY.welcome && TODAY.welcome.nextEvent) renderNext(TODAY.welcome);
    paintCalendarLater();
  }
  function toggleNextPrep(key) {
    NEXT_PREP.open = NEXT_PREP.open === key ? '' : key;
    repaintNextPrep();
    if (!NEXT_PREP.open || typeof document === 'undefined') return;
    var box = document.querySelector('[data-next-prep-form] [data-next-prep-steer]');
    if (box) { box.focus(); if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' }); }
  }
  // Escape closes the panel and keeps the words (they come back when it opens again); Cancel closes it and drops them.
  function closeNextPrep(drop) {
    var key = NEXT_PREP.open; if (!key) return false;
    if (drop) delete NEXT_PREP.drafts[key];
    NEXT_PREP.open = '';
    repaintNextPrep();
    var opener = typeof document !== 'undefined' && typeof CSS !== 'undefined' && CSS.escape ? document.querySelector('[data-next-prep="' + CSS.escape(key) + '"]') : null;
    if (opener && opener.focus) opener.focus();
    return true;
  }
  function nextPrepInput(box) { var key = NEXT_PREP.open; if (key) nextPrepDraft(key).text = box.value; }
  function addNextPrepFiles(list) {
    var key = NEXT_PREP.open; if (!key) return;
    var dr = nextPrepDraft(key), max = nextPrepMax().maxFiles, chat = nextPrepChat(), refused = [];
    Array.prototype.slice.call(list || []).forEach(function (f) {
      if (dr.files.length >= max) { refused.push('A prep holds ' + max + ' files. ' + (f.name || 'A file') + ' was not added.'); return; }
      var c = chat && chat.classify ? chat.classify(f) : {};
      if (c && c.refuse) { refused.push(c.refuse); return; }
      if (c && c.kind === 'video') { refused.push((f.name || 'That video') + ' is a video. Prep reads documents and the text in images.'); return; }
      dr.files.push(f);
    });
    if (refused.length) toast(refused.join(' '));
    repaintNextPrep();
  }
  function removeNextPrepFile(i) {
    var key = NEXT_PREP.open; if (!key) return;
    nextPrepDraft(key).files.splice(Number(i), 1);
    repaintNextPrep();
  }
  function startNextPrep() {
    var key = NEXT_PREP.open, row = key && NEXT_PREP.rows[key], chat = nextPrepChat();
    if (!row || NEXT_PREP.busy || !chat || !chat.prepStart) return;
    var mode = nextPrepMode(); if (!mode) return;
    var dr = nextPrepDraft(key);
    var extra = { steer: dr.text.trim(), files: mode === 'prep' ? dr.files.slice() : [] };
    NEXT_PREP.busy = true; NEXT_PREP.open = '';
    repaintNextPrep();
    go('messages', ['cos']);
    // The words and files stay with the meeting until the prep (or the Ask) is on its way; a failure keeps them.
    chat.prepStart(row.title, row.start, extra).then(function (how) {
      if (how) delete NEXT_PREP.drafts[key];
      else toast('Prep is not on for this Mac.');
    }, function (err) {
      toast((err && err.message) || 'Prep did not start. Your context is still under the meeting on Today.');
    }).then(function () { NEXT_PREP.busy = false; });
  }
  function prepNext() {
    var n = TODAY.welcome && TODAY.welcome.nextEvent, d = n && toDate(n.time), chat = window.COSWeb && window.COSWeb.cosChat;
    if (!n || !n.title || !chat || !chat.prepFor) return;
    go('messages', ['cos']);
    chat.prepFor(n.title, d ? d.toISOString() : null).catch(function (err) { toast((err && err.message) || 'Prep me did not start.'); });
  }
  // ── Ask about this (Today round 2, Miles 11/09) ─────────
  // "Ask COS from this page about the summary and take action coming off of that summary": one box under the model's
  // summary. Send goes to Messages, then COS, and submits an Ask (panes/cos-chat.js askAbout) that carries the summary,
  // when it was written and the sessions it read, as the Ask's quoted reference (data, never instructions; no transcript
  // text, only the last message into each session). COS can then answer, or pass an instruction to a session by its
  // title through the Ask's own relay ("Sent to <title>" on the answer card). Hidden without a model summary, without
  // Ask on the Mac (capabilities: durable query jobs) or while the Mac does not answer.
  function paintTodayAsk(brief) {
    var form = $('today-ask'); if (!form) return;
    var chat = window.COSWeb && window.COSWeb.cosChat;
    // Ask's capability is read once per page (the chat's /api/health read); paint again when it lands.
    if (brief && chat && chat.known && !chat.known() && chat.ensureCaps && !TODAY.askCaps) {
      TODAY.askCaps = true;
      chat.ensureCaps().then(function () { if (TODAY.model && state.pane === 'today') renderStory(TODAY.model); }, function () {});
    }
    var on = !!(brief && !TODAY.offline && TODAY.sessionsState === 'answered' && chat && chat.askAbout && chat.askOn && chat.askOn());
    form.classList.toggle('hidden', !on);
  }
  // The sessions the summary read: the server's own list with the summary (7.0.10+ round 2 `sessions`: title, provider,
  // state, when it last moved, the last message into it), else what this page holds for the same rows.
  function todayAskContext(b) {
    var rows = [];
    if (Array.isArray(b.sessions) && b.sessions.length) {
      b.sessions.forEach(function (r) { if (r && r.title) rows.push({ title: String(r.title), provider: String(r.provider || 'claude'), state: String(r.state || ''), movedAt: r.movedAt || null, lastAsk: r.lastAsk ? String(r.lastAsk) : '' }); });
    } else {
      (state.sessions || []).forEach(function (s) {
        if (sxKeepWarm(s)) return;
        var kind = sxState(s) === 'waiting' ? 'waiting' : s.running_active ? 'working' : s.running ? 'open' : '';
        if (!kind) return;
        var k = splitSessionId(s.provider, s.session_id || s.id);
        rows.push({ title: sessionTitle(s), provider: k.provider, state: kind, movedAt: kind === 'open' ? (s.last_activity_at || s.state_since) : (s.state_since || s.last_activity_at), lastAsk: '' });
      });
    }
    return { summary: String(b.text || ''), at: b.at || null, sessions: rows };
  }
  function sendTodayAsk() {
    var input = $('today-ask-input'), text = input ? input.value.trim() : '';
    var chat = window.COSWeb && window.COSWeb.cosChat, b = briefShown();
    if (!text || TODAY.askBusy || !b || !chat || !chat.askAbout) return;
    TODAY.askBusy = true;
    var ctx = todayAskContext(b);
    go('messages', ['cos']);
    chat.askAbout(text, ctx).then(function () { input.value = ''; autoGrow(input); }, function (err) {
      toast((err && err.message) || 'Ask did not send. Your words are still in the box on Today.');
    }).then(function () { TODAY.askBusy = false; });
  }
  // From today's meetings: Work's suggestions from meetings held today. They stay here until
  // midnight, then join Sort in Work; Review opens them in Work's Sort.
  function localDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function loadTodayIntake() {
    var card = $('intake-card'); if (!card) return Promise.resolve();
    return api('/api/work-intake').then(function (d) {
      var today = localDay(new Date());
      var items = ((d && d.items) || []).filter(function (it) {
        if (['suggested', 'review', 'ask'].indexOf(it.status) < 0) return false;
        var day = String((it.meeting && (it.meeting.filename || it.meeting.date)) || '').match(/\d{4}-\d{2}-\d{2}/);
        return day && day[0] === today;
      });
      TODAY.intake = items; TODAY.intakeCaps = (d && d.capabilities) || {};
      // A decision made on Today hides its row at once; a read that no longer lists it ends the hiding.
      Object.keys(TODAY.gone).forEach(function (id) { if (!items.some(function (it) { return it.id === id; })) delete TODAY.gone[id]; });
      paintTodayIntake();
    }, function () { card.classList.add('hidden'); });
  }
  // Today's overlay (panes/today-actions.js) reads what the cards show from here and repaints the intake card after a
  // decision, so the counts move the moment Work takes it.
  var TODAY = { needs: [], working: [], open: [], welcome: {}, offline: false, at: 0, intake: null, intakeCaps: {}, gone: {},
    gen: 0, sessionsState: 'pending', workState: 'pending', voices: { state: 'pending', groups: [] }, memories: { state: 'pending', n: 0 }, extraAt: 0,
    recording: false, model: null, showAllNeeds: false, showLater: false };
  function todayIntakeOpen() { return (TODAY.intake || []).filter(function (it) { return !TODAY.gone[it.id]; }); }
  function paintTodayIntake() {
    var card = $('intake-card'); if (!card) return;
    var items = todayIntakeOpen();
    if (!items.length) { card.classList.add('hidden'); return; }
    var meetings = {};
    items.forEach(function (it) { var t = (it.meeting && it.meeting.title) || 'A meeting'; meetings[t] = (meetings[t] || 0) + 1; });
    $('intake-count').textContent = String(items.length);
    $('intake-body').innerHTML = Object.keys(meetings).slice(0, 4).map(function (t) {
      return '<button type="button" class="intake-row" data-today="meeting" data-key="' + esc(t) + '"><span class="intake-meeting">' + esc(t) + '</span><span class="intake-n">' + meetings[t] + '</span></button>';
    }).join('') + '<p class="intake-foot">Moves to Work at midnight.</p>';
    card.classList.remove('hidden');
  }
  function openTodayAction(t, kindIn, keyIn) {
    var kind = kindIn || t.getAttribute('data-today'), key = keyIn != null ? keyIn : t.getAttribute('data-key') || '';
    ensurePane('todayActions', 4000).then(function (m) {
      if (!m || !m.open) throw new Error('The Today overlay did not start.');
      m.open(kind, key, t);
    }).catch(function (err) {
      // Without the overlay, the tap goes where it went before: the session reader, or Sort in Work. Web has no client
      // log route, so the failure is said on screen and in the console first. An overlay that half opened leaves its
      // history entry, which the fallback replaces, so Back from there still lands on Today.
      var s = String(kind === 'run' || kind === 'wait' ? key : t.getAttribute('data-session-key') || '').split('|');
      var session = (kind === 'run' || kind === 'wait' || kind === 'need') && !!s[1];
      var dest = session ? ['sessions', s[0], s.slice(1).join('|')] : kind === 'pet' ? ['sessions'] : ['work'].concat(kind === 'need' ? [] : ['sort']);
      console.error('[today] the overlay did not open (' + kind + '); opening ' + dest.join('/') + ' instead.', err);
      toast(session ? 'Could not open that here. Opening the session.' : kind === 'pet' ? 'Could not open that here. Opening Sessions.' : 'Could not open that here. Opening it in Work.');
      if (history.state && history.state.cosTodayOverlay) location.replace('#/' + dest.map(encodeURIComponent).join('/'));
      else go(dest[0], dest.slice(1));
    });
  }
  function setBadge(name, on) { document.querySelectorAll('[data-badge="' + name + '"]').forEach(function (b) { b.classList.toggle('hidden', !on); }); }

  // ── Sessions ────────────────────────────────────────────
  // Control's Sessions pane (ActivityWindow.swift sessionsList 2288-2366, sessionRow 2773-2865,
  // sessionsStatus 2911-2933; Models.swift ClaudeSession 1762-2150): one flat list on a clock
  // (Updated, Opened, Pinned), the ON DISK / WAITING / PINNED strip, and per row the provider
  // badge, PINNED, the state chip, "Updated <time>" and, for twins, "Opened <date>". The pane holds
  // three views, Sessions | Usage | COS cost, as on the Mac. Data: GET /api/agent-sessions and
  // /api/agent-sessions/search. The Mac's own enrichment (Desktop titles, scheduled jobs, the
  // jobs-today list) has no server route, so it is not here.
  var SX_PREFS = 'cos_web_sessions';
  function sxPref(key, fallback, allowed) { var v = readStore(SX_PREFS)[key]; return allowed.indexOf(v) >= 0 ? v : fallback; }
  // Usage's own choices ride along once they have been read, so an early save never writes defaults over them.
  function sxSave() {
    var v = readStore(SX_PREFS);
    v.clock = SX.clock; v.view = SX.view; v.recency = SX.recency;
    if (SX.uPrefsLoaded) { v.uPeriod = SX.uPeriod; v.uFrom = SX.uFrom; v.uTo = SX.uTo; v.uMeasure = SX.uMeasure; v.uSeries = SX.uSeries; v.uScale = SX.uScale; v.uLines = SX.uLines; }
    writeStore(SX_PREFS, v);
  }
  var SX = {
    rows: null, dropped: null, enabled: true, loading: false, error: '', loadedAt: 0,
    clock: sxPref('clock', 'updated', ['updated', 'opened', 'pinned']),
    view: sxPref('view', 'sessions', ['sessions', 'usage', 'cost']),
    recency: sxPref('recency', 'newest', ['newest', 'oldest', 'match']),
    q: '', instant: [], remote: [], searching: false, searchError: '', ranFor: '', semantic: null, semanticReason: '', searchSeq: 0, searchTimer: null,
    hooks: null, hooksAt: 0,
    usage: null, usageAt: 0, usageLoading: false, usageError: '',
    uPeriod: 'Last 30 days', uTool: 'All tools', uModel: 'All models',
    // Usage on a wide screen (uWideModel): the custom range, the chart sentence, the chosen bar, the table's order.
    uFrom: '', uTo: '', uMeasure: 'all', uSeries: 'tool', uScale: '', uScaleBeforeHistory: '', uDayJump: false, uLines: false,
    uInspect: null, uPinned: null, uSort: 'tokens', uSortAsc: false, uOpen: {}, uCols: null, uToolBefore: null, uM: null
  };
  var SX_VIEWS = { sessions: 'Sessions', usage: 'Usage', cost: 'COS cost' };

  function sxProvider(p) { return p === 'codex' || p === 'cursor' ? p : 'claude'; }
  function sxProviderLabel(p) { p = sxProvider(p); return p === 'codex' ? 'Codex' : p === 'cursor' ? 'Cursor' : 'Claude'; }
  // Each platform's own mark, the same SVGs COS Control draws (Resources/mark-claude.svg, mark-codex.svg,
  // mark-cursor.svg): Claude, OpenAI and Cursor. One filled path each, tinted by the tile's provider color.
  var SX_GLYPHS = {
    claude: '<path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>',
    codex: '<path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/>',
    cursor: '<path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/>'
  };
  function sxGlyph(p) {
    p = sxProvider(p);
    return '<span class="sx-glyph ' + p + '" role="img" aria-label="' + (p === 'codex' ? 'ChatGPT' : sxProviderLabel(p)) + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + SX_GLYPHS[p] + '</svg></span>';
  }
  function sxBadge(p) { p = sxProvider(p); return '<span class="sx-badge ' + p + '">' + sxProviderLabel(p).toUpperCase() + '</span>'; }

  // ClaudeSession.title: the job label, else the name, else the workspace, else the id.
  function sxTitle(s) {
    var t = plain(s.display_label || s.custom_title || '').replace(/\s+/g, ' ').trim();
    return t || String(s.project || '').trim() || String(s.session_id || s.id || 'Session');
  }
  function sxWarmWords(t) { t = String(t || '').trim().toLowerCase(); return t === 'ready' || t.indexOf('this is an automated local readiness check') === 0; }
  // A warm-up is known by its first prompt, never by a title someone gave it (Models.swift isKeepWarm).
  function sxKeepWarm(s) { return sxWarmWords(s.display_label) && (!s.first_prompt || sxWarmWords(s.first_prompt)); }
  function sxTime(v) { var d = toDate(v); return d ? d.getTime() : 0; }
  function sxShortDate(d) {
    if (d.toDateString() === new Date().toDateString()) return clock(d);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // The row's state in Control's words (HelperSources/main.swift sessionStateFromServer and
  // claudePeerState): the server's derivation when the hooks or the registry back it; otherwise a
  // Claude row with no live process is stale, and the rest read from the server's own state.
  var SX_FROM_SERVER = { running: 'running', waiting: 'waiting', idle: 'recent', ended: 'stale', failed: 'error' };
  function sxState(s) {
    var a = s.agent_state || '', src = s.state_source || '';
    if ((src === 'hook' || src === 'registry') && SX_FROM_SERVER[a]) return SX_FROM_SERVER[a];
    if (sxProvider(s.provider) === 'claude' && !s.alive) return 'stale';
    if (a === 'waiting') return 'waiting';
    if (a === 'failed') return 'error';
    return s.running_active || a === 'running' ? 'running' : 'recent';
  }
  function sxNeedsPerson(s) { var st = sxState(s); return st === 'waiting' || st === 'error'; }
  // "Permission: Bash git push", "Question", "Plan approval", "Input".
  function sxWaitingKind(kind, detail) {
    detail = String(detail || '').trim();
    if (kind === 'permission') return detail ? 'Permission: ' + detail : 'Permission';
    if (kind === 'question') return 'Question';
    if (kind === 'plan') return 'Plan approval';
    if (kind === 'mcp_input') return 'Input';
    if (!kind) return detail;
    var cap = String(kind).charAt(0).toUpperCase() + String(kind).slice(1);
    return detail ? cap + ': ' + detail : cap;
  }
  function sxStateLabel(s, st) {
    var base = '';
    if (st === 'waiting') { var k = sxWaitingKind(s.waiting_kind, s.waiting_detail); base = k ? 'Waiting · ' + k : 'Waiting'; }
    else if (st === 'stale') base = 'Stale';
    else if (st === 'running') base = 'Running';
    else if (st === 'error') base = s.failure ? 'Failed · ' + String(s.failure).replace(/_/g, ' ') : 'Failed';
    var queued = Number(s.queued_turns) || 0;
    if (queued > 0) return base ? base + ' · ' + queued + ' queued' : queued + ' queued';
    return base;
  }

  function sxReal() { return (SX.rows || []).filter(function (s) { return !sxKeepWarm(s); }); }
  function byUpdated(a, b) { return sxTime(b.modified) - sxTime(a.modified); }
  // visibleSessions: Updated is every row by its last update; Opened is what is alive or was opened
  // in the last 7 days, newest first; Pinned is the pins.
  function sxVisible() {
    var real = sxReal();
    if (SX.clock === 'opened') {
      var week = Date.now() - 7 * 86400000;
      return real.filter(function (s) { if (s.alive) return true; var t = sxTime(s.created) || sxTime(s.modified); return t > 0 && t >= week; })
        .sort(function (a, b) { return sxTime(b.created) - sxTime(a.created); });
    }
    if (SX.clock === 'pinned') return real.filter(function (s) { return !!s.pinned; }).sort(byUpdated);
    return real.slice().sort(byUpdated);
  }
  // Two rows with one name are almost always a fork and its parent: those rows say when each opened.
  function sxAmbiguous(rows) {
    var seen = {}, dupes = {};
    rows.forEach(function (s) { var k = sxTitle(s); if (seen[k]) dupes[k] = true; else seen[k] = true; });
    return dupes;
  }
  function sxDropped() {
    var d = SX.dropped || {}, parts = [];
    var age = Math.max(0, Number(d.age) || 0), cap = Math.max(0, Number(d.limit) || 0), big = Math.max(0, Number(d.oversized) || 0);
    if (age) parts.push(age + ' older than 7 days');
    if (cap) parts.push(cap + ' over the cap');
    if (big) parts.push(big + ' too large');
    return { age: age, summary: parts.length ? parts.join(' · ') + ' not shown' : '' };
  }
  function sxQueryActive() { return SX.q.trim().length >= 2; }

  function sxDetailLine(vis) {
    if (sxQueryActive()) return SX.searching ? 'Looking up…' : 'Lookup across Claude, Codex, and Cursor';
    if (SX.loading) return vis.length ? 'Refreshing…' : 'Claude · Codex · Cursor · reading the last 7 days…';
    if (SX.error) return SX.error;
    if (!vis.length) return 'No sessions';
    if (SX.clock === 'opened') return 'Claude · Codex · Cursor · opened in last 7 days';
    if (SX.clock === 'pinned') return 'Claude · Codex · Cursor · pinned';
    var dropped = sxDropped().summary;
    return dropped ? 'Last 7 days · ' + dropped : 'Claude · Codex · Cursor · updated in last 7 days';
  }
  function sxStats(vis) {
    if (!vis.length && SX.loading && !sxQueryActive()) return [['–', 'ON DISK'], ['–', 'WAITING'], ['–', 'PINNED']];
    if (!vis.length) return [];
    return [[vis.length, 'ON DISK'], [vis.filter(sxNeedsPerson).length, 'WAITING'], [vis.filter(function (s) { return !!s.pinned; }).length, 'PINNED']];
  }
  function sxEmptyCopy() {
    if (SX.clock === 'opened') return 'No sessions opened in the last 7 days. Pins are under Pinned.';
    if (SX.clock === 'pinned') return 'No pinned sessions. Star Claude Desktop chats, pin Cursor chats, or pin Codex/ChatGPT threads to see them here.';
    var d = sxDropped();
    if (d.summary && d.age > 0) return 'No sessions updated on this Mac in the last 7 days. ' + d.summary.replace(/ not shown$/, '') + '. Search to find them.';
    return 'No Claude, Codex, or Cursor sessions updated on this Mac in the last 7 days.';
  }
  function sxEmpty(text) { return '<div class="cx-list"><p class="cx-empty">' + esc(text) + '</p></div>'; }

  // The hero, the view switch and the clock: painted on every change so the counts never lag the list.
  function paintSessionsHero() {
    var hero = $('sessions-hero'), views = $('sessions-views');
    if (!hero || !views) return;
    var view = SX.view, vis = SX.rows ? sxVisible() : [];
    var detail = view === 'cost' ? 'What COS itself used, on top of your sessions' : view === 'usage' ? 'Token usage and estimated API value' : sxDetailLine(vis);
    var stats = view === 'sessions' ? sxStats(vis) : [];
    var busy = view === 'sessions' ? SX.loading : SX.usageLoading;
    hero.innerHTML = '<span class="cx-glyph"><svg class="icon"><use href="#i-sessions"/></svg></span>' +
      '<div class="cx-hero-text"><h1 class="cx-title">Sessions</h1><p class="cx-detail-line">' + esc(detail) + liveHeroNote(view) + '</p></div>' +
      '<div class="cx-actions"><button type="button" class="cx-btn quiet" data-sx="refresh"' + (busy ? ' disabled' : '') + '><svg class="icon"><use href="#i-refresh"/></svg>Refresh</button></div>' +
      (stats.length ? '<div class="cx-stats">' + stats.map(function (s) { return '<span class="cx-stat"><b>' + esc(typeof s[0] === 'number' ? s[0].toLocaleString() : s[0]) + '</b><span>' + s[1] + '</span></span>'; }).join('') + '</div>' : '');
    var clockOn = view === 'sessions' && !sxQueryActive();
    views.innerHTML = '<div class="cx-switch" role="group" aria-label="Sessions view">' +
        Object.keys(SX_VIEWS).map(function (v) { return '<button type="button" data-sx="view" data-view="' + v + '" aria-pressed="' + (v === view) + '">' + SX_VIEWS[v] + '</button>'; }).join('') +
      '</div>' +
      (clockOn ? '<div class="cx-switch sx-clock" role="group" aria-label="Clock">' +
        [['updated', 'Updated'], ['opened', 'Opened'], ['pinned', 'Pinned']].map(function (c) { return '<button type="button" data-sx="clock" data-clock="' + c[0] + '" aria-pressed="' + (c[0] === SX.clock) + '">' + c[1] + '</button>'; }).join('') +
      '</div>' : '');
    var split = $('sessions-split'), usage = $('sessions-usage');
    if (split) split.classList.toggle('hidden', view !== 'sessions');
    if (usage) usage.classList.toggle('hidden', view === 'sessions');
  }

  // 7.0.1: the hero's counts say when they are not live ("Reconnecting", "as of 2 min ago"); nothing without a stream.
  function liveHeroNote(view) {
    if (view !== 'sessions' || typeof liveSessionsNote !== 'function') return '';
    var n = liveSessionsNote();
    return '<span class="sx-live-note">' + (n ? ' · ' + esc(n) : '') + '</span>';
  }
  function loadSessions(force) {
    var r = parseRoute();
    var reading = r.pane === 'sessions' && r.args.length === 2;
    if (reading) SX.view = 'sessions';
    else if (r.pane === 'sessions') window.COSWeb.setCrumb(SX.view === 'sessions' ? '' : SX_VIEWS[SX.view]);
    paintSessionsHero();
    if (SX.view !== 'sessions') { renderUsageView(force === true); return Promise.resolve(); }
    loadSessionHooks();
    if (force !== true && SX.rows && Date.now() - SX.loadedAt < 15000) { renderSessionGroups(); return Promise.resolve(); }
    // Paint the shared copy at once (Today usually fetched it) and refresh in place behind it.
    var cached = !SX.rows && sessionListCached();
    if (cached && cached.data && Array.isArray(cached.data.sessions)) {
      SX.rows = cached.data.sessions; SX.dropped = cached.data.dropped || null; SX.enabled = cached.data.enabled !== false;
      SX.loadedAt = cached.at;
      if (sxQueryActive()) SX.instant = sxInstant(SX.q);
      var fresh = force !== true && Date.now() - cached.at < 15000;
      SX.loading = !fresh;   // rows stay on screen; the header reads "Refreshing…" until the new list lands
      renderSessionGroups();
      if (fresh) return Promise.resolve();
    } else {
      SX.loading = true;
      renderSessionGroups();
    }
    return sessionList(force === true ? 0 : 15000).then(function (d) {
      SX.rows = (d && d.sessions) || [];
      SX.dropped = (d && d.dropped) || null;
      SX.enabled = !(d && d.enabled === false);
      SX.loading = false; SX.error = ''; SX.loadedAt = Date.now();
      state.sessions = SX.rows;
      if (sxQueryActive()) SX.instant = sxInstant(SX.q);
      renderSessionGroups();
    }).catch(function (err) {
      SX.loading = false;
      SX.error = (err && err.message) || 'Sessions did not load';
      renderSessionGroups();
    });
  }
  // The project most sessions share says nothing; name it only when a session differs (Today's rows).
  function usualProject() {
    var counts = {}, best = '', n = 0;
    state.sessions.forEach(function (s) { if (!s.project) return; counts[s.project] = (counts[s.project] || 0) + 1; if (counts[s.project] > n) { n = counts[s.project]; best = s.project; } });
    return best;
  }
  // The Ask sheet's compact row (⌘K recents and hits).
  function sessionRow(s, sub) {
    var key = splitSessionId(s.provider, s.session_id || s.id);
    var r = parseRoute();
    var selected = r.pane === 'sessions' && r.args[0] === key.provider && r.args[1] === key.id;
    var project = s.project && s.project !== usualProject() ? String(s.project).replace(/^-Users-[^-]+-/, '') : '';
    return '<button type="button" class="row" data-session="' + esc(key.provider) + '|' + esc(key.id) + '"' + (selected ? ' aria-selected="true"' : '') + '>' +
      '<span class="row-title">' + esc(sessionTitle(s)) + '</span>' +
      '<span class="row-side">' + esc(ago(s.last_activity_at || s.modified || s.created)) + '</span>' +
      '<span class="row-sub">' + badge(key.provider) + '<span class="clip">' + esc(sub || project) + '</span></span></button>';
  }
  // Control's row: glyph, title, a snippet on search hits, then badge · PINNED · state · Updated ·
  // Opened (twins only, amber) · workspace; a match chip and a chevron on the right.
  function sxRow(s, hit, ambiguous) {
    var key = splitSessionId(s.provider, s.session_id || s.id);
    var r = parseRoute();
    var selected = r.pane === 'sessions' && r.args[0] === key.provider && r.args[1] === key.id;
    var st = sxState(s), label = sxStateLabel(s, st), title = sxTitle(s);
    var upd = toDate(s.modified), opened = toDate(s.created);
    var meta = sxBadge(key.provider) +
      (s.pinned ? '<span class="sx-pinned">PINNED</span>' : '') +
      (label ? '<span class="sx-chip ' + st + '">' + esc(label) + '</span>' : '') +
      (notSentFor(key.provider, key.id) ? '<span class="sx-chip refused" title="' + esc(notSentFor(key.provider, key.id).line) + '">' + esc(notSentFor(key.provider, key.id).label || 'Not sent') + '</span>' : '') +
      (upd ? '<span class="sx-when">Updated ' + esc(sxShortDate(upd)) + '</span>' : '') +
      (ambiguous[title] && opened ? '<span class="sx-opened" title="Another session on screen has the same name. This one was opened ' + esc(sxShortDate(opened)) + '.">Opened ' + esc(sxShortDate(opened)) + '</span>' : '') +
      (s.project && String(s.project) !== title ? '<span class="sx-ws">' + esc(s.project) + '</span>' : '');
    var match = hit ? (hit.match === 'both' ? 'Keyword + meaning' : hit.match === 'semantic' ? 'Meaning' : 'Keyword') : '';
    // An instant title hit's snippet is the title itself; it says nothing twice.
    var snippet = hit && hit.snippet ? plain(hit.snippet).replace(/\s+/g, ' ').trim() : '';
    return '<button type="button" class="cx-row sx-row" data-session="' + esc(key.provider) + '|' + esc(key.id) + '"' + (selected ? ' aria-selected="true"' : '') + '>' +
      sxGlyph(key.provider) +
      '<span class="cx-row-body"><span class="sx-title">' + esc(title) + '</span>' +
      (snippet && snippet !== title ? '<span class="sx-snippet">' + esc(snippet) + '</span>' : '') +
      '<span class="sx-meta">' + meta + '</span></span>' +
      '<span class="sx-side">' + (match ? '<span class="sx-match">' + match + '</span>' : '') + '<span class="chev"></span></span></button>';
  }
  function sxListHtml() {
    if (!SX.rows) return SX.error ? sxEmpty(SX.error) : skeletonRows(6);
    if (!SX.enabled && !SX.rows.length) return sxEmpty('AI sessions are off. Turn on Show AI sessions in Settings, Work and agents.');
    var vis = sxVisible();
    if (!vis.length) return sxEmpty(SX.error || sxEmptyCopy());
    var amb = sxAmbiguous(vis);
    return '<div class="cx-list sx-list">' + vis.map(function (s) { return sxRow(s, null, amb); }).join('') + '</div>';
  }
  // The list, under the hero. The name stays: the shared input handler calls it when the search clears.
  function renderSessionGroups() {
    var input = $('sessions-q');
    var q = input ? input.value.trim() : '';
    if (q.length < 2 && SX.q) { SX.q = ''; SX.instant = []; SX.remote = []; SX.ranFor = ''; SX.searchError = ''; SX.semantic = null; SX.searching = false; }
    paintSessionsHero();
    paintHooks();
    var clear = $('sessions-clear'); if (clear) clear.classList.toggle('hidden', !(input && input.value));
    var hint = $('sessions-hint');
    if (hint) {
      var note = sxQueryActive() && SX.ranFor === SX.q && SX.semantic === false ? sxSemanticHint(SX.semanticReason) : '';
      hint.textContent = note; hint.classList.toggle('hidden', !note);
    }
    var list = $('sessions-list'); if (!list) return;
    list.innerHTML = sxQueryActive() ? sxSearchHtml() : sxListHtml();
  }

  // Search (ActivityWindow.swift sessionsSearchBar 2652-2712, ControllerModel scheduleSessionSearch):
  // instant title hits from the loaded list, then the server's keyword and meaning hits, one row
  // per session, ordered by the Recency choice.
  var SX_STOP = ['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'at', 'by', 'with', 'from', 'vs', 'is', 'it', 'be', 'as', 'we', 'our'];
  function sxTokens(q) {
    var seen = {}, out = [];
    String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).forEach(function (t) { if (t.length >= 2 && SX_STOP.indexOf(t) < 0 && !seen[t]) { seen[t] = true; out.push(t); } });
    return out;
  }
  function sxScore(tokens, title, hay) {
    if (!tokens.length) return 0;
    var tl = title.toLowerCase(), hl = hay.toLowerCase(), hits = 0, inTitle = 0;
    tokens.forEach(function (t) { var a = tl.indexOf(t) >= 0, b = hl.indexOf(t) >= 0; if (!a && !b) return; hits += 1; if (a) inTitle += 1; });
    if (!hits) return 0;
    var coverage = hits / tokens.length;
    if (coverage < 0.5 && !inTitle) return 0;
    return Math.min(1, coverage * 0.65 + (inTitle / tokens.length) * 0.35);
  }
  function sxInstant(q) {
    var tokens = sxTokens(q);
    if (!tokens.length) return [];
    return sxReal().map(function (s) {
      var t = sxTitle(s), v = sxScore(tokens, t, [s.display_label || '', s.project || '', t].join('\n'));
      return v > 0 ? { s: s, snippet: t, match: 'keyword', score: v } : null;
    }).filter(Boolean).sort(function (a, b) { return b.score - a.score; }).slice(0, 20);
  }
  function sxKey(s) { var k = splitSessionId(s.provider, s.session_id || s.id); return k.provider + ':' + k.id.toLowerCase(); }
  // One session whether the id is whole or the list's 8-character prefix (ClaudeSession.sameSession).
  function sxSame(a, b) {
    if (a === b) return true;
    var x = a.split(':'), y = b.split(':');
    if (x[0] !== y[0] || !x[1] || !y[1]) return false;
    var short = x[1].length <= y[1].length ? x[1] : y[1], long = short === x[1] ? y[1] : x[1];
    return short.length >= 8 && long.indexOf(short) === 0;
  }
  function sxHits() {
    var out = [];
    SX.instant.concat(SX.remote).forEach(function (h) {
      var k = sxKey(h.s);
      for (var i = 0; i < out.length; i++) if (sxSame(sxKey(out[i].s), k)) { if (out[i].score < h.score) out[i] = h; return; }
      out.push(h);
    });
    var date = function (h) { return sxTime(h.s.modified) || sxTime(h.s.created); };
    return out.sort(function (a, b) {
      if (SX.recency === 'match') return (b.score - a.score) || (date(b) - date(a));
      if (SX.recency === 'oldest') return ((date(a) || Infinity) - (date(b) || Infinity)) || (b.score - a.score);
      return (date(b) - date(a)) || (b.score - a.score);
    });
  }
  // A hit names the session as the search found it; the list's own row carries the live state.
  function sxListed(s) {
    var k = sxKey(s);
    var row = (SX.rows || []).filter(function (x) { return sxSame(sxKey(x), k); })[0];
    return row || s;
  }
  function sxSearchHtml() {
    var hits = sxHits();
    if (!hits.length) {
      if (SX.searching) return '<p class="cx-note sx-looking">Looking up…</p>';
      if (SX.searchError) return sxEmpty(SX.searchError);
      return sxEmpty('No sessions match that lookup.');
    }
    var rows = hits.map(function (h) { return { s: sxListed(h.s), h: h }; });
    var amb = sxAmbiguous(sxVisible().concat(rows.map(function (x) { return x.s; })));
    return '<div class="cx-list sx-list">' + rows.map(function (x) { return sxRow(x.s, x.h, amb); }).join('') + '</div>';
  }
  // The words Control shows when meaning search is not available (em dashes made periods).
  function sxSemanticHint(reason) {
    reason = String(reason || '');
    if (reason.indexOf('server_error_') === 0) return 'Keyword only. The server returned ' + reason.slice('server_error_'.length);
    if (reason === 'server_too_old') return 'Keyword only. Meaning search needs a server update';
    if (reason === 'server_unreachable') return 'Keyword only. The server did not answer in time';
    if (reason === 'no_server_token') return 'Keyword only. No server token available';
    if (reason === 'no_session_embeddings' || reason === 'embeddings_unreachable') return 'Keyword only. Meaning search needs an OpenAI key';
    return 'Keyword only. Meaning search is unavailable';
  }
  function searchSessions() {
    var input = $('sessions-q');
    var q = input ? input.value.trim() : '';
    clearTimeout(SX.searchTimer);
    SX.q = q;
    if (q.length < 2) { renderSessionGroups(); return; }
    if (q !== SX.ranFor) SX.remote = [];
    SX.instant = sxInstant(q);
    SX.searchError = '';
    SX.searching = true;
    var mine = ++SX.searchSeq;
    renderSessionGroups();
    api('/api/agent-sessions/search?q=' + encodeURIComponent(q) + '&limit=20').then(function (d) {
      if (mine !== SX.searchSeq) return;
      SX.remote = ((d && d.hits) || []).map(function (h) {
        return { s: h, snippet: h.snippet || '', match: h.match || 'keyword', score: Number(h.score) || Math.max(Number(h.keywordScore) || 0, Number(h.semanticScore) || 0) };
      });
      SX.semantic = !!(d && d.semanticAvailable === true);
      SX.semanticReason = (d && d.semanticReason) || '';
      SX.searching = false; SX.ranFor = q;
      renderSessionGroups();
    }, function (err) {
      if (mine !== SX.searchSeq) return;
      SX.searching = false; SX.ranFor = q; SX.remote = [];
      if (!SX.instant.length) SX.searchError = (err && err.message) || 'The lookup failed.';
      renderSessionGroups();
    });
  }
  // ── Meaning search (W1, 7.0.x): "Find a session about this", as COS Control's command panel does it
  // (SetupAssistant.swift 1476-1900). POST /api/agent-sessions/find takes exactly { query, consentedProvider, stage }
  // (routes/session-find.ts:45-51). Nothing is sent before the person says yes for the decision model that decides search
  // now. A yes for Jev is no yes for SubQ. The yes is kept in this browser only (the Mac keeps its own).
  var MEANING_STORE = 'cos.web.meaningConsent';
  var MEANING_NAME = { jev: 'Jev', subq: 'SubQ' };
  var MEANING_TITLE = { consent_required: 'Meaning search needs your okay', provider_changed: 'The decision model changed',
    decision_not_configured: 'Meaning search needs a key', jev_not_configured: 'Meaning search needs a key', sessions_off: 'Sessions are off',
    find_off: 'Meaning search is off', cap_reached: 'Meaning search is used up for today', breaker_open: 'Meaning search is paused',
    query_too_short: 'Type a few more words', failed: 'Meaning search did not answer' };
  var MEANING_STRENGTH = { strong: 'Strong match', likely: 'Likely match', possible: 'Possible match' };
  var MEANING = { view: null, at: 0 };
  function meaningChoices() {
    try { var v = JSON.parse(localStorage.getItem(MEANING_STORE) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
  }
  function meaningChoose(provider, choice) {
    if (!MEANING_NAME[provider]) return;
    var c = meaningChoices();
    if (choice === 'on' || choice === 'never') c[provider] = choice; else delete c[provider];
    try { localStorage.setItem(MEANING_STORE, JSON.stringify(c)); } catch (e) { /* private mode: the question comes back next time */ }
  }
  // GET /api/decision-provider: the model that decides search now, whether its key is saved, and whether this server can
  // find sessions by meaning at all (capabilities.sessionFind). Read again after a minute, or after a refusal.
  function meaningSettings(force) {
    if (!force && MEANING.view && Date.now() - MEANING.at < 60000) return Promise.resolve(MEANING.view);
    return api('/api/decision-provider').then(function (d) {
      var p = d && d.effective ? d.effective.search : null;
      p = MEANING_NAME[p] ? p : null;
      MEANING.view = { provider: p, keyed: !!(p && d.configured && d.configured[p] === true), capable: !!(d && d.capabilities && d.capabilities.sessionFind === true) };
      MEANING.at = Date.now();
      return MEANING.view;
    });
  }
  function meaningConsentText(provider) {
    return 'Each search sends the words you type here, plus the title and first 150 characters of the first prompt from up to 508 recent sessions, to ' +
      MEANING_NAME[provider] + '. Emails, links, home-folder paths and key-shaped text are removed first. Names and other details are not.' +
      (provider === 'subq' ? ' SubQ keeps what it is sent.' : '');
  }
  function meaningConsentHtml(provider) {
    return '<div class="list meaning-consent"><p class="empty"><strong>Find sessions by meaning with ' + esc(MEANING_NAME[provider]) + '?</strong>' + esc(meaningConsentText(provider)) + '</p>' +
      '<div class="row-actions"><button type="button" class="btn small primary" data-action="meaning-consent" data-provider="' + esc(provider) + '" data-choice="on">Turn on</button>' +
      '<button type="button" class="btn small" data-action="meaning-consent" data-provider="' + esc(provider) + '" data-choice="never">Never</button></div></div>';
  }
  function meaningRows(q, d) {
    var rows = (d && Array.isArray(d.rows)) ? d.rows : [];
    return '<h2 class="group-title"><span>About \u201c' + esc(q) + '\u201d</span><span>' + rows.length + '</span></h2><div class="list">' + rows.map(function (r) {
      var s = { provider: r.provider, session_id: r.session_id, display_label: r.display_label, custom_title: r.custom_title, first_prompt: r.first_prompt, project: r.project,
        modified: r.modified, last_activity_at: r.last_activity_at, alive: r.alive, pinned: r.pinned, slug: r.slug };
      return sessionRow(s, MEANING_STRENGTH[r.strength] || MEANING_STRENGTH.possible);
    }).join('') + '</div>';
  }
  function meaningRun(q, provider, stage) {
    return api('/api/agent-sessions/find', { method: 'POST', body: { query: q, consentedProvider: provider, stage: stage }, timeoutMs: 90000 }).then(function (d) {
      if (d && d.available === false) {
        if (d.reason === 'provider_changed') MEANING.view = null;
        return emptyBox(MEANING_TITLE[d.reason] || 'Meaning search did not run', d.message || '');
      }
      var rows = (d && Array.isArray(d.rows)) ? d.rows : [];
      // The first stage reads the newest 254 sessions; with nothing there, look once further back (Control's "Looking further back").
      if (!rows.length && stage === 'first') return meaningRun(q, provider, 'full');
      if (!rows.length) return emptyBox('Nothing close by meaning', 'Checked ' + (Number(d && d.asked) || 0) + ' sessions. Try other words, or search by words.');
      return meaningRows(q, d);
    });
  }
  function findByMeaning(q) {
    return meaningSettings(false).then(function (m) {
      if (!m.capable) return emptyBox('Meaning search is not on here', 'This COS server cannot find sessions by meaning. Search by words instead.');
      if (!m.provider || !m.keyed) return emptyBox('Meaning search needs a decision model', 'Choose Jev or SubQ in Settings, and save its key in COS Control on your Mac.');
      var choice = meaningChoices()[m.provider];
      if (choice === 'never') return emptyBox('Meaning search is off in this browser', 'You chose Never for ' + MEANING_NAME[m.provider] + '.') +
        '<div class="row-actions"><button type="button" class="btn small" data-action="meaning-consent" data-provider="' + esc(m.provider) + '" data-choice="ask">Ask me again</button></div>';
      if (choice !== 'on') return meaningConsentHtml(m.provider);
      return meaningRun(q, m.provider, 'first');
    }).catch(function (err) { return emptyBox('Meaning search did not run', (err && err.message) || ''); });
  }
  // ── end meaning search

  // The hooks banner (ActivityWindow.swift 2867-2905). Installing hooks writes to the Mac's Claude
  // settings, which stays a Mac action, so the web names where to do it.
  function loadSessionHooks() {
    if (Date.now() - SX.hooksAt < 60000) { paintHooks(); return; }
    SX.hooksAt = Date.now();
    api('/api/session-hooks/status').then(function (d) {
      SX.hooks = (d && d.sessionHooks && d.sessionHooks.state) || null; paintHooks();
    }, function (err) { SX.hooks = err && err.status === 404 ? 'route_absent' : null; paintHooks(); });
  }
  function paintHooks() {
    var el = $('sessions-hooks'); if (!el) return;
    var st = SX.hooks;
    if (['missing', 'drift', 'script_outdated', 'route_absent'].indexOf(st) < 0) { el.innerHTML = ''; return; }
    var text = st === 'route_absent' ? 'Live session state needs COS server 6.48.0 or later.'
      : st === 'missing' ? 'Claude Code hooks are not installed: sessions read from their transcripts only.'
      : 'Claude Code hooks need a refresh (' + (st === 'drift' ? 'settings changed' : 'script outdated') + ').';
    var where = st === 'route_absent' ? 'Update Server from COS Control on your Mac.' : (st === 'missing' ? 'Install hooks' : 'Reinstall hooks') + ' from COS Control on your Mac.';
    el.innerHTML = '<div class="sx-hooks"><span class="sx-hooks-dot" aria-hidden="true"></span><span>' + esc(text) + ' <span class="sx-hooks-where">' + esc(where) + '</span></span></div>';
  }

  // The view switch: Sessions | Usage | COS cost. A reader belongs to Sessions, so another view
  // closes it; the route repaints the pane and names the view in the breadcrumb.
  function setSessionsView(v) {
    if (!SX_VIEWS[v] || v === SX.view) return;
    SX.view = v; sxSave();
    go('sessions');
  }

  // Pane-level events for this pane's own controls (data-sx). Sends, Stop, Fork and the queue
  // keep their data-action names, which the shared listener handles.
  var sxPane = $('pane-sessions');
  if (sxPane) {
    if ($('sessions-recency')) $('sessions-recency').value = SX.recency;
    sxPane.addEventListener('click', function (e) {
      var t = e.target.closest('[data-sx]');
      if (!t || !sxPane.contains(t)) return;
      var act = t.getAttribute('data-sx'), rd = state.reading;
      if (act === 'view') return setSessionsView(t.getAttribute('data-view'));
      if (act === 'clock') { SX.clock = t.getAttribute('data-clock'); sxSave(); return renderSessionGroups(); }
      if (act === 'refresh') {
        if (SX.view !== 'sessions') return renderUsageView(true);
        SX.hooksAt = 0;
        loadSessions(true);
        if (sxQueryActive()) searchSessions();
        return;
      }
      if (act === 'clear') { var input = $('sessions-q'); input.value = ''; searchSessions(); input.focus(); return; }
      if (act === 'copy-session') return copySessionBrief();
      if (act === 'full') { if (SX_SPLIT) SX_SPLIT.toggleFull(); return; }
      if (act === 'refresh-turns' && rd) { rd.refusal = null; renderVerdict(rd); refreshTurns(rd.provider, rd.id); return; }
      if (act === 'retry' && rd) { rd.refusal = null; renderVerdict(rd); return sendSessionTurn(!!rd.retryFork); }
      if (act === 'caution-send' && rd) { rd.cautionAck = true; rd.cautionAsk = false; renderVerdict(rd); return sendSessionTurn(false); }
      if (act === 'caution-cancel' && rd) { rd.cautionAsk = false; renderVerdict(rd); return; }
      if (act === 'usage-clear') { SX.uTool = 'All tools'; SX.uModel = 'All models'; SX.uToolBefore = null; uSliceChanged(); return paintUsage(); }
      if (act === 'usage-range') return uOpenRange(t, true);
    });
    sxPane.addEventListener('input', function (e) {
      if (e.target.id !== 'sessions-q') return;
      clearTimeout(SX.searchTimer);
      if (e.target.value.trim().length < 2) { searchSessions(); return; }
      // The last answer belonged to other words: until this one lands, the instant title hits stand alone.
      SX.q = e.target.value.trim();
      if (SX.q !== SX.ranFor) { SX.remote = []; SX.searching = true; }
      SX.instant = sxInstant(SX.q);
      renderSessionGroups();
      SX.searchTimer = setTimeout(searchSessions, 350);
    });
    sxPane.addEventListener('change', function (e) {
      var id = e.target.id;
      if (id === 'sessions-recency') { SX.recency = e.target.value; sxSave(); return renderSessionGroups(); }
      // Custom dates opens the date sheet; the menu goes back to the range in force if it is cancelled.
      if (id === 'usage-period') { if (e.target.value === U_CUSTOM) return uOpenRange(e.target, true); SX.uPeriod = e.target.value; uPeriodChanged(); return paintUsage(); }
      if (id === 'usage-tool') { SX.uTool = e.target.value; SX.uModel = 'All models'; SX.uToolBefore = null; uSliceChanged(); return paintUsage(); }
      if (id === 'usage-model') { SX.uModel = e.target.value; SX.uToolBefore = null; uSliceChanged(); return paintUsage(); }
    });
  }

  // Duo tables: the divider between two columns, where both show side by side. One kit (splitKit) for every pane that
  // has them: a list beside its reader in Sessions (760 px and up), Memories (760 px and up) and Messages with the COS
  // chat (860 px and up), and a reader beside its side panel in a meeting (Ask, 860 px and up) and a Work card (900 px).
  // Drag it with a finger, mouse or pen (pointer events, captured, so a table's own sideways scroll and text selection
  // in the panes never start a drag), or focus it and use the arrow keys (Shift for bigger steps, Home and End).
  // A double tap or double click goes back to the default width. The width is a share of the split (CSS clamps it so the
  // list keeps 240 px and the reader 380 px, also after the screen turns) and is remembered on this device, one key per
  // pane; "Full width" in the reader hides the list and "Show list" brings it back. Storage that throws (a private
  // window) only means the choice lasts this visit. Below a pane's own breakpoint the divider is hidden by CSS and the
  // kit does nothing (o.media), so a phone's layout never changes.
  var SX_SPLIT_KEY = 'cos_web_sessions_split', SX_LIST_MIN = 240, SX_READER_MIN = 380, SX_HANDLE_W = 18, SX_KEY_STEP = 16, SX_DOUBLE_MS = 350;
  // o: key (storage), prefix (class names: <prefix>-sized, -full and -dragging), cssVar (the share, default
  // --<prefix>-list-share), label (what the divider sizes, for screen readers), sized (the column the share sizes,
  // default the list), side ('end' when that column is on the right: a side panel grows as the line moves left),
  // fullSel (the Full width buttons), media (where the divider shows), listMin (the sized column's minimum), readerMin
  // (the other column's), handleW (px, the same numbers as the pane's CSS clamp), memo (this visit's choice, kept across
  // a pane's repaint when storage is off).
  function splitKit(split, handle, storage, o) {
    var KEY = o.key, PRE = o.prefix || 'split', LIST_MIN = o.listMin || SX_LIST_MIN, READER_MIN = o.readerMin || SX_READER_MIN,
      HANDLE_W = o.handleW || SX_HANDLE_W, LIST_SEL = o.sized || '.split-list', FULL_SEL = o.fullSel || '[data-split-full="' + KEY + '"]', memo = o.memo || null,
      VAR = o.cssVar || '--' + PRE + '-list-share', END = o.side === 'end';
    var saved = {};
    try { var raw = JSON.parse(storage.getItem(KEY) || 'null'); if (raw && typeof raw === 'object') saved = raw; } catch (_e) { saved = {}; }
    if (memo && memo.at) saved = memo;
    var share = typeof saved.share === 'number' && saved.share > 0 && saved.share < 100 ? saved.share : null, full = saved.full === true, lastTap = 0;
    function save() {
      if (memo) { memo.share = share; memo.full = full; memo.at = Date.now(); }
      try { storage.setItem(KEY, JSON.stringify({ share: share, full: full })); } catch (_e) { /* this visit only */ }
    }
    // Narrow (a phone, the folded Duo): the divider is not shown, and nothing here may move the layout.
    function narrow() { return !!o.media && typeof matchMedia === 'function' && !matchMedia(o.media).matches; }
    function total() { return split.getBoundingClientRect().width; }
    function listWidth() { var l = split.querySelector(LIST_SEL); return l ? l.getBoundingClientRect().width : 0; }
    function bounds(t) { return { min: LIST_MIN, max: Math.max(LIST_MIN, t - HANDLE_W - READER_MIN) }; }
    function aria() {
      var t = total(); if (!(t > 0)) return;
      var b = bounds(t), pct = function (px) { return Math.round(px / t * 100); }, now = pct(listWidth());
      handle.setAttribute('aria-valuemin', String(pct(b.min)));
      handle.setAttribute('aria-valuemax', String(pct(b.max)));
      handle.setAttribute('aria-valuenow', String(now));
      handle.setAttribute('aria-valuetext', (o.label || 'List') + ' ' + now + '% of the width');
    }
    function paint() {
      split.classList.toggle(PRE + '-sized', share != null);
      if (share != null) split.style.setProperty(VAR, share.toFixed(2) + '%'); else split.style.removeProperty(VAR);
      split.classList.toggle(PRE + '-full', full);
      document.querySelectorAll(FULL_SEL).forEach(function (b) { b.setAttribute('aria-pressed', String(full)); b.textContent = full ? 'Show list' : 'Full width'; });
      aria();
    }
    // px: the sized column's width asked for; kept inside both columns' minimums for the split's width now.
    function setWidth(px, persist) {
      if (narrow()) return;
      var t = total(); if (!(t > 0)) return;
      var b = bounds(t);
      share = Math.min(b.max, Math.max(b.min, px)) / t * 100;
      paint();
      if (persist) save();
    }
    function reset() { share = null; paint(); save(); }
    handle.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (narrow()) return;
      e.preventDefault();
      var x0 = e.clientX, start = listWidth(), moved = false, id = e.pointerId;
      try { handle.setPointerCapture(id); } catch (_e) {}
      split.classList.add(PRE + '-dragging');
      // A column on the right grows as the pointer moves left.
      function dx(ev) { return END ? x0 - ev.clientX : ev.clientX - x0; }
      function move(ev) {
        if (ev.pointerId !== id) return;
        if (!moved && Math.abs(ev.clientX - x0) < 4) return;
        moved = true;
        setWidth(start + dx(ev), false);
      }
      function end(ev) {
        if (ev.pointerId !== id) return;
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
        split.classList.remove(PRE + '-dragging');
        // The lift's own position counts: a browser may fold the last moves into it.
        if (moved) { if (ev.type === 'pointerup') setWidth(start + dx(ev), false); save(); lastTap = 0; return; }
        if (ev.type !== 'pointerup') return;
        var now = Date.now();
        if (now - lastTap < SX_DOUBLE_MS) { lastTap = 0; reset(); } else lastTap = now;
      }
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    });
    handle.addEventListener('dblclick', function (e) { if (narrow()) return; e.preventDefault(); reset(); });
    handle.addEventListener('keydown', function (e) {
      if (narrow()) return;
      var t = total(), b = bounds(t), w = listWidth(), step = e.shiftKey ? SX_KEY_STEP * 4 : SX_KEY_STEP;
      // The arrows move the line the way they point; Home and End take it to the left and right limits.
      var left = END ? 1 : -1;
      var to = e.key === 'ArrowLeft' ? w + left * step : e.key === 'ArrowRight' ? w - left * step : e.key === 'Home' ? (END ? b.max : b.min) : e.key === 'End' ? (END ? b.min : b.max) : null;
      if (to == null) return;
      e.preventDefault();
      setWidth(to, true);
    });
    paint();
    return {
      setWidth: setWidth, reset: reset, paint: paint,
      toggleFull: function () { full = !full; paint(); save(); },
      state: function () { return { share: share, full: full }; }
    };
  }
  // Sessions: the first pane with the divider, unchanged (its markup is in index.html, its CSS in panes/sessions.css).
  var SX_SPLIT_OPTS = { key: SX_SPLIT_KEY, prefix: 'sx', label: 'Session list', fullSel: '[data-sx="full"]', media: '(min-width: 760px)',
    listMin: SX_LIST_MIN, readerMin: SX_READER_MIN, handleW: SX_HANDLE_W };
  function sxSplitKit(split, handle, storage) { return splitKit(split, handle, storage, SX_SPLIT_OPTS); }
  // The other panes (W.splitKit): the divider's markup, a Full width button, and mount, which binds the kit to a split
  // the pane just drew. One live kit per key; a pane that draws its split again gets a fresh kit with this visit's choice.
  var SPLITS = {}, SPLIT_MEMO = {}, SPLIT_NO_STORE = { getItem: function () { return null; }, setItem: function () {} };
  function splitStorage() { try { return window.localStorage || null; } catch (_e) { return null; } }
  function splitHandleHtml(o) {
    return '<div class="split-handle" role="separator" aria-orientation="vertical" aria-controls="' + esc(o.controls) + '" aria-label="' + esc(o.label + ' width') +
      '" tabindex="0" title="Drag to resize. Double-tap or double-click to reset."' + (o.id ? ' id="' + esc(o.id) + '"' : '') + '></div>';
  }
  function splitFullButton(key, controls) {
    var live = SPLITS[key], full = !!(live && live.kit.state().full);
    return '<button type="button" class="cx-btn quiet split-full-btn" data-split-full="' + esc(key) + '" aria-controls="' + esc(controls || '') + '" aria-pressed="' + full + '">' + (full ? 'Show list' : 'Full width') + '</button>';
  }
  function mountSplit(split, handle, o) {
    if (!split || !handle || !o || !o.key) return null;
    var live = SPLITS[o.key];
    if (live && live.split === split && live.handle === handle) return live.kit;
    var memo = SPLIT_MEMO[o.key] || (SPLIT_MEMO[o.key] = {});
    var kit = splitKit(split, handle, splitStorage() || SPLIT_NO_STORE, Object.assign({}, o, { memo: memo }));
    SPLITS[o.key] = { kit: kit, split: split, handle: handle };
    return kit;
  }
  var SX_SPLIT = null;
  (function () {
    var split = $('sessions-split'), handle = $('sessions-handle');
    if (!split || !handle) return;
    var store = splitStorage();
    SX_SPLIT = sxSplitKit(split, handle, store || SPLIT_NO_STORE);
  })();
  // A turned screen or a fold changes the split's width: every divider on the page repaints its limits.
  window.addEventListener('resize', function () {
    if (SX_SPLIT) SX_SPLIT.paint();
    Object.keys(SPLITS).forEach(function (k) { var s = SPLITS[k]; if (s.split.isConnected) s.kit.paint(); });
  });
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-split-full]') : null;
    var live = b ? SPLITS[b.getAttribute('data-split-full')] : null;
    if (live) live.kit.toggleFull();
  });

  // ── Sessions: read, send, queue, fork, stop (the glasses' Continue, from a browser) ──
  // The server owns every safety rule (agent-session-bindings.ts): COS writes into a desktop
  // thread only through a binding, attaches only when no live process owns the thread, and
  // re-checks before delivery. This page follows the same order the glasses do:
  //   attach (or reuse this tab's binding) -> send the turn under ONE key per draft ->
  //   if the session is busy, park it in the session's queue -> watch the live stream.
  // A refusal is an answer with the server's own words, never an error to retry blindly. The
  // draft key is reused on a resend, so a retry after a lost answer can never post twice.
  // One id for the life of the page, read once. Without storage (a private window) the old code made
  // a new id on every call, so one page sent different ids to /attach, /queued-turns and /fork.
  var WEB_SESSION_KEY = 'cos_web_sid';
  var webSessionId = null;
  function cosSessionId() {
    if (webSessionId) return webSessionId;
    var stored = null;
    try { stored = localStorage.getItem(WEB_SESSION_KEY); } catch (_e) { stored = null; }
    if (stored && /^web-[a-z0-9]{8,24}$/.test(stored)) return (webSessionId = stored);
    webSessionId = 'web-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
    try { localStorage.setItem(WEB_SESSION_KEY, webSessionId); } catch (_e) {}
    return webSessionId;
  }
  function newTurnKey() { return 'ct' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10).padEnd(8, '0'); }
  function targetKey(provider, id) { return provider.length + ':' + provider + ':' + id.length + ':' + id; }
  var BINDING_REUSE_MS = 25 * 60000; // the server keeps a binding 30 min
  var PARKABLE_REFUSALS = /^(native_thread_working|native_target_busy|target_busy)$/;
  // A binding is kept per browser, across reloads: the server allows one live binding per
  // thread, so a reload that forgot it would read its own binding as "target busy".
  var BINDINGS_KEY = 'cos_web_bindings';
  function readBindings() {
    try { var all = JSON.parse(localStorage.getItem(BINDINGS_KEY) || '{}'); return all && typeof all === 'object' ? all : {}; } catch (_e) { return {}; }
  }
  function bindingFor(provider, id) {
    var b = readBindings()[provider + '|' + id];
    return b && typeof b.bindingId === 'string' && typeof b.epoch === 'number' && Date.now() - b.at < BINDING_REUSE_MS ? b : null;
  }
  function rememberBinding(provider, id, b) {
    var all = readBindings(), now = Date.now();
    Object.keys(all).forEach(function (k) { if (!all[k] || now - all[k].at >= BINDING_REUSE_MS) delete all[k]; });
    if (b) all[provider + '|' + id] = b; else delete all[provider + '|' + id];
    try { localStorage.setItem(BINDINGS_KEY, JSON.stringify(all)); } catch (_e) {}
  }
  function sessionPath(provider, id, tail) { return '/api/agent-sessions/' + encodeURIComponent(provider) + '/' + encodeURIComponent(id) + (tail || ''); }

  // 6.99.30 (QA, held from Codex for .30): a queued message the server refused or let expire is said where the person
  // looks, not only in the Sessions reader: a "Not sent" line in Today's sheet for that session and a chip on its row in
  // the Sessions list. What the server's queue said last, per session, in this browser for a day; each read of the
  // queue replaces it, so a row the server drops clears the mark.
  var NOT_SENT_KEY = 'cos_web_not_sent', NOT_SENT_KEEP_MS = 86400000;
  function notSentRows(rows) { return (rows || []).filter(function (t) { return t && (t.status === 'refused' || t.status === 'expired'); }); }
  // A row COS cannot tell went in or not (deliveryState unknown, e.g. a steer it could not confirm) is not "Not sent":
  // it may be in the session already, so it has its own label and its own line, never a "Not sent:" prefix.
  function maybeSent(t) { return !!(t && t.deliveryState === 'unknown'); }
  function notSentLabel(t) { return maybeSent(t) ? 'May have been sent' : 'Not sent'; }
  function notSentLine(t) {
    if (maybeSent(t)) return String(t.reasonCopy || 'May not have been sent. Read it, then say it again.').trim();
    var why = String((t && t.reasonCopy) || (t && t.status === 'expired' ? 'the thread stayed busy too long.' : 'the session refused it.')).trim();
    return /^not sent\b/i.test(why) ? why : 'Not sent: ' + why.charAt(0).toLowerCase() + why.slice(1);
  }
  function noteNotSent(provider, id, rows) {
    var all = readStore(NOT_SENT_KEY), k = provider + '|' + id, now = Date.now(), list = notSentRows(rows);
    Object.keys(all).forEach(function (x) { if (!all[x] || now - (Number(all[x].at) || 0) > NOT_SENT_KEEP_MS) delete all[x]; });
    if (list.length) all[k] = { n: list.length, line: notSentLine(list[list.length - 1]).slice(0, 240), label: notSentLabel(list[list.length - 1]), at: now }; else delete all[k];
    writeStore(NOT_SENT_KEY, all);
  }
  function notSentFor(provider, id) {
    var v = readStore(NOT_SENT_KEY)[provider + '|' + id];
    return v && Date.now() - (Number(v.at) || 0) <= NOT_SENT_KEEP_MS ? v : null;
  }

  // Like api(), but a 4xx refusal comes back as { status, body } instead of throwing, because
  // these routes answer "busy", "changed" or "not now" with a body the person should read.
  // A timeout here stays the caller's (an abort: "may have saved", a probe that gives up), never a down mark; api()
  // reads and the question poll are what say a hung Mac is not answering (6.99.32).
  function apiAnswer(path, opts) {
    var o = opts || {};
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl && o.timeoutMs ? setTimeout(function () { ctrl.abort(); }, o.timeoutMs) : null;
    var headers = { 'X-COS-Web': '1' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    var sentAt = Date.now();
    return fetch(path, { method: o.method || 'GET', headers: headers, credentials: 'same-origin', body: o.body !== undefined ? JSON.stringify(o.body) : undefined, signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        sxNoteClock(res, sentAt);
        noteServer(true);
        if (res.status === 401) { showAuth(); throw new Error('Signed out. Connect this browser again.'); }
        return res.text().then(function (t) { var b = {}; try { b = t ? JSON.parse(t) : {}; } catch (_e) { b = {}; } return { status: res.status, body: b || {} }; });
      }, function (err) {
        // A timeout this call asked for stays an abort (its callers say "may have saved"); the rest never reached the Mac.
        if (err && err.name === 'AbortError') throw err;
        noteServer(false);
        throw unreachableError(err);
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  // Per-browser memory for one session: messages held until a reply ends, and the queue keys
  // this browser parked (so Remove is offered only on its own rows). Both survive a reload.
  var HELD_KEY = 'cos_web_held', PARKED_KEY = 'cos_web_parked';
  function readStore(key) { try { var v = JSON.parse(localStorage.getItem(key) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_e) { return {}; } }
  function writeStore(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_e) {} }
  function saveHeld(r) {
    var all = readStore(HELD_KEY), k = r.provider + '|' + r.id;
    var keep = r.held.filter(function (h) { return !h.cancelled; }).map(function (h) {
      var o = { text: h.text, key: h.key, since: h.since };
      if (h.ids && h.ids.length) { o.ids = h.ids; if (h.files && h.files.length) o.files = h.files; }
      return o;
    });
    if (keep.length) all[k] = keep; else delete all[k];
    writeStore(HELD_KEY, all);
  }
  function rememberParked(r, key) {
    var all = readStore(PARKED_KEY), k = r.provider + '|' + r.id;
    all[k] = (all[k] || []).concat(key).slice(-50);
    writeStore(PARKED_KEY, all);
  }
  function parkedByMe(r, key) { return (readStore(PARKED_KEY)[r.provider + '|' + r.id] || []).indexOf(key) >= 0; }

  // The server serves at most 40 turns (lib/agent-session-turns.ts SESSION_TURNS_MAX), each
  // shaped to 4,000 characters. Control reads up to 120 from the Mac's own files.
  var SX_TURNS = 40;
  // Control's detail subtitle (Models.swift ClaudeSessionDetail.subtitle).
  function sxSubtitle(d, provider, turns, more) {
    var parts = [sxProviderLabel(d.provider || provider)];
    if (d.project) parts.push(String(d.project).replace(/^-Users-[^-]+-/, ''));
    if (d.git_branch && d.git_branch !== 'unknown') parts.push(String(d.git_branch));
    var total = Number(d.message_count) || 0;
    if (more) parts.push(total > turns.length && !d.truncated ? 'last ' + turns.length + ' of ' + total + ' turns' : 'last ' + turns.length + ' turns');
    else parts.push(turns.length + (turns.length === 1 ? ' turn' : ' turns'));
    if (Number(d.omitted_tools) > 0) parts.push('tools omitted');
    if (d.truncated) parts.push('large session · earlier turns skipped');
    return parts.join(' · ');
  }
  function sxTruncNote(d, turns, more) {
    if (!more) return '';
    var total = Number(d.message_count) || 0;
    return 'Showing the last ' + turns.length + (total > turns.length && !d.truncated ? ' of ' + total : '') + ' turns. Copy session keeps the original request plus the newest context.';
  }

  // Wide layouts: give the reader the whole width, or bring the list back (sxSplitKit). Hidden under 760 px by CSS.
  function sxFullButton() {
    var full = !!(SX_SPLIT && SX_SPLIT.state().full);
    return '<button type="button" class="cx-btn quiet sx-full-btn" data-sx="full" aria-controls="sessions-list-col" aria-pressed="' + full + '">' + (full ? 'Show list' : 'Full width') + '</button>';
  }
  function openSession(provider, id) {
    var reader = $('session-reader');
    if (!provider || !id) return;
    readerImagesStop($('session-turns'));
    if (state.stream) { state.stream.close(); state.stream = null; }
    clearInterval(state.turnPoll);
    if (state.reading) { clearInterval(state.reading.heldTimer); clearInterval(state.reading.feedTimer); }
    var held = (readStore(HELD_KEY)[provider + '|' + id] || []).filter(function (h) { return h && typeof h.text === 'string' && typeof h.key === 'string'; });
    var r = state.reading = { provider: provider, id: id, draft: null, live: null, held: held, flushing: null, feed: newFeed(), verdict: null, cautionAck: false, cautionAsk: false, refusal: null, detail: null, turns: [], more: false, queued: 0 };
    if (SX.view !== 'sessions') { SX.view = 'sessions'; sxSave(); paintSessionsHero(); }
    document.querySelectorAll('#sessions-list [data-session]').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-session') === provider + '|' + id)); });
    var listed = (SX.rows || []).filter(function (s) { return sxSame(sxKey(s), provider + ':' + String(id).toLowerCase()); })[0];
    if (listed) window.COSWeb.setCrumb(sxTitle(listed));
    reader.innerHTML = '<div class="sx-reader-head"><div class="skeleton" style="height:26px;width:70%;margin:6px 0 10px"></div><div class="skeleton" style="width:45%"></div></div>' + skeletonRows(3);
    api(sessionPath(provider, id, '?turns=' + SX_TURNS + '&cards=1')).then(function (d) {
      if (state.reading !== r) return;
      var turns = Array.isArray(d && d.recent_turns) ? d.recent_turns : ((d && d.recent_turns && d.recent_turns.turns) || (d && d.turns) || []);
      r.detail = d; r.turns = turns; r.more = d.recent_turns_more === true;
      r.queued = Number(d.queued_turns) || 0;
      var title = sxTitle(d);
      window.COSWeb.setCrumb(title);
      var trunc = sxTruncNote(d, turns, r.more);
      reader.innerHTML =
        '<div class="sx-reader-head"><div class="sx-head-line">' + sxBadge(provider) + '<h2 class="sx-reader-title">' + esc(title) + '</h2>' + sxFullButton() + '</div>' +
          '<p class="sx-subtitle">' + esc(sxSubtitle(d, provider, turns, r.more)) + '</p></div>' +
        '<div class="sx-activity" id="session-live" aria-live="polite"></div>' +
        '<div class="sx-mac-q" id="session-mac-q" role="status" hidden></div>' +
        (trunc ? '<p class="sx-note">' + esc(trunc) + '</p>' : '') +
        '<div class="turns sx-turns" id="session-turns">' + renderTurns(turns, d) + '</div>' +
        '<div class="sx-foot"><button type="button" class="cx-btn quiet" data-sx="copy-session" title="A kickstart brief for another agent, built from the turns COS serves. Not a Claude Code resume: it does not reopen this session.">Copy session</button>' +
          '<span class="sx-foot-note">Kickstart brief for another agent. Not a Claude Code resume.</span></div>' +
        '<p class="sx-copy-note hidden" id="session-copy-note" role="status"></p>' +
        '<div class="sx-chat">' +
          '<div id="session-verdict"></div>' +
          '<form class="composer att-composer" id="session-form" data-provider="' + esc(provider) + '" data-id="' + esc(id) + '">' +
            '<div class="cc-chips att-files hidden" id="session-files"></div>' +
            '<textarea id="session-input" rows="1" placeholder="Continue this session…" enterkeyhint="send" aria-label="Continue this session"></textarea>' +
            '<div class="composer-actions"><span id="session-clip" class="att-clip"></span><button type="button" class="btn small" data-action="fork-session" title="Copy this session and send the message to the copy">Fork</button>' +
            '<button type="submit" class="btn primary small" id="session-send">Send</button></div>' +
          '</form><div class="status-line" id="session-status"></div>' +
          '<p class="sx-caution hidden" id="session-caution"></p>' +
          '<div id="session-queue"></div>' +
        '</div>';
      readerImagesMount($('session-turns'), r);
      sxNoteList(r, d);
      setLive({});
      if (typeof readerMacPaint === 'function') readerMacPaint(r, sxState(d) === 'waiting');
      paintReaderFiles();
      paintWebKeyOffer(r);
      // The Mac's answer about files may not be in yet: ask once, then draw the clip.
      var kitR = readerKit(); if (kitR && !kitR.turnFiles()) kitR.ensureCaps().then(function () { paintReaderFiles(); paintWebKeyOffer(r); }, function () {});
      renderHeld(state.reading);
      loadQueue(provider, id);
      sxProbeAttach(r);
      if (state.reading.held.length) {
        sessionStatus('Waiting for the current reply. ' + (state.reading.held.length > 1 ? state.reading.held.length + ' messages send' : 'Yours sends') + ' as soon as it finishes. ', null, '<button type="button" class="link-btn" data-action="drop-after">Don’t send</button>');
        startHeldTimer(state.reading);
      }
      if (turns.length) requestAnimationFrame(function () { window.scrollTo(0, document.documentElement.scrollHeight); });
      watchSession(provider, id);
    }).catch(function (err) {
      if (state.reading !== r) return;
      reader.innerHTML = sxEmpty((err && err.message) || 'This session did not open.') + '<p class="sx-retry"><button type="button" class="cx-btn quiet" data-session="' + esc(provider) + '|' + esc(id) + '">Retry</button></p>';
    });
  }

  // ACTIVITY (ActivityWindow.swift SessionActivityFeed 6800-6890, SessionLiveFeed.swift): the state
  // word with its clock, the current prompt, the last eight tool lines, and the honest counters.
  // The reducer follows SessionLiveFeed.applying: a reseed (seq 1 after anything) starts over.
  function newFeed() { return { transport: 'idle', transportSeenAt: null, agentState: null, stateSince: null, stateSeenAt: null, seenMemo: null, statusAt: null, waitingKind: null, waitingDetail: null, failure: null, lastReply: null, prompt: '', tools: [], lastSeq: 0, lastEventAt: null, missed: 0, connected: false, fallback: null }; }
  function applyFeed(r, e) {
    if (typeof e.seq !== 'number') return;
    var f = r.feed;
    if (e.seq === 1 && f.lastSeq > 0) { var keep = f.connected, seenMemo = f.seenMemo; f = r.feed = newFeed(); f.connected = keep; f.seenMemo = seenMemo; }
    else if (f.lastSeq > 0 && e.seq > f.lastSeq + 1) f.missed += e.seq - f.lastSeq - 1;
    f.lastSeq = e.seq;
    f.lastEventAt = typeof e.at === 'number' ? new Date(e.at) : new Date();
    f.connected = true;
    if (f.fallback === 'reconnecting') f.fallback = null;
    if (e.kind === 'status') {
      f.statusAt = f.lastEventAt;
      // When this page first saw each state (its own clock): the Stop's echo window is measured by it. The
      // memo outlives a reseed, so a reconnect that repeats a state seen before a Stop is not news.
      var memo = f.seenMemo || (f.seenMemo = {});
      if (e.state) {
        if (!memo.stream || memo.stream.key !== e.state) memo.stream = { key: e.state, seen: Date.now() };
        f.transport = e.state; f.transportSeenAt = memo.stream.seen;
      }
      if (e.agent_state) {
        var since = toDate(e.state_since), hookKey = e.agent_state + '|' + sxMs(since);
        if (!memo.hook || memo.hook.key !== hookKey) memo.hook = { key: hookKey, seen: Date.now() };
        f.stateSeenAt = memo.hook.seen;
        f.agentState = e.agent_state; f.stateSince = since;
        f.waitingKind = e.waiting_kind || null; f.waitingDetail = e.waiting_detail || null; f.failure = e.failure || null;
        if (e.last_reply) f.lastReply = e.last_reply;
      }
    } else if (e.kind === 'prompt') {
      f.prompt = String(e.text || ''); f.tools = [];
    } else if (e.kind === 'tool') {
      f.tools.push({ seq: e.seq, verb: e.verb || 'tool', target: e.target || '' });
      if (f.tools.length > 8) f.tools.splice(0, f.tools.length - 8);
    }
  }
  // `other` is the stream's verb for every tool it has no verb for; its target names the tool ("Used SendMessage").
  var SX_VERBS = { read: 'Read', edit: 'Edited', write: 'Edited', bash: 'Ran', run: 'Ran', search: 'Searched', grep: 'Searched', glob: 'Searched', fetch: 'Fetched', web: 'Fetched', agent: 'Delegated', task: 'Delegated', other: 'Used' };
  function sxToolLine(t) { var v = String(t.verb || 'tool'); var w = SX_VERBS[v] || v.charAt(0).toUpperCase() + v.slice(1); return t.target ? w + ' ' + t.target : w; }
  // ONE STATE FOR THE SESSION CARD (6.99.29). Miles, 11/07 11:01: Today's session overlay showed
  // "Idle 40s" over "Working on: Yes install and proceed", beside "Working right now" and "The
  // session is busy" while the session ran its turn. Each piece read its own source: the badge the
  // hooks' derived state (which a turn delivered through the peer inbox does not move), the composer
  // the server's write gate, the send note the park answer, and a delivered live turn was read as a
  // finished one. Now every piece of the card (the badge word and clock, the prompt line's label,
  // Stop, the composer's park note and the reader's state line) reads sxTruth, and each signal says
  // what it saw and WHEN that became true; the freshest wins:
  //   hook   the stream's derived agent_state, since its state_since
  //   stream the stream's own state, when no derived state rides it, as of that status line
  //   list   the session row or detail: running_active as of its last activity, else since state_since
  //   gate   the server's write gate: native_thread_working on the attachability probe, a refused
  //          turn or a parked send, or a turn delivered live into the open session, as of the answer;
  //          a later free answer, or a COS child's turn that finished, clears it
  //   stop   this page's Stop (and a finished COS child turn): idle as of then, and no working signal
  //          that ARRIVED in the next SX_STOP_ECHO_MS counts (the stream's status trails a Stop). The
  //          window is the page's own clock (`seen`, when this page observed each signal), never the
  //          signal's server time, and a turn this page sends ends it (continueSession clears stoppedAt).
  // Waiting, failed and ended, from the hook or the session row, are the session's own words and stay:
  // a gate or stream that sees a busy file does not unseat a question (QA 6.99.29: the row and the
  // hook carry the same state_since, so the row's Waiting must hold as the hook's does). Signals with
  // the same time are ordered gate, stream, list, hook, stop: the hook's word wins a tie. Idle yields
  // only to working seen more than SX_IDLE_GRACE_MS after it, the server's rule for the flush that
  // trails a Stop (TRANSCRIPT_AFTER_IDLE_GRACE_MS).
  var SX_IDLE_GRACE_MS = 5000, SX_STOP_ECHO_MS = 8000, SX_GATE_RECHECK_MS = 20000, SX_PROBE_TIMEOUT_MS = 15000;
  var SX_TIE_RANK = { gate: 0, stream: 1, list: 2, hook: 3, stop: 4 };
  function sxMs(v) {
    var t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'string' && v ? Date.parse(v) : NaN;
    return isFinite(t) ? t : null;
  }
  var SX_HOOK_WORD = { running: 'Working', waiting: 'Waiting', failed: 'Failed', ended: 'Done', idle: 'Idle' };
  function sxSignals(r) {
    var f = r.feed || {}, out = [];
    // `seen`: when this page observed the signal (its own clock), for the Stop's echo window.
    if (f.agentState && SX_HOOK_WORD[f.agentState]) out.push({ word: SX_HOOK_WORD[f.agentState], at: sxMs(f.stateSince) || sxMs(f.statusAt) || 0, src: 'hook', seen: sxMs(f.stateSeenAt) });
    else if (f.statusAt) out.push({ word: f.transport === 'working' ? 'Working' : f.transport === 'done' ? 'Done' : 'Idle', at: sxMs(f.statusAt), src: 'stream', seen: sxMs(f.transportSeenAt) });
    if (r.list && r.list.at != null) out.push({ word: r.list.word, at: r.list.at, src: 'list', seen: sxMs(r.list.seen) });
    // A gate answer and a Stop are this page's own moments: ranked on the Mac's clock (sxServerTime) against the Mac's
    // own times, and kept on this page's clock as `seen` for the echo window (6.99.30, QA: clock skew).
    if (r.gate && r.gate.busy && r.gate.at != null) out.push({ word: 'Working', at: sxServerTime(r.gate.at), src: 'gate', seen: r.gate.at });
    var stop = sxMs(r.stoppedAt);
    if (stop !== null) out.push({ word: 'Idle', at: sxServerTime(stop), src: 'stop', seen: stop });
    return out;
  }
  /** { word, at, src }: the one state the whole card shows. Null before any signal. */
  function sxTruth(r) {
    var stop = sxMs(r.stoppedAt);
    var all = sxSignals(r).sort(function (a, b) { return a.at - b.at || SX_TIE_RANK[a.src] - SX_TIE_RANK[b.src]; });
    var best = null;
    all.forEach(function (c) {
      if (!best) { best = c; return; }
      if (c.word === 'Working') {
        // The Stop's echo, judged by when this page saw the signal (a signal with no arrival time: by its own).
        var seen = c.seen != null ? c.seen : c.at;
        if (stop !== null && seen >= stop && seen - stop < SX_STOP_ECHO_MS) return;
        if (stop !== null && seen < stop) return;
        if ((best.src === 'hook' || best.src === 'list') && (c.src === 'gate' || c.src === 'stream') && /^(Waiting|Failed|Done)$/.test(best.word)) return;
        if (best.word === 'Idle' && best.src !== 'stop' && c.src !== best.src && c.at <= best.at + SX_IDLE_GRACE_MS) return;
      }
      best = c;
    });
    return best;
  }
  /** Settle the page's working flag from the one state; true when it changed. */
  function sxSettle(r) {
    var t = sxTruth(r), working = !!(t && t.word === 'Working');
    r.live = r.live || {};
    var was = !!r.live.working;
    r.live.working = working;
    r.live.waiting = !!(t && t.word === 'Waiting');
    if (!working) { r.live.step = null; r.live.prose = null; }
    return was !== working;
  }
  /** What the server's write gate said, and when. A free answer clears an earlier busy one. */
  function sxNoteGate(r, busy) { r.gate = { busy: !!busy, at: Date.now() }; }
  /** The list or detail row's view, timed by its own evidence. */
  function sxNoteList(r, row) {
    if (!row) return;
    var waiting = sxState(row) === 'waiting', working = !!row.running_active && !waiting;
    var at = working ? (sxMs(row.last_activity_at) || sxMs(row.state_since)) : (sxMs(row.state_since) || sxMs(row.last_activity_at));
    // A row with no time of its own is the oldest word: the live feed outranks it the moment it speaks.
    var word = working ? 'Working' : waiting ? 'Waiting' : 'Idle', was = r.list;
    // Arrival is the first time this page saw THIS word at THIS time: a re-read of the same row is not news.
    r.list = { word: word, at: at != null ? at : 0, seen: was && was.word === word && was.at === (at != null ? at : 0) && was.seen != null ? was.seen : Date.now() };
  }
  /** A gate busy answer that decides the card is re-asked while the card shows it: 20 s after the last attempt, and
   *  each failed attempt doubles the wait, up to 16 times (QA 6.99.29: a failing probe was re-asked every second).
   *  Every attempt is stamped (gate.triedAt) and ends within SX_PROBE_TIMEOUT_MS (6.99.30: before that a probe that
   *  never answered left r.probing set, and the gate was never asked again). So a busy gate stands only while the
   *  server keeps answering busy, or keeps not answering, and a fresher signal (a Stop, the hook going idle more than
   *  the grace after it) still outranks it. `at` stays the time of the last ANSWER: a failure is no evidence of busy. */
  function sxGateStale(r) {
    var t = sxTruth(r);
    if (!(t && t.src === 'gate' && r.gate) || r.probing) return false;
    var last = Math.max(r.gate.at || 0, r.gate.triedAt || 0), fails = r.gate.failures || 0;
    return Date.now() - last > SX_GATE_RECHECK_MS * Math.min(Math.pow(2, fails), 16);
  }
  function sxFeedWord(r) {
    var t = sxTruth(r);
    return t ? t.word : 'Idle';
  }
  /** The prompt line: what the session works on, or what it was last asked. */
  function sxPromptLine(r, text) {
    return (sxFeedWord(r) === 'Working' ? 'Working on: ' : 'Last asked: ') + text;
  }
  function sxFeedDetail(f, word) {
    if (word === 'Waiting' && f.agentState === 'waiting') {
      var d = String(f.waitingDetail || '').trim();
      if (f.waitingKind === 'permission') return d ? 'Permission: ' + d : 'Permission';
      if (f.waitingKind === 'question') return 'Question';
      if (f.waitingKind === 'plan') return 'Plan approval';
      if (f.waitingKind === 'mcp_input') return 'Input';
      return d;
    }
    if (word === 'Failed' && f.agentState === 'failed') return String(f.failure || '').replace(/_/g, ' ');
    if (word === 'Idle' && f.agentState === 'idle') { var reply = String(f.lastReply || '').trim(); return reply ? 'last reply: ' + reply : ''; }
    return '';
  }
  function sxElapsed(f, r) {
    var t = r ? sxTruth(r) : null;
    var since = t && t.at ? new Date(t.at) : f.stateSince || f.lastEventAt;
    if (!since) return '';
    // QA 6.99.30 (Skeptic): every moment here is on the Mac's clock (the truth's own time, or the Mac's state_since), so
    // now is too; a phone a minute behind read "0s" for a minute.
    var s = Math.max(0, Math.floor((sxServerTime(Date.now()) - since.getTime()) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }
  function sxFallbackLine(reason) {
    if (reason === 'http_404') return 'No live feed for this session (no transcript to follow); showing the stored turns.';
    if (reason === 'http_503') return 'The server has no room for another live feed right now; showing the stored turns.';
    if (reason === 'reconnecting') return 'Reconnecting to the live feed…';
    if (reason === 'stream_lost') return 'The live feed stopped answering; showing the stored turns. Reopen the session to try again.';
    if (reason === 'unreachable') return 'Your Mac is not answering. This is the last state it sent.';
    return 'Live feed unavailable (' + reason + '); showing the stored turns.';
  }
  // The block keeps one size whatever it holds (/qa: the turns below moved while Miles read, as tool
  // lines and prose came and went): a label row with the counters, a state row with the clock and
  // Stop, one prompt line, and a tail of the newest tool lines and reply text, fixed in height and
  // anchored to its bottom, so the newest line shows and older lines slide out of view above it.
  function paintActivity(r) {
    var box = $('session-live');
    if (!box || state.reading !== r) return;
    var f = r.feed, live = r.live || {};
    var on = f.connected || f.lastSeq > 0 || live.working;
    var bits = [];
    if (on && f.missed > 0) bits.push('<span class="warn">missed ' + f.missed + '</span>');
    if (on && r.queued > 0) bits.push('<span class="accent">' + (r.queued === 1 ? '1 queued' : r.queued + ' queued') + '</span>');
    if (on && f.fallback === 'reconnecting') bits.push('<span>reconnecting…</span>');
    var html = '<div class="sx-act-label"><span>ACTIVITY</span>' + (bits.length ? '<span class="sx-act-bits">' + bits.join('') + '</span>' : '') + '</div>';
    if (on) {
      var word = sxFeedWord(r), detail = sxFeedDetail(f, word);
      html += '<div class="sx-act-state"><span class="sx-dot ' + word.toLowerCase() + '" aria-hidden="true"></span><strong>' + word + '</strong>' +
        '<span class="sx-act-detail">' + esc(detail) + '</span>' +
        '<span class="sx-act-clock" id="session-elapsed">' + esc(sxElapsed(f, r)) + '</span>' +
        (live.working ? '<button type="button" class="cx-btn quiet sx-act-stop" data-action="stop-session">Stop</button>' : '') + '</div>' +
        '<p class="sx-act-prompt">' + esc(f.prompt) + '</p>' +
        '<div class="sx-act-tail">' + f.tools.map(function (t) { return '<div class="sx-act-tool">' + esc(sxToolLine(t)) + '</div>'; }).join('') +
          (live.working && live.prose ? '<div class="sx-act-prose">' + esc(String(live.prose).slice(-600)) + '</div>' : '') + '</div>';
    } else {
      html += '<p class="sx-act-fallback">' + esc(f.fallback ? sxFallbackLine(f.fallback) : 'Connecting to the live feed…') + '</p>';
    }
    box.innerHTML = html;
    // The clock ticks only while the session works or waits (Control 0.5.337). A Working that only the write gate
    // says is re-asked even with no live feed (QA 6.99.29), so it cannot stand forever once the feed is lost.
    clearInterval(r.feedTimer); r.feedTimer = null;
    var t = sxTruth(r), w = t ? t.word : 'Idle';
    if (((f.connected || f.lastSeq > 0) && (w === 'Working' || w === 'Waiting')) || (t && t.src === 'gate' && w === 'Working')) {
      r.feedTimer = setInterval(function () {
        if (state.reading !== r) { clearInterval(r.feedTimer); return; }
        var el = $('session-elapsed'); if (el) el.textContent = sxElapsed(r.feed, r);
        if (sxGateStale(r)) sxProbeAttach(r);
      }, 1000);
    }
  }
  // EventSource hides the status of a refused stream, so one GET reads it for the fallback line.
  function sxProbeStream(provider, id, r) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    fetch(sessionPath(provider, id, '/stream?seed=turn'), { headers: { 'X-COS-Web': '1' }, credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) { var code = res.status; if (ctrl) ctrl.abort(); return code; }, function () { return 0; })
      .then(function (code) {
        if (state.reading !== r || r.feed.lastSeq > 0) return;
        r.feed.fallback = code === 200 ? 'stream_lost' : code ? 'http_' + code : 'unreachable';
        paintActivity(r);
      });
  }

  // The live stream: one JSON object per data line, `kind` = status | prompt | tool | prose | heartbeat.
  function watchSession(provider, id) {
    var r0 = state.reading;
    if (typeof EventSource !== 'function') { if (r0) { r0.feed.fallback = 'unsupported'; paintActivity(r0); } return; }
    var es;
    try { es = new EventSource(sessionPath(provider, id, '/stream?seed=turn')); } catch (_e) { if (r0) { r0.feed.fallback = 'unsupported'; paintActivity(r0); } return; }
    state.stream = es;
    var wasWorking = false, wasWaiting = false;
    es.onerror = function () {
      var r = state.reading;
      if (!r || r.id !== id || state.stream !== es) return;
      if (es.readyState === 2) {
        if (r.feed.lastSeq > 0) { r.feed.connected = false; r.feed.fallback = 'stream_lost'; paintActivity(r); }
        else sxProbeStream(provider, id, r);
      } else { r.feed.fallback = 'reconnecting'; paintActivity(r); }
    };
    es.onmessage = function (ev) {
      var e; try { e = JSON.parse(ev.data); } catch (_e) { return; }
      var r = state.reading;
      if (!r || r.id !== id) return;
      applyFeed(r, e);
      if (e.kind === 'status') {
        // 6.99.29: the one state (sxTruth), never this line's own reading of itself.
        setLive({});
        var working = !!(r.live && r.live.working);
        var waiting = !working && (e.state === 'waiting' || e.state === 'needs_input' || e.agent_state === 'waiting');
        var el = $('session-state');
        if (el) el.textContent = working ? 'Working now' : waiting ? 'Waiting for you' : 'Open';
        if (typeof readerMacPaint === 'function') readerMacPaint(r, waiting);
        if (wasWorking && !working) { refreshTurns(provider, id); replyEnded(r); }
        wasWorking = working;
        // Gone to waiting: its question may be parked for this page now (6.99.27).
        if (waiting && !working && !wasWaiting) questionsNudge();
        wasWaiting = waiting && !working;
      } else if (e.kind === 'tool') {
        setLive({ step: [e.verb, e.target].filter(Boolean).join(' ') });
      } else if (e.kind === 'prose' && e.text) {
        setLive({ prose: String(e.text) });
      } else if (e.kind === 'prompt') {
        paintActivity(r);
      }
    };
  }
  function setLive(patch) {
    var r = state.reading; if (!r) return;
    // The working flag is never set here: it is the one state's (sxSettle).
    var p = Object.assign({}, patch); delete p.working;
    r.live = Object.assign(r.live || {}, p);
    var moved = sxSettle(r);
    paintActivity(r);
    if (moved) renderVerdict(r);
  }
  function refreshTurns(provider, id) {
    var reading = state.reading;
    api(sessionPath(provider, id, '?turns=' + SX_TURNS + '&cards=1')).then(function (d) {
      var r = state.reading;
      if (!r || r !== reading || r.id !== id || r.provider !== provider) return;
      var turns = Array.isArray(d && d.recent_turns) ? d.recent_turns : [];
      var box = $('session-turns'); if (box) { sxMergeTurns(box, r.turns || [], turns, d); readerImagesMount(box, r); }
      // The header keeps the subtitle it opened with: a rewrap above the turns would move them.
      r.detail = d; r.turns = turns; r.more = d.recent_turns_more === true;
      renderHeld(r);
      loadQueue(provider, id);
      sxProbeAttach(r);
    }).catch(function () {});
  }
  // Control's queue line for a parked turn (Models.swift 1655): Next, 2nd in line, 3rd in line.
  function sxQueueLine(t) {
    var p = Number(t.position);
    if (!(p >= 0)) return 'Waiting';
    if (p === 0) return 'Next';
    if (p === 1) return '2nd in line';
    if (p === 2) return '3rd in line';
    return (p + 1) + 'th in line';
  }
  function loadQueue(provider, id) {
    apiAnswer(sessionPath(provider, id, '/queued-turns')).then(function (q) {
      var r = state.reading;
      var box = $('session-queue'); if (!box || !r || r.id !== id) return;
      var rows = (q.status === 200 && q.body && q.body.turns) || [];
      var waiting = rows.filter(function (t) { return t.status === 'waiting' || t.status === 'queued' || t.status === 'pending'; });
      // QA 6.99.29: a queued message the server refused (or let expire) stays in view with the server's reason,
      // instead of vanishing from the line.
      var notSent = notSentRows(rows);
      if (q.status === 200) noteNotSent(provider, id, rows);
      if (q.status === 200 && r.queued !== waiting.length) { r.queued = waiting.length; paintActivity(r); }
      if (!waiting.length && !notSent.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="sx-queue">' + (waiting.length ? '<p class="sx-queue-head">' + (waiting.length === 1 ? '1 follow-up queued. It sends when this session is available.' : waiting.length + ' follow-ups queued. They send in order when this session is available.') + '</p>' : '') +
        waiting.map(function (t) {
          var mine = t.owner !== 'codex' && parkedByMe(r, t.clientTurnId);
          return '<div class="sx-queue-row"><span class="sx-queue-state">' + esc(sxQueueLine(t)) + '</span><span class="sx-queue-text">' + esc(t.preview || t.prompt || 'Message') + '</span>' +
            (mine ? '<button type="button" class="cx-btn quiet" data-action="unqueue" data-turn-key="' + esc(t.clientTurnId) + '" title="Cancel this queued message. It will not be sent.">Cancel</button>' : '') + '</div>';
        }).join('') +
        notSent.map(function (t) {
          return '<div class="sx-queue-row sx-queue-refused"><span class="sx-queue-state">' + esc(notSentLabel(t)) + '</span><span class="sx-queue-text">' + esc(t.preview || t.prompt || 'Message') +
            '<span class="sx-queue-reason">' + esc(notSentLine(t)) + '</span></span></div>';
        }).join('') + '</div>';
    }).catch(function () {});
  }

  // What the server says about writing into this session before anything is sent (Control's
  // probeChatAttachability): a busy thread parks a send, another app holding it idle asks first,
  // and anything else is the server's refusal, word for word.
  function sxProbeAttach(r) {
    // Today's overlay probes its own session object (r.view): the same verdict, painted by its view.
    r.probing = true;
    // Every attempt is stamped; a failed one backs the next off (sxGateStale). A gate answer resets both.
    if (r.gate) r.gate.triedAt = Date.now();
    var failed = function () { if (r.gate) r.gate.failures = (r.gate.failures || 0) + 1; };
    return apiAnswer(sessionPath(r.provider, r.id, '/attachability'), { timeoutMs: SX_PROBE_TIMEOUT_MS }).then(function (a) {
      if (state.reading !== r && !r.view) return;
      if (a.status === 404) { failed(); r.verdict = { attachable: false, reason: 'route_absent', reasonCopy: 'Update the COS server to continue a thread from here.', ownerCount: 0 }; viewOf(r).verdict(r); return; }
      var b = a.body || {};
      if (a.status !== 200 || typeof b.attachable !== 'boolean') { failed(); return; }
      var owners = Number(b.ownerCount) || 0;
      r.verdict = { attachable: b.attachable, reason: String(b.reason || ''), reasonCopy: String(b.reasonCopy || ''), ownerCount: owners, caution: b.attachable === true && owners > 0,
        // Steer mid-turn: the server says whether a message sent now goes into the running turn.
        midTurn: !!(b.midTurn && b.midTurn.available === true) };
      // 6.99.29: the gate's answer is a signal of the one state, as of now.
      sxNoteGate(r, b.attachable === false && b.reason === 'native_thread_working');
      sxRepaint(r);
    }).catch(failed).finally(function () { r.probing = false; });
  }
  var SX_PARK = {
    cursor: 'Working right now. A message you send goes into this Cursor chat when its turn ends.',
    codex: 'Working right now. A message you send joins the Codex app’s queue for this thread.',
    claude: 'Working right now. A message you send waits and lands when this turn ends.'
  };
  // Steer mid-turn: only when the server says this session takes a message inside its running turn.
  var SX_PARK_MIDTURN = 'Working right now. Your message lands at its next step.';
  // QA 7.0.0: a message with files never goes in mid-turn (the drain steers words only; a row with files waits for the
  // turn end, and the park answer says landsAt turn_end). With files in the box the note says so.
  var SX_PARK_FILES = 'Working right now. A message with files waits and lands when this turn ends.';
  // `hasFiles`: a view (Today's sheet) says whether its own box holds files; the reader's box is read here.
  function sxParkLine(r, hasFiles) {
    if (!(r.verdict && r.verdict.midTurn === true)) return SX_PARK[sxProvider(r.provider)];
    if (hasFiles === undefined) hasFiles = sxReaderHasFiles(r);
    return hasFiles ? SX_PARK_FILES : SX_PARK_MIDTURN;
  }
  /** The composer's "Working right now" note: a busy gate verdict, and the one state agrees. */
  function sxParkNoteShows(r) {
    var v = r.verdict;
    if (!v || v.attachable !== false || !/^(native_thread_working|native_target_busy)$/.test(v.reason)) return false;
    return sxFeedWord(r) === 'Working' || v.reason === 'native_target_busy';
  }
  function sxSupplement(reason) {
    if (reason === 'native_target_busy') return 'It frees itself within 30 minutes. Detaching is not available in Control yet.';
    if (reason === 'native_target_fenced') return 'Fences can be released from the Fences card in this panel.';
    return '';
  }
  function renderVerdict(r) {
    var box = $('session-verdict'), line = $('session-caution');
    if (!box || state.reading !== r) return;
    var v = r.verdict, html = '';
    var forkBtn = '<button type="button" class="cx-btn quiet" data-action="fork-session" title="Runs your message in a copy of this thread. The original is untouched.">Fork with this message</button>';
    function refusalBox(copy, supplement, buttons) {
      return '<div class="sx-box refusal" role="status"><p>' + esc(copy) + '</p>' + (supplement ? '<p class="sx-box-sub">' + esc(supplement) + '</p>' : '') +
        (buttons ? '<div class="sx-box-actions">' + buttons + '</div>' : '') + '</div>';
    }
    if (r.cautionAsk) {
      html = '<div class="sx-box confirm" role="alertdialog" aria-labelledby="sx-caution-title" aria-describedby="sx-caution-body"><strong id="sx-caution-title">Send into an open session?</strong>' +
        '<p id="sx-caution-body">Another app on this Mac has this session open. It looks idle right now, but a reply will run with that session’s own permissions.</p>' +
        '<div class="sx-box-actions"><button type="button" class="cx-btn danger" data-sx="caution-send">Send anyway</button><button type="button" class="cx-btn quiet" data-sx="caution-cancel">Cancel</button></div></div>';
    } else if (r.refusal) {
      var f = r.refusal;
      html = refusalBox(f.copy, f.supplement,
        (f.changed ? '<button type="button" class="cx-btn quiet" data-sx="refresh-turns">Refresh</button><button type="button" class="cx-btn quiet" data-action="send-anyway">Continue anyway</button>' : '') +
        (f.retry ? '<button type="button" class="cx-btn quiet" data-sx="retry">Retry</button>' : '') +
        (f.fork ? forkBtn : ''));
    } else if (v && v.attachable === false && /^(native_thread_working|native_target_busy)$/.test(v.reason)) {
      // 6.99.29: "Working right now" only while the one state says so.
      if (sxParkNoteShows(r)) html = '<div class="sx-park"><p>' + esc(sxParkLine(r)) + '</p>' + (/fork/i.test(v.reasonCopy) ? '<div class="sx-box-actions">' + forkBtn + '</div>' : '') + '</div>';
    } else if (v && v.attachable === false && v.reasonCopy) {
      html = refusalBox(v.reasonCopy, sxSupplement(v.reason), /fork/i.test(v.reasonCopy) ? forkBtn : '');
    }
    box.innerHTML = html;
    if (line) {
      var caution = v && v.caution ? (sxProvider(r.provider) === 'codex'
        ? 'The Codex app has this thread open. COS will ask before the first send, then hands your message to the app’s own queue, where it shows.'
        : 'Another app on this Mac has this session open. COS will ask before the first send. The reply lands in the transcript; the open desk tab will not show it until you resume.') : '';
      line.textContent = caution; line.classList.toggle('hidden', !caution);
    }
  }

  /** Repaint whichever card shows this session after its one state moved (the reader or a view). */
  function sxRepaint(r) {
    sxSettle(r);
    if (r.view) { if (typeof r.view.stateChanged === 'function') r.view.stateChanged(r); else r.view.verdict(r); return; }
    if (state.reading === r) { paintActivity(r); renderVerdict(r); }
  }
  function sessionStatus(text, kind, actionHtml) {
    var el = $('session-status'); if (!el) return;
    el.className = 'status-line' + (kind === 'error' ? ' error' : '');
    el.innerHTML = esc(text || '') + (actionHtml || '');
  }
  // 11/07: the files sent with the words (media ids) are part of the draft: other files are another message, with a
  // key of its own, so the server never answers a new message with an old one's replay.
  function draftFor(text, r, ids) {
    r = r || state.reading;
    var files = Array.isArray(ids) ? ids.slice() : [];
    if (!r.draft || r.draft.text !== text || (r.draft.ids || []).join(',') !== files.join(',')) r.draft = { text: text, key: newTurnKey(), ids: files };
    return r.draft;
  }
  // The box is cleared only of the very words that were sent; anything typed since stays.
  function clearBoxOf(text) {
    var input = $('session-input');
    if (input && input.value.trim() === String(text).trim()) { input.value = ''; autoGrow(input); }
    if (state.reading && state.reading.draft && state.reading.draft.text === text) state.reading.draft = null;
  }
  // Words go back in the box only if the box is empty; otherwise the status line keeps them. `files` says what became
  // of the message's files (heldFilesBack).
  function returnToBox(text, why, files) {
    var input = $('session-input');
    if (input && !input.value.trim()) { input.value = text; autoGrow(input); sessionStatus(why + ' Your message is back in the box.' + (files || ''), 'error'); }
    else sessionStatus(why + ' Not sent: “' + String(text).slice(0, 80) + (text.length > 80 ? '…' : '') + '”' + (files || ''), 'error');
  }
  // Your words show in the conversation the moment the Mac accepts them; the next refresh of
  // the transcript replaces the bubble with the real turn.
  function showPendingTurn(text, note, heldKey) {
    var box = $('session-turns'); if (!box) return;
    var ph = box.querySelector('.reader-placeholder'); if (ph) ph.remove();
    var el = document.createElement('div');
    el.className = 'turn user pending';
    if (heldKey) el.setAttribute('data-held-key', heldKey);
    el.innerHTML = '<span class="who">You, ' + esc(note) + '</span>' + md(text);
    box.appendChild(el);
    requestAnimationFrame(function () { window.scrollTo(0, document.documentElement.scrollHeight); });
  }
  function heldBubble(key) { return document.querySelector('#session-turns .turn.pending[data-held-key="' + key.replace(/[^A-Za-z0-9_-]/g, '') + '"]'); }
  function renderHeld(r) {
    r.held.forEach(function (h) { if (!h.cancelled && !heldBubble(h.key)) showPendingTurn(h.text, 'sends after this reply', h.key); });
  }

  // Where the send path below reports: the reader's own page by default. Today's overlay (panes/today-actions.js)
  // hands continueSession a session object with its own view, so a reply or a steer from Today runs this same attach,
  // turn and queue path (one binding store, one key per draft, the same refusals). The overlay keeps its own copies of
  // the gates around it (sendSessionTurn), the turn watch (watchTurn) and the refusal box (renderVerdict).
  var READER_VIEW = {
    status: function (r, text, kind, actionHtml) { sessionStatus(text, kind, actionHtml); },
    pending: function (r, text, note) { showPendingTurn(text, note); },
    clear: function (r, text) { clearBoxOf(text); },
    verdict: function (r) { renderVerdict(r); },
    hold: function (r, draft) { holdUntilReplyEnds(r, draft); },
    watch: function (r, bindingId, key) { watchTurn(bindingId, key, r.provider, r.id); },
    queue: function (r) { loadQueue(r.provider, r.id); }
  };
  function viewOf(r) { return (r && r.view) || READER_VIEW; }

  // ── files with a message to a session (6.99.27, Miles: "We still don't have the ability to take picture, or add photo
  // or files from the web") ──
  // The COS chat's attach kit (panes/cos-chat.js, W.cosChat.attach), as on Today's reply box: Take photo and the clip,
  // any file the Mac takes on a turn (threadTurnFileBytes, 64 MB; a video 100 MB), up to 5, sent as it is. The ids go
  // with the words; the server writes where each file is on the Mac under them. One box per session, kept in this tab.
  var READER_FILES = {};
  function readerKit() { var c = window.COSWeb && window.COSWeb.cosChat; return c && c.attach ? c.attach : null; }
  function readerFilesOn() { var k = readerKit(); return !!(k && k.turnFiles() > 0 && state.reading); }
  function readerBox(r) {
    var kit = readerKit(); if (!kit || !r) return null;
    var key = r.provider + '|' + r.id;
    if (!READER_FILES[key]) READER_FILES[key] = kit.box({
      changed: function (box) { if (state.reading && READER_FILES[state.reading.provider + '|' + state.reading.id] === box) paintReaderFiles(); },
      removed: function () { sessionStatus(''); },
      signedOut: function () { sessionStatus('This browser was signed out. Your message and files are kept. Sign in, then tap Retry on each file.', 'error'); }
    }, { anyBytes: kit.turnFileBytes() });
    if (!READER_FILES[key].anyBytes && !READER_FILES[key].atts.length && kit.turnFileBytes()) READER_FILES[key].anyBytes = kit.turnFileBytes();
    return READER_FILES[key];
  }
  // Whether the reader's own box holds a file for this session (any state: a file still uploading goes with the message).
  function sxReaderHasFiles(r) {
    if (!r || r.view || state.reading !== r || !readerFilesOn()) return false;
    var box = readerBox(r);
    return !!(box && box.atts.length);
  }
  function readerFilesState(box) {
    var kit = readerKit();
    if (!kit || !box || !box.atts.length) return 'none';
    return kit.pending(box) ? 'waiting' : kit.failed(box) ? 'failed' : 'ready';
  }
  function paintReaderFiles() {
    var kit = readerKit(), r = state.reading, slot = $('session-clip'), list = $('session-files');
    if (!slot || !list) return;
    if (!readerFilesOn()) { slot.innerHTML = ''; list.innerHTML = ''; list.classList.add('hidden'); return; }
    var box = readerBox(r), full = box.atts.length >= kit.max, mode = String(box.anyBytes || 0);
    if (slot.getAttribute('data-mode') !== mode) { slot.innerHTML = kit.cameraHtml('data-sx-file') + kit.clipHtml('data-sx-file', { any: box.anyBytes }); slot.setAttribute('data-mode', mode); }
    Array.prototype.forEach.call(slot.querySelectorAll('.cc-attach'), function (l) { l.classList.toggle('full', full); });
    Array.prototype.forEach.call(slot.querySelectorAll('[data-sx-file]'), function (i) { i.disabled = full || !!r.sending; });
    list.innerHTML = kit.chipsHtml(box, 'data-action') + (box.atts.length ? '<p class="att-limit">' + esc(kit.limitLine(box)) + '</p>' : '');
    list.classList.toggle('hidden', !box.atts.length);
    // QA 7.0.0: the "Working right now" note depends on whether files go with the message (sxParkLine).
    if (r && r.verdict) renderVerdict(r);
    // Send and Fork wait while a file uploads. A failed file never greys them out (QA 6.99.27): a tap says why.
    var st = readerFilesState(box), form = $('session-form');
    if (!form || r.sending) return;
    var send = $('session-send'), forkBtn = form.querySelector('[data-action="fork-session"]');
    if (send) { send.disabled = st === 'waiting'; send.textContent = st === 'waiting' ? 'Uploading' : 'Send'; }
    if (forkBtn) forkBtn.disabled = st === 'waiting';
  }
  function addReaderFiles(list) {
    var kit = readerKit(), r = state.reading; if (!kit || !r || !readerFilesOn() || !list || !list.length) return;
    var refusals = kit.add(readerBox(r), list);
    if (refusals.length) sessionStatus(refusals.join(' '), 'error');
    paintReaderFiles();
  }
  // The files that went with a message leave the box; any added since stay. Taken, not removed: the status line stays
  // (a held message's Don't send is on it). Answers what went, for a held message to keep.
  function readerFilesSent(box, ids) {
    var kit = readerKit(); if (!kit || !box || !ids || !ids.length) return [];
    return kit.take(box, ids);
  }
  // QA 6.99.27: a held message keeps what its files were, so if it does not go, it comes back whole (heldFilesBack).
  function keepHeldFiles(r, text, ids, went) {
    if (!went || !went.length) return;
    r.held.forEach(function (h) { if (!h.files && h.text === text && (h.ids || []).join(',') === ids.join(',')) h.files = went; });
    saveHeld(r);
  }
  // The Mac keeps a file no turn took for 4 hours (lib/turn-file-store.ts, and the media store's own rule); this
  // trusts a file for 5 minutes less. Past that it says the file has gone rather than offer one the send would refuse.
  var HELD_FILE_KEEP_MS = 4 * 60 * 60000 - 5 * 60000;
  function heldFilesBack(r, h) {
    var ids = h.ids || []; if (!ids.length) return '';
    var kit = readerKit(), box = readerFilesOn() ? readerBox(r) : null, now = Date.now();
    var known = (h.files || []).filter(function (f) { return f && ids.indexOf(f.mediaId) >= 0; });
    var kept = known.filter(function (f) { return f.keptAt > 0 && now - f.keptAt < HELD_FILE_KEEP_MS; });
    var back = box && kept.length ? kit.restore(box, kept) : 0;
    var lost = ids.length - back, expired = known.length - kept.length;
    var said = !back ? '' : back === ids.length ? (back === 1 ? ' Its file is attached again.' : ' Its ' + back + ' files are attached again.')
      : ' ' + back + ' of its files ' + (back === 1 ? 'is' : 'are') + ' attached again.';
    if (!lost) return said;
    var gone = lost === expired
      ? (lost === 1 ? ' The file it carried was kept for 4 hours and has gone.' : ' The ' + lost + ' files it carried were kept for 4 hours and have gone.')
      : (lost === 1 ? ' A file it carried did not come back.' : ' ' + lost + ' files it carried did not come back.');
    return said + gone + ' Attach ' + (lost === 1 ? 'it' : 'them') + ' again.';
  }

  function sendSessionTurn(fork, opts) {
    var r = state.reading; var form = $('session-form');
    if (!r || !form) return;
    var input = $('session-input'), text = input.value.trim();
    if (!text) { sessionStatus(fork ? 'Write what the copy should do first.' : 'Write a message first.', 'error'); return; }
    // 6.99.27: files. Never before every upload has finished, never with one that failed. A fork carries them too: its
    // first turn is this message, so the copy gets the same files (the fork route writes their paths as a turn does).
    var fb = readerFilesOn() ? readerBox(r) : null, fst = readerFilesState(fb);
    if (fst === 'waiting') { sessionStatus('A file is still uploading. ' + (fork ? 'Fork' : 'Send') + ' when it finishes.'); return; }
    if (fst === 'failed') { sessionStatus('A file did not upload. Retry it or remove it.', 'error'); return; }
    var fileIds = fst === 'ready' ? readerKit().ids(fb) : [];
    if (fileIds.length && !fork) opts = Object.assign({}, opts || {}, { attachmentIds: fileIds });
    // Control's caution (SessionChatVerdict.caution): another app holds this session and looks
    // idle, so the first send asks before it writes. A fork writes to a copy and never asks.
    if (!fork && r.verdict && r.verdict.caution && !r.cautionAck) { r.cautionAsk = true; renderVerdict(r); return; }
    // One send at a time: Enter submits the form even while Send is disabled, and a second send
    // during the first attach could park the same text in the queue while the first lands.
    if (r.sending) return;
    if (r.refusal || r.cautionAsk) { r.refusal = null; r.cautionAsk = false; renderVerdict(r); }
    r.sending = true;
    var btns = form.querySelectorAll('button'); btns.forEach(function (b) { b.disabled = true; });
    var done = function () { r.sending = false; btns.forEach(function (b) { b.disabled = false; }); paintReaderFiles(); };
    (fork ? forkSession(r, text, fileIds) : continueSession(r, text, opts || {}).then(function (how) {
      // The Mac took the message (sent, waiting in line, or held until the reply ends): its files went with it.
      if (/^(sent|parked|held)$/.test(how)) { var went = readerFilesSent(fb, fileIds); if (how === 'held') keepHeldFiles(r, text, fileIds, went); }
      return how;
    })).then(done, function (err) {
      done();
      if (state.reading !== r) return;
      var why = err && err.name === 'AbortError'
        ? (fork ? 'No answer from your Mac yet. The copy may still be made; tapping Fork again is safe, it will not make a second one.' : 'No answer from your Mac yet. It may still land. Sending again is safe; it will not post twice.')
        : (err && err.message) || 'Could not reach your Mac.';
      sessionStatus('');
      r.retryFork = !!fork;
      r.refusal = { copy: why, retry: true, fork: !fork };
      renderVerdict(r);
    });
  }

  // One attempt to deliver `text`. `opts.held` is a message waiting for a reply to end: its
  // attempts never touch the box or the status line unless they settle it.
  // Resolves to 'sent' | 'parked' | 'held' | 'refused' | 'changed'.
  function continueSession(r, text, opts) {
    var provider = r.provider, id = r.id;
    var draft = opts.held ? { text: opts.held.text, key: opts.held.key, ids: opts.held.ids || [] } : draftFor(text, r, opts.attachmentIds), view = viewOf(r);
    // Files go only to a server that said it takes them (threadTurnAttachments); the caller shows no clip otherwise.
    var files = draft.ids && draft.ids.length ? { attachmentIds: draft.ids } : {};
    if (!opts.held) view.status(r, 'Sending');
    var bound = bindingFor(provider, id);
    var attach = bound ? Promise.resolve({ ok: true, binding: bound }) : apiAnswer(sessionPath(provider, id, '/attach'), { method: 'POST', body: { cosSessionId: cosSessionId() }, timeoutMs: 20000 }).then(function (a) {
      // 201 Created on success; any 2xx that says attached counts.
      if (a.status >= 200 && a.status < 300 && a.body.attached === true && a.body.bindingId && typeof a.body.epoch === 'number') {
        var b = { bindingId: a.body.bindingId, epoch: a.body.epoch, at: Date.now() };
        rememberBinding(provider, id, b);
        return { ok: true, binding: b };
      }
      return { ok: false, refusal: a.body };
    });
    return attach.then(function (at) {
      // Busy right now (the Mac is writing to it, or another binding holds it): park the
      // message in the session's own queue; the server delivers it when the session is free.
      // Any other refusal is permanent for this thread, and a parked message would never go.
      if (!at.ok) {
        var why = (at.refusal && at.refusal.reason) || '';
        if (PARKABLE_REFUSALS.test(why)) return parkTurn(r, draft, at.refusal, opts);
        var copy = ((at.refusal && at.refusal.reasonCopy) || 'COS cannot write to this session right now.') + ' Fork sends your message to a copy instead.';
        if (opts.held) settleHeld(r, opts.held, 'refused', copy);
        else {
          // Control's refusal box: the server's words, then Fork with this message.
          view.status(r, '');
          r.refusal = { copy: (at.refusal && at.refusal.reasonCopy) || 'COS cannot write to this session right now.', supplement: sxSupplement(why), fork: true };
          view.verdict(r);
        }
        return 'refused';
      }
      // QA 6.99.29: a turn this page sends starts new work, so the last Stop (or finished COS turn) no longer
      // mutes the working signals that follow (a held follow-up goes 800 ms after the end, inside the echo window).
      r.stoppedAt = null;
      return apiAnswer('/api/agent-sessions/bindings/' + encodeURIComponent(at.binding.bindingId) + '/turns', {
        method: 'POST', timeoutMs: 25000,
        body: Object.assign({ prompt: draft.text, epoch: at.binding.epoch, targetKey: targetKey(provider, id), clientTurnId: draft.key }, files, opts.acknowledgedRevision ? { acknowledgedRevision: opts.acknowledgedRevision } : {}),
      }).then(function (t) {
        var b = t.body || {};
        if (t.status >= 200 && t.status < 300 && (b.outcome === 'queued' || b.outcome === 'completed')) {
          if (opts.held) settleHeld(r, opts.held, 'sent');
          else { view.pending(r, draft.text, b.replayed ? 'already sent' : 'sent'); view.clear(r, draft.text); }
          view.status(r, b.replayed ? 'Already sent. Watching for the reply.' : 'Sent. Watching for the reply.');
          view.watch(r, at.binding.bindingId, draft.key);
          // 6.99.29: a turn that went live is in the open session, which now works on it.
          if (b.outcome === 'completed' && b.via === 'live') { sxNoteGate(r, true); try { sxRepaint(r); } catch (_e) {} }
          return 'sent';
        }
        var reason = b.reason || '';
        if (reason === 'native_thread_working') return parkTurn(r, draft, b, opts);
        // COS's own reply is still running on this thread. The server's queue counts that
        // thread as free (the running child is COS's), so it cannot park this; the page holds
        // it under the same key and sends it the moment the reply ends.
        if (reason === 'native_turn_in_progress') { if (!opts.held) view.hold(r, draft); return 'held'; }
        if (reason === 'native_thread_changed' && b.revision) {
          if (opts.held) settleHeld(r, opts.held, 'refused', 'This session changed on your Mac while your message waited.');
          else {
            // Control's refusal box for a changed thread: Refresh, Continue anyway, Fork with this message.
            r.sendAnyway = b.revision;
            view.status(r, '');
            r.refusal = { copy: b.reasonCopy || 'This session changed on your Mac since you opened it.', changed: true, fork: true };
            view.verdict(r);
          }
          return 'changed';
        }
        if (/^(stale_epoch|binding_expired|binding_not_active|binding_unusable|unknown_binding)$/.test(reason) && !opts.reattached) {
          rememberBinding(provider, id, null);
          return continueSession(r, text, Object.assign({}, opts, { reattached: true }));
        }
        var refusedCopy = b.reasonCopy || 'The session did not take that message.';
        if (opts.held) settleHeld(r, opts.held, 'refused', refusedCopy);
        else view.status(r, refusedCopy + ' It is still in the box.', 'error');
        return 'refused';
      });
    });
  }

  // ── BEGIN web-key handoff (6.99.31, Phase 3, review W2) ──
  // With the Mac's webKeySigner capability (only with COS_WEB_KEY_AUTHORITY on) and an enrolled phone key, the session
  // composer offers "Approve on this phone". That is a TOP-LEVEL navigation to the signer page on port 3144 carrying a
  // one-use handoff id in the fragment. The words stay on the Mac until the signer claims them; they are never in a URL.
  // Without the capability nothing here runs: no request, no button, the composer exactly as before.
  var WEB_KEY = { status: null, statusAt: 0, loading: null, generation: 0, views: [], refreshing: null, navigation: null };
  var WEB_KEY_COPY = {
    no_phone_key: 'No phone has a key yet. Set one up on the approval page first.',
    attachments_not_signable: 'Files cannot be approved on the phone yet. Remove them, or use Send.',
    words_too_long: 'That message is too long to approve on the phone. Shorten it, or use Send.',
    handoff_cap_reached: 'Too many approvals are waiting. Finish one, or wait two minutes.',
    origin_unavailable: 'Your Mac does not know its Tailscale name yet, so the approval page cannot open.',
    web_key_authority_off: 'Phone approval is turned off on the Mac.'
  };
  function webKeyCapable() { var k = readerKit(); return !!(k && typeof k.webKeySigner === 'function' && k.webKeySigner() === 1); }
  function webKeyStatus() {
    var age = Date.now() - WEB_KEY.statusAt;
    if (WEB_KEY.status && age >= 0 && age < 30000) return Promise.resolve(WEB_KEY.status);
    if (!WEB_KEY.loading) {
      var generation = WEB_KEY.generation;
      WEB_KEY.loading = apiAnswer('/api/web-key/status', { timeoutMs: 15000 }).then(function (a) {
        if (generation !== WEB_KEY.generation) return null;
        WEB_KEY.loading = null;
        WEB_KEY.status = a.status === 200 && a.body && a.body.ok === true && Number.isSafeInteger(a.body.activeKeys) && a.body.activeKeys >= 0 ? { activeKeys: a.body.activeKeys } : null;
        WEB_KEY.statusAt = Date.now();
        return WEB_KEY.status;
      }, function () { if (generation === WEB_KEY.generation) { WEB_KEY.loading = null; WEB_KEY.status = null; } return null; });
    }
    return WEB_KEY.loading;
  }
  function webKeySetupUrl() {
    var host = location.hostname;
    // The passkey belongs to this Mac's full MagicDNS host, never an IP, local alias or public suffix.
    if (typeof host !== 'string' || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}ts\.net$/.test(host)) return null;
    return 'https://' + host + ':3144/';
  }
  function phoneApprovalView(r, opts) {
    opts = opts || {};
    var prefix = opts.prefix || 'session';
    return { prefix: prefix, form: $(prefix + '-form'), send: $(prefix + '-send'), input: $(prefix + '-input'),
      live: opts.live || function () { return state.reading === r; },
      status: opts.status || sessionStatus, files: opts.files || function () { return readerFilesState(readerFilesOn() ? readerBox(r) : null); } };
  }
  function phoneApprovalViewLive(view) {
    return view.live() && view.form && view.send && view.form === $(view.prefix + '-form') && view.send === $(view.prefix + '-send');
  }
  function clearPhoneOffer(r, view) {
    var offer = view.form.querySelector('[data-phone-offer]'), packets = view.form.querySelector('[data-phone-packets]');
    if (offer && offer.parentNode) offer.parentNode.removeChild(offer);
    if (packets && packets.parentNode) packets.parentNode.removeChild(packets);
    r.phonePackets = {}; r.phonePacketSha256 = ''; r.phoneDraft = null;
  }
  function refreshWebKeyOffers() {
    if (!webKeyCapable() || WEB_KEY.refreshing) return;
    WEB_KEY.status = null; WEB_KEY.statusAt = 0; WEB_KEY.loading = null; WEB_KEY.generation += 1;
    WEB_KEY.views = WEB_KEY.views.filter(function (entry) { return phoneApprovalViewLive(entry.view); });
    if (!WEB_KEY.views.length) return;
    var views = WEB_KEY.views.slice();
    views.forEach(function (entry) { clearPhoneOffer(entry.r, entry.view); });
    var fresh = webKeyStatus(); WEB_KEY.refreshing = fresh;
    fresh.then(function () { if (WEB_KEY.refreshing === fresh) WEB_KEY.refreshing = null; });
    views.forEach(function (entry) { paintWebKeyOffer(entry.r, entry.opts); });
  }
  // Safari can restore this exact DOM after enrollment or revocation on the separate signer origin.
  // Refetch once per persisted return; closed/replaced readers are pruned and no timer is installed.
  // (Guarded: it runs at load, and a host without window events, the web-control vm harnesses, must still load.)
  if (window.addEventListener) window.addEventListener('pageshow', function (e) {
    if (!e || !e.persisted) return;
    var nav = WEB_KEY.navigation; WEB_KEY.navigation = null;
    if (nav && nav.token.completed && nav.r.phoneNavigation === nav.token) {
      if (nav.r.sending === nav.token) nav.r.sending = false;
      nav.r.phoneNavigation = null;
    }
    refreshWebKeyOffers();
  });
  function phonePacketDetails(p, sha) {
    return 'Requested ' + p.action + ': ' + p.artifact + ' ' + p.version + '\nChannel: ' + p.channel + '\nDigest: ' + p.digest +
      '\nReceiver: ' + p.provider + ' / ' + p.sessionId + '\nExpires: ' + new Date(p.exp).toISOString() + '\nPacket: ' + sha +
      '\nThis request approves nothing until you review it and confirm on the phone.';
  }
  function paintWebKeyOffer(r, opts) {
    if (!webKeyCapable()) return;
    var view = phoneApprovalView(r, opts);
    if (!phoneApprovalViewLive(view)) return;
    WEB_KEY.views = WEB_KEY.views.filter(function (entry) { return phoneApprovalViewLive(entry.view) && entry.view.form !== view.form; });
    WEB_KEY.views.push({ r: r, opts: opts, view: view });
    var generation = WEB_KEY.generation;
    webKeyStatus().then(function (st) {
      if (generation !== WEB_KEY.generation || !phoneApprovalViewLive(view)) return;
      if (!st) { clearPhoneOffer(r, view); return; }
      var offer = view.form.querySelector('[data-phone-offer]');
      if (offer && !!view.form.querySelector('[data-phone-setup]') === (st.activeKeys === 0)) return;
      if (offer || st.activeKeys === 0) clearPhoneOffer(r, view);
      if (st.activeKeys === 0) {
        var setupUrl = webKeySetupUrl(); if (!setupUrl) return;
        var setup = document.createElement('a');
        setup.className = 'btn small'; setup.setAttribute('data-phone-offer', '1');
        setup.setAttribute('data-phone-setup', '1'); setup.setAttribute('href', setupUrl); setup.setAttribute('target', '_top');
        setup.textContent = 'Set up phone approvals';
        view.send.parentNode.insertBefore(setup, view.send);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small'; b.setAttribute('data-phone-offer', '1');
      b.setAttribute(view.prefix === 'ta' ? 'data-ta' : 'data-action', view.prefix === 'ta' ? 'approve-phone' : 'approve-on-phone');
      b.title = 'Review an exact request on the approval page, then confirm with your phone passkey';
      b.textContent = 'Approve on this phone';
      view.send.parentNode.insertBefore(b, view.send);
      return apiAnswer('/api/web-key/packets?provider=' + encodeURIComponent(r.provider) + '&sessionId=' + encodeURIComponent(r.id)).then(function (a) {
        if (generation !== WEB_KEY.generation || !phoneApprovalViewLive(view) || view.form.querySelector('[data-phone-offer]') !== b) return;
        var rows = a.status === 200 && a.body && a.body.ok === true && Array.isArray(a.body.packets) ? a.body.packets : [];
        rows = rows.filter(function (row) { var p = row && row.packet; return p && p.provider === r.provider && p.sessionId === r.id &&
          (p.action === 'install' || p.action === 'publish') && Number.isSafeInteger(p.exp) && p.exp >= Date.now() && /^[0-9a-f]{64}$/.test(row.packetSha256 || ''); });
        r.phonePackets = {}; rows.forEach(function (row) { r.phonePackets[row.packetSha256] = row.packet; });
        if (!rows.length) return;
        var box = document.createElement('div'), label = document.createElement('label'), select = document.createElement('select'), disclosure = document.createElement('details'), summary = document.createElement('summary'), detail = document.createElement('pre');
        box.className = 'phone-approval-packet'; box.setAttribute('data-phone-packets', '1'); select.id = view.prefix + '-phone-packet'; detail.id = view.prefix + '-phone-details';
        label.textContent = 'What to approve'; label.setAttribute('for', select.id);
        var message = document.createElement('option'); message.value = ''; message.textContent = 'Message only — no release approval'; select.appendChild(message);
        rows.forEach(function (row) { var option = document.createElement('option'), p = row.packet; option.value = row.packetSha256;
          option.textContent = p.action + ' ' + p.artifact + ' ' + p.version + ' / ' + p.channel; select.appendChild(option); });
        select.value = r.phonePacketSha256 || '';
        var update = function () { r.phonePacketSha256 = select.value; var p = r.phonePackets[select.value];
          detail.textContent = p ? phonePacketDetails(p, select.value) : 'Message only. This authorizes no install, publish or push.';
          if (p && view.input && !view.input.value.trim()) view.input.value = 'Approve ' + p.action + ' ' + p.artifact + ' ' + p.version + ' on ' + p.channel + '.';
        };
        select.addEventListener('change', update); update();
        summary.textContent = 'Review release request'; disclosure.appendChild(summary); disclosure.appendChild(detail);
        box.appendChild(label); box.appendChild(select); box.appendChild(disclosure); view.form.insertBefore(box, view.form.firstChild);
      }, function () { /* No packet is selected implicitly when this read fails. */ });
    });
  }
  // Only the signer on this same host, port 3144, path /, with nothing but the handoff id in the fragment.
  function webKeySignerUrlOk(u) {
    try {
      var x = new URL(u);
      return x.protocol === 'https:' && x.hostname === location.hostname && x.port === '3144' && x.pathname === '/' && !x.search && /^#h=[A-Za-z0-9_-]{16,64}$/.test(x.hash);
    } catch (_e) { return false; }
  }
  function approveOnPhone(opts) {
    opts = opts || {};
    var r = opts.r || state.reading; if (!r || r.sending) return Promise.resolve('busy');
    var view = phoneApprovalView(r, opts), say = view.status;
    if (!view.live()) return Promise.resolve('stale');
    var input = view.input, text = input ? input.value.trim() : '';
    if (!text) { say('Write a message first.', 'error'); return Promise.resolve('empty'); }
    if (view.files() !== 'none') { say(WEB_KEY_COPY.attachments_not_signable, 'error'); return Promise.resolve('files'); }
    var provider = r.provider, id = r.id, packetSha = r.phonePacketSha256 || '';
    var packet = packetSha && r.phonePackets && r.phonePackets[packetSha];
    if (packetSha && (!packet || packet.exp < Date.now() || packet.provider !== provider || packet.sessionId !== id)) { say('That release request expired or changed. Reopen this session to load its current request.', 'error'); return Promise.resolve('packet'); }
    var draft = r.phoneDraft;
    if (!draft || draft.text !== text || draft.packetSha256 !== packetSha) draft = r.phoneDraft = { text: text, key: newTurnKey(), packetSha256: packetSha };
    var bound = bindingFor(provider, id);
    // Other senders assign boolean true. This unique truthy owner lets late callbacks and a BFCache return
    // release only this phone operation, never a newer ordinary send or another phone operation.
    var operation = { completed: false };
    r.phoneNavigation = operation; r.sending = operation;
    var ownsSending = function () { return r.sending === operation && r.phoneNavigation === operation; };
    var releaseSending = function () { if (ownsSending()) { r.sending = false; r.phoneNavigation = null; } };
    say('Opening the approval page.');
    var attach = bound ? Promise.resolve(bound) : apiAnswer(sessionPath(provider, id, '/attach'), { method: 'POST', body: { cosSessionId: cosSessionId() }, timeoutMs: 20000 }).then(function (a) {
      if (a.status >= 200 && a.status < 300 && a.body.attached === true && a.body.bindingId && typeof a.body.epoch === 'number') {
        var b = { bindingId: a.body.bindingId, epoch: a.body.epoch, at: Date.now() };
        rememberBinding(provider, id, b);
        return b;
      }
      return null;
    });
    return attach.then(function (b) {
      if (!ownsSending() || !phoneApprovalViewLive(view)) return 'stale';
      if (!b) { say('COS cannot write to this session right now.', 'error'); return 'refused'; }
      var request = { bindingId: b.bindingId, epoch: b.epoch, targetKey: targetKey(provider, id), clientTurnId: draft.key, prompt: draft.text };
      if (packetSha) request.packetSha256 = packetSha;
      return apiAnswer('/api/web-key/handoff', { method: 'POST', timeoutMs: 15000, body: request }).then(function (h) {
        if (!ownsSending() || !phoneApprovalViewLive(view)) return 'stale';
        var body = h.body || {};
        if (h.status === 201 && body.ok === true && webKeySignerUrlOk(body.signerUrl)) {
          say('Opening the approval page.');
          location.assign(body.signerUrl);
          operation.completed = true;
          WEB_KEY.navigation = { r: r, token: operation };
          return 'opened';
        }
        if (h.status === 201) { say('Open Control from your Mac’s Tailscale name to approve on this phone.', 'error'); return 'refused'; }
        if (/^(binding_changed|unknown_binding)$/.test(body.error || '') && !opts.reattached) {
          rememberBinding(provider, id, null);
          releaseSending();
          return approveOnPhone(Object.assign({}, opts, { r: r, reattached: true }));
        }
        say(WEB_KEY_COPY[body.error] || 'The Mac did not open an approval for that message.', 'error');
        return 'refused';
      });
    }).then(function (how) { if (how !== 'opened') releaseSending(); return how; }, function () {
      if (ownsSending()) { releaseSending(); say('Could not reach your Mac.', 'error'); }
      return 'failed';
    });
  }
  // ── END web-key handoff ──

  var HELD_MAX_MS = 5 * 60000, HELD_RETRY_MS = 8000;
  function holdUntilReplyEnds(r, draft) {
    if (!r.held.some(function (h) { return h.key === draft.key; })) {
      r.held.push({ text: draft.text, key: draft.key, since: Date.now(), ids: draft.ids || [] });
      showPendingTurn(draft.text, 'sends after this reply', draft.key);
      saveHeld(r);
    }
    clearBoxOf(draft.text);
    sessionStatus('COS is still answering. ' + (r.held.length > 1 ? r.held.length + ' messages send' : 'Yours sends') + ' as soon as it finishes. ', null, '<button type="button" class="link-btn" data-action="drop-after">Don’t send</button>');
    startHeldTimer(r);
  }
  function startHeldTimer(r) {
    clearInterval(r.heldTimer);
    r.heldTimer = setInterval(function () { flushHeld(r); }, HELD_RETRY_MS);
  }
  function replyEnded(r) { if (r && r.held && r.held.length) setTimeout(function () { flushHeld(r); }, 800); }
  // Tries the oldest held message once. A "still answering" answer changes nothing on screen.
  function flushHeld(r) {
    if (state.reading !== r) { clearInterval(r.heldTimer); return; }
    var next = r.held.filter(function (h) { return !h.cancelled; })[0];
    if (!next) { clearInterval(r.heldTimer); return; }
    if (r.flushing) return;
    if (Date.now() - next.since > HELD_MAX_MS) { settleHeld(r, next, 'timeout', 'The session stayed busy for five minutes.'); return; }
    r.flushing = next;
    continueSession(r, next.text, { held: next }).then(function () {}, function () { /* no answer: keep it, retry */ })
      .finally(function () { r.flushing = null; if (next.cancelled && r.held.indexOf(next) >= 0) settleHeld(r, next, 'cancelled'); });
  }
  // Ends one held message: sent, refused, timed out or cancelled.
  function settleHeld(r, h, how, copy) {
    r.held = r.held.filter(function (x) { return x !== h; });
    saveHeld(r);
    var bubble = heldBubble(h.key);
    if (how === 'sent') {
      if (bubble) { bubble.removeAttribute('data-held-key'); bubble.querySelector('.who').textContent = 'You, sent'; }
      if (h.cancelled) sessionStatus('Too late to stop it: that message had already gone.');
    } else if (how === 'parked') {
      if (bubble) { bubble.removeAttribute('data-held-key'); bubble.querySelector('.who').textContent = 'You, waiting in line'; }
    } else {
      if (bubble) bubble.remove();
      // The whole message comes back: its words, and its files where the Mac still keeps them.
      returnToBox(h.text, how === 'cancelled' ? 'Not sent.' : copy || 'Not sent.', heldFilesBack(r, h));
    }
    if (!r.held.some(function (x) { return !x.cancelled; })) clearInterval(r.heldTimer);
  }
  function dropHeld() {
    var r = state.reading; if (!r || !r.held.length) return;
    r.held.slice().forEach(function (h) {
      h.cancelled = true;
      if (r.flushing !== h) settleHeld(r, h, 'cancelled');
    });
    saveHeld(r);
  }

  function parkTurn(r, draft, refusal, opts) {
    var view = viewOf(r);
    return apiAnswer(sessionPath(r.provider, r.id, '/queued-turns'), {
      method: 'POST', timeoutMs: 15000,
      body: Object.assign({ cosSessionId: cosSessionId(), clientTurnId: draft.key, prompt: draft.text }, draft.ids && draft.ids.length ? { attachmentIds: draft.ids } : {}),
    }).then(function (q) {
      var b = q.body || {};
      if (b.queued === true || b.error === 'duplicate_turn') {
        rememberParked(r, draft.key);
        if (opts.held) settleHeld(r, opts.held, 'parked');
        else { view.pending(r, draft.text, 'waiting in line'); view.clear(r, draft.text); }
        view.status(r, b.error === 'duplicate_turn' ? 'Already waiting to send.' : (b.landsAt === 'next_step' ? 'The session is busy. Yours lands at its next step.' : b.position ? 'The session is busy. Yours is #' + (b.position + 1) + ' in line and sends on its own.' : 'The session is busy. Yours sends next, on its own.'));
        view.queue(r);
        // 6.99.29: "The session is busy" is the gate's word as of now; the card shows the same. Last, and
        // never allowed to cost the parked message its settlement.
        if (b.queued === true && refusal && refusal.reason === 'native_thread_working') { sxNoteGate(r, true); try { sxRepaint(r); } catch (_e) {} }
        return 'parked';
      }
      if (b.error === 'thread_free' && !opts.freeRetry) return continueSession(r, draft.text, Object.assign({}, opts, { freeRetry: true }));
      // 11/07: a file that could not be kept refuses the park with its own words, which say which step to take.
      var copy = (b.attachmentError && b.reasonCopy) || (refusal && refusal.reasonCopy) || (b.error === 'queue_full' ? 'That session already has a full line of waiting messages.' : 'COS could not send or queue that.');
      if (opts.held) settleHeld(r, opts.held, 'refused', copy); else view.status(r, copy + ' It is still in the box.', 'error');
      return 'refused';
    });
  }

  // Follow one sent turn to its end (completed, refused, or ambiguous) for up to 3 minutes.
  function watchTurn(bindingId, key, provider, id) {
    clearInterval(state.turnPoll);
    var started = Date.now();
    state.turnPoll = setInterval(function () {
      var r = state.reading;
      if (!r || r.id !== id || Date.now() - started > 180000) { clearInterval(state.turnPoll); return; }
      apiAnswer('/api/agent-sessions/bindings/' + encodeURIComponent(bindingId) + '/turns/' + encodeURIComponent(key)).then(function (s) {
        var o = s.body && s.body.outcome;
        if (o === 'completed') {
          clearInterval(state.turnPoll); refreshTurns(provider, id);
          // 6.99.29: a turn delivered LIVE is in the open session, which is now working on it; only a
          // COS child's finished turn is the end of the work. Either way the one state settles it.
          if (s.body.via === 'live') { sxNoteGate(r, true); sessionStatus('Sent into the open session.'); }
          else { r.stoppedAt = Date.now(); sessionStatus('Done.'); }
          setLive({}); var st = $('session-state'); if (st) st.textContent = r.live && r.live.working ? 'Working now' : 'Open';
          if (s.body.via !== 'live') replyEnded(r);
        } else if (o === 'refused') { clearInterval(state.turnPoll); sessionStatus(s.body.reasonCopy || 'The session refused that message.', 'error'); replyEnded(r); }
        else if (o === 'ambiguous') { clearInterval(state.turnPoll); sessionStatus(s.body.reasonCopy || 'COS cannot tell whether that landed. Look at the session before sending it again.', 'error'); }
      }).catch(function () {});
    }, 3000);
  }

  // Fork copies the session and runs the message there. One key per draft, so a second tap or
  // a resend after a timeout finds the same job instead of making a second copy.
  function forkSession(r, text, ids) {
    ids = Array.isArray(ids) ? ids : [];
    // Other files are another fork, with its own key.
    if (!r.forkDraft || r.forkDraft.text !== text || (r.forkDraft.ids || []).join(',') !== ids.join(',')) r.forkDraft = { text: text, key: 'fk' + newTurnKey().slice(2), ids: ids.slice() };
    var forkId = r.forkDraft.key;
    sessionStatus('Copying the session. This can take up to a minute.');
    var settle = function (b) {
      if (b.forked === true) {
        r.forkDraft = null; clearBoxOf(text); readerFilesSent(readerFilesOn() ? readerBox(r) : null, ids);
        sessionStatus('Forked. The copy has your message and shows in Sessions in a moment.');
        setTimeout(function () { if (state.pane === 'sessions') loadSessions(true); }, 4000);
        return true;
      }
      if (b.forked === false || b.state === 'failed' || b.state === 'refused') { sessionStatus((b.reasonCopy || 'COS could not copy that session.'), 'error'); return true; }
      return false;
    };
    return apiAnswer(sessionPath(r.provider, r.id, '/fork'), { method: 'POST', timeoutMs: 65000, body: Object.assign({ prompt: text, cosSessionId: cosSessionId(), clientForkId: forkId }, ids.length ? { attachmentIds: ids } : {}) }).then(function (f) {
      if (settle(f.body || {})) return;
      if (f.status !== 202) { sessionStatus('COS could not copy that session.', 'error'); return; }
      // 202: running in the background. Follow its job for up to three minutes.
      var started = Date.now();
      return new Promise(function (resolve) {
        var poll = setInterval(function () {
          if (state.reading !== r || Date.now() - started > 180000) { clearInterval(poll); resolve(); return; }
          apiAnswer('/api/agent-session-forks/' + encodeURIComponent(forkId)).then(function (j) {
            if (settle(j.body || {})) { clearInterval(poll); resolve(); }
          }).catch(function () {});
        }, 3000);
      });
    });
  }

  function stopSession() {
    var r = state.reading; if (!r) return;
    sessionStatus('Stopping');
    apiAnswer(sessionPath(r.provider, r.id, '/cancel'), { method: 'POST', timeoutMs: 15000, body: { clientCancelId: newTurnKey() } }).then(function (c) {
      var b = c.body || {};
      sessionStatus(b.reasonCopy || (b.cancelled ? 'Stopped.' : 'COS could not stop it.'), b.cancelled ? null : 'error');
      if (b.cancelled) {
        r.stoppedAt = Date.now();
        clearInterval(state.turnPoll);
        setLive({}); var st = $('session-state'); if (st) st.textContent = 'Open';
        setTimeout(function () { if (state.reading === r) refreshTurns(r.provider, r.id); }, 1500);
      }
    }).catch(function (err) { sessionStatus(err.message, 'error'); });
  }

  function removeQueued(key) {
    var r = state.reading; if (!r || !key || !parkedByMe(r, key)) return;
    apiAnswer(sessionPath(r.provider, r.id, '/queued-turns/' + encodeURIComponent(key)), { method: 'DELETE' }).then(function (d) {
      sessionStatus(d.body && d.body.cancelled ? 'Removed from the line.' : ((d.body && d.body.reasonCopy) || 'It may already be sending.'), d.body && d.body.cancelled ? null : 'error');
      loadQueue(r.provider, r.id);
    });
  }

  // Output previews are separate from composer attachments. Only the DTO fields reach the lazy viewer.
  // opts.part (sxTurnHtml): 'before' is only the step that came before a reply's words, drawn above them; 'after' is
  // everything else, drawn below; 'user' is a YOU turn's attached images and never a reply's outputs. No opts: all of it.
  function readerImagesHtml(turn) {
    var opts = arguments[1], part = opts && opts.part;
    // 6.99.35: "Show files and images your sessions make" is off (Settings, Privacy). The server sent no names, only this mark.
    if (turn && turn.previewsOff === true) return part === 'before' ? '' : '<p class="rm-status rm-off">Previews are off. Turn them on in Settings, Privacy.</p>';
    if (part === 'before') return readerToolsHtml(turn, true);
    if (part === 'user') return readerToolsHtml(turn, false);
    var head = part === 'after' ? '' : readerToolsHtml(turn, true);
    var images = turn && Array.isArray(turn.outputImages) ? turn.outputImages.filter(function (x) {
      return x && /^ai_[a-f0-9]{64}$/.test(x.id || '') && (x.state === 'available' || x.state === 'unavailable');
    }).map(function (x) { return { id: x.id, label: String(x.label || 'Output image').slice(0, 180), state: x.state, reason: x.reason }; }) : [];
    return head + (images.length ? '<div data-reader-images="' + esc(JSON.stringify(images)) + '"><p class="rm-status" role="status">Loading image previews…</p></div>' : '') + readerFilesHtml(turn) + readerToolsHtml(turn, false);
  }
  // 11/08: images the session looked at (a Read of a PNG, a screenshot) and a prompt's attached images, as the Claude
  // app shows them under a step: "Read", "1 of 2". Only the checked DTO fields travel; the viewer loads them lazily by
  // opaque id. `before`: the step came before the turn's words. The count of more rides on the last strip shown.
  var READER_TOOLS = ['Read', 'Screenshot', 'Image', 'Attached'];
  function readerToolsHtml(turn, before) {
    var all = turn && Array.isArray(turn.toolImages) ? turn.toolImages.filter(function (x) {
      return x && /^ti_[a-f0-9]{64}$/.test(x.id || '') && (x.state === 'available' || x.state === 'unavailable');
    }).slice(0, 12) : [];
    var mine = all.filter(function (x) { return (x.before === true) === before; }).map(function (x) {
      return { id: x.id, tool: READER_TOOLS.indexOf(x.tool) >= 0 ? x.tool : 'Image', index: Math.floor(Number(x.index)) || 1, total: Math.floor(Number(x.total)) || 1, state: x.state,
        reason: ['outside_workspace', 'unavailable', 'too_large', 'missing', 'secret_file'].indexOf(x.reason) >= 0 ? x.reason : undefined };
    });
    var hasAfter = all.some(function (x) { return x.before !== true; });
    var more = Math.max(0, Math.min(9999, Math.floor(Number(turn && turn.toolImagesMore)) || 0));
    var hasBefore = all.some(function (x) { return x.before === true; });
    var mineMore = more && (before ? hasBefore && !hasAfter : !(hasBefore && !hasAfter)) ? more : 0;
    if (!mine.length && !mineMore) return '';
    return '<div data-reader-tools="' + esc(JSON.stringify({ items: mine, more: mineMore, before: before })) + '"><p class="rm-status" role="status">Loading images…</p></div>';
  }
  // 6.99.35: files a Claude session sent with SendUserFile that are not images. Names, types and sizes only; the
  // lazy viewer opens them through the authenticated output-files route by opaque id.
  var READER_FILE_KINDS = ['pdf', 'text', 'html', 'image', 'file'];
  function readerFilesHtml(turn) {
    var files = turn && Array.isArray(turn.outputFiles) ? turn.outputFiles.filter(function (x) {
      return x && /^af_[a-f0-9]{64}$/.test(x.id || '') && (x.state === 'available' || x.state === 'unavailable');
    }).map(function (x) {
      return { id: x.id, name: String(x.name || 'File').slice(0, 120), kind: READER_FILE_KINDS.indexOf(x.kind) >= 0 ? x.kind : 'file',
        type: String(x.type || 'File').slice(0, 40), size: typeof x.size === 'number' && x.size >= 0 ? x.size : null, state: x.state, reason: x.reason };
    }) : [];
    return files.length ? '<div data-reader-files="' + esc(JSON.stringify(files)) + '"><p class="rm-status" role="status">Loading files…</p></div>' : '';
  }
  function readerImagesStop(host) {
    if (!host) return;
    host.__cosImageOwner = null;
    if (window.COSWeb.readerMedia) window.COSWeb.readerMedia.unmount(host);
  }
  function readerImagesMount(host, r) {
    if (!host || !r) return;
    if (!host.querySelectorAll('[data-reader-images]').length && !host.querySelectorAll('[data-reader-files]').length && !host.querySelectorAll('[data-reader-tools]').length && !host.querySelectorAll('[data-reader-links]').length) { readerImagesStop(host); return; }
    var owner = host.__cosImageOwner = {};
    // Preview engine phase 1: the shared viewer loads first, so link cards and sent files open in it. If it cannot load,
    // links stay their words and sent files keep the 6.99.35 viewer.
    ensurePane('preview', 4000).catch(function () { return null; }).then(function () { return ensurePane('readerMedia', 4000); }).then(function (kit) {
      if (host.__cosImageOwner !== owner || host.isConnected === false) return;
      if (!kit) throw new Error('Image previews could not load.');
      kit.mount(host, r.provider, r.id);
    }).catch(function () {
      if (host.__cosImageOwner !== owner || host.isConnected === false) return;
      Array.prototype.slice.call(host.querySelectorAll('[data-reader-images]')).concat(Array.prototype.slice.call(host.querySelectorAll('[data-reader-files]')), Array.prototype.slice.call(host.querySelectorAll('[data-reader-tools]'))).forEach(function (slot) {
        slot.textContent = 'Image previews could not load. ';
        var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'link-btn'; retry.textContent = 'Retry images';
        retry.addEventListener('click', function () { readerImagesMount(host, r); }); slot.appendChild(retry);
      });
    });
  }

  // Copy session (Control's Kickstart brief, HelperSources/main.swift claudeKickstartCopy). Control
  // builds it from the Mac's transcript; the web builds it from the turns the server serves and
  // the session's first prompt, so it keeps the original request and the newest context.
  function sxKickstart(r) {
    var d = r.detail || {}, p = sxProvider(r.provider);
    var name = p === 'codex' ? 'Codex' : p === 'cursor' ? 'Cursor' : 'Claude Code';
    var title = sxTitle(d);
    var branch = d.git_branch && d.git_branch !== 'unknown' ? d.git_branch : '(unknown)';
    var out = '# Kickstart: ' + (title || name + ' session') + '\n\n' +
      'Read-only export of a ' + name + ' session. Continue this work here. Do not look for ' + name + ' jsonl or session IDs to resume.\n\n' +
      '- Workspace: ' + (d.project || '(unknown)') + '\n- Branch: ' + branch + '\n- Session: ' + (d.session_id || r.id) +
      (Number(d.omitted_tools) > 0 ? '\n- Tool calls omitted: ' + d.omitted_tools : '') + '\n\n';
    var turns = (r.turns || []).filter(function (t) { return String(t.text || '').trim(); });
    var firstUser = turns.filter(function (t) { return t.role === 'user'; })[0];
    var original = String(d.first_prompt || '').trim() || (firstUser ? String(firstUser.text).trim() : '');
    out += original ? '## Original request\n\n' + original + '\n\n## Conversation\n\n' : '## Conversation\n\n';
    if (r.more) out += '[Older turns omitted. COS serves the newest ' + turns.length + '. Original request kept.]\n\n';
    turns.forEach(function (t) {
      var text = String(t.text).trim().replace(/\[([^\]\n]*)\]\(cos-file:\d{1,2}\)/g, '$1');
      if (original && t.role === 'user' && text === original) return;
      out += '**' + (t.role === 'user' ? 'You' : 'Assistant') + '**\n\n' + text + '\n\n';
    });
    return out.length > 100000 ? out.slice(0, 100000) + '\n[truncated]\n' : out;
  }
  function copySessionBrief() {
    var r = state.reading, note = $('session-copy-note');
    if (!r || !r.detail) return;
    var text = sxKickstart(r);
    var say = function (msg) { if (note) { note.textContent = msg; note.classList.remove('hidden'); } };
    if (!text.trim()) return say('Nothing to copy');
    copyText(text).then(function () { say('Copied kickstart for another agent'); }, function (err) { say((err && err.message) || 'This browser would not copy.'); });
  }

  // Markdown for an assistant turn (Control renders replies with COSMarkdownView): headings, lists,
  // code, quotes, tables, rules, links. Everything is escaped first, so a reply can never add
  // markup of its own; a link keeps only an http(s) address.
  // Preview engine phase 1: the server turns a reply's local link into `[words](cos-file:N)`, N its card in the turn's
  // outputLinks. While a turn with cards renders (sxInline.links), that becomes a slot panes/reader-media.js fills with the
  // card; anywhere else (a file shown in the viewer, previews off, an older turn) it is just the words.
  function sxInline(s) {
    var links = sxInline.links;
    var codes = [];
    s = s.replace(/`([^`\n]+)`/g, function (_m, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\[([^\]\n]*)\]\(cos-file:(\d{1,2})\)/g, function (_m, words, n) {
      return links && Number(n) < links ? '<span class="rm-link-slot" data-reader-link="' + Number(n) + '">' + words + '</span>' : words;
    });
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, function (_m, i) { return '<code>' + codes[Number(i)] + '</code>'; });
  }
  var SX_LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  var SX_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  var SX_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  function sxCells(row) { return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); }
  function sxMd(text, links) {
    // links: the turn's card list. Only a real list turns markers into slots (the count bounds the indexes).
    var held = sxInline.links;
    sxInline.links = Array.isArray(links) && links.length ? Math.min(20, links.length) : null;
    try { return sxMdBody(text); } finally { sxInline.links = held; }
  }
  function sxMdBody(text) {
    var lines = esc(String(text || '')).replace(/\r\n?/g, '\n').split('\n');
    var out = [], para = [], i = 0;
    function flush() { if (para.length) { out.push('<p>' + para.map(sxInline).join('<br>') + '</p>'); para = []; } }
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) {
        flush();
        var code = [];
        i += 1;
        while (i < lines.length && !/^\s*(```|~~~)/.test(lines[i])) { code.push(lines[i]); i += 1; }
        i += 1;
        out.push('<pre><code>' + code.join('\n') + '</code></pre>');
        continue;
      }
      if (!line.trim()) { flush(); i += 1; continue; }
      var h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) { flush(); var lvl = Math.min(6, h[1].length + 2); out.push('<h' + lvl + '>' + sxInline(h[2]) + '</h' + lvl + '>'); i += 1; continue; }
      if (SX_RULE.test(line)) { flush(); out.push('<hr>'); i += 1; continue; }
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && SX_TABLE_SEP.test(lines[i + 1])) {
        flush();
        var head = sxCells(line), aligns = sxCells(lines[i + 1]).map(function (a) { return /^:-+:$/.test(a) ? 'center' : /-:$/.test(a) ? 'right' : ''; });
        i += 2;
        var body = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) { body.push(sxCells(lines[i])); i += 1; }
        var fit = tableFit([head].concat(body));
        var cell = function (tag, c, k, first) {
          var st = [aligns[k] ? 'text-align:' + aligns[k] : '', fit.width(k, first)].filter(Boolean).join(';');
          return '<' + tag + (st ? ' style="' + st + '"' : '') + '>' + fit.cell(k, sxInline(c), first) + '</' + tag + '>';
        };
        out.push('<div class="sx-table tf-wrap"><table class="' + fit.tableClass + ' tf-grid"><thead><tr>' + head.map(function (c, k) { return cell('th', c, k, true); }).join('') + '</tr></thead><tbody>' +
          body.map(function (row) { return '<tr>' + head.map(function (_c, k) { return cell('td', row[k] || '', k, false); }).join('') + '</tr>'; }).join('') + '</tbody></table></div>');
        continue;
      }
      if (/^\s*&gt;/.test(line)) {
        flush();
        var quote = [];
        while (i < lines.length && /^\s*&gt;/.test(lines[i])) { quote.push(lines[i].replace(/^\s*&gt;\s?/, '')); i += 1; }
        out.push('<blockquote>' + sxMd.unescaped(quote) + '</blockquote>');
        continue;
      }
      if (SX_LIST.test(line)) { flush(); var list = sxListBlock(lines, i); out.push(list.html); i = list.next; continue; }
      para.push(line.trim());
      i += 1;
    }
    flush();
    return out.join('');
  }
  // A quote's lines are already escaped: paragraphs and line breaks only, inline styles kept.
  sxMd.unescaped = function (lines) {
    return lines.join('\n').split(/\n\s*\n/).map(function (p) { return '<p>' + p.split('\n').map(sxInline).join('<br>') + '</p>'; }).join('');
  };
  // The card list a turn's Markdown box carries for panes/reader-media.js, checked here: ids and words only.
  sxMd.linksAttr = function (turn) {
    var list = turn && Array.isArray(turn.outputLinks) ? turn.outputLinks.slice(0, 20).map(function (x) {
      return x && /^al_[a-f0-9]{64}$/.test(x.id || '') && (x.state === 'available' || x.state === 'unavailable') ? {
        id: x.id, name: String(x.name || 'File').slice(0, 120), label: String(x.label || '').slice(0, 120), kind: String(x.kind || 'file').slice(0, 20),
        type: String(x.type || 'File').slice(0, 40), size: typeof x.size === 'number' && x.size >= 0 ? x.size : undefined,
        line: typeof x.line === 'number' && x.line > 0 ? Math.floor(x.line) : undefined, state: x.state, reason: typeof x.reason === 'string' ? x.reason.slice(0, 30) : undefined
      } : { id: '', state: 'invalid' };
    }) : [];
    return list.length ? ' data-reader-links="' + esc(JSON.stringify(list)) + '"' : '';
  };
  // Nested lists by indent: a deeper item opens a list inside the open item, a shallower one closes back.
  function sxListBlock(lines, i) {
    var html = '', stack = [];
    while (i < lines.length) {
      var m = SX_LIST.exec(lines[i]);
      if (!m) {
        if (!lines[i].trim() && i + 1 < lines.length && SX_LIST.test(lines[i + 1])) { i += 1; continue; }
        if (stack.length && /^\s{2,}\S/.test(lines[i])) { html += '<br>' + sxInline(lines[i].trim()); i += 1; continue; }
        break;
      }
      var indent = m[1].replace(/\t/g, '    ').length, tag = /\d/.test(m[2]) ? 'ol' : 'ul';
      var start = tag === 'ol' ? parseInt(m[2], 10) : 1;
      var open = '<' + tag + (tag === 'ol' && start > 1 ? ' start="' + start + '"' : '') + '>';
      if (!stack.length || indent > stack[stack.length - 1].indent) { html += open; stack.push({ indent: indent, tag: tag }); }
      else {
        while (stack.length > 1 && indent < stack[stack.length - 1].indent) html += '</li></' + stack.pop().tag + '>';
        html += '</li>';
        if (stack[stack.length - 1].tag !== tag) { html += '</' + stack.pop().tag + '>' + open; stack.push({ indent: indent, tag: tag }); }
      }
      html += '<li>' + sxInline(m[3]);
      i += 1;
    }
    while (stack.length) html += '</li></' + stack.pop().tag + '>';
    return { html: html, next: i };
  }

  // YOU and ASSISTANT cards, shown whole (Control: "a reply is Markdown; what you typed is shown as
  // you typed it"). The server shapes each turn to 4,000 characters with a visible ellipsis.
  function renderTurns(turns, d) {
    if (!turns.length) return '<p class="reader-placeholder">This session has no user or assistant prose stored.</p>';
    return turns.map(sxTurnHtml).join('');
  }
  // One turn's identity, for telling which turns a refresh brought that the page already shows.
  function sxTurnSig(t) {
    var text = String(t.text || t.content || '').trim();
    return (String(t.role || '').toLowerCase() === 'user' ? 'u' : 'a') + '|' + (t.at || '') + '|' + text.length + '|' + text.slice(0, 48) + '|' + readerImagesHtml(t) + (sxMd.linksAttr ? sxMd.linksAttr(t) : '');
  }
  function sxTurnHtml(t) {
    var role = String(t.role || '').toLowerCase() === 'user' ? 'user' : 'assistant';
    var text = String(t.text || t.content || '').trim();
    var at = toDate(t.at);
    var when = at ? (Date.now() - at.getTime() < 86400000 ? clock(at) : sxShortDate(at)) : '';
    return '<div class="turn ' + role + ' sx-turn" data-sig="' + esc(sxTurnSig(t)) + '"><span class="who"><span>' + (role === 'user' ? 'YOU' : 'ASSISTANT') + '</span>' +
      (when ? '<span class="sx-turn-when">' + esc(when) + '</span>' : '') + '</span>' +
      // A YOU turn shows only its attached images (and the previews-off mark); never a reply's outputs.
      (role === 'user' ? '<div class="sx-plain">' + esc(text) + '</div>' + readerImagesHtml(t, { part: 'user' })
        : readerImagesHtml(t, { part: 'before' }) + '<div class="sx-md"' + (sxMd.linksAttr ? sxMd.linksAttr(t) : '') + '>' + sxMd(text, t.outputLinks) + '</div>' + readerImagesHtml(t, { part: 'after' })) + '</div>';
  }
  // A refresh never rebuilds what you are reading (Miles, /qa: "start to scroll and then it reloads
  // the section"). The server's window slides as a session grows, so the turns the page already
  // shows are found at the start of the new list and only what follows them is appended; older
  // cards stay. Your sent and waiting bubbles give way to the real turns only when new turns land.
  // When the lists share nothing, the card you are reading is kept where it was on screen.
  function sxMergeTurns(box, old, next, d) {
    if (!old.length && !next.length) return;
    var oldSigs = old.map(sxTurnSig), nextSigs = next.map(sxTurnSig), fresh = null;
    for (var j = 0; j < oldSigs.length && fresh === null; j++) {
      var tail = oldSigs.slice(j);
      if (tail.length > nextSigs.length) continue;
      if (tail.every(function (s, k) { return s === nextSigs[k]; })) fresh = next.slice(tail.length);
    }
    if (fresh) {
      if (!fresh.length) return;
      box.querySelectorAll('.turn.pending, .reader-placeholder').forEach(function (el) { el.remove(); });
      box.insertAdjacentHTML('beforeend', fresh.map(sxTurnHtml).join(''));
      return;
    }
    var anchor = null, top = 0, cards = box.querySelectorAll('.turn[data-sig]');
    for (var i = 0; i < cards.length; i++) {
      var rect = cards[i].getBoundingClientRect();
      if (rect.bottom > 0) { anchor = cards[i].getAttribute('data-sig'); top = rect.top; break; }
    }
    box.innerHTML = renderTurns(next, d);
    if (!anchor) return;
    var same = [].filter.call(box.querySelectorAll('.turn[data-sig]'), function (el) { return el.getAttribute('data-sig') === anchor; })[0];
    if (same) window.scrollBy(0, same.getBoundingClientRect().top - top);
  }

  // ── Ask COS (the Ask sheet's first row) ─────────────────
  // 6.99.10: the same request as the COS chat's Ask (panes/cos-chat.js submitAsk). Before, this sent `prompt` with a
  // `web_<time>` id and no generation or era, so the server refused every one (409 message_era_mismatch on a Mac with
  // a message era, else invalid_client_job_id) and a small status line was the only sign.
  function webJobId() {
    // crypto.randomUUID needs a secure context; a plain-http tailnet page is not one.
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  var TODAY_REFERENCE = 'What Today in COS Control shows right now';
  // files: { attachmentIds, atts } from the Ask sheet's clip (askSheetFiles), or nothing.
  function askCos(prompt, statusEl, files) {
    // 6.99.12: "it shows Sent but never shows up" (Miles, 11/04). With Ask COS in Messages, the sheet hands its words to
    // that composer (panes/cos-chat.js submitAsk), so the answer streams on screen and lands as a numbered turn. The
    // request below is the fallback for a page without it; it resolves to the Messages route to open.
    var chat = window.COSWeb && window.COSWeb.cosChat;
    // Asked from Today: COS gets a short summary of what Today shows (panes/today-actions.js summary), as the Ask's
    // quoted reference, the query-jobs field for context. Asked from any other pane, nothing extra is sent.
    var context = state.pane === 'today' ? ensurePane('todayActions', 1500).then(function (m) {
      // A broken summary never costs the Ask: it goes without it, and the console says why.
      var ctx;
      try { ctx = m && m.summary ? m.summary() : ''; } catch (err) { console.error('[today] the Today summary failed; asking without it.', err); return ''; }
      // The model's summary of the sessions leads it when there is one, inside the same cap; past the cap it is left out.
      var b = typeof briefShown === 'function' ? briefShown() : null;
      var lead = b ? 'Summary of the sessions, written by a model ' + (briefMinutes(b.at) < 1 ? 'just now' : span(b.at) + ' ago') + (b.state === 'stale' ? ' (things have moved since)' : '') + ': ' + b.text : '';
      return ctx && lead && lead.length + 1 + ctx.length <= ((m && m.summaryMax) || 4000) ? lead + '\n' + ctx : ctx;
    }, function () { return ''; }) : Promise.resolve('');
    if (chat && chat.askFromSheet) {
      setStatus(statusEl, 'Sending…');
      return context.then(function (ctx) {
        var extra = files ? { attachmentIds: files.attachmentIds, atts: files.atts } : {};
        if (ctx) extra.context = ctx;
        return chat.askFromSheet(prompt, ctx || files ? extra : undefined);
      }).then(function (where) { setStatus(statusEl, ''); return where; }, function (err) {
        setStatus(statusEl, err.message, true);
        throw err;
      });
    }
    setStatus(statusEl, 'Sent. COS is answering.');
    var body = { clientJobId: webJobId(), generation: 1, query: prompt, source: 'web', activityToolMode: 'status' };
    if (files && files.attachmentIds && files.attachmentIds.length) body.attachmentIds = files.attachmentIds;
    return context.then(function (ctx) {
      if (ctx) body.reference = { query: TODAY_REFERENCE, response: ctx };
      return api('/api/query-jobs', { method: 'POST', body: body, timeoutMs: 30000 });
    }).then(function () {
      // The answer lands in Messages; refresh it there if it is open.
      var again = function () { if (state.pane === 'messages' && PANES.messages && PANES.messages.refresh) PANES.messages.refresh(); };
      setTimeout(again, 4000);
      setTimeout(function () { again(); setStatus(statusEl, ''); }, 15000);
    }).catch(function (err) {
      setStatus(statusEl, err.message, true);
      toast('Ask COS did not send: ' + err.message);
      throw err;
    });
  }
  // ── Usage ───────────────────────────────────────────────
  // Usage and COS cost are views inside Sessions, as on the Mac (ActivityWindow.swift 2306-2325);
  // an old #/usage link opens the Usage view there. Data: GET /api/usage/summary, the helper's
  // read-only session-usage and cos-usage reports (web-usage-bridge.ts). The figures follow
  // SessionUsageCore.swift: COS cost counts measured dollars (measuredUSD) and never adds
  // estimates into them, and its rows keep Control's category titles.
  function loadUsage() {
    SX.view = 'usage'; sxSave();
    location.replace('#/sessions');
  }
  function renderUsageView(force) {
    var box = $('sessions-usage'); if (!box) return;
    uLoadPrefs(); uWire();
    var stale = !SX.usage || Date.now() - SX.usageAt > 5 * 60000;
    if (SX.usage) paintUsage(true);
    else box.innerHTML = '<p class="cx-note sx-reading">' + (SX.view === 'cost' ? 'Reading what COS used.' : 'Reading local usage…') + '</p>';
    if ((!force && !stale) || SX.usageLoading) return;
    SX.usageLoading = true; paintSessionsHero();
    // The server runs the two Mac helpers side by side, each capped at 15 s (web-usage-bridge.ts), so a
    // cold read can pass the 20 s default for reads once the network is added; 30 s covers it.
    api('/api/usage/summary' + (force ? '?refresh=1' : ''), { timeoutMs: 30000 }).then(function (d) {
      SX.usage = d || {}; SX.usageAt = Date.now(); SX.usageError = ''; SX.usageLoading = false;
      paintSessionsHero(); paintUsage(true);
    }, function (err) {
      SX.usageLoading = false; SX.usageError = (err && err.message) || 'Usage did not load.';
      paintSessionsHero(); paintUsage(true);
    });
  }
  // background: a refresh or a breakpoint change, which waits while someone is using the page (uHeld). What a person
  // chose paints at once. From 860 px Usage takes the Mac's desktop layout; under it the vertical view is unchanged.
  function paintUsage(background) {
    var box = $('sessions-usage'); if (!box || SX.view === 'sessions') return;
    if (background === true && SX.view === 'usage' && uHeld()) { SX.uDeferred = true; return; }
    SX.uDeferred = false; SX.uRedraw = false;
    var wide = SX.view === 'usage' && !!SX.usage && uWide();
    SX.uWideShown = wide;
    box.classList.toggle('u-wide', wide);
    if (!wide) SX.uM = null;
    if (!SX.usage) { box.innerHTML = SX.usageError ? '<div class="cx-notice warn">' + esc(SX.usageError) + '</div>' : ''; return; }
    box.innerHTML = (SX.usageError ? '<div class="cx-notice warn">' + esc(SX.usageError) + '</div>' : '') +
      (SX.view === 'cost' ? cosCostHtml(SX.usage) : wide ? sessionUsageWideHtml(SX.usage) : sessionUsageHtml(SX.usage));
    if (wide) uDrawWide();
  }

  // Numbers the way Control writes them (SessionUsagePresentation, CosCostPresentation).
  function uCurrency(v, digits) { return (Number(v) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }); }
  function uMoney(v) { v = Number(v) || 0; return v > 0 && v < 0.01 ? 'under 1¢' : uCurrency(v, v < 10 ? 2 : 0); }
  function uAtLeast(v) { return v < 0.01 ? 'at least a fraction of 1¢' : 'at least ' + uMoney(v); }
  function uDollars(v) { v = Number(v) || 0; return v > 0 && v < 1 ? '<$1' : uCurrency(v, 0); }
  function uNum(n) { return (Number(n) || 0).toLocaleString('en-US'); }
  function uShort(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e8) return (n / 1e6).toFixed(0) + 'M';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e5) return (n / 1e3).toFixed(0) + 'K';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }
  function uShare(part, whole) { if (!(whole > 0)) return 'Unavailable'; var p = 100 * part / whole; return p > 0 && p < 0.1 ? '<0.1%' : p.toFixed(1) + '%'; }
  var U_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function uDayWords(key) { var p = String(key || '').split('-').map(Number); return p.length === 3 && p[1] ? U_MONTHS[p[1] - 1] + ' ' + p[2] + ', ' + p[0] : String(key || ''); }

  // SessionUsagePricing.tokens, for the chart's hover card: "2.82B", "48.30M", "12.5K".
  function uTok2(n) { n = Number(n) || 0; return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); }
  // spokenTokens: "78.0 billion", for the summary card's headline.
  function uSpoken(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' billion';
    if (n >= 1e6) return (n >= 1e8 ? (n / 1e6).toFixed(0) : (n / 1e6).toFixed(1)) + ' million';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' thousand';
    return uNum(n);
  }
  // deltaPercent: "+48.1%", "-3.2%", "0.0%"; no prior is Unavailable, never a made-up change.
  function uDelta(cur, prior) {
    if (!(prior > 0)) return 'Unavailable';
    var p = 100 * (cur - prior) / prior;
    if (Math.abs(p) < 0.05) return '0.0%';
    return (p > 0 ? '+' : '') + p.toFixed(1) + '%';
  }

  // ── Usage range math (pure: no page, no SX; server/lib/web-usage-range.test.ts runs this block) ──
  // Dates are ledger day keys (yyyy-MM-dd) in the report's time zone. A day key is a civil date, so the arithmetic
  // runs on UTC midnights and never meets a daylight-saving gap (SessionUsageDay in SessionUsageCore.swift).
  var U_CUSTOM = 'Custom dates';
  var U_PRESETS = ['Last 7 days', 'Last 30 days', 'Last 90 days', 'This month', 'Last month', 'This quarter', 'Year to date', 'Last weekend', 'All history'];
  var U_LAST = { 'Last 7 days': 7, 'Last 30 days': 30, 'Last 90 days': 90 };
  var U_MONTH_RE = /^\d{4}-\d{2}$/, U_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var U_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  // Today's date where the report was written. A zone the browser does not know falls back to the browser's own day.
  function uDayKey(tz, now) {
    var d = now || new Date();
    try {
      var parts = {};
      new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
        .forEach(function (p) { parts[p.type] = p.value; });
      if (parts.year && parts.month && parts.day) return parts.year + '-' + parts.month + '-' + parts.day;
    } catch (_e) { /* an unknown zone */ }
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function uSerial(key) { var p = String(key).split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000); }
  function uFromSerial(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function uAddDays(key, n) { return uFromSerial(uSerial(key) + n); }
  // 0 is Monday. 1970-01-01 was a Thursday.
  function uWeekday(key) { return ((uSerial(key) + 3) % 7 + 7) % 7; }
  function uValidDay(key) { return U_DAY_RE.test(String(key || '')) && uFromSerial(uSerial(key)) === key; }
  function uMonthAdd(month, n) { var p = month.split('-').map(Number), m = p[0] * 12 + (p[1] - 1) + n; return Math.floor(m / 12) + '-' + String(m % 12 + 1).padStart(2, '0'); }
  function uMonthEnd(month) { return uAddDays(uMonthAdd(month, 1) + '-01', -1); }
  function uKnownPeriod(p) { return U_PRESETS.indexOf(p) >= 0 || U_MONTH_RE.test(String(p || '')) || p === U_CUSTOM; }
  function uMonthShaped(p) { return p === 'This month' || p === 'Last month' || U_MONTH_RE.test(String(p || '')); }
  function uMonthOf(p, today) { return p === 'This month' ? today.slice(0, 7) : p === 'Last month' ? uMonthAdd(today.slice(0, 7), -1) : p; }
  // The words Control uses when a custom range is not one.
  function uCustomError(from, to) {
    if (!uValidDay(from) || !uValidDay(to)) return 'Choose a start and an end date.';
    return from > to ? 'Choose an end date on or after the start.' : '';
  }
  // The dates a period covers, [first, last]. Null is All history; false is a custom range that is not one. A month or
  // quarter covers all its dates, as Control's selectionBounds does; the calendar and the comparison stop at today.
  function uRange(period, today, from, to) {
    if (period === 'All history') return null;
    if (U_LAST[period]) return [uAddDays(today, 1 - U_LAST[period]), today];
    if (period === 'Last weekend') { var monday = uAddDays(today, -uWeekday(today)); return [uAddDays(monday, -2), uAddDays(monday, -1)]; }
    if (uMonthShaped(period)) { var m = uMonthOf(period, today); return [m + '-01', uMonthEnd(m)]; }
    if (period === 'This quarter') {
      var q = today.slice(0, 4) + '-' + String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0');
      return [q + '-01', uMonthEnd(uMonthAdd(q, 2))];
    }
    if (period === 'Year to date') return [today.slice(0, 4) + '-01-01', today];
    if (period === U_CUSTOM) return uCustomError(from, to) ? false : [from, to];
    return false;
  }
  // Like-for-like windows (SessionUsageCore comparisonWindows): a month in progress against the same dates of the month
  // before, clamped to its length; a finished month against the whole month before; anything else against the same
  // number of dates just before it, counting only the dates that have happened. All history has nothing before it.
  function uCompare(period, today, from, to) {
    if (period === 'All history') return null;
    var shifted = function (a, b, span) { var n = span || (uSerial(b) - uSerial(a) + 1); return { current: [a, b], prior: [uAddDays(a, -n), uAddDays(b, -n)] }; };
    if (period === 'Last weekend') { var w = uRange(period, today); return shifted(w[0], w[1], 7); }
    if (uMonthShaped(period)) {
      var month = uMonthOf(period, today), first = month + '-01', prev = uMonthAdd(month, -1);
      if (month === today.slice(0, 7)) {
        var same = uAddDays(prev + '-01', uSerial(today) - uSerial(first)), end = uMonthEnd(prev);
        return { current: [first, today], prior: [prev + '-01', same < end ? same : end] };
      }
      return { current: [first, uMonthEnd(month)], prior: [prev + '-01', uMonthEnd(prev)] };
    }
    var r = uRange(period, today, from, to);
    if (!r || r[0] > today) return null;
    return shifted(r[0], r[1] < today ? r[1] : today);
  }
  // ‹ › on the summary card: the same length earlier or later. A month steps a month and a calendar quarter steps a
  // quarter; anything else moves by its number of days, and a step that lands on the last 7, 30 or 90 days says so.
  // Nothing steps past today, or earlier than the first day of history.
  function uStep(period, today, from, to, delta, firstDay) {
    if (period === 'All history') return null;
    var nb, next;
    if (uMonthShaped(period)) {
      var m = uMonthAdd(uMonthOf(period, today), delta);
      nb = [m + '-01', uMonthEnd(m)]; next = { period: m, from: '', to: '' };
    } else {
      var r = uRange(period, today, from, to);
      if (!r) return null;
      var quarter = /-(01|04|07|10)-01$/.test(r[0]) && r[1] === uMonthEnd(uMonthAdd(r[0].slice(0, 7), 2));
      if (quarter) { var qs = uMonthAdd(r[0].slice(0, 7), 3 * delta); nb = [qs + '-01', uMonthEnd(uMonthAdd(qs, 2))]; }
      else { var n = uSerial(r[1]) - uSerial(r[0]) + 1; nb = [uAddDays(r[0], delta * n), uAddDays(r[1], delta * n)]; }
      next = { period: U_CUSTOM, from: nb[0], to: nb[1] };
      Object.keys(U_LAST).forEach(function (p) { if (nb[1] === today && nb[0] === uAddDays(today, 1 - U_LAST[p])) next = { period: p, from: '', to: '' }; });
    }
    if (nb[0] > today) return null;
    if (delta < 0 && firstDay && nb[1] < firstDay) return null;
    return next;
  }
  // The scale a period opens on until someone picks one, so bars stay few enough to read (defaultScale, extended to the
  // ranges the web adds: a quarter by week, a long custom range or year by week or month).
  function uDefaultScale(period, today, from, to) {
    if (period === 'All history') return 'monthly';
    if (period === 'Last 90 days' || period === 'This quarter') return 'weekly';
    if (period === 'Year to date' || period === U_CUSTOM) {
      var r = uRange(period, today, from, to);
      if (!r) return 'daily';
      var n = uSerial(r[1] < today ? r[1] : today) - uSerial(r[0]) + 1;
      return n > 200 ? 'monthly' : n > 62 ? 'weekly' : 'daily';
    }
    return 'daily';
  }
  function uPeriodKey(day, scale) { return scale === 'monthly' ? day.slice(0, 7) : scale === 'weekly' ? uAddDays(day.slice(0, 10), -uWeekday(day.slice(0, 10))) : day.slice(0, 10); }
  function uPeriodStart(key) { return key.length === 7 ? key + '-01' : key; }
  function uShortDay(key) { var p = key.split('-').map(Number); return U_MONTHS[p[1] - 1].slice(0, 3) + ' ' + p[2]; }
  // dateRangeTitle: "Sep 6 – Oct 5, 2026", "Dec 29, 2025 – Jan 4, 2026", "Oct 19, 2026".
  function uDateRangeTitle(b) {
    var a = b[0], z = b[1];
    if (a === z) return uShortDay(a) + ', ' + a.slice(0, 4);
    return a.slice(0, 4) === z.slice(0, 4) ? uShortDay(a) + ' – ' + uShortDay(z) + ', ' + z.slice(0, 4) : uShortDay(a) + ', ' + a.slice(0, 4) + ' – ' + uShortDay(z) + ', ' + z.slice(0, 4);
  }
  // periodTitle: a bar's name, clamped to the selection, so a boundary week or month says which of its dates are in it.
  function uPeriodTitle(key, scale, bounds) {
    var first = uPeriodStart(key);
    var clamp = function (a, z) { return [bounds && bounds[0] > a ? bounds[0] : a, bounds && bounds[1] < z ? bounds[1] : z]; };
    if (scale === 'monthly') {
      var name = U_MONTHS[Number(first.slice(5, 7)) - 1] + ' ' + first.slice(0, 4), end = uMonthEnd(first.slice(0, 7)), c = clamp(first, end);
      return (c[0] === first && c[1] === end) || c[0] > c[1] ? name : name + ' (' + uShortDay(c[0]) + ' – ' + uShortDay(c[1]) + ')';
    }
    if (scale === 'weekly') {
      var sunday = uAddDays(first, 6), w = clamp(first, sunday);
      return (w[0] === first && w[1] === sunday) || w[0] > w[1] ? 'Week of ' + uDateRangeTitle([first, sunday]) : uDateRangeTitle(w) + ' (partial week)';
    }
    return U_WEEKDAYS[uWeekday(first)] + ', ' + uShortDay(first) + ', ' + first.slice(0, 4);
  }
  // The label on the period button: the preset's words, "October 2026", or a custom range's dates.
  function uRangeTitle(period, from, to) {
    if (period === U_CUSTOM) return uCustomError(from, to) ? 'Custom dates' : uDateRangeTitle([from, to]);
    if (U_MONTH_RE.test(period)) return U_MONTHS[Number(period.slice(5)) - 1] + ' ' + period.slice(0, 4);
    return period;
  }
  // partialPeriods: the first and last week or month that the selection or today cuts short.
  function uPartialPeriods(keys, scale, firstDay, lastDay) {
    var out = {};
    if (scale === 'daily' || !firstDay) return out;
    keys.forEach(function (k) {
      var s = uPeriodStart(k), e = scale === 'weekly' ? uAddDays(s, 6) : uMonthEnd(s.slice(0, 7));
      if (s < firstDay || e > lastDay) out[k] = true;
    });
    return out;
  }
  // axisKeys: at most about seven labels, from the first period, never the last (it would run off the edge).
  function uAxisKeys(keys) {
    if (keys.length <= 7) return keys.slice();
    var step = Math.ceil(keys.length / 7), out = [];
    for (var i = 0; i < keys.length - 1; i += step) out.push(keys[i]);
    return out;
  }
  function uAxisLabel(key) {
    var s = uPeriodStart(key), m = U_MONTHS[Number(s.slice(5, 7)) - 1].slice(0, 3);
    return key.length === 7 ? (s.slice(5, 7) === '01' ? m + ' ' + s.slice(0, 4) : m) : m + ' ' + Number(s.slice(8, 10));
  }
  // niceAxisTop: four even steps that land on round numbers.
  function uNiceTop(peak) {
    if (!(peak > 0) || !isFinite(peak)) return 1;
    var target = peak * 1.04, mag = Math.pow(10, Math.floor(Math.log10(target)));
    var steps = [1, 1.2, 1.6, 2, 2.4, 3.2, 4, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * mag >= target) return steps[i] * mag;
    return 10 * mag;
  }
  // ── end of usage range math ──

  // ── Usage view (SessionUsageView.swift 329-445) ──
  var U_PERIODS = ['Last 7 days', 'Last 30 days', 'Last 90 days', 'Last weekend', 'All history'];
  function uToolName(p) { return p === 'Anthropic' ? 'Claude Code' : p === 'OpenAI' ? 'Codex' : p === 'Cursor' ? 'Cursor' : 'Codex (' + p + ')'; }
  // "claude-opus-5-5" reads "Opus 5.5"; an unknown id stays recognizable.
  function uModelName(id) {
    var name = String(id || '').replace(/-\d{8}$/, '');
    if (name.indexOf('cursor-') === 0) name = name.slice(7);
    var parts = name.split('-');
    if (parts.length < 2) return name;
    var isVersion = function (s) { return /^[\d.]+$/.test(s); };
    var cap = function (s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
    if (parts[0] === 'claude') {
      parts.shift();
      if (parts.length > 1 && isVersion(parts[0])) { var t = parts[0]; parts[0] = parts[1]; parts[1] = t; }
      var family = parts.shift(), version = [];
      while (parts.length && isVersion(parts[0])) version.push(parts.shift());
      return [cap(family)].concat(version.length ? [version.join('.')] : []).concat(parts).join(' ');
    }
    if (parts[0] === 'gpt') return ['GPT-' + parts[1]].concat(parts.slice(2).map(function (p, i) { return i === 0 ? cap(p) : p; })).join(' ');
    return [cap(parts[0])].concat(parts.slice(1)).join(' ');
  }
  function uTotals(rows) {
    var t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0, priced: 0, usd: 0 };
    rows.forEach(function (b) {
      var c = b.counts || {};
      t.input += Number(c.input) || 0; t.output += Number(c.output) || 0; t.cacheRead += Number(c.cacheRead) || 0; t.cacheWrite += Number(c.cacheWrite) || 0;
      t.events += Number(b.events) || 0; t.priced += Number(b.pricedEvents) || 0; t.usd += Number(b.estimatedUSD) || 0;
    });
    t.fresh = t.input + t.output + t.cacheWrite;
    t.all = t.fresh + t.cacheRead;
    return t;
  }
  function uCostCell(t) { return t.priced > 0 ? uDollars(t.usd) + (t.priced < t.events ? '+' : '') : 'No price'; }
  function uGroup(rows, keyFn) {
    var by = {}, order = [];
    rows.forEach(function (b) { var k = keyFn(b); if (!by[k]) { by[k] = []; order.push(k); } by[k].push(b); });
    return order.map(function (k) { return { key: k, rows: by[k], t: uTotals(by[k]) }; });
  }
  function uSelect(id, label, value, options) {
    return '<select id="' + id + '" class="field sx-select" aria-label="' + label + '">' + options.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('') + '</select>';
  }
  function sessionUsageHtml(d) {
    var su = d.sessionUsage;
    var how = '<details class="sx-how"><summary>How this is counted</summary>' + uHowLines(su).map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') + '</details>';
    if (!su) return '<div class="sx-uempty">' + esc('Usage has not been read yet. Refresh reads Claude Code and Codex logs on this Mac.') + '</div>' + how;
    var tz = su.timeZone || '';
    var buckets = (Array.isArray(su.buckets) ? su.buckets : []).filter(function (b) { return b && typeof b.day === 'string'; });
    var pending = [];
    if (Number(su.pendingFiles) > 0) pending.push('Reading older history: ' + su.pendingFiles + ' files remaining. Totals will grow until it finishes.');
    if (su.cursorFeed && su.cursorFeed.pending === true && su.cursorFeed.message) pending.push(su.cursorFeed.message + ' Totals will grow until it finishes.');
    var pendingHtml = pending.map(function (n) { return '<p class="cx-note sx-unote">' + esc(n) + '</p>'; }).join('');
    if (!buckets.length) return '<div class="sx-uempty">' + esc('No usage recorded yet. Claude Code and Codex sessions on this Mac appear here once their logs are read. A missing tool is not zero usage.') + pendingHtml + '</div>' + how;

    var months = []; buckets.forEach(function (b) { var m = b.day.slice(0, 7); if (months.indexOf(m) < 0) months.push(m); });
    months.sort().reverse();
    var periods = U_PERIODS.concat(months.slice(0, 12));
    // A range picked on the wide layout (This quarter, a custom range) stays when the phone folds; Custom dates sits
    // before All history, as on the Mac.
    if (!uKnownPeriod(SX.uPeriod) || (SX.uPeriod === U_CUSTOM && uCustomError(SX.uFrom, SX.uTo))) SX.uPeriod = 'Last 30 days';
    if (SX.uPeriod !== U_CUSTOM && periods.indexOf(SX.uPeriod) < 0) periods.splice(4, 0, SX.uPeriod);
    periods.splice(periods.indexOf('All history'), 0, U_CUSTOM);
    var bounds = uRange(SX.uPeriod, uDayKey(tz), SX.uFrom, SX.uTo);
    var inPeriod = bounds === null ? buckets : bounds ? buckets.filter(function (b) { return b.day >= bounds[0] && b.day <= bounds[1]; }) : [];
    var tools = uGroup(buckets, function (b) { return b.provider; }).sort(function (a, b) { return b.t.all - a.t.all; }).map(function (g) { return g.key; });
    if (SX.uTool !== 'All tools' && tools.indexOf(SX.uTool) < 0) SX.uTool = 'All tools';
    var forTool = buckets.filter(function (b) { return SX.uTool === 'All tools' || b.provider === SX.uTool; });
    var models = uGroup(forTool, function (b) { return b.model; }).sort(function (a, b) { return b.t.all - a.t.all; }).map(function (g) { return g.key; });
    if (SX.uModel !== 'All models' && models.indexOf(SX.uModel) < 0) SX.uModel = 'All models';
    var selected = inPeriod.filter(function (b) { return (SX.uTool === 'All tools' || b.provider === SX.uTool) && (SX.uModel === 'All models' || b.model === SX.uModel); });
    var hasFilter = SX.uTool !== 'All tools' || SX.uModel !== 'All models';
    var updated = toDate(su.updatedAt);

    var html = '<div class="sx-ufilters">' +
      uSelect('usage-period', 'Period', SX.uPeriod, periods.map(function (p) { return [p, p === U_CUSTOM ? (SX.uPeriod === U_CUSTOM ? uRangeTitle(p, SX.uFrom, SX.uTo) : p) : /^\d{4}-\d{2}$/.test(p) ? U_MONTHS[Number(p.slice(5)) - 1] + ' ' + p.slice(0, 4) : p]; })) +
      (SX.uPeriod === U_CUSTOM ? '<button type="button" class="sx-link" data-sx="usage-range">Change dates</button>' : '') +
      uSelect('usage-tool', 'Tool', SX.uTool, [['All tools', 'All tools']].concat(tools.map(function (p) { return [p, uToolName(p)]; }))) +
      uSelect('usage-model', 'Model', SX.uModel, [['All models', 'All models']].concat(models.map(function (m) { return [m, uModelName(m)]; }))) +
      (hasFilter ? '<button type="button" class="sx-link" data-sx="usage-clear">Clear filters</button>' : '') +
      (updated ? '<span class="sx-fresh">Updated ' + esc(clock(updated)) + '</span>' : '') +
      '</div>' + pendingHtml;
    if (!selected.length) return html + '<div class="sx-uempty">No recorded usage for this selection. A missing tool is not zero usage.</div>' + uFooter(su, selected) + how;

    var t = uTotals(selected);
    var days = uGroup(selected, function (b) { return b.day; });
    var pricedDays = days.filter(function (g) { return g.t.priced > 0; });
    var perDay = pricedDays.length ? uDollars(pricedDays.reduce(function (s, g) { return s + g.t.usd; }, 0) / pricedDays.length) + (pricedDays.some(function (g) { return g.t.priced < g.t.events; }) ? '+' : '') : 'No price';
    var figures = [
      ['API value', uCostCell(t), '', 'What these tokens would cost at standard API rates. Not your subscription bill.'],
      ['New tokens', uShort(t.fresh), '', 'Input, output and cache writes.'],
      ['All tokens', uShort(t.all), uShare(t.cacheRead, t.all) + ' read again from cache', 'New tokens plus context read again from cache.'],
      ['API value a day', perDay, days.length + ' ' + (days.length === 1 ? 'day' : 'days') + ' with usage', 'Average across days with a price. Days without logs or a price are left out, not counted as zero.']
    ];
    html += '<div class="sx-figures">' + figures.map(function (f, i) {
      return '<div class="sx-figure' + (i === 0 ? ' lead' : '') + '" title="' + esc(f[3]) + '"><b>' + esc(f[1]) + '</b><span class="sx-figure-title">' + esc(f[0]) + '</span>' + (f[2] ? '<span class="sx-figure-note">' + esc(f[2]) + '</span>' : '') + '</div>';
    }).join('') + '</div>';

    // By tool and model, largest first.
    var byModel = uGroup(selected, function (b) { return b.provider + '|' + b.model; }).sort(function (a, b) { return b.t.all - a.t.all; });
    html += '<h3 class="sx-uhead">By tool and model</h3><div class="sx-table sx-utable"><table><thead><tr><th>Model</th><th>Tool</th><th class="num hp">New tokens</th><th class="num">All tokens</th><th class="num">API value</th></tr></thead><tbody>' +
      byModel.map(function (g) {
        var b = g.rows[0];
        return '<tr><td title="' + esc(b.model) + '">' + esc(uModelName(b.model)) + '</td><td>' + esc(uToolName(b.provider)) + '</td><td class="num hp">' + uShort(g.t.fresh) + '</td><td class="num">' + uShort(g.t.all) + '</td><td class="num">' + esc(uCostCell(g.t)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    // Day by day, newest first, with a bar for the day's new tokens.
    var dayRows = days.slice().sort(function (a, b) { return a.key < b.key ? 1 : -1; }).slice(0, 45);
    var peak = dayRows.reduce(function (m, g) { return Math.max(m, g.t.fresh); }, 0) || 1;
    html += '<h3 class="sx-uhead">Day by day</h3><div class="cx-list sx-days">' + dayRows.map(function (g) {
      var p = g.key.split('-').map(Number);
      var label = new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
      return '<div class="sx-day"><span class="sx-day-date">' + esc(label) + '</span><span class="sx-day-bar" aria-hidden="true"><span style="width:' + Math.max(1, Math.round(100 * g.t.fresh / peak)) + '%"></span></span>' +
        '<span class="sx-day-tok">' + uShort(g.t.fresh) + '</span><span class="sx-day-usd">' + esc(uCostCell(g.t)) + '</span></div>';
    }).join('') + '</div>' + (days.length > dayRows.length ? '<p class="cx-note">The newest ' + dayRows.length + ' of ' + days.length + ' days.</p>' : '');
    return html + uFooter(su, selected) + how;
  }
  function uFooter(su, selected) {
    var bits = ['Read from ' + uNum(su.filesIndexed) + ' log files on this Mac.'];
    if (Number(su.unreadableFiles) > 0) bits.push(uNum(su.unreadableFiles) + ' could not be read.');
    var missing = {}, unpriced = 0;
    selected.forEach(function (b) { var gap = (Number(b.events) || 0) - (Number(b.pricedEvents) || 0); if (gap > 0) { unpriced += gap; var n = uModelName(b.model); missing[n] = (missing[n] || 0) + gap; } });
    if (unpriced > 0) {
      var names = Object.keys(missing).sort(function (a, b) { return missing[b] - missing[a] || (a < b ? -1 : 1); });
      bits.push('A + means a figure leaves out ' + uNum(unpriced) + ' records with no verified price: ' + names.slice(0, 2).join(' and ') + (names.length > 2 ? ' and ' + (names.length - 2) + ' more' : '') + '.');
    }
    return '<p class="sx-ufoot">' + bits.map(esc).join(' ') + '</p>';
  }
  function uHowLines(su) {
    var lines = ['While COS Control is running it refreshes every five minutes. Pausing keeps existing history. Only counts, dates, model names and file checkpoints are stored. Local logs are never uploaded.'];
    if (su) {
      (su.coverage || []).forEach(function (c) { if (typeof c === 'string') lines.push(c); });
      var gaps = (Number(su.unreadableFiles) || 0) + (Number(su.malformedRows) || 0) + (Number(su.missingBaselineEvents) || 0);
      if (gaps > 0) lines.push('Gaps: ' + (su.unreadableFiles || 0) + ' unreadable files or oversized rows, ' + (su.malformedRows || 0) + ' malformed rows, ' + (su.missingBaselineEvents || 0) + ' missing usage baselines. Totals reflect what could be read.');
      lines.push('Calendar dates in ' + (su.timeZone || 'this Mac’s time zone') + '. Days without logs are missing, not zero. Weeks run Monday to Sunday, and the first and last week or month of a period can be partial.');
    }
    lines.push('New tokens are input, output and cache writes. Output includes reasoning. Cache reads are repeated context, not cache savings.');
    var checked = su && /^\d{4}-\d{2}-\d{2}/.test(String(su.pricingVersion || '')) ? uDayWords(String(su.pricingVersion).slice(0, 10)) : 'October 25, 2026';
    lines.push('API value is the standard API rate, checked ' + checked + ' and applied to all dates. It leaves out discounts, speed tiers, tools and taxes, and it is not your subscription bill. Cursor’s value is the per-request cost Cursor reports.');
    lines.push('Token share is not your plan allowance. It compares recorded tokens in this selection; providers calculate subscription limits separately.');
    return lines;
  }


  // ── Usage, wide (860 px and up): the Mac's desktop layout (SessionUsageView body, SessionUsageSplitLayout) ──
  // Figures, then the chart beside the summary card, then the day-by-day calendar, the Tool and model table and the
  // daily breakdown. Under 860 px the vertical view above stays as it was. The chart and calendar draw after the HTML
  // lands, at the width they get, and redraw only on their own: a hover, a tap or a refresh never rebuilds a control
  // under a finger (uHeld).
  var U_WIDE_MQ = '(min-width: 860px)';
  function uWide() { try { return !!(window.matchMedia && window.matchMedia(U_WIDE_MQ).matches); } catch (_e) { return false; } }
  var U_MEASURES = [['all', 'All tokens'], ['new', 'New tokens'], ['value', 'API value']];
  var U_SERIES = [['tool', 'tool'], ['model', 'model'], ['type', 'token type']];
  var U_SCALES = [['daily', 'day'], ['weekly', 'week'], ['monthly', 'month']];
  var U_COLUMNS = [
    ['records', 'Records', 'Usage records, about one for each model response.'],
    ['cacheReads', 'Cache reads', 'How much of all tokens was context read again from cache.'],
    ['perMillion', 'Per 1M new', 'API value for each million new tokens, counting only rows where every record has a price.'],
    ['lastUsed', 'Last used', 'The last day with a record in this selection.']
  ];
  var U_COLS_KEY = 'cos_web_usage_columns';
  // SessionUsageChart.seriesColor and rankedColors. The values live in sessions.css as --u-* tokens.
  var U_RANKED = ['var(--u-gold)', 'var(--u-codex)', 'var(--u-output)', 'var(--u-input)', 'var(--u-purple)', 'var(--u-brown)'];
  var U_HASHED = ['var(--u-blue)', 'var(--u-green)', 'var(--u-pink)', 'var(--u-indigo)', 'var(--u-tan)'];
  function uSeriesColor(name) {
    switch (name) {
      case 'Claude Code': return 'var(--u-gold)';
      case 'Codex': return 'var(--u-codex)';
      case 'Cursor': return 'var(--u-cursor)';
      case 'Codex (Ollama)': return 'var(--u-purple)';
      case 'Input': return 'var(--u-input)';
      case 'Output': return 'var(--u-output)';
      case 'Read from cache': return 'var(--u-read)';
      case 'Written to cache': return 'var(--u-purple)';
      case 'Other models': return 'var(--u-gray)';
    }
    var h = 0, bytes = new TextEncoder().encode(String(name));
    for (var i = 0; i < bytes.length; i++) h = (h * 31 + bytes[i]) % U_HASHED.length;
    return U_HASHED[h];
  }

  // SessionUsagePricing.rate and categoryUSD (SessionUsageCore.swift 98-170, rates checked 2026-10-25): the stored
  // value of a fully priced row split across its token types, reconciling to it. Partly priced rows and Cursor are not
  // split, and the card says so instead of inventing the difference.
  var U_RATES_ANTHROPIC = {
    'claude-opus-5-5': [4, 20, 0.2], 'claude-sonnet-5-5': [2, 10, 0.1],
    'claude-fable-5-1': [10, 50, 0.25], 'claude-mythos-5-1': [10, 50, 0.25], 'claude-fable-5': [10, 50, 1], 'claude-mythos-5': [10, 50, 1],
    'claude-opus-5': [5, 25, 0.5], 'claude-opus-4-8': [5, 25, 0.5], 'claude-opus-4-7': [5, 25, 0.5], 'claude-opus-4-6': [5, 25, 0.5], 'claude-opus-4-5': [5, 25, 0.5],
    'claude-opus-4-1': [15, 75, 1.5], 'claude-opus-4': [15, 75, 1.5], 'claude-sonnet-5': [2, 10, 0.2],
    'claude-sonnet-4-6': [3, 15, 0.3], 'claude-sonnet-4-5': [3, 15, 0.3], 'claude-sonnet-4': [3, 15, 0.3],
    'claude-haiku-4-5': [1, 5, 0.1], 'claude-3-5-haiku': [0.8, 4, 0.08]
  };
  var U_RATES_OPENAI = { 'gpt-6.1-sol': [2, 10, 0.1, 2.5, 5], 'gpt-6-astra': [10, 50, 1, 12.5, 25], 'gpt-6-luna': [0.1, 0.5, 0.01, 0.125, 0.25], 'gpt-5.3-codex': [1.75, 14, 0.175, 0, 0] };
  function uRate(provider, model, prompt) {
    var name = String(model || '').replace(/-\d{8}$/, ''), t;
    if (provider === 'Anthropic') {
      t = name === 'claude-haiku-5-5' ? (prompt > 100000 ? [0.5, 2.5, 0.05] : [0.1, 0.5, 0.01]) : U_RATES_ANTHROPIC[name];
      return t ? { input: t[0], output: t[1], read: t[2], write5: t[0] * 1.25, write1h: t[0] * 2 } : null;
    }
    t = provider === 'OpenAI' ? U_RATES_OPENAI[name] : null;
    return t ? { input: t[0], output: t[1], read: t[2], write5: t[3], write1h: t[4] } : null;
  }
  function uCategoryUSD(b) {
    var c = b.counts || {}, events = Number(b.events) || 0, usd = Number(b.estimatedUSD) || 0;
    if (!(events > 0) || Number(b.pricedEvents) !== events || !(usd > 0)) return null;
    var r = uRate(b.provider, b.model, 0);
    if (!r) return null;
    var write = Number(c.cacheWrite) || 0;
    var inU = (Number(c.input) || 0) * r.input / 1e6, outU = (Number(c.output) || 0) * r.output / 1e6, readU = (Number(c.cacheRead) || 0) * r.read / 1e6;
    var w5 = write * r.write5 / 1e6, nonWrite = inU + outU + readU;
    // One-hour cache writes raise only cacheWrite, never past every write at the one-hour rate.
    if (b.provider === 'Anthropic' && write > 0 && String(b.model).indexOf('claude-haiku-5-5') !== 0) {
      var rem = usd - nonWrite, cap = write * r.write1h / 1e6;
      if (rem >= w5 * 0.999 && rem <= cap * 1.001) return { input: inU, output: outU, cacheRead: readU, cacheWrite: Math.max(0, rem) };
    }
    var base = nonWrite + w5;
    if (!(base > 0)) return null;
    var s = usd / base;
    return { input: inU * s, output: outU * s, cacheRead: readU * s, cacheWrite: Math.max(0, usd - inU * s - outU * s - readU * s) };
  }
  function uCostSplit(rows) {
    var sp = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, priced: 0, unsplit: 0 };
    rows.forEach(function (b) {
      if (!(Number(b.pricedEvents) > 0)) return;
      sp.priced += Number(b.estimatedUSD) || 0;
      var c = uCategoryUSD(b);
      if (!c) { sp.unsplit += Number(b.events) || 0; return; }
      sp.input += c.input; sp.output += c.output; sp.cacheRead += c.cacheRead; sp.cacheWrite += c.cacheWrite;
    });
    sp.split = sp.input + sp.output + sp.cacheRead + sp.cacheWrite;
    return sp;
  }
  // tokenMix: always the four disjoint types, so the strips, the card's rows and the chart describe the same set.
  function uTokenMix(t, excl, rows) {
    var c = uCostSplit(rows);
    return [
      { id: 'Input', count: t.input, usd: c.input },
      { id: 'Output', count: t.output, usd: c.output },
      { id: 'Read from cache', count: t.cacheRead, usd: c.cacheRead, excluded: excl },
      { id: 'Written to cache', count: t.cacheWrite, usd: c.cacheWrite }
    ];
  }
  function uMeasured(t, excl) { return excl ? t.fresh : t.all; }
  // summarize: one total per key, largest first by the measured tokens, ties by name.
  function uSummaries(rows, keyFn, excl) {
    return uGroup(rows, keyFn).sort(function (a, b) { var x = uMeasured(a.t, excl), y = uMeasured(b.t, excl); return x === y ? (a.key < b.key ? -1 : 1) : y - x; });
  }
  function uCostLabel2(t) { return t.priced > 0 ? uCurrency(t.usd, 2) + (t.priced < t.events ? '+' : '') : 'No price'; }
  function uSumCost(t) { return t.priced > 0 ? uDollars(t.usd) + (t.priced < t.events ? '+' : '') : 'No price'; }
  // peakDay: the highest day by the chart's measure; API value ranks only days with a price. Ties go to the earlier date.
  function uPeakDay(rows, cost, excl) {
    var best = null;
    uGroup(rows, function (b) { return b.day; }).forEach(function (g) {
      if (cost && !(g.t.priced > 0)) return;
      var v = cost ? g.t.usd : uMeasured(g.t, excl);
      if (!best || v > best.v || (v === best.v && g.key < best.g.key)) best = { g: g, v: v };
    });
    return best && best.g;
  }
  // comparePeriod: the selection against the window before it, for the same tool and model.
  function uComparePeriod(M, cost, excl) {
    var t = uTotals(M.selected), out = { peak: uPeakDay(M.selected, cost, excl), prior: null, has: false, partialPrior: false, costPartial: false, tok: 'Unavailable', usd: 'Unavailable' };
    var w = uCompare(M.period, M.today, SX.uFrom, SX.uTo);
    if (!w) return out;
    out.prior = w.prior;
    var priorRows = M.matching.filter(function (b) { return b.day >= w.prior[0] && b.day <= w.prior[1]; });
    // Each tool in view must reach back that far, or a mostly empty window would read as a real baseline.
    var provs = {}; M.selected.forEach(function (b) { provs[b.provider] = true; });
    var names = Object.keys(provs);
    out.partialPrior = !names.length || names.some(function (p) { var first = M.firstByProvider[p]; return !first || first > w.prior[0]; });
    var pt = uTotals(priorRows);
    out.has = priorRows.length > 0;
    out.tok = out.has ? uDelta(uMeasured(t, excl), uMeasured(pt, excl)) : 'Unavailable';
    out.usd = out.has && t.priced > 0 && pt.priced > 0 ? uDelta(t.usd, pt.usd) : 'Unavailable';
    out.costPartial = t.priced < t.events || pt.priced < pt.events;
    return out;
  }
  function uPriorNote(delta, c, pricedOnly) {
    if (!c.has || c.partialPrior || delta === 'Unavailable') return '';
    return delta + ' on the period before' + (pricedOnly ? ', priced records' : '');
  }
  // The selection the wide view draws. Built once per paint; a hover or a tap reads it and never rebuilds it.
  function uWideModel(d) {
    var su = d.sessionUsage, tz = su.timeZone || '', today = uDayKey(tz);
    var buckets = (Array.isArray(su.buckets) ? su.buckets : []).filter(function (b) { return b && typeof b.day === 'string' && uValidDay(b.day.slice(0, 10)); });
    var M = { su: su, tz: tz, today: today, buckets: buckets, firstByProvider: {} };
    if (!buckets.length) return M;
    buckets.forEach(function (b) { var f = M.firstByProvider[b.provider]; if (!f || b.day < f) M.firstByProvider[b.provider] = b.day; if (!M.firstDay || b.day < M.firstDay) M.firstDay = b.day; });
    var months = []; buckets.forEach(function (b) { var m = b.day.slice(0, 7); if (months.indexOf(m) < 0) months.push(m); });
    M.months = months.sort().reverse();
    if (!uKnownPeriod(SX.uPeriod) || (SX.uPeriod === U_CUSTOM && uCustomError(SX.uFrom, SX.uTo))) SX.uPeriod = 'Last 30 days';
    M.period = SX.uPeriod;
    M.bounds = uRange(M.period, today, SX.uFrom, SX.uTo);
    var inPeriod = M.bounds ? buckets.filter(function (b) { return b.day >= M.bounds[0] && b.day <= M.bounds[1]; }) : buckets;
    M.tools = uGroup(buckets, function (b) { return b.provider; }).sort(function (a, b) { return b.t.all - a.t.all; }).map(function (g) { return g.key; });
    if (SX.uTool !== 'All tools' && M.tools.indexOf(SX.uTool) < 0) SX.uTool = 'All tools';
    var forTool = buckets.filter(function (b) { return SX.uTool === 'All tools' || b.provider === SX.uTool; });
    M.models = uGroup(forTool, function (b) { return b.model; }).sort(function (a, b) { return b.t.all - a.t.all; }).map(function (g) { return g.key; });
    if (SX.uModel !== 'All models' && M.models.indexOf(SX.uModel) < 0) SX.uModel = 'All models';
    var inSlice = function (b) { return (SX.uTool === 'All tools' || b.provider === SX.uTool) && (SX.uModel === 'All models' || b.model === SX.uModel); };
    M.matching = buckets.filter(inSlice);
    M.selected = inPeriod.filter(inSlice);
    M.hasFilter = SX.uTool !== 'All tools' || SX.uModel !== 'All models';
    M.cost = SX.uMeasure === 'value'; M.excl = SX.uMeasure === 'new';
    M.series = SX.uSeries;
    M.scale = uScale(M);
    if (!M.selected.length) return M;

    // Bars: one per period with records. Slots run continuously from the first to the last, so a gap shows as a gap.
    M.keyOf = {}; M.keySet = {};
    M.selected.forEach(function (b) { if (!M.keyOf[b.day]) { M.keyOf[b.day] = uPeriodKey(b.day, M.scale); M.keySet[M.keyOf[b.day]] = true; } });
    M.keys = Object.keys(M.keySet).sort();
    M.slots = [];
    for (var k = M.keys[0]; k <= M.keys[M.keys.length - 1];) {
      M.slots.push(k);
      k = M.scale === 'monthly' ? uMonthAdd(k, 1) : uAddDays(k, M.scale === 'weekly' ? 7 : 1);
    }
    var firstSel = M.selected.reduce(function (m, b) { return !m || b.day < m ? b.day : m; }, '');
    var lo = M.bounds && M.bounds[0] > firstSel ? M.bounds[0] : firstSel, hi = M.bounds && M.bounds[1] < today ? M.bounds[1] : today;
    M.partial = uPartialPeriods(M.keys, M.scale, lo, hi);
    M.inspect = uInspected(M);

    // The six largest models by the measured tokens. The chart and the card name the same six.
    var top = {}, rank = {};
    uSummaries(M.selected, function (b) { return b.model; }, M.excl).slice(0, 6).forEach(function (g, i) { top[g.key] = true; rank[uModelName(g.key)] = U_RANKED[i]; });
    M.rankColor = rank;
    var groups = {};
    M.selected.forEach(function (b) { var key = M.keyOf[b.day]; (groups[key] = groups[key] || []).push(b); });
    M.points = [];
    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      if (M.series === 'type') {
        var gt = uTotals(g);
        uTokenMix(gt, M.excl, g).forEach(function (c) { if (M.cost || !c.excluded) M.points.push({ key: key, series: c.id, tokens: c.count, usd: c.usd, priced: gt.priced, events: gt.events }); });
        return;
      }
      var by = {};
      g.forEach(function (b) { var s = M.series === 'tool' ? uToolName(b.provider) : top[b.model] ? uModelName(b.model) : 'Other models'; (by[s] = by[s] || []).push(b); });
      Object.keys(by).forEach(function (s) { var st = uTotals(by[s]); M.points.push({ key: key, series: s, tokens: uMeasured(st, M.excl), usd: st.usd, priced: st.priced, events: st.events }); });
    });
    // The largest series sits at the bottom of every stack, and the legend and colours read the same order.
    var totals = {};
    M.points.forEach(function (p) { totals[p.series] = (totals[p.series] || 0) + (M.cost ? p.usd : p.tokens); });
    M.order = Object.keys(totals).sort(function (a, b) { return totals[a] === totals[b] ? (a < b ? -1 : 1) : totals[b] - totals[a]; });
    M.color = function (name) { return M.series === 'model' ? (rank[name] || 'var(--u-gray)') : uSeriesColor(name); };
    M.plotted = function (p) { return M.cost ? p.usd : p.tokens / 1e6; };
    M.figure = function (p) { return !M.cost || p.priced > 0; };
    M.average = uChartAverage(M);
    if (M.cost && M.selected.every(function (b) { return !(Number(b.pricedEvents) > 0); })) M.noChart = 'No verified prices for this selection.';
    else if (M.cost && M.series === 'type' && !(uCostSplit(M.selected).split > 0)) M.noChart = 'This cost cannot be split by token type. Cursor reports one cost per request.';
    M.compare = uComparePeriod(M, M.cost, M.excl);
    M.weeks = uCalendarWeeks(M);
    return M;
  }
  // The scale in use: a day jump (Busiest day, a calendar square) shows days until the whole period comes back.
  function uScale(M) { return SX.uDayJump ? 'daily' : SX.uScale || uDefaultScale(M.period, M.today, SX.uFrom, SX.uTo); }
  function uInspected(M) { return SX.uInspect && SX.uInspect.scale === M.scale && M.keySet && M.keySet[SX.uInspect.key] ? SX.uInspect.key : null; }
  // chartAverage: the typical bar, leaving out partial ones and, for value, bars with no price. Lines draw none, and
  // under four full periods an average says nothing a glance does not.
  function uChartAverage(M) {
    if (SX.uLines) return null;
    var totals = {};
    M.points.forEach(function (p) { if (M.figure(p)) totals[p.key] = (totals[p.key] || 0) + M.plotted(p); });
    var full = Object.keys(totals).filter(function (k) { return !M.partial[k]; }).map(function (k) { return totals[k]; });
    return full.length >= 4 ? full.reduce(function (s, v) { return s + v; }, 0) / full.length : null;
  }
  function uDayValue(M, t) { return M.cost ? t.usd : uMeasured(t, M.excl); }
  function uDayFigure(M, v) { return M.cost ? uDollars(v) : uShort(v); }
  // calendarWeeks: Monday-to-Sunday columns over the selection, through today. A day outside it stays blank; a day in
  // it with no records has no logs, which is not zero.
  function uCalendarWeeks(M) {
    var lower = M.bounds ? M.bounds[0] : M.firstDay, upper = M.bounds && M.bounds[1] < M.today ? M.bounds[1] : M.today;
    if (!lower || lower > upper) return [];
    var days = {}; uGroup(M.selected, function (b) { return b.day; }).forEach(function (g) { days[g.key] = g; });
    var weeks = [], spans = uSerial(upper) - uSerial(lower) > 366;
    for (var monday = uAddDays(lower, -uWeekday(lower)); monday <= upper; monday = uAddDays(monday, 7)) {
      var first = monday < lower ? lower : monday;
      var label = U_MONTHS[Number(first.slice(5, 7)) - 1].slice(0, 3) + (spans && (!weeks.length || first.slice(5, 7) === '01') ? ' ' + first.slice(0, 4) : '');
      var prev = weeks.length ? weeks[weeks.length - 1].days.filter(function (x) { return x.inRange; })[0] : null;
      var cells = [];
      for (var i = 0; i < 7; i++) { var day = uAddDays(monday, i); cells.push({ id: day, inRange: day >= lower && day <= upper, sum: days[day] || null }); }
      weeks.push({ id: monday, label: prev && prev.id.slice(5, 7) === first.slice(5, 7) ? null : label, days: cells });
    }
    // A stub first column would run its label into the next month's.
    if (weeks.length > 1 && weeks[1].label && weeks[0].days.filter(function (x) { return x.inRange; }).length < 4) weeks[0].label = null;
    return weeks;
  }
  // calendarFit: the most recent weeks that fit at 4 px a square or more, with month labels that do not touch.
  function uCalendarFit(all, width) {
    var spacing = all.length > 52 ? 1 : 3;
    if (!(width > 0) || !all.length) return { weeks: all, spacing: spacing, numbers: false };
    var fits = Math.max(1, Math.floor((width + spacing) / (4 + spacing)));
    var weeks = all.slice(-fits).map(function (w) { return { id: w.id, label: w.label, days: w.days }; });
    if (weeks.length < all.length) {
      var f = weeks[0].days.filter(function (x) { return x.inRange; })[0];
      if (f) weeks[0].label = U_MONTHS[Number(f.id.slice(5, 7)) - 1].slice(0, 3) + ' ' + f.id.slice(0, 4);
    }
    var pitch = (width + spacing) / weeks.length, kept = [], labels = {};
    var labelled = weeks.map(function (w, i) { return [i, w.label]; }).filter(function (x) { return x[1]; });
    labelled.filter(function (x) { return x[1].indexOf(' ') >= 0; }).concat(labelled.filter(function (x) { return x[1].indexOf(' ') < 0; })).forEach(function (x) {
      var start = x[0] * pitch, end = start + x[1].length * 6.5 + 2;
      if (kept.some(function (r) { return start < r[1] + 4 && r[0] < end + 4; }) || end > width + 8) return;
      kept.push([start, end]); labels[x[0]] = x[1];
    });
    weeks.forEach(function (w, i) { w.label = labels[i] || null; });
    return { weeks: weeks, spacing: spacing, numbers: width / weeks.length - spacing >= 44 };
  }
  var U_CHEV = '<svg class="u-chev" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg>';
  // One word of the chart sentence: the word shows, and a real select over it opens the platform's own picker.
  function uWord(id, label, value, options) {
    var shown = (options.filter(function (o) { return o[0] === value; })[0] || options[0])[1];
    return '<label class="u-word"><span class="u-word-text">' + esc(shown) + '</span>' + U_CHEV +
      '<select id="' + id + '" aria-label="' + esc(label) + '">' + options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
  }
  function uWholeTitle(M) {
    var parts = [M.period === U_CUSTOM ? uDateRangeTitle([SX.uFrom, SX.uTo]) : uRangeTitle(M.period)];
    if (SX.uTool !== 'All tools') parts.push(uToolName(SX.uTool));
    if (SX.uModel !== 'All models') parts.push(uModelName(SX.uModel));
    return parts.join(', ');
  }
  function uMeasureWords() { return SX.uMeasure === 'value' ? 'API value' : SX.uMeasure === 'new' ? 'New tokens' : 'All tokens'; }
  function uSwatch(color) { return color ? '<span class="u-sw" style="background:' + color + '" aria-hidden="true"></span>' : ''; }

  // The answers people open the page for (figures, SessionUsageView 702-750), with the change on the period before.
  function uFiguresHtml(M) {
    var all = uComparePeriod(M, false, false), nw = uComparePeriod(M, false, true), t = uTotals(M.selected);
    var days = uGroup(M.selected, function (b) { return b.day; }), priced = days.filter(function (g) { return g.t.priced > 0; });
    var perDay = priced.length ? uDollars(priced.reduce(function (s, g) { return s + g.t.usd; }, 0) / priced.length) + (priced.some(function (g) { return g.t.priced < g.t.events; }) ? '+' : '') : 'No price';
    var list = [
      ['API value', uCostCell(t), uPriorNote(all.usd, all, all.costPartial), 'What these tokens would cost at standard API rates. Not your subscription bill.'],
      ['New tokens', uShort(t.fresh), uPriorNote(nw.tok, nw), 'Input, output and cache writes.'],
      ['All tokens', uShort(t.all), uShare(t.cacheRead, t.all) + ' read again from cache', 'New tokens plus context read again from cache.'],
      ['API value a day', perDay, days.length + ' ' + (days.length === 1 ? 'day' : 'days') + ' with usage', 'Average across days with a price. Days without logs or a price are left out, not counted as zero.']
    ];
    // monthPace: this calendar month for the tool and model in view, whatever period is selected.
    var month = M.today.slice(0, 7), mt = uTotals(M.matching.filter(function (b) { return b.day.slice(0, 7) === month; }));
    if (mt.priced > 0) {
      var todayN = Number(M.today.slice(8)), last = uMonthEnd(month), total = Number(last.slice(8));
      var start = M.matching.filter(function (b) { return b.day.slice(0, 7) === month; }).reduce(function (m, b) { return Math.min(m, Number(b.day.slice(8, 10))); }, todayN);
      var elapsed = todayN - start + 1, projected = elapsed >= 3 && todayN < total ? mt.usd + mt.usd / elapsed * (total - todayN) : null;
      list.push([U_MONTHS[Number(month.slice(5)) - 1] + ' so far', uDollars(mt.usd) + (mt.priced < mt.events ? '+' : ''), projected === null ? '' : 'About ' + uDollars(projected) + ' by ' + uShortDay(last),
        'This calendar month for the tool and model in view, whatever period is selected. The estimate is a straight line from the days so far.']);
    }
    return '<div class="sx-figures u-figs' + (list.length > 4 ? ' five' : '') + '">' + list.map(function (f, i) {
      return '<div class="sx-figure' + (i === 0 ? ' lead' : '') + '" title="' + esc(f[3]) + '"><b>' + esc(f[1]) + '</b><span class="sx-figure-title">' + esc(f[0]) + '</span>' + (f[2] ? '<span class="sx-figure-note">' + esc(f[2]) + '</span>' : '') + '</div>';
    }).join('') + '</div>';
  }

  function uChartSectionHtml(M) {
    var sentence = '<div class="u-sentence">' + uWord('u-measure', 'Measure', SX.uMeasure, U_MEASURES) + '<span>by</span>' + uWord('u-series', 'Stack by', SX.uSeries, U_SERIES) +
      '<span>per</span>' + uWord('u-scale', 'Time scale', M.scale, U_SCALES) + '<span class="u-grow"></span>' +
      '<button type="button" class="u-style" data-u="lines" data-on="0" aria-pressed="' + !SX.uLines + '" aria-label="Stacked bars" title="Stacked bars"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 14h12M4 12V7M8 12V3M12 12V8"/></svg></button>' +
      '<button type="button" class="u-style" data-u="lines" data-on="1" aria-pressed="' + !!SX.uLines + '" aria-label="Lines" title="Lines"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 14h12M2.5 11l3.5-4 3 2.5L13.5 4"/></svg></button></div>';
    var legend = M.order.map(function (n) { return '<span class="u-key">' + uSwatch(M.color(n)) + esc(n) + '</span>'; }).join('');
    var scaleWord = M.scale === 'weekly' ? 'week' : M.scale === 'monthly' ? 'month' : 'day';
    if (!SX.uLines && Object.keys(M.partial).length) legend += '<span class="u-key">Lighter bars cover part of a ' + scaleWord + (M.average !== null ? ' and are left out of the average.' : '.') + '</span>';
    return '<section class="u-chartcol">' + sentence +
      '<div class="u-chart" id="u-chart" tabindex="0" role="group" aria-label="' + esc(uMeasureWords() + ' by ' + (SX.uSeries === 'type' ? 'token type' : SX.uSeries) + ' per ' + scaleWord + '. Arrow keys step through the bars.') + '">' +
      '<div class="u-tip hidden" id="u-tip" aria-hidden="true"></div></div>' +
      '<div class="u-legend">' + legend + '</div></section>';
  }

  // The summary card (SessionUsageInspector): the whole period until a bar is chosen, then that bar.
  function uCardHtml(M) {
    var key = M.inspect, rows = key ? M.selected.filter(function (b) { return M.keyOf[b.day] === key; }) : M.selected;
    var t = uTotals(rows), measured = uMeasured(t, M.excl);
    var title = key ? uPeriodTitle(key, M.scale, M.bounds) : uWholeTitle(M), earlier, later;
    if (key) { var i = M.keys.indexOf(key); earlier = i > 0; later = i < M.keys.length - 1; }
    else { earlier = !!uStep(M.period, M.today, SX.uFrom, SX.uTo, -1, M.firstDay); later = !!uStep(M.period, M.today, SX.uFrom, SX.uTo, 1, M.firstDay); }
    var step = function (d, on) {
      return '<button type="button" class="u-step" data-u="step" data-d="' + d + '"' + (on ? '' : ' disabled') + ' aria-label="' + (d < 0 ? 'Earlier period' : 'Later period') + '" title="' + (d < 0 ? 'Earlier period' : 'Later period') + '">' +
        '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="' + (d < 0 ? 'M6.5 1.5L3 5l3.5 3.5' : 'M3.5 1.5L7 5 3.5 8.5') + '"/></svg></button>';
    };
    var h = '<div class="u-card-top">' + (key ? '<p class="u-card-title">' + esc(title) + '</p>'
      : '<button type="button" class="u-card-title u-rangelink" data-u="range" aria-haspopup="dialog" title="Choose the dates">' + esc(title) + U_CHEV + '</button>') + step(-1, earlier) + step(1, later) + '</div>';
    if (key) {
      h += '<p class="u-card-head">' + esc(M.cost ? uCostCell(t) : uSpoken(measured) + (M.excl ? ' new tokens' : ' tokens')) + '</p>' +
        '<p class="u-card-sub">' + esc(M.cost ? uSpoken(t.all) + ' tokens' : t.priced > 0 ? uDollars(t.usd) + ' at API rates' + (t.priced < t.events ? ', plus unpriced records' : '') : 'No verified price') + '</p>';
    }
    var mix = uTokenMix(t, false, rows).sort(function (a, b) { return b.count - a.count; }), split = uCostSplit(rows);
    var strip = function (label, parts) {
      var sum = parts.reduce(function (s, p) { return s + Math.max(0, p[1]); }, 0);
      return '<div class="u-mix"><span>' + label + '</span><div class="u-strip" aria-hidden="true">' + parts.filter(function (p) { return p[1] > 0 && sum > 0; }).map(function (p) {
        return '<i style="flex-grow:' + (p[1] / sum).toFixed(5) + ';background:' + uSeriesColor(p[0]) + '"></i>';
      }).join('') + '</div></div>';
    };
    h += '<div class="u-mixes">' + strip('Share of tokens', mix.map(function (c) { return [c.id, c.count]; })) +
      (split.split > 0 ? strip('Share of API value', mix.map(function (c) { return [c.id, c.usd]; })) : '') + '</div>';
    var row = function (color, name, a, b, help) {
      return '<div class="u-crow">' + uSwatch(color) + '<span class="u-cname" title="' + esc(help || name) + '">' + esc(name) + '</span><span class="u-cnum">' + esc(a) + '</span><span class="u-cval">' + esc(b) + '</span></div>';
    };
    var tools = uSummaries(rows, function (b) { return b.provider; }, M.excl);
    if (tools.length > 1) h += '<h4 class="u-ch">Tools</h4>' + tools.map(function (g) { return row(uSeriesColor(uToolName(g.key)), uToolName(g.key), uShort(uMeasured(g.t, M.excl)), uSumCost(g.t)); }).join('');
    if (key) {
      var models = uSummaries(rows, function (b) { return b.provider + '|' + b.model; }, M.excl);
      h += '<h4 class="u-ch">Models</h4>' + models.slice(0, 5).map(function (g) {
        var id = g.rows[0].model, name = uModelName(id);
        return row(M.series === 'model' ? M.rankColor[name] : '', name, uShort(uMeasured(g.t, M.excl)), uSumCost(g.t), id);
      }).join('') + (models.length > 5 ? '<p class="u-cnote">' + (models.length - 5) + ' more not listed here</p>' : '');
    }
    h += '<h4 class="u-ch">Token types</h4>' + uTokenMix(t, M.excl, rows).sort(function (a, b) { return b.count - a.count; }).map(function (c) {
      return row(uSeriesColor(c.id), c.id, c.excluded ? 'Not counted' : uShort(c.count), split.split > 0 ? uDollars(c.usd) : '');
    }).join('');
    if (split.unsplit > 0 && split.split > 0) {
      h += '<p class="u-cnote">Values by type cover ' + esc(uDollars(split.split)) + ' of ' + esc(uDollars(split.priced)) + '. ' +
        (rows.some(function (b) { return b.provider === 'Cursor'; }) ? 'Cursor and partly priced records are' : 'Partly priced records are') + ' not split.</p>';
    }
    h += '<hr class="u-rule-h">';
    if (key) h += '<p class="u-cline">' + esc(uSpoken(t.fresh) + ' were new. ' + uShare(t.cacheRead, t.all) + ' was context read again from cache.') + '</p>';
    if (!key) {
      var c = M.compare;
      if (c.peak) h += '<button type="button" class="u-peak" data-u="peak" data-day="' + esc(c.peak.key) + '" title="Show this day">Busiest day: ' + esc(uPeriodTitle(c.peak.key, 'daily') + ', ' + (M.cost ? uDollars(c.peak.t.usd) : uShort(uMeasured(c.peak.t, M.excl)))) + '</button>';
      if (c.prior && (!c.has || c.partialPrior)) h += '<p class="u-cline">' + (c.partialPrior ? 'History does not reach back a full period, so there is no comparison.' : 'No usage in the period before.') + '</p>';
      if (c.prior && c.has && !c.partialPrior) h += '<p class="u-cline">' + esc('Compared with ' + uDateRangeTitle(c.prior) + ': tokens ' + c.tok + ', API value ' + c.usd + (c.costPartial ? ' (priced records only)' : '') + '.') + '</p>';
    }
    if (key) h += '<button type="button" class="sx-link u-whole" data-u="whole">Show the whole period</button>';
    return h;
  }

  function uCols() {
    if (!SX.uCols) {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(U_COLS_KEY) || 'null'); } catch (_e) { saved = null; }
      SX.uCols = Array.isArray(saved) ? U_COLUMNS.map(function (c) { return c[0]; }).filter(function (c) { return saved.indexOf(c) >= 0; }) : ['records', 'lastUsed'];
    }
    return SX.uCols;
  }
  // sortModels: unpriced rows sort last on API value in both directions; ties break on provider and model.
  function uSortRows(groups, sort, asc) {
    return groups.slice().sort(function (a, b) {
      if (sort === 'cost' && (a.t.priced > 0) !== (b.t.priced > 0)) return a.t.priced > 0 ? -1 : 1;
      var x, y;
      if (sort === 'model') { x = String(a.rows[0].model).toLowerCase(); y = String(b.rows[0].model).toLowerCase(); if (x !== y) return (x < y) === asc ? -1 : 1; return a.key < b.key ? -1 : 1; }
      x = sort === 'newTokens' ? a.t.fresh : sort === 'cost' ? a.t.usd : a.t.all;
      y = sort === 'newTokens' ? b.t.fresh : sort === 'cost' ? b.t.usd : b.t.all;
      if (x === y) return a.key < b.key ? -1 : 1;
      return asc ? x - y : y - x;
    });
  }
  // The Tool and model table (SessionUsageView usageTable): tools, each with its models, in the chosen order.
  function uTableHtml(M) {
    var cols = uCols(), whole = uTotals(M.selected), wholeV = M.cost ? whole.usd : uMeasured(whole, M.excl), last = {};
    M.selected.forEach(function (b) { var k = b.provider + '|' + b.model; if (!last[k] || b.day > last[k]) last[k] = b.day; });
    var year = M.today.slice(0, 4);
    var share = function (t) {
      var part = M.cost ? t.usd : uMeasured(t, M.excl);
      var text = M.cost ? (t.priced > 0 ? uShare(t.usd, whole.usd) : '') : uShare(part, wholeV);
      if (text === 'Unavailable') text = '';
      var f = wholeV > 0 ? part / wholeV : 0;
      return { text: text, f: f };
    };
    var extra = function (rows, t) {
      return cols.map(function (c) {
        if (c === 'records') return '<td class="num">' + uNum(t.events) + '</td>';
        if (c === 'cacheReads') return '<td class="num">' + esc(uShare(t.cacheRead, t.all)) + '</td>';
        if (c === 'perMillion') {
          var full = rows.filter(function (b) { return Number(b.events) > 0 && Number(b.pricedEvents) === Number(b.events); }), ft = uTotals(full);
          return '<td class="num">' + (ft.fresh > 0 ? esc(uCurrency(ft.usd / ft.fresh * 1e6, 2)) : 'No price') + '</td>';
        }
        var day = rows.map(function (b) { return last[b.provider + '|' + b.model] || ''; }).reduce(function (m, d) { return d > m ? d : m; }, '');
        return '<td class="num">' + (day ? esc(uShortDay(day) + (day.slice(0, 4) === year ? '' : ', ' + day.slice(0, 4))) : '') + '</td>';
      }).join('');
    };
    var cells = function (rows, t, color) {
      var s = share(t);
      return '<td class="num">' + uShort(t.all) + '</td><td class="num">' + uShort(t.fresh) + '</td>' + extra(rows, t) +
        '<td class="num u-sharecell"><span class="u-sharebar" aria-hidden="true"' + (s.text ? '' : ' data-empty') + '><i style="width:' + (s.f > 0 ? Math.max(2, Math.round(56 * s.f)) : 0) + 'px;background:' + color + '"></i></span>' + esc(s.text) + '</td>' +
        '<td class="num">' + esc(uSumCost(t)) + '</td>';
    };
    var sortTh = function (label, sort, help, lead) {
      var on = SX.uSort === sort;
      return '<th class="' + (lead ? 'name' : 'num') + '"' + (on ? ' aria-sort="' + (SX.uSortAsc ? 'ascending' : 'descending') + '"' : '') + '><button type="button" class="u-sort' + (on ? ' on' : '') + '" data-u="sort" data-sort="' + sort + '" title="' + esc(help) + '">' + label +
        (on ? '<svg class="u-dir" viewBox="0 0 10 6" aria-hidden="true"><path d="' + (SX.uSortAsc ? 'M1 5l4-4 4 4' : 'M1 1l4 4 4-4') + '"/></svg>' : '') + '</button></th>';
    };
    var head = '<tr>' + sortTh('Name', 'model', 'Sort models by name', true) + sortTh('All tokens', 'tokens', 'Sort by all tokens') + sortTh('New tokens', 'newTokens', 'Sort by input, output and cache writes') +
      cols.map(function (c) { var d = U_COLUMNS.filter(function (x) { return x[0] === c; })[0]; return '<th class="num" title="' + esc(d[2]) + '">' + d[1] + '</th>'; }).join('') +
      '<th class="num" title="Share of the selected ' + (M.cost ? 'API value' : 'tokens') + '. Never your subscription allowance.">Share</th>' + sortTh('API value', 'cost', 'Sort by API value; unpriced models stay last') + '</tr>';
    var span = 5 + cols.length, body = '';
    uSummaries(M.selected, function (b) { return b.provider; }, false).forEach(function (g) {
      var tool = uToolName(g.key), color = uSeriesColor(tool), on = SX.uTool === g.key;
      body += '<tr class="u-tool"><td><button type="button" class="u-namebtn" data-u="tool" data-p="' + esc(g.key) + '" title="' + (on ? 'Show all tools' : 'Show only ' + esc(tool)) + '">' + uSwatch(color) + esc(tool) + '</button></td>' + cells(g.rows, g.t, color) + '</tr>';
      var models = uSortRows(uGroup(g.rows, function (b) { return b.model; }), SX.uSort, SX.uSortAsc);
      var open = SX.uOpen[g.key] || SX.uModel !== 'All models', shown = open ? models : models.slice(0, 5);
      shown.forEach(function (m) {
        var mine = SX.uModel === m.key && SX.uTool === g.key;
        body += '<tr class="u-model"><td><button type="button" class="u-namebtn' + (mine ? ' on' : '') + '" data-u="model" data-p="' + esc(g.key) + '" data-m="' + esc(m.key) + '" title="' + esc(m.key) + '">' + esc(uModelName(m.key)) + '</button></td>' + cells(m.rows, m.t, color) + '</tr>';
      });
      if (models.length > shown.length) {
        var hidden = models.slice(shown.length), hr = [], n = hidden.length;
        hidden.forEach(function (m) { hr = hr.concat(m.rows); });
        body += '<tr class="u-model"><td><button type="button" class="u-namebtn u-more" data-u="more" data-p="' + esc(g.key) + '">' + n + ' more ' + (n === 1 ? 'model' : 'models') + '</button></td>' + cells(hr, uTotals(hr), 'var(--sub)') + '</tr>';
      } else if (models.length > 5 && SX.uModel === 'All models') {
        body += '<tr class="u-model"><td colspan="' + span + '"><button type="button" class="u-namebtn u-more" data-u="fewer" data-p="' + esc(g.key) + '">Show fewer</button></td></tr>';
      }
    });
    var menu = '<details class="u-cols"' + (SX.uColsOpen ? ' open' : '') + '><summary>Columns' + U_CHEV + '</summary><div class="u-cols-menu" role="group" aria-label="Table columns">' +
      U_COLUMNS.map(function (c) { return '<label class="u-colopt" title="' + esc(c[2]) + '"><input type="checkbox" data-ucol="' + c[0] + '"' + (cols.indexOf(c[0]) >= 0 ? ' checked' : '') + '>' + c[1] + '</label>'; }).join('') + '</div></details>';
    return '<section class="u-tablesec"><div class="u-thead"><h3 class="sx-uhead u-h" id="u-table-title">' + esc(M.inspect ? 'Tool and model, ' + uWholeTitle(M) : 'Tool and model') + '</h3>' + menu + '</div>' +
      '<div class="u-tablewrap"><table class="u-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div></section>';
  }
  function uBreakdownHtml(M) {
    var days = uGroup(M.selected, function (b) { return b.day; }).sort(function (a, b) { return a.key < b.key ? 1 : -1; });
    var whole = uMeasured(uTotals(M.selected), M.excl), year = M.today.slice(0, 4);
    return '<details class="u-breakdown"' + (SX.uBreakOpen ? ' open' : '') + '><summary>Daily breakdown, ' + uNum(days.length) + ' recorded ' + (days.length === 1 ? 'day' : 'days') + U_CHEV + '</summary>' +
      '<div class="u-brow u-bhead"><span>Date</span><span>Tokens</span><span>Share</span><span>Records</span><span>API value</span></div>' +
      days.map(function (g) {
        var v = uMeasured(g.t, M.excl);
        return '<button type="button" class="u-brow' + (M.scale === 'daily' && M.inspect === g.key ? ' on' : '') + '" data-u="day" data-day="' + g.key + '" title="' + g.key + '"><span>' + esc(U_WEEKDAYS[uWeekday(g.key)].slice(0, 3) + ', ' + uShortDay(g.key) + (g.key.slice(0, 4) === year ? '' : ', ' + g.key.slice(0, 4))) + '</span>' +
          '<span>' + uShort(v) + '</span><span>' + esc(uShare(v, whole)) + '</span><span>' + uNum(g.t.events) + '</span><span>' + esc(uCostLabel2(g.t)) + '</span></button>';
      }).join('') + '</details>';
  }
  function sessionUsageWideHtml(d) {
    var su = d.sessionUsage;
    var how = '<details class="sx-how"><summary>How this is counted</summary>' + uHowLines(su).map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') + '</details>';
    SX.uM = null;
    if (!su) return '<div class="sx-uempty">' + esc('Usage has not been read yet. Refresh reads Claude Code and Codex logs on this Mac.') + '</div>' + how;
    var M = uWideModel(d);
    var pending = [];
    if (Number(su.pendingFiles) > 0) pending.push('Reading older history: ' + su.pendingFiles + ' files remaining. Totals will grow until it finishes.');
    if (su.cursorFeed && su.cursorFeed.pending === true && su.cursorFeed.message) pending.push(su.cursorFeed.message + ' Totals will grow until it finishes.');
    var pendingHtml = pending.map(function (n) { return '<p class="cx-note sx-unote">' + esc(n) + '</p>'; }).join('');
    if (!M.buckets.length) return '<div class="sx-uempty">' + esc('No usage recorded yet. Claude Code and Codex sessions on this Mac appear here once their logs are read. A missing tool is not zero usage.') + pendingHtml + '</div>' + how;
    var updated = toDate(su.updatedAt);
    var html = '<div class="sx-ufilters u-filters">' +
      '<button type="button" class="field sx-select u-rangebtn" data-u="range" aria-haspopup="dialog" aria-label="Period: ' + esc(uRangeTitle(M.period, SX.uFrom, SX.uTo)) + '">' + esc(uRangeTitle(M.period, SX.uFrom, SX.uTo)) + '</button>' +
      uSelect('usage-tool', 'Tool', SX.uTool, [['All tools', 'All tools']].concat(M.tools.map(function (p) { return [p, uToolName(p)]; }))) +
      uSelect('usage-model', 'Model', SX.uModel, [['All models', 'All models']].concat(M.models.map(function (m) { return [m, uModelName(m)]; }))) +
      (M.hasFilter ? '<button type="button" class="sx-link" data-sx="usage-clear">Clear filters</button>' : '') +
      (updated ? '<span class="sx-fresh">Updated ' + esc(clock(updated)) + '</span>' : '') + '</div>' + pendingHtml;
    if (!M.selected.length) return html + '<div class="sx-uempty">No recorded usage for this selection. A missing tool is not zero usage.</div>' + uFooter(su, M.selected) + how;
    SX.uM = M;
    html += uFiguresHtml(M) +
      '<div class="u-split">' + uChartSectionHtml(M) + '<aside class="u-card" id="u-card" aria-label="Summary" aria-live="polite">' + uCardHtml(M) + '</aside></div>';
    // Under three columns the bars above already say all of this.
    if (M.weeks.length >= 3) html += '<section class="u-daysec"><h3 class="sx-uhead u-h">' + esc(uMeasureWords()) + ' day by day</h3><div class="u-heat" id="u-heat"></div></section>';
    return html + uTableHtml(M) + uBreakdownHtml(M) + uFooter(su, M.selected) + how;
  }

  // ── Drawing: the chart (SessionUsageChart) and the calendar (SessionUsageCalendar), at the width they get ──
  var U_CHART_H = 300;
  function uAxisValue(M, v, top) {
    if (!(v > 0)) return '0';
    if (M.cost) return uCurrency(v, top < 10 ? 2 : 0);
    if (v >= 1000) return Math.round(v / 100) / 10 + 'B';
    if (v >= 1) return Math.round(v * 10) / 10 + 'M';
    return Math.round(v * 10000) / 10 + 'K';
  }
  function uDim(M, key) {
    var partial = M.partial[key] ? 0.42 : 1;
    if (!M.inspect) return partial;
    return key === M.inspect ? 1 : 0.32 * partial;
  }
  function uDrawChart() {
    var M = SX.uM, host = $('u-chart');
    if (!M || !host) return;
    var old = host.querySelector('svg, .u-chart-empty');
    if (old) old.remove();
    uBindChart(host);
    if (M.noChart) { host.insertAdjacentHTML('afterbegin', '<p class="u-chart-empty">' + esc(M.noChart) + '</p>'); SX.uGeom = null; return; }
    // The chart takes the card's height, so the two columns end together (SessionUsageSplitLayout).
    var W = Math.max(240, host.clientWidth), H = Math.max(U_CHART_H, Math.floor(host.clientHeight)), padL = 48, padR = 6, padT = 20, padB = 24, pw = W - padL - padR, ph = H - padT - padB;
    var slots = M.slots, n = slots.length, slot = pw / n, byKey = {};
    M.points.forEach(function (p) { (byKey[p.key] = byKey[p.key] || []).push(p); });
    var peak = 0;
    if (SX.uLines) M.points.forEach(function (p) { if (M.figure(p)) peak = Math.max(peak, M.plotted(p)); });
    else Object.keys(byKey).forEach(function (k) { peak = Math.max(peak, byKey[k].reduce(function (s, p) { return s + M.plotted(p); }, 0)); });
    var top = uNiceTop(peak), y = function (v) { return padT + ph - v / top * ph; }, f1 = function (v) { return Math.round(v * 10) / 10; };
    var s = ['<svg class="u-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">'];
    [0, 0.25, 0.5, 0.75, 1].forEach(function (fr) {
      var yy = f1(y(top * fr));
      s.push('<line class="u-grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yy + '" y2="' + yy + '"/><text class="u-ylab" x="' + (padL - 7) + '" y="' + f1(yy + 3.5) + '" text-anchor="end">' + esc(uAxisValue(M, top * fr, top)) + '</text>');
    });
    var order = {}; M.order.forEach(function (name, i) { order[name] = i; });
    if (!SX.uLines) {
      var bw = Math.max(1, Math.min(slot * 0.72, 44));
      slots.forEach(function (k, i) {
        var pts = (byKey[k] || []).filter(M.figure).sort(function (a, b) { return order[a.series] - order[b.series]; });
        if (!pts.length) return;
        var x = f1(padL + i * slot + (slot - bw) / 2), base = 0;
        s.push('<g class="u-col" data-key="' + k + '" opacity="' + uDim(M, k) + '">');
        pts.forEach(function (p) {
          var v = M.plotted(p);
          if (!(v > 0)) return;
          var y1 = y(base + v), y0 = y(base);
          s.push('<rect x="' + x + '" y="' + f1(y1) + '" width="' + f1(bw) + '" height="' + f1(Math.max(0.5, y0 - y1)) + '" style="fill:' + M.color(p.series) + '"/>');
          base += v;
        });
        s.push('</g>');
      });
    } else {
      M.order.forEach(function (name) {
        var d = '', dots = '', pen = false;
        slots.forEach(function (k, i) {
          var p = (byKey[k] || []).filter(function (q) { return q.series === name && M.figure(q); })[0];
          if (!p) { pen = false; return; }
          var x = f1(padL + (i + 0.5) * slot), yy = f1(y(M.plotted(p)));
          d += (pen ? 'L' : 'M') + x + ' ' + yy; pen = true;
          if (n <= 62) dots += '<circle cx="' + x + '" cy="' + yy + '" r="2.4" style="fill:' + M.color(name) + '"/>';
        });
        s.push('<path class="u-line" d="' + d + '" style="stroke:' + M.color(name) + '"/>' + dots);
      });
    }
    if (M.average !== null) {
      var ay = f1(y(M.average));
      s.push('<line class="u-avg" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + ay + '" y2="' + ay + '"/><text class="u-avglab" x="' + (W - padR - 2) + '" y="' + f1(ay - 5) + '" text-anchor="end">Average ' + esc(uAxisValue(M, M.average, top)) + '</text>');
    }
    uAxisKeys(slots).forEach(function (k) {
      var i = slots.indexOf(k), mid = M.scale === 'daily' && i > 0;
      s.push('<text class="u-xlab" x="' + f1(mid ? padL + (i + 0.5) * slot : padL + i * slot) + '" y="' + (H - 6) + '" text-anchor="' + (mid ? 'middle' : 'start') + '">' + esc(uAxisLabel(k)) + '</text>');
    });
    s.push('<line class="u-hover hidden" id="u-hover" x1="0" x2="0" y1="' + padT + '" y2="' + (padT + ph) + '"/>');
    s.push('<rect class="u-hit" x="' + padL + '" y="0" width="' + f1(pw) + '" height="' + (padT + ph) + '"/></svg>');
    host.insertAdjacentHTML('afterbegin', s.join(''));
    SX.uGeom = { padL: padL, slot: slot, n: n, W: W };
    if (SX.uPinned && M.keySet[SX.uPinned]) uTipShow(SX.uPinned, padL + (slots.indexOf(SX.uPinned) + 0.5) * slot);
    else uTipHide();
  }
  function uKeyAt(host, clientX) {
    var g = SX.uGeom, M = SX.uM;
    if (!g || !M) return null;
    var x = clientX - host.getBoundingClientRect().left, i = Math.floor((x - g.padL) / g.slot);
    if (i < 0 || i >= g.n) return null;
    var k = M.slots[i];
    return M.keySet[k] ? { key: k, x: x } : null;
  }
  // The hover card: the bar's period and figure, then each series in it, largest first.
  function uTipShow(key, px) {
    var M = SX.uM, tip = $('u-tip'), host = $('u-chart'), g = SX.uGeom;
    if (!M || !tip || !host || !g) return;
    var rows = M.selected.filter(function (b) { return M.keyOf[b.day] === key; }), t = uTotals(rows);
    var line = uPeriodTitle(key, M.scale, M.bounds) + (M.partial[key] ? ' (part of a ' + (M.scale === 'weekly' ? 'week' : 'month') + ')' : '') + ': ' +
      (M.cost ? uCostLabel2(t) : uTok2(uMeasured(t, M.excl)) + ' tokens');
    var members = M.points.filter(function (p) { return p.key === key; });
    var list = members.length > 1 ? M.order.map(function (name) {
      var p = members.filter(function (q) { return q.series === name; })[0];
      if (!p) return '';
      return '<div class="u-tiprow">' + uSwatch(M.color(name)) + '<span>' + esc(name) + '</span><b>' + esc(M.cost ? (p.priced > 0 ? uDollars(p.usd) : 'No price') : uShort(p.tokens)) + '</b></div>';
    }).join('') : '';
    tip.innerHTML = '<p>' + esc(line) + '</p>' + list;
    var cw = Math.min(320, host.clientWidth - 16), right = px + 18, left = px - 18 - cw, x;
    if (right + cw <= host.clientWidth - 8 && (left < 8 || px <= host.clientWidth / 2)) x = right;
    else if (left >= 8) x = left;
    else x = px > host.clientWidth / 2 ? 8 : Math.max(8, host.clientWidth - 8 - cw);
    tip.style.width = cw + 'px';
    tip.style.transform = 'translateX(' + Math.round(x) + 'px)';
    tip.classList.remove('hidden');
    var hover = $('u-hover'), cx = Math.round((g.padL + (M.slots.indexOf(key) + 0.5) * g.slot) * 10) / 10;
    if (hover) { hover.setAttribute('x1', cx); hover.setAttribute('x2', cx); hover.classList.remove('hidden'); }
  }
  function uTipHide() {
    var tip = $('u-tip'), hover = $('u-hover');
    if (tip) tip.classList.add('hidden');
    if (hover) hover.classList.add('hidden');
  }
  // Mouse: hover shows the card, a click chooses the bar. Touch has no hover, so a finger scrubs: the card follows it
  // across the bars, and lifting it chooses that bar. A vertical drag still scrolls the page (touch-action: pan-y).
  function uBindChart(host) {
    if (host.__uBound) return;
    host.__uBound = true;
    host.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse' && !SX.uScrub) return;
      var h = uKeyAt(host, e.clientX);
      if (h) uTipShow(h.key, h.x); else if (!SX.uPinned) uTipHide();
    });
    host.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !SX.uPinned) uTipHide(); });
    host.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') return;
      SX.uScrub = true;
      var h = uKeyAt(host, e.clientX);
      if (h) uTipShow(h.key, h.x);
    });
    host.addEventListener('pointerup', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      var h = uKeyAt(host, e.clientX);
      SX.uScrub = false;
      if (!h) { if (e.pointerType !== 'mouse') { SX.uPinned = null; uTipHide(); } return; }
      SX.uPinned = e.pointerType === 'mouse' ? null : h.key;
      uInspectKey(h.key, true);
    });
    host.addEventListener('pointercancel', function () { SX.uScrub = false; if (!SX.uPinned) uTipHide(); });
    host.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); uMoveInspect(e.key === 'ArrowLeft' ? -1 : 1); }
      else if (e.key === 'Escape' && SX.uInspect) { e.preventDefault(); uShowWhole(); }
    });
  }
  function uDrawHeat() {
    var M = SX.uM, host = $('u-heat');
    if (!M || !host || !M.weeks || M.weeks.length < 3) return;
    var fit = uCalendarFit(M.weeks, Math.max(0, host.clientWidth - 26 - 150 - 16)), long = M.weeks.length > 26;
    var counted = function (sum) { return sum && (!M.cost || sum.t.priced > 0); };
    var top = 0;
    fit.weeks.forEach(function (w) { w.days.forEach(function (x) { if (counted(x.sum)) top = Math.max(top, uDayValue(M, x.sum.t)); }); });
    var sums = [0, 0, 0, 0, 0, 0, 0], cnt = [0, 0, 0, 0, 0, 0, 0];
    uGroup(M.selected, function (b) { return b.day; }).forEach(function (g) { if (!counted(g)) return; var i = uWeekday(g.key); sums[i] += uDayValue(M, g.t); cnt[i] += 1; });
    var avg = sums.map(function (v, i) { return cnt[i] ? v / cnt[i] : 0; }), topAvg = Math.max.apply(null, avg);
    var cols = 'grid-template-columns:repeat(' + fit.weeks.length + ',minmax(0,1fr));column-gap:' + fit.spacing + 'px';
    var inspected = M.scale === 'daily' ? M.inspect : null, empty = M.hasFilter ? 'no records for this selection' : 'no logs';
    var h = '<div class="u-cal' + (fit.numbers ? ' numbers' : '') + '"' + (long ? ' role="img" aria-label="Calendar of ' + M.weeks.length + ' weeks. Daily breakdown lists each day."' : '') + '>' +
      '<div class="u-cal-row u-cal-months"><span class="u-cal-lab"></span><div class="u-cal-weeks" style="' + cols + '">' +
      fit.weeks.map(function (w) { return '<span class="u-cal-month">' + (w.label ? esc(w.label) : '') + '</span>'; }).join('') + '</div><span class="u-cal-avg">Daily average</span></div>';
    for (var wd = 0; wd < 7; wd++) {
      h += '<div class="u-cal-row"><span class="u-cal-lab">' + U_WEEKDAYS[wd].slice(0, 3) + '</span><div class="u-cal-weeks" style="' + cols + '">';
      fit.weeks.forEach(function (w) {
        var x = w.days[wd];
        if (!x.inRange) { h += '<span class="u-cell out"></span>'; return; }
        if (counted(x.sum)) {
          var v = uDayValue(M, x.sum.t), level = top > 0 ? Math.sqrt(v / top) : 0, t = x.sum.t;
          var detail = uPeriodTitle(x.id, 'daily') + ': ' + uCostLabel2(t) + ', ' + uShort(t.all) + ' tokens, ' + uShort(t.fresh) + ' new, ' + uNum(t.events) + ' records';
          h += '<button type="button" class="u-cell day' + (level > 0.65 ? ' deep' : '') + (inspected === x.id ? ' on' : '') + '" data-u="day" data-day="' + x.id + '"' + (long ? ' tabindex="-1"' : '') +
            ' style="background:color-mix(in srgb, var(--u-gold) ' + Math.round((0.12 + 0.82 * level) * 100) + '%, transparent)" title="' + esc(detail) + '" aria-label="' + esc(detail) + '"' + (inspected === x.id ? ' aria-pressed="true"' : '') + '>' +
            (fit.numbers ? esc(uDayFigure(M, v) + (M.cost && t.priced < t.events ? '+' : '')) : '') + '</button>';
        } else {
          var why = uPeriodTitle(x.id, 'daily') + ': ' + (x.sum ? 'no price' : empty);
          h += '<span class="u-cell ' + (long ? 'faint' : 'none') + '" title="' + esc(why) + '"' + (long ? '' : ' role="img" aria-label="' + esc(why) + '"') + '></span>';
        }
      });
      h += '</div><span class="u-cal-avg"><span class="u-avgbar"><i style="width:' + (topAvg > 0 ? (avg[wd] > 0 ? Math.max(2, Math.round(88 * avg[wd] / topAvg)) : 0) : 0) + 'px"></i></span>' +
        '<span class="u-avgnum">' + (avg[wd] > 0 ? esc(uDayFigure(M, avg[wd])) : '') + '</span></span></div>';
    }
    if (fit.weeks.length < M.weeks.length) h += '<p class="u-cnote">Showing the most recent ' + fit.weeks.length + ' of ' + M.weeks.length + ' weeks. The daily averages cover all of them, and Daily breakdown lists every day.</p>';
    host.innerHTML = h + '</div>';
  }
  function uDrawWide() { uDrawChart(); uDrawHeat(); }

  // ── Wide interactions ──
  // A chosen bar repaints the card, the bars and the calendar's outline, never the controls around them.
  function uRepaintInspect() {
    var M = SX.uM;
    if (!M) return;
    M.inspect = uInspected(M);
    var card = $('u-card'), title = $('u-table-title');
    if (card) card.innerHTML = uCardHtml(M);
    if (title) title.textContent = M.inspect ? 'Tool and model, ' + uWholeTitle(M) : 'Tool and model';
    document.querySelectorAll('#sessions-usage .u-brow.on').forEach(function (b) { b.classList.remove('on'); });
    if (M.inspect && M.scale === 'daily') { var row = document.querySelector('#sessions-usage .u-brow[data-day="' + M.inspect + '"]'); if (row) row.classList.add('on'); }
    uDrawWide();
  }
  function uInspectKey(key, toggle) {
    var M = SX.uM;
    if (!M) return;
    if (toggle && M.inspect === key) { SX.uPinned = null; return uShowWhole(); }
    SX.uInspect = { key: key, scale: M.scale };
    uRepaintInspect();
  }
  // moveInspection: with nothing chosen, left starts at the last bar and right at the first.
  function uMoveInspect(delta) {
    var M = SX.uM;
    if (!M || !M.keys || !M.keys.length) return;
    var i = M.inspect ? M.keys.indexOf(M.inspect) + delta : delta < 0 ? M.keys.length - 1 : 0;
    if (i < 0 || i >= M.keys.length) return;
    SX.uPinned = null;
    SX.uInspect = { key: M.keys[i], scale: M.scale };
    uRepaintInspect();
  }
  // Show the whole period: back from a chosen bar, and from a day jump to the scale it left.
  function uShowWhole() {
    SX.uInspect = null; SX.uPinned = null;
    if (SX.uDayJump) { SX.uDayJump = false; return paintUsage(); }
    uRepaintInspect();
  }
  function uInspectDay(day) {
    var M = SX.uM;
    if (M && M.scale === 'daily' && M.inspect === day) return uShowWhole();
    if (M && M.scale !== 'daily') SX.uDayJump = true;
    SX.uInspect = { key: day, scale: 'daily' }; SX.uPinned = null;
    paintUsage();
  }
  // A new period starts on the whole of it. All history opens on months and gives back a picked scale on the way out.
  function uPeriodChanged() {
    SX.uInspect = null; SX.uPinned = null; SX.uDayJump = false;
    if (SX.uScale) {
      if (SX.uPeriod === 'All history') { if (SX.uScale !== 'monthly') { SX.uScaleBeforeHistory = SX.uScale; SX.uScale = 'monthly'; } }
      else if (SX.uScaleBeforeHistory) { SX.uScale = SX.uScaleBeforeHistory; SX.uScaleBeforeHistory = ''; }
    }
    sxSave();
  }
  function uSliceChanged() { SX.uInspect = null; SX.uPinned = null; SX.uDayJump = false; }
  function uStepRange(delta) {
    var M = SX.uM;
    if (!M) return;
    if (M.inspect) return uMoveInspect(delta);
    var next = uStep(M.period, M.today, SX.uFrom, SX.uTo, delta, M.firstDay);
    if (!next) return;
    SX.uPeriod = next.period;
    if (next.period === U_CUSTOM) { SX.uFrom = next.from; SX.uTo = next.to; }
    uPeriodChanged();
    paintUsage();
    var again = document.querySelector('#u-card [data-u="step"][data-d="' + delta + '"]:not([disabled])') || document.querySelector('#u-card [data-u="step"]:not([disabled])');
    if (again) again.focus();
  }
  // A refresh, a breakpoint change or a resize waits while a finger is down, a menu is open or the dates are being picked.
  function uHeld() {
    var box = $('sessions-usage'), a = document.activeElement;
    return !!(SX.uPointer || SX.uSheet || (box && box.querySelector('.u-cols[open]')) || (box && a && box.contains(a) && a.tagName === 'SELECT'));
  }
  function uFlush() {
    if (uHeld()) return;
    if (SX.uDeferred) paintUsage();
    else if (SX.uRedraw) uDrawWide();
    SX.uRedraw = false;
  }
  function uUsageAction(t) {
    var act = t.getAttribute('data-u');
    if (act === 'range') return uOpenRange(t);
    if (act === 'step') return uStepRange(Number(t.getAttribute('data-d')));
    if (act === 'whole') return uShowWhole();
    if (act === 'peak' || act === 'day') return uInspectDay(t.getAttribute('data-day'));
    if (act === 'lines') { SX.uLines = t.getAttribute('data-on') === '1'; sxSave(); return paintUsage(); }
    if (act === 'sort') {
      var sort = t.getAttribute('data-sort');
      if (SX.uSort === sort) SX.uSortAsc = !SX.uSortAsc; else { SX.uSort = sort; SX.uSortAsc = sort === 'model'; }
      return paintUsage();
    }
    if (act === 'tool') { var p = t.getAttribute('data-p'); SX.uTool = SX.uTool === p ? 'All tools' : p; SX.uModel = 'All models'; SX.uToolBefore = null; uSliceChanged(); return paintUsage(); }
    if (act === 'model') {
      var tp = t.getAttribute('data-p'), m = t.getAttribute('data-m');
      if (SX.uModel === m && SX.uTool === tp) { SX.uModel = 'All models'; SX.uTool = SX.uToolBefore || SX.uTool; SX.uToolBefore = null; }
      else { if (SX.uToolBefore === null || SX.uToolBefore === undefined) SX.uToolBefore = SX.uTool; SX.uTool = tp; SX.uModel = m; }
      uSliceChanged();
      return paintUsage();
    }
    if (act === 'more') { SX.uOpen[t.getAttribute('data-p')] = true; return paintUsage(); }
    if (act === 'fewer') { delete SX.uOpen[t.getAttribute('data-p')]; return paintUsage(); }
  }
  function uUsageChange(e) {
    var id = e.target.id;
    if (id === 'u-measure') { SX.uMeasure = e.target.value; sxSave(); return paintUsage(); }
    if (id === 'u-series') { SX.uSeries = e.target.value; sxSave(); return paintUsage(); }
    if (id === 'u-scale') {
      var M = SX.uM, scale = e.target.value;
      // A day carries into the week or month that holds it; anything else would mislabel the period.
      if (SX.uInspect && SX.uInspect.scale === 'daily' && scale !== 'daily') SX.uInspect = { key: uPeriodKey(SX.uInspect.key, scale), scale: scale };
      else if (!M || !M.inspect) SX.uInspect = null;
      SX.uScale = scale; SX.uDayJump = false; SX.uScaleBeforeHistory = '';
      sxSave();
      return paintUsage();
    }
    var col = e.target.getAttribute && e.target.getAttribute('data-ucol');
    if (col) {
      var cols = uCols().slice(), i = cols.indexOf(col);
      if (i >= 0) cols.splice(i, 1); else cols.push(col);
      SX.uCols = U_COLUMNS.map(function (c) { return c[0]; }).filter(function (c) { return cols.indexOf(c) >= 0; });
      try { localStorage.setItem(U_COLS_KEY, JSON.stringify(SX.uCols)); } catch (_e) { /* storage off: the choice lasts this visit */ }
      // The menu stays open while columns are chosen, so the next box is one tap away.
      SX.uColsOpen = true;
      paintUsage();
      var cb = document.querySelector('#sessions-usage [data-ucol="' + col + '"]');
      if (cb) cb.focus();
    }
  }

  // ── The date range sheet: presets, a month, or Custom From and To. A popover beside its button when wide, a bottom
  // sheet on a phone. Nothing applies until Apply; Cancel, Escape and a tap outside leave the range as it was. ──
  function uRangeContext() {
    var su = SX.usage && SX.usage.sessionUsage, tz = (su && su.timeZone) || '', today = uDayKey(tz), first = '', months = [];
    ((su && su.buckets) || []).forEach(function (b) {
      if (!b || typeof b.day !== 'string') return;
      if (!first || b.day < first) first = b.day;
      var m = b.day.slice(0, 7); if (months.indexOf(m) < 0) months.push(m);
    });
    return { today: today, first: first, months: months.sort().reverse() };
  }
  function uSheetDates(period, ctx) {
    if (period === 'All history') return ctx.first ? [ctx.first.slice(0, 10), ctx.today] : [uAddDays(ctx.today, -29), ctx.today];
    var r = uRange(period, ctx.today, SX.uFrom, SX.uTo);
    if (!r) return [uAddDays(ctx.today, -29), ctx.today];
    return [r[0], r[1] > ctx.today ? ctx.today : r[1]];
  }
  function uOpenRange(anchor, custom) {
    var ctx = uRangeContext(), period = custom ? U_CUSTOM : SX.uPeriod;
    var dates = SX.uPeriod === U_CUSTOM && !uCustomError(SX.uFrom, SX.uTo) ? [SX.uFrom, SX.uTo] : uSheetDates(SX.uPeriod, ctx);
    var wide = uWide();
    SX.uSheet = { period: period, from: dates[0], to: dates[1], anchor: anchor, wide: wide, ctx: ctx };
    var back = $('u-range-back');
    if (!back) {
      back = document.createElement('div');
      back.id = 'u-range-back';
      back.className = 'u-range-back hidden';
      document.body.appendChild(back);
      back.addEventListener('click', function (e) {
        if (e.target === back) return uCloseRange(false);
        var t = e.target.closest('[data-us]');
        if (!t) return;
        var act = t.getAttribute('data-us');
        if (act === 'cancel') return uCloseRange(false);
        if (act === 'apply') return uSheetApply();
        if (act === 'pick') return uSheetPick(t.getAttribute('data-period'));
      });
      back.addEventListener('input', uSheetInput);
      back.addEventListener('change', uSheetInput);
      back.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); uCloseRange(false); }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); uSheetApply(); }
      });
    }
    var S = SX.uSheet, presets = U_PRESETS.map(function (p) {
      var d = uSheetDates(p, ctx), words = p === 'All history' ? (ctx.first ? 'Since ' + uDateRangeTitle([ctx.first.slice(0, 10), ctx.first.slice(0, 10)]) : '') : uDateRangeTitle(d);
      return '<button type="button" class="u-preset" role="radio" aria-checked="' + (S.period === p) + '" data-us="pick" data-period="' + esc(p) + '"><span>' + esc(p) + '</span><span class="u-preset-dates">' + esc(words) + '</span></button>';
    }).join('');
    back.className = 'u-range-back' + (wide ? ' pop' : ' bottom');
    back.innerHTML = '<div class="u-range" role="dialog" aria-modal="true" aria-labelledby="u-range-title">' +
      '<h2 class="u-range-title" id="u-range-title">Dates</h2>' +
      '<div class="u-presets" role="radiogroup" aria-label="Ranges">' + presets + '</div>' +
      '<label class="u-range-field"><span>A month</span><select id="u-range-month" class="field"><option value="">Choose a month</option>' +
      ctx.months.map(function (m) { return '<option value="' + m + '"' + (S.period === m ? ' selected' : '') + '>' + esc(uRangeTitle(m)) + '</option>'; }).join('') + '</select></label>' +
      '<div class="u-custom' + (S.period === U_CUSTOM ? ' on' : '') + '" id="u-custom"><p class="u-custom-title">Custom dates</p><div class="u-dates">' +
      '<label class="u-range-field"><span>From</span><input type="date" class="field" id="u-from" value="' + S.from + '" max="' + ctx.today + '"></label>' +
      '<label class="u-range-field"><span>To</span><input type="date" class="field" id="u-to" value="' + S.to + '" max="' + ctx.today + '"></label></div>' +
      '<p class="u-range-err" id="u-range-err" role="alert"></p></div>' +
      '<p class="u-range-note">' + esc((ctx.first ? 'History on this Mac starts ' + uDateRangeTitle([ctx.first.slice(0, 10), ctx.first.slice(0, 10)]) + '. ' : '') + 'Days without logs are missing, not zero.') + '</p>' +
      '<div class="u-range-actions"><button type="button" class="cx-btn quiet" data-us="cancel">Cancel</button><button type="button" class="cx-btn primary" data-us="apply" id="u-range-apply">Apply</button></div></div>';
    uSheetPlace();
    uSheetCheck();
    var focus = S.period === U_CUSTOM ? $('u-from') : back.querySelector('.u-preset[aria-checked="true"]') || $('u-range-month');
    if (focus) focus.focus();
  }
  function uSheetPlace() {
    var S = SX.uSheet, panel = document.querySelector('#u-range-back .u-range');
    if (!S || !panel) return;
    panel.style.top = panel.style.left = '';
    if (!S.wide || !S.anchor || !S.anchor.getBoundingClientRect) return;
    var r = S.anchor.getBoundingClientRect(), w = Math.min(380, innerWidth - 32), left = Math.min(Math.max(16, r.right - w), innerWidth - 16 - w);
    var top = r.bottom + 8, room = innerHeight - top - 16;
    if (room < 420 && r.top > room) top = Math.max(16, r.top - 8 - Math.min(panel.scrollHeight, innerHeight - 32));
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
    panel.style.maxHeight = Math.round(innerHeight - top - 16) + 'px';
  }
  // In place, never rebuilt: the radios, the month and the two dates follow the choice.
  function uSheetPick(period) {
    var S = SX.uSheet;
    if (!S) return;
    S.period = period;
    var d = uSheetDates(period, S.ctx);
    S.from = d[0]; S.to = d[1];
    $('u-from').value = S.from; $('u-to').value = S.to;
    $('u-range-month').value = U_MONTH_RE.test(period) ? period : '';
    uSheetCheck();
  }
  function uSheetInput(e) {
    var S = SX.uSheet;
    if (!S) return;
    if (e.target.id === 'u-range-month') { if (e.target.value) uSheetPick(e.target.value); return; }
    if (e.target.id !== 'u-from' && e.target.id !== 'u-to') return;
    S.period = U_CUSTOM; S.from = $('u-from').value; S.to = $('u-to').value;
    $('u-range-month').value = '';
    uSheetCheck();
  }
  function uSheetCheck() {
    var S = SX.uSheet;
    if (!S) return;
    document.querySelectorAll('#u-range-back .u-preset').forEach(function (b) { b.setAttribute('aria-checked', String(b.getAttribute('data-period') === S.period)); });
    var err = S.period === U_CUSTOM ? uCustomError(S.from, S.to) : '';
    $('u-custom').classList.toggle('on', S.period === U_CUSTOM);
    $('u-range-err').textContent = err;
    $('u-range-apply').disabled = !!err;
    return err;
  }
  function uSheetApply() {
    var S = SX.uSheet;
    if (!S || uSheetCheck()) return;
    SX.uPeriod = S.period;
    if (S.period === U_CUSTOM) { SX.uFrom = S.from; SX.uTo = S.to; }
    uCloseRange(true);
    uPeriodChanged();
    paintUsage();
    uRefocus(S);
  }
  function uCloseRange(applied) {
    var S = SX.uSheet, back = $('u-range-back');
    SX.uSheet = null;
    if (back) { back.className = 'u-range-back hidden'; back.innerHTML = ''; }
    if (applied) return;
    // A narrow Period menu left on Custom dates goes back to the range in force.
    if (S && !S.wide) paintUsage(); else if (SX.uDeferred) paintUsage();
    uRefocus(S);
  }
  function uRefocus(S) {
    if (!S || !S.anchor) return;
    var a = S.anchor;
    if (!document.body.contains(a)) {
      var sel = a.id ? '#' + a.id : a.getAttribute('data-sx') ? '[data-sx="' + a.getAttribute('data-sx') + '"]' : a.classList.contains('u-rangelink') ? '#u-card [data-u="range"]' : '.u-rangebtn';
      a = document.querySelector('#sessions-usage ' + sel) || document.querySelector('#sessions-usage #usage-period');
    }
    if (a && a.focus) a.focus();
  }

  // Wired once, the first time Usage shows: the breakpoint, resizes, and the finger that holds a repaint back.
  function uWire() {
    if (SX.uWired) return;
    var box = $('sessions-usage');
    if (!box) return;
    SX.uWired = true;
    box.addEventListener('click', function (e) { var t = e.target.closest('[data-u]'); if (t && box.contains(t)) uUsageAction(t); });
    box.addEventListener('change', uUsageChange);
    box.addEventListener('toggle', function (e) {
      if (e.target.classList.contains('u-breakdown')) SX.uBreakOpen = e.target.open;
      if (e.target.classList.contains('u-cols')) { SX.uColsOpen = e.target.open; if (!e.target.open) setTimeout(uFlush, 0); }
    }, true);
    box.addEventListener('pointerdown', function () { SX.uPointer = true; }, true);
    var release = function () { if (!SX.uPointer) return; SX.uPointer = false; if (SX.uDeferred || SX.uRedraw) setTimeout(uFlush, 400); };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    document.addEventListener('pointerdown', function (e) {
      if (SX.uPinned && !e.target.closest('#u-chart')) { SX.uPinned = null; uTipHide(); }
      var cols = box.querySelector('.u-cols[open]');
      if (cols && !cols.contains(e.target)) cols.removeAttribute('open');
    });
    box.addEventListener('focusout', function () { setTimeout(function () { if (SX.uDeferred || SX.uRedraw) uFlush(); }, 0); });
    try {
      var mq = window.matchMedia(U_WIDE_MQ), onMq = function () { if (SX.view === 'usage' && SX.usage) paintUsage(true); };
      if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
    } catch (_e) { /* no media queries: the vertical layout stays */ }
    var timer = null;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (SX.uSheet) uSheetPlace();
        if (!SX.uWideShown || SX.view !== 'usage') return;
        if (uHeld()) SX.uRedraw = true; else uDrawWide();
      }, 150);
    });
  }
  // The viewer's last range, scale and chart choices, checked before use (the stored words could be from an older page).
  function uLoadPrefs() {
    if (SX.uPrefsLoaded) return;
    SX.uPrefsLoaded = true;
    var p = readStore(SX_PREFS);
    if (uKnownPeriod(p.uPeriod) && (p.uPeriod !== U_CUSTOM || !uCustomError(p.uFrom, p.uTo))) { SX.uPeriod = p.uPeriod; SX.uFrom = p.uFrom || ''; SX.uTo = p.uTo || ''; }
    if (['all', 'new', 'value'].indexOf(p.uMeasure) >= 0) SX.uMeasure = p.uMeasure;
    if (['tool', 'model', 'type'].indexOf(p.uSeries) >= 0) SX.uSeries = p.uSeries;
    if (['daily', 'weekly', 'monthly'].indexOf(p.uScale) >= 0) SX.uScale = p.uScale;
    SX.uLines = p.uLines === true;
  }

  // ── COS cost view (SessionUsageView.swift CosCostView 1773-2009, CosCostPresentation) ──
  var COS_CATS = {
    dictation: ['Dictation', 'dictation', 'dictations'],
    transcription: ['Transcription cleanup', 'cleanup', 'cleanups'],
    dictationBeforeSplit: ['Dictation and transcripts, before Oct 20', 'cleanup', 'cleanups'],
    meetingNotes: ['Meeting notes', 'note or summary', 'notes and summaries'],
    answers: ['Answers', 'answer', 'answers'],
    liveAndUpkeep: ['Live help and upkeep', 'check', 'checks'],
    memoryIndexing: ['Memory indexing', 'indexing call', 'indexing calls'],
    other: ['Other', 'other call', 'other calls'],
    work: ['Work', 'background call', 'background calls'],
    sessionFinding: ['Finding sessions', 'search', 'searches']
  };
  var COS_FIELDS = ['calls', 'measuredCalls', 'measuredUSD', 'measuredTokens', 'unpricedMeasuredCalls', 'unpricedLedgerTokens', 'estimatedCalls', 'estimatedUSD', 'estimatedPricedCalls', 'estimatedTokens', 'addsToTotalUSD', 'addsUnlessCursorFeedUSD', 'approximateMatches'];
  function cosCount(cat, n) { var c = COS_CATS[cat] || COS_CATS.other; return uNum(n) + ' ' + (n === 1 ? c[1] : c[2]); }
  // A category this page does not know joins Other, so every row keeps one of Control's titles.
  function cosRows(report) {
    var by = {};
    (report.rows || []).forEach(function (row) {
      var cat = COS_CATS[row.category] ? row.category : 'other';
      var acc = by[cat] || (by[cat] = { category: cat });
      COS_FIELDS.forEach(function (k) { acc[k] = (acc[k] || 0) + (Number(row[k]) || 0); });
    });
    return Object.keys(by).map(function (k) { return by[k]; });
  }
  function cosSum(rows, k) { return rows.reduce(function (s, r) { return s + (Number(r[k]) || 0); }, 0); }
  function cosUsageState(su) {
    if (!su) return 'unavailable';
    if (Number(su.pendingFiles) > 0 || (su.cursorFeed && su.cursorFeed.pending === true)) return 'importing';
    return 'ready';
  }
  function cosCostHtml(d) {
    var report = d.cosCost, su = d.sessionUsage;
    if (!report) return '<div class="sx-uempty">Reading what COS used.</div>';
    var rows = cosRows(report), overhead = rows.filter(function (r) { return r.category !== 'work'; });
    var workRow = rows.filter(function (r) { return r.category === 'work'; })[0] || null;
    var work = report.work || {}, sessions = report.sessions || {};
    var reading = (Number(sessions.stillReading) || 0) > 0 || sessions.busy === true;
    var us = cosUsageState(su);
    // The total the person ran: Usage's API value in the window, plus COS spend Usage cannot see.
    var lo = report.windowStart || '', hi = report.windowEnd || '';
    var buckets = (su && su.buckets) || [];
    var inWin = function (b) { return (!lo || b.day >= lo) && (!hi || b.day <= hi); };
    var cursorHeld = !!(su && su.cursorFeed && su.cursorFeed.lastSuccessAt) || buckets.some(function (b) { return b.provider === 'Cursor' && inWin(b); });
    var ran = buckets.filter(inWin).reduce(function (s, b) { return s + (Number(b.estimatedUSD) || 0); }, 0) +
      rows.reduce(function (s, r) { return s + (Number(r.addsToTotalUSD) || 0) + (cursorHeld ? 0 : (Number(r.addsUnlessCursorFeedUSD) || 0)); }, 0) +
      (Number(work.addsToTotalUSD) || 0);
    var ranPartial = us !== 'unavailable' && buckets.some(function (b) { return inWin(b) && (Number(b.pricedEvents) || 0) < (Number(b.events) || 0); });
    var total = cosSum(overhead, 'calls'), measured = cosSum(overhead, 'measuredCalls'), estimated = cosSum(overhead, 'estimatedCalls');
    var usd = cosSum(overhead, 'measuredUSD');
    var measuredPartial = overhead.some(function (r) { return r.unpricedMeasuredCalls > 0 || r.unpricedLedgerTokens > 0; });
    var workUSD = (Number(work.measuredUSD) || 0) + (workRow ? workRow.measuredUSD : 0);
    var workTokens = (Number(work.measuredTokens) || 0) + (workRow ? workRow.measuredTokens : 0);
    var callWord = total === 1 ? 'call' : 'calls';

    // The headline: the answer, then what it leaves out (headlineParts).
    var answer, caveat = '';
    if (!report.auditFound && total === 0) { answer = 'COS has no record of its calls on this Mac yet.'; caveat = ' The record starts with its first one.'; }
    else if (total === 0) {
      var withoutCalls = overhead.some(function (r) { return r.measuredTokens > 0; }) || workTokens > 0 || (Number(work.widerTokens) || 0) > 0;
      answer = withoutCalls ? 'COS made no counted calls in the last 30 days.' : 'COS made no calls in the last 30 days.';
      caveat = withoutCalls ? ' Its Work and background usage is below.' : '';
    } else if (measured <= 0) {
      answer = 'COS made ' + uNum(total) + ' ' + callWord + ' in the last 30 days.';
      caveat = reading ? ' Still reading the session logs that could hold their cost.'
        : sessions.failed ? ' COS could not read the usage history, so the session logs that could hold their cost are missing from this pass.'
        : ' This server doesn’t measure their cost yet.';
    } else {
      var lead = reading || sessions.failed ? 'Measured so far: COS used ' : 'Measured: COS used ';
      var usdText = uMoney(usd) + (measuredPartial ? '+' : ''), ranText = uMoney(ran) + (ranPartial ? '+' : '');
      if (usd <= 0) answer = 'COS made ' + uNum(total) + ' ' + callWord + ' in the last 30 days. ' + uNum(measured) + ' were measured, on models with no verified price.';
      else if (us === 'unavailable' || ran <= 0 || usd > ran) answer = lead + usdText + ' in the last 30 days.';
      else if (us === 'importing') answer = lead + usdText + ' of the ' + ranText + ' read so far in the last 30 days.';
      else answer = lead + usdText + ' of the ' + ranText + ' you ran in the last 30 days.';
      if (estimated > 0 && usd > 0) caveat = ' ' + uNum(estimated) + ' more ' + (estimated === 1 ? 'call has' : 'calls have') + ' only character counts, so the real figure is higher.';
    }
    if (report.auditUnreadable) {
      if (total === 0) { answer = 'COS could not read its record of calls, so there is no count to show.'; caveat = ''; }
      else caveat += ' COS could not read its record of calls, so some are missing here.';
    }
    var html = '<h2 class="sx-cost-head">' + esc(answer) + (caveat ? '<span>' + esc(caveat) + '</span>' : '') + '</h2>';
    var showsDollars = rows.some(function (r) { return r.measuredUSD > 0 || r.estimatedUSD > 0; }) || (Number(work.widerUSD) || 0) > 0;
    if (showsDollars) html += '<p class="sx-cost-api">These are API values: what the same calls would cost at standard API rates. They aren’t your bill.</p>';

    var status = [];
    if (reading) { var n = Number(sessions.stillReading) || 0; status.push(['', n > 0 ? 'Still reading ' + uNum(n) + ' ' + (n === 1 ? 'session' : 'sessions') + '. These figures will grow until it finishes.' : 'Still reading. The usage history was busy, so these figures may grow.']); }
    if (us === 'importing') {
      var files = Number(su.pendingFiles) || 0;
      status.push(['warn', files > 0 ? 'Usage is still reading ' + uNum(files) + ' log ' + (files === 1 ? 'file' : 'files') + ', so the total will grow and the share will settle.' : 'Usage is still reading your Cursor usage, so the total will grow and the share will settle.']);
    } else if (us === 'unavailable') status.push(['warn', 'Usage has not been read yet, so there is no total to compare this with.']);
    if (status.length) html += '<div class="sx-cost-status">' + status.map(function (s) { return '<p class="' + s[0] + '">' + esc(s[1]) + '</p>'; }).join('') + '</div>';

    // Category rows (rowLines): measured first, largest first; then estimated; then tokens with no
    // price; then empty rows. Dictation and Transcription cleanup always show.
    if (total > 0 || overhead.some(function (r) { return r.measuredTokens > 0; })) {
      var list = overhead.slice();
      ['dictation', 'transcription'].forEach(function (c) { if (!list.some(function (r) { return r.category === c; })) { var e = { category: c }; COS_FIELDS.forEach(function (k) { e[k] = 0; }); list.push(e); } });
      var rank = function (r) { return r.measuredUSD > 0 ? 0 : r.estimatedUSD > 0 ? 1 : (r.calls > 0 || r.measuredTokens > 0 ? 2 : 3); };
      var size = function (r) { return r.measuredUSD > 0 ? r.measuredUSD : r.estimatedUSD > 0 ? r.estimatedUSD : r.calls; };
      list.sort(function (a, b) { return (rank(a) - rank(b)) || (size(b) - size(a)) || (a.category < b.category ? -1 : 1); });
      var peak = list.reduce(function (m, r) { return Math.max(m, r.measuredUSD + r.estimatedUSD); }, 0);
      html += '<div class="sx-cost-rows">' + list.map(function (r) { return cosRowHtml(r, peak); }).join('') + '</div>';
    }

    // Work: what a person chose, under the figure rather than inside it.
    var workCount = !work.handoffsFound ? 'This Mac has no record of Work runs.' : !(Number(work.runs) > 0) ? 'No Work runs in the last 30 days' : uNum(work.runs) + ' ' + (Number(work.runs) === 1 ? 'run' : 'runs') + ' you started';
    var workPartial = (Number(work.unpricedEvents) || 0) > 0 || (workRow ? workRow.unpricedMeasuredCalls > 0 : false);
    var workFigure = workUSD > 0 ? uMoney(workUSD) + (workPartial ? '+' : '') : workTokens > 0 ? 'No price' : '';
    var wider = (Number(work.widerUSD) || 0) + (workRow ? workRow.measuredUSD : 0);
    var widerPartial = (Number(work.widerUnpricedEvents) || 0) > 0 || (workRow ? workRow.unpricedMeasuredCalls > 0 : false);
    var workLines = [];
    if (wider - workUSD >= 0.01) workLines.push(['strong', uMoney(wider) + (widerPartial ? '+' : '') + ' if you count what you did later in those sessions.']);
    if (work.handoffsFound && Number(work.runs) > 0) workLines.push(['', 'From each run’s session log, from its start until you next typed in that session or its last turn finished. Not part of the figure above.']);
    if (workRow && workRow.estimatedCalls > 0) workLines.push(['', 'Plus ' + cosCount('work', workRow.estimatedCalls) + (workRow.estimatedUSD > 0 ? ', ' + uAtLeast(workRow.estimatedUSD) + ' estimated' : ', no verified price') + '.']);
    var unproven = Number(work.unprovenRuns) || 0;
    if (unproven > 0) workLines.push(['', uNum(unproven) + ' ' + (unproven === 1 ? 'run has' : 'runs have') + ' no provable end, so ' + (unproven === 1 ? 'it is' : 'they are') + ' only in the wider figure.']);
    var noLogs = Number(work.runsWithoutLogs) || 0;
    if (noLogs > 0) workLines.push(['', uNum(noLogs) + ' ' + (noLogs === 1 ? 'run' : 'runs') + ' left no log COS can read, so ' + (noLogs === 1 ? 'it isn’t' : 'they aren’t') + ' counted.']);
    html += '<div class="sx-work"><div class="sx-work-top"><div><b class="sx-work-title">Work</b><span class="sx-work-count">' + esc(workCount) + '</span></div>' +
      '<div class="sx-work-fig">' + (workFigure ? '<b>' + esc(workFigure) + '</b>' : '') + (workTokens > 0 ? '<span>' + uShort(workTokens) + ' tokens, measured</span>' : '') + '</div></div>' +
      workLines.map(function (l) { return '<p class="' + l[0] + '">' + esc(l[1]) + '</p>'; }).join('') + '</div>';

    // Footer: the notes, then how this is counted.
    var notes = [];
    if (ranPartial) {
      var short = measuredPartial || estimated > 0 || (Number(sessions.compressed) || 0) > 0 || (Number(sessions.noLogs) || 0) > 0 || reading;
      notes.push(short ? 'Some of your own sessions use models with no verified price, and COS’s own figure leaves some calls out too. Neither side is complete, so the share can be higher or lower.'
        : 'Some of your own sessions use models with no verified price. They aren’t in the total you ran, so it is higher than shown and COS’s share of it is lower.');
    }
    var compressed = Number(sessions.compressed) || 0, gone = Number(sessions.noLogs) || 0;
    if (compressed > 0) notes.push(uNum(compressed) + ' ' + (compressed === 1 ? 'session is' : 'sessions are') + ' compressed and could not be read, so their cost is not in these figures.');
    if (gone > 0) notes.push(uNum(gone) + ' ' + (gone === 1 ? 'session has' : 'sessions have') + ' no log left on this Mac, so their cost is not in these figures.');
    if (sessions.busy) notes.push('The usage history was busy, so this pass read nothing new. COS tries again soon.');
    if (sessions.failed) notes.push('COS could not read the usage history, so this pass read nothing new. It tries again in 5 minutes.');
    if (!report.runLedgersFound && overhead.some(function (r) { return r.category === 'answers' && r.calls > 0; })) notes.push('This server has no run records, so answers stay estimated.');
    var undated = Number(report.undatedCalls) || 0, unreadable = Number(report.unreadableRows) || 0;
    if (undated > 0) notes.push(uNum(undated) + ' ' + (undated === 1 ? 'call has' : 'calls have') + ' no readable date, so ' + (undated === 1 ? 'it isn’t' : 'they aren’t') + ' in these 30 days.');
    if (unreadable > 0) notes.push(uNum(unreadable) + ' ' + (unreadable === 1 ? 'line' : 'lines') + ' could not be read at all.');
    var approximate = cosSum(rows, 'approximateMatches');
    var method = [
      'Measured means the provider reported the tokens, in a session log or a record COS keeps. Estimated means COS only has the length of the text, so it divides characters by four and uses the model’s plain rate. Cache reads and system prompts aren’t in that, which is why an estimate says at least.',
      'Estimated figures stay out of every measured total. Rates are standard API rates, checked ' + (report.ratesCheckedOn ? uDayWords(report.ratesCheckedOn) : 'recently') + '. A model with no verified rate shows tokens and No price, never $0. A dollar figure that leaves out some calls with no rate ends in a +.',
      'The total you ran is what Usage counted in these 30 days, plus COS calls Usage can’t see because they keep no session log.',
      'A Work run counts from its start until you next typed in that session, another session messaged it, or its last turn finished. COS tells a typed turn from a tool result by the row’s type and never reads the words. Background work the run started counts as the run. With none of those endings in the log, a run has no provable end and stays in the wider figure only. The wider figure is everything in those sessions from the first run’s start, and it stays out of every share.'
    ];
    if (approximate > 0) method.push(uNum(approximate) + ' ' + (approximate === 1 ? 'call was' : 'calls were') + ' matched to ' + (approximate === 1 ? 'its run' : 'their runs') + ' by time and model, because older servers write no id. Newer rows carry one.');
    method.push('Only counts, dates and model names are read from these logs.');
    html += '<div class="sx-cost-foot">' + notes.map(function (n) { return '<p>' + esc(n) + '</p>'; }).join('') +
      '<details class="sx-how"><summary>How this is counted</summary>' + method.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') + '</details></div>';
    return html;
  }
  // One category (rowLine): what a person got, a bar (measured solid, an estimated floor paler
  // after it), and the dollars or the word for what the row has instead.
  function cosRowHtml(r, peak) {
    var title = (COS_CATS[r.category] || COS_CATS.other)[0];
    var tokens = uShort(r.measuredTokens + (r.measuredCalls === 0 ? r.estimatedTokens : 0)) + ' tokens';
    var count = r.calls > 0 ? cosCount(r.category, r.calls) : r.measuredTokens > 0 ? 'Counted by the day' : 'None in the last 30 days';
    var figure = '', detail = '', evidence = 'none', mix = [];
    if (r.calls > 0 || r.measuredTokens > 0) {
      if (r.measuredCalls > 0 && r.estimatedCalls > 0) {
        var rest = r.estimatedPricedCalls > 0 && r.estimatedPricedCalls < r.estimatedCalls ? uNum(r.estimatedPricedCalls) + ' of the ' + uNum(r.estimatedCalls) + ' others' : 'the rest';
        mix.push(uNum(r.measuredCalls) + ' measured' + (r.estimatedUSD > 0 ? ', ' + uAtLeast(r.estimatedUSD) + ' estimated for ' + rest : ', no verified price for the rest') + '.');
      }
      var partial = r.measuredUSD > 0 && (r.unpricedMeasuredCalls > 0 || r.unpricedLedgerTokens > 0);
      if (r.measuredUSD > 0 && r.unpricedMeasuredCalls > 0) mix.push(uNum(r.unpricedMeasuredCalls) + ' measured ' + (r.unpricedMeasuredCalls === 1 ? 'call has' : 'calls have') + ' no verified price, so the dollars are a floor.');
      if (r.measuredUSD > 0 && r.unpricedLedgerTokens > 0) mix.push(uShort(r.unpricedLedgerTokens) + ' tokens counted by the day have no verified price, so the dollars are a floor.');
      if (r.measuredUSD > 0) { evidence = 'measured'; figure = uMoney(r.measuredUSD) + (partial ? '+' : ''); detail = tokens + ', measured'; }
      else if (r.measuredTokens > 0 && r.estimatedCalls === 0) { evidence = 'noprice'; figure = 'No price'; detail = tokens; }
      else if (r.estimatedUSD > 0) { evidence = 'estimated'; figure = 'Estimated'; detail = uAtLeast(r.estimatedUSD); }
      else { evidence = 'noprice'; figure = 'No price'; detail = tokens; }
    }
    var m = peak > 0 ? Math.min(1, r.measuredUSD / peak) : 0, e = peak > 0 ? Math.min(1 - m, r.estimatedUSD / peak) : 0;
    return '<div class="sx-cost-row"><div class="sx-cost-name"><b>' + esc(title) + '</b><span>' + esc(count) + '</span>' + (mix.length ? '<span class="mix">' + esc(mix.join(' ')) + '</span>' : '') + '</div>' +
      '<div class="sx-cost-bar" aria-hidden="true">' + (m > 0 ? '<span class="m" style="width:' + (m * 100).toFixed(2) + '%"></span>' : '') + (e > 0 ? '<span class="e" style="width:' + (e * 100).toFixed(2) + '%"></span>' : '') + '</div>' +
      '<div class="sx-cost-fig ' + evidence + '">' + (figure ? '<b>' + esc(figure) + '</b>' : '') + (detail ? '<span>' + esc(detail) + '</span>' : '') + '</div></div>';
  }

  // ── Settings ────────────────────────────────────────────
  function paintAppearance() {
    var choice = window.CosTheme ? window.CosTheme.choice() : 'system';
    document.querySelectorAll('[data-theme-choice]').forEach(function (b) {
      var on = b.getAttribute('data-theme-choice') === choice;
      b.setAttribute('aria-pressed', String(on));
      b.querySelector('.value').innerHTML = on ? '<span class="check">✓</span>' : '';
    });
  }
  var codeTimer = null;
  // A QR as inline SVG from vendor/qrcode-encoder.js (window.COSQR). Only numbers reach the
  // markup; the text is encoded, never inserted. Empty when the encoder did not load.
  function qrSvg(text) {
    if (!window.COSQR || !window.COSQR.matrix) return '';
    var m; try { m = window.COSQR.matrix(text); } catch (_e) { return ''; }
    var n = m.size, q = 4, d = '';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (m.data[y * n + x]) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
    var w = n + q * 2;
    return '<svg class="qr" viewBox="0 0 ' + w + ' ' + w + '" role="img" aria-label="Sign-in QR code" shape-rendering="crispEdges"><rect width="' + w + '" height="' + w + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  function showDeviceCode() {
    var panel = $('device-code-panel');
    panel.classList.remove('hidden');
    panel.innerHTML = '<p>Getting a code</p>';
    api('/api/web-session/device-code', { method: 'POST', body: {} }).then(function (d) {
      var url = state.tailnetUrl || (location.origin + '/control');
      var exp = toDate(d.expiresAt);
      // The QR is the phone link with this code on it: the camera opens it, the page signs in
      // with the code (one use, five minutes), and nothing is typed. Same code, same rules.
      var link = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'code=' + encodeURIComponent(d.code);
      panel.innerHTML = qrSvg(link) +
        '<p class="qr-hint">Scan with your phone\'s camera to sign it in.</p>' +
        '<p>Or open <span class="url">' + esc(url) + '</span> on the phone and type this code:</p>' +
        '<span class="code">' + esc(d.code) + '</span>' +
        '<p id="device-code-left"></p>';
      clearInterval(codeTimer);
      var tick = function () {
        var left = exp ? Math.round((exp.getTime() - Date.now()) / 1000) : 0;
        var el = $('device-code-left');
        if (!el) { clearInterval(codeTimer); return; }
        if (left <= 0) { clearInterval(codeTimer); panel.innerHTML = '<p>That code expired. Choose Use COS on another phone or browser for a new one.</p>'; return; }
        el.textContent = 'Works once, for ' + (left >= 60 ? Math.ceil(left / 60) + ' more min' : left + ' more sec') + '.';
      };
      tick(); codeTimer = setInterval(tick, 1000);
    }).catch(function (err) { panel.innerHTML = '<p class="status-line error">' + esc(err.message) + '</p>'; });
  }
  function loadTailnetUrl() {
    api('/api/tailscale/web-url').then(function (d) {
      // The phone link is plain http by name, then by address. The https name link comes last:
      // the Mac's local certificate does not cover the Tailscale name, so Safari refuses it.
      state.tailnetUrl = d.magicDnsUrl || d.ipv4Url || d.magicDnsHttpsUrl || '';
      // Settings renders this line itself; fill it only if it is on screen now.
      var el = $('tailnet-url'); if (el) el.textContent = state.tailnetUrl || 'Tailscale is not running on the Mac';
    }).catch(function () { var el = $('tailnet-url'); if (el) el.textContent = 'Tailscale address unavailable'; });
  }

  // ── Ask sheet (⌘K) ──────────────────────────────────────
  var JUMPS = [
    ['today', 'Today'], ['messages', 'Messages'], ['speakers', 'Speakers'], ['meetings', 'Meetings'], ['memories', 'Memories'],
    ['threads', 'Threads'], ['sessions', 'Sessions'], ['work', 'Work'], ['dictation', 'Dictation'], ['usage', 'Usage'], ['settings', 'Settings']
  ];
  // ⌘K's File to Work inbox (Control's todaySubmitAsk, ActivityWindow.swift 8810): the words become a task in the Work
  // inbox, in Control's taskDomain (quilt when the server has it, else the first domain it lists: reconcileTaskDomain),
  // through POST /api/tasks/capture,
  // the route Work's Add task uses. One captureId per text: a second tap, or a retry after a lost answer, files it once.
  var ASK_FILE = { text: '', id: '', busy: false, domains: null, note: null };
  // The result shows on the row itself, so it is in view wherever the sheet is (W5-r2: a status line under the sheet
  // at 1000x703 hid a refusal), and a toast says it too.
  function fileNoteHtml(q) {
    var n = ASK_FILE.note && ASK_FILE.note.text === q ? ASK_FILE.note : null;
    if (n) return '<span class="note' + (n.error ? ' file-error' : '') + '" role="' + (n.error ? 'alert' : 'status') + '">' + esc(n.line) + '</span>';
    return '<span class="note">' + esc('As a task in ' + fileDomainLabel()) + '</span>';
  }
  function fileDomainEntry() {
    var d = ASK_FILE.domains || [];
    return d.filter(function (x) { return x && x.name === 'quilt'; })[0] || d.filter(function (x) { return x && x.name; })[0] || null;
  }
  function fileDomain() { var e = fileDomainEntry(); return e ? e.name : 'quilt'; }
  function fileDomainLabel() { var e = fileDomainEntry(); return (e && e.label) || domainLabel(fileDomain()); }
  function loadFileDomains() {
    if (ASK_FILE.domains) return Promise.resolve();
    return api('/api/domains').then(function (d) { ASK_FILE.domains = (d && Array.isArray(d.domains)) ? d.domains : []; }, function () { ASK_FILE.domains = null; });
  }
  function fileToInbox(text) {
    if (ASK_FILE.busy || !text) return;
    if (ASK_FILE.text !== text) { ASK_FILE.text = text; ASK_FILE.id = webJobId(); }
    ASK_FILE.busy = true; ASK_FILE.note = null; renderAskFile();
    loadFileDomains().then(function () {
      return api('/api/tasks/capture', { method: 'POST', body: { domain: fileDomain(), text: text, section: 'inbox', captureId: ASK_FILE.id }, timeoutMs: 20000 });
    }).then(function () {
      ASK_FILE.busy = false; ASK_FILE.text = ''; ASK_FILE.note = null;
      var box = $('ask-q'); if (box && box.value.trim() === text) { box.value = ''; renderAsk(); }
      renderAskFile();
      toast('Filed to the Work inbox.');
      if (PANES.work && PANES.work.intakeChanged) PANES.work.intakeChanged();   // Work reads its board again when it opens
    }, function (err) {
      ASK_FILE.busy = false;
      var line = 'Not filed: ' + ((err && err.message) || 'your Mac did not answer') + ' Filing again is safe.';
      ASK_FILE.note = { text: text, line: line, error: true };
      renderAskFile();
      toast(line);
    });
  }
  function renderAskFile() {
    var b = document.querySelector('#ask-results [data-action="ask-file"]'); if (!b) return;
    b.disabled = ASK_FILE.busy;
    var g = b.querySelector('.grow'); if (!g) return;
    var q = ($('ask-q') && $('ask-q').value.trim()) || '';
    g.innerHTML = esc(ASK_FILE.busy ? 'Filing\u2026' : 'File to Work inbox') + fileNoteHtml(q);
  }
  // ── files with Ask COS (11/07, Miles: "Sometimes I need to pass context via a screenshot, photo or file") ──
  // The COS chat's own clip, chips, limits and upload (panes/cos-chat.js, W.cosChat.attach): photos, PDF, TXT, MD, CSV,
  // JSON, XLSX, MP4 and MOV, up to 5, pasted, dropped or picked. They go with Ask COS only; the sheet's other rows take
  // words. Ask COS waits for every upload, and a file that failed has to be retried or removed first. Closing the sheet
  // keeps them for the next Ask in this tab.
  var ASK_FILES = null, ASK_SENDING = false;
  function askKit() { var c = window.COSWeb && window.COSWeb.cosChat; return c && c.attach ? c.attach : null; }
  function askFiles() {
    var kit = askKit(); if (!kit) return null;
    if (!ASK_FILES) ASK_FILES = kit.box({
      changed: paintAskFiles,
      removed: function () { setStatus($('ask-status'), ''); },
      signedOut: function () { setStatus($('ask-status'), 'This browser was signed out. Your files are kept. Sign in, then tap Retry on each file.', true); }
    });
    return ASK_FILES;
  }
  function askFilesState() {
    var kit = askKit(), b = ASK_FILES;
    if (!kit || !b || !b.atts.length) return 'none';
    return kit.pending(b) ? 'waiting' : kit.failed(b) ? 'failed' : 'ready';
  }
  function paintAskClip() {
    var slot = $('ask-clip'), kit = askKit(); if (!slot) return;
    var on = !!(kit && kit.askOn());
    if (!on) { slot.innerHTML = ''; return; }
    // 6.99.27: Take photo beside the clip (a phone or tablet only; kit.cameraHtml).
    if (!slot.querySelector('[data-ask-file]')) slot.innerHTML = kit.cameraHtml('data-ask-file') + kit.clipHtml('data-ask-file');
    var full = !!(ASK_FILES && ASK_FILES.atts.length >= kit.max);
    Array.prototype.forEach.call(slot.querySelectorAll ? slot.querySelectorAll('.cc-attach') : [], function (l) { l.classList.toggle('full', full); });
    Array.prototype.forEach.call(slot.querySelectorAll ? slot.querySelectorAll('[data-ask-file]') : [], function (i) { i.disabled = full || ASK_SENDING; });
  }
  function paintAskFiles() {
    var kit = askKit(), box = $('ask-files'), b = ASK_FILES; if (!box || !kit) return;
    var st = askFilesState();
    box.innerHTML = st === 'none' ? '' : kit.chipsHtml(b, 'data-action') + '<p class="ask-files-note">' + esc(
      st === 'waiting' ? 'Uploading. Ask COS waits for it.' : st === 'failed' ? 'A file did not upload. Retry it or remove it, then Ask COS.'
        : (b.atts.length === 1 ? 'This file goes' : 'These files go') + ' with Ask COS. Write the question above.') + '</p>';
    box.classList.toggle('hidden', st === 'none');
    paintAskClip(); paintAskRow();
  }
  function addAskFiles(list) {
    var kit = askKit(), b = askFiles(); if (!kit || !b || !list || !list.length) return;
    var refusals = kit.add(b, list);
    setStatus($('ask-status'), refusals.join(' '), !!refusals.length);
    paintAskFiles();
  }
  // The Ask COS row says what it sends, and waits while a file uploads.
  function askRowNote(q) {
    var n = ASK_FILES ? ASK_FILES.atts.length : 0;
    // The files first: on the folded phone the line is cut, and they are what changed.
    return '“' + q + '”' + (n ? ' with ' + (n === 1 ? '1 file' : n + ' files') : '') + (state.pane === 'today' ? (n ? ' and' : ' with') + ' what Today shows' : '');
  }
  function paintAskRow() {
    var row = document.querySelector('#ask-results [data-action="ask-cos"]'); if (!row) return;
    var st = askFilesState();
    row.disabled = ASK_SENDING || st === 'waiting' || st === 'failed';
    var note = row.querySelector('.note'), q = ($('ask-q') && $('ask-q').value.trim()) || '';
    if (note) note.textContent = ASK_SENDING ? 'Sending…' : st === 'waiting' ? 'Waiting for the upload' : askRowNote(q);
  }
  function askSheetSend(q) {
    if (ASK_SENDING) return;
    var kit = askKit(), b = ASK_FILES, st = askFilesState();
    if (st === 'waiting') { setStatus($('ask-status'), 'A file is still uploading. Ask COS when it finishes.'); return; }
    if (st === 'failed') { setStatus($('ask-status'), 'A file did not upload. Retry it or remove it, then Ask COS.', true); return; }
    var files = st === 'ready' ? { attachmentIds: kit.ids(b), atts: kit.sent(b) } : null;
    ASK_SENDING = true; paintAskRow(); paintAskClip();
    var done = function () { ASK_SENDING = false; paintAskRow(); paintAskClip(); };
    askCos(q, $('ask-status'), files).then(function (where) {
      done();
      // Sent: these files went with it. Anything added while it was sending stays for the next Ask.
      if (files && b) b.atts.filter(function (t) { return files.attachmentIds.indexOf(t.mediaId) >= 0; }).forEach(function (t) { kit.remove(b, t.id); });
      closeAsk(); go('messages', Array.isArray(where) ? where : []);
    }).catch(done);
  }
  function openAsk(prefill) {
    loadFileDomains().then(function () { if (!$('ask-sheet').classList.contains('hidden') && $('ask-q').value.trim()) renderAsk(); });
    $('ask-sheet').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    var input = $('ask-q'); input.value = prefill || '';
    renderAsk(); paintAskFiles(); paintAskClip();
    var kit = askKit(); if (kit && !kit.askOn()) kit.ensureCaps().then(paintAskClip, function () {});
    setTimeout(function () { input.focus(); }, 30);
  }
  function closeAsk() { $('ask-sheet').classList.add('hidden'); document.body.style.overflow = ''; }
  function renderAsk() {
    var q = $('ask-q').value.trim();
    var out = $('ask-results');
    if (!q) {
      var recent = state.sessions.slice(0, 5);
      out.innerHTML = '<h2 class="group-title">Go to</h2><div class="list">' + JUMPS.map(function (j) {
        return '<button type="button" class="nav-row" data-goto="' + j[0] + '"><svg class="icon"><use href="#i-' + j[0] + '"/></svg><span class="grow">' + esc(j[1]) + '</span><span class="chev"></span></button>';
      }).join('') + '</div>' +
        (recent.length ? '<h2 class="group-title">Recent sessions</h2><div class="list">' + recent.map(function (s) { return sessionRow(s); }).join('') + '</div>' : '');
      return;
    }
    var jumps = JUMPS.filter(function (j) { return j[1].toLowerCase().indexOf(q.toLowerCase()) === 0; });
    out.innerHTML = '<div class="list" style="margin-top:14px">' +
      '<button type="button" class="nav-row" data-action="ask-cos"><svg class="icon"><use href="#i-ask"/></svg><span class="grow">Ask COS<span class="note">' + esc(askRowNote(q)) + '</span></span></button>' +
      '<button type="button" class="nav-row" data-action="ask-file"' + (ASK_FILE.busy ? ' disabled' : '') + '><svg class="icon"><use href="#i-work"/></svg><span class="grow">' + (ASK_FILE.busy ? 'Filing\u2026' : 'File to Work inbox') + fileNoteHtml(q) + '</span></button>' +
      '<button type="button" class="nav-row" data-action="ask-meaning"><svg class="icon"><use href="#i-sessions"/></svg><span class="grow">Find a session about this<span class="note">Ranks every session by meaning</span></span></button>' +
      '<button type="button" class="nav-row" data-action="ask-work"><svg class="icon"><use href="#i-work"/></svg><span class="grow">Find a task about this<span class="note">Searches Work by meaning</span></span></button>' +
      jumps.map(function (j) { return '<button type="button" class="nav-row" data-goto="' + j[0] + '"><svg class="icon"><use href="#i-' + j[0] + '"/></svg><span class="grow">Go to ' + esc(j[1]) + '</span><span class="chev"></span></button>'; }).join('') +
      '</div><div id="ask-hits"></div><p class="status-line" id="ask-status"></p>';
    paintAskRow();
    clearTimeout(renderAsk.t);
    if (q.length >= 2) renderAsk.t = setTimeout(function () {
      api('/api/agent-sessions/search?q=' + encodeURIComponent(q) + '&limit=6').then(function (d) {
        var hits = (d && d.hits) || [];
        var el = $('ask-hits'); if (!el || $('ask-q').value.trim() !== q) return;
        el.innerHTML = hits.length ? '<h2 class="group-title"><span>Sessions with “' + esc(q) + '”</span><span>' + hits.length + '</span></h2><div class="list">' + hits.map(function (s) { return sessionRow(s, s.snippet); }).join('') + '</div>' : '';
      }).catch(function () {});
    }, 220);
  }

  // ── events (one delegated listener) ─────────────────────
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-today-next],[data-next-prep],[data-next-prep-cancel],[data-next-prep-remove],[data-today-needs],[data-today],[data-goto],[data-pane],[data-session],[data-meeting],[data-speakers],[data-action],[data-open-ask],[data-theme-choice],#topbar-back,#section-btn,#sign-out,#copy-link,#ask-close,#auth-switch,#auth-token-show,#auth-retry,#device-code-btn');
    if (!t) { if (e.target.id === 'ask-sheet') closeAsk(); if (e.target.id === 'section-menu') closeMenu(); return; }
    var inSheet = !!t.closest('#ask-sheet');
    if (t.id === 'topbar-back') return goBack();
    if (t.id === 'section-btn') return openMenu();
    if (t.id === 'auth-retry') { t.disabled = true; t.textContent = 'Checking'; api('/api/web-session/status').then(function (st) { if (st && st.authenticated) showShell(st); else showAuth(); }, function (err) { if (err && err.status) showAuth(err.message); else authOffline(true); }).then(function () { t.disabled = false; t.textContent = 'Try again'; }); return; }
    if (t.id === 'auth-switch') {
      var toToken = $('auth-token-block').classList.contains('hidden');
      $('auth-token-block').classList.toggle('hidden', !toToken);
      $('auth-code-block').classList.toggle('hidden', toToken);
      t.textContent = toToken ? 'Use a sign-in code instead' : 'Use the pairing token instead';
      (toToken ? $('auth-token') : $('auth-code')).focus();
      return;
    }
    if (t.id === 'auth-token-show') {
      // A stale or partial paste is invisible in a password field; let the person look.
      var shown = $('auth-token').type === 'text';
      $('auth-token').type = shown ? 'password' : 'text';
      t.textContent = shown ? 'Show token' : 'Hide token';
      t.setAttribute('aria-pressed', shown ? 'false' : 'true');
      return;
    }
    if (t.id === 'device-code-btn') return showDeviceCode();
    if (t.id === 'ask-close') return closeAsk();
    if (t.id === 'sign-out') { api('/api/web-session/logout', { method: 'POST' }).finally(function () { showAuth(); }); return; }
    if (t.id === 'copy-link') {
      var link = state.tailnetUrl || location.origin + '/control';
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(function () { toast('Link copied'); }, function () { toast(link); });
      else toast(link);
      return;
    }
    if (t.hasAttribute('data-open-ask')) return openAsk();
    if (t.hasAttribute('data-today')) return t.getAttribute('data-today') === 'pet' ? petTap(t) : openTodayAction(t);
    if (t.hasAttribute('data-today-next')) return prepNext();
    if (t.hasAttribute('data-next-prep')) return toggleNextPrep(t.getAttribute('data-next-prep'));
    if (t.hasAttribute('data-next-prep-cancel')) return closeNextPrep(true);
    if (t.hasAttribute('data-next-prep-remove')) return removeNextPrepFile(t.getAttribute('data-next-prep-remove'));
    if (t.hasAttribute('data-today-needs')) {
      var which = t.getAttribute('data-today-needs');
      if (which === 'all') TODAY.showAllNeeds = true;
      else if (which === 'later') TODAY.showLater = true;
      else { TODAY.extraAt = 0; return loadToday(); }
      return paintNeeds();
    }
    if (t.hasAttribute('data-theme-choice')) { window.CosTheme.set(t.getAttribute('data-theme-choice')); paintAppearance(); return; }
    if (t.hasAttribute('data-goto') || t.hasAttribute('data-pane')) {
      if (inSheet) closeAsk(); closeMenu();
      // "work/sort" is a pane and its arguments, not one name.
      var dest = String(t.getAttribute('data-goto') || t.getAttribute('data-pane')).split('/');
      return go(dest[0], dest.slice(1));
    }
    if (t.hasAttribute('data-session')) { if (inSheet) closeAsk(); var p = t.getAttribute('data-session').split('|'); return go('sessions', [p[0], p.slice(1).join('|')]); }
    if (t.hasAttribute('data-meeting')) { var m = t.getAttribute('data-meeting').split('|'); return go('meetings', m); }
    if (t.hasAttribute('data-speakers')) return go('speakers', [t.getAttribute('data-speakers')]);
    var action = t.getAttribute('data-action');
    if (action === 'fork-session') return sendSessionTurn(true);
    if (action === 'run-job-stop') return stopRunJob(t);
    if (action === 'conn-retry') return connRetry(true);
    if (action === 'conn-hide-signin') { CONN.hideFor = signinEndsAt(); return connPaint(); }
    if (action === 'approve-on-phone') return approveOnPhone();
    if (action === 'send-anyway') { var rev = state.reading && state.reading.sendAnyway; if (state.reading) state.reading.sendAnyway = null; return sendSessionTurn(false, { acknowledgedRevision: rev }); }
    if (action === 'stop-session') return stopSession();
    if (action === 'drop-after') return dropHeld();
    if (action === 'unqueue') return removeQueued(t.getAttribute('data-turn-key'));
    if (action === 'revoke-all') {
      if (t.getAttribute('data-armed') !== '1') { t.setAttribute('data-armed', '1'); t.querySelector('.grow').firstChild.textContent = 'Tap again to sign out every browser'; return; }
      api('/api/web-session/revoke-all', { method: 'POST', body: {} }).then(function () { showAuth('Every browser is signed out, this one too.'); }).catch(function (err) { setStatus($('settings-status'), err.message, true); });
      return;
    }
    if (action === 'expand-turn') { var tr = document.querySelector('.turn[data-turn="' + t.getAttribute('data-turn') + '"]'); if (tr) tr.classList.remove('clamped'); t.remove(); return; }
    var q = $('ask-q').value.trim();
    if ((action === 'att-remove' || action === 'att-retry') && t.closest('#session-form') && state.reading) {
      var kitR = readerKit(), boxR = kitR && readerBox(state.reading); if (!boxR) return;
      sessionStatus('');
      if (action === 'att-remove') kitR.remove(boxR, t.getAttribute('data-att')); else kitR.retry(boxR, t.getAttribute('data-att'));
      return;
    }
    if (inSheet && (action === 'att-remove' || action === 'att-retry') && ASK_FILES) {
      var kitA = askKit(); setStatus($('ask-status'), '');
      if (action === 'att-remove') kitA.remove(ASK_FILES, t.getAttribute('data-att')); else kitA.retry(ASK_FILES, t.getAttribute('data-att'));
      return;
    }
    if (action === 'ask-cos' && q) return askSheetSend(q);
    if (action === 'ask-file' && q) return fileToInbox(q);
    if (action === 'ask-meaning' && q) { $('ask-hits').innerHTML = skeletonRows(3); findByMeaning(q).then(function (html) { var el = $('ask-hits'); if (el) el.innerHTML = html; }); return; }
    if (action === 'meaning-consent') { meaningChoose(t.getAttribute('data-provider'), t.getAttribute('data-choice')); if (q) { $('ask-hits').innerHTML = skeletonRows(3); findByMeaning(q).then(function (html) { var el = $('ask-hits'); if (el) el.innerHTML = html; }); } return; }
    if (action === 'ask-work' && q) {
      closeAsk(); go('work');
      // The Work pane (panes/work.js) owns its search box; hand it the query.
      ensurePane('work').then(function () { if (PANES.work && PANES.work.search) PANES.work.search(q); }, function () {});
    }
  });

  document.addEventListener('submit', function (e) {
    var f = e.target;
    e.preventDefault();
    if (f.id === 'auth-form') {
      var usingToken = !$('auth-token-block').classList.contains('hidden');
      var value = (usingToken ? $('auth-token') : $('auth-code')).value.trim();
      if (!value) return;
      var body = usingToken ? { token: value } : { code: value };
      api('/api/web-session/login', { method: 'POST', body: body }).then(function (d) { $('auth-token').value = ''; $('auth-code').value = ''; showShell(d); })
        .catch(function (err) {
          // The server names what failed (wrong token, wrong code, the glasses code, lockout).
          // No status means the request never reached COS (the browser's own "Load failed").
          showAuth(err && err.status ? err.message : UNREACHABLE_COPY);
        });
    } else if (f.id === 'session-form') sendSessionTurn(false);
    else if (f.id === 'today-ask') sendTodayAsk();
    else if (f.hasAttribute && f.hasAttribute('data-next-prep-form')) startNextPrep();
    else if (f.id === 'sessions-search-form') { $('sessions-q').blur(); searchSessions(); }
    else if (f.id === 'ask-form') {
      var hits = $('ask-hits'); if (hits && $('ask-q').value.trim().length >= 2) renderAsk();
    }
  });

  // The Ask sheet's clip, a pasted screenshot in its box, and files dropped on it (askFiles above).
  document.addEventListener('change', function (e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-ask-file')) { addAskFiles(e.target.files); e.target.value = ''; }
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-sx-file')) { addReaderFiles(e.target.files); e.target.value = ''; }
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-next-prep-file')) { addNextPrepFiles(e.target.files); e.target.value = ''; }
  });
  // The Sessions reader's box: a pasted screenshot, and files dropped on it.
  document.addEventListener('paste', function (e) {
    if (!e.target || e.target.id !== 'session-input') return;
    var kit = readerKit(), files = kit && readerFilesOn() ? kit.pasted(e) : null;
    if (files) { e.preventDefault(); addReaderFiles(files); }
  });
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var form = e.target && e.target.closest ? e.target.closest('#session-form') : null, kit = readerKit();
      if (!form || !kit || !readerFilesOn()) return;
      var files = kit.dragged(e, form); if (files) addReaderFiles(files);
    });
  });
  document.addEventListener('paste', function (e) {
    if (!e.target || e.target.id !== 'ask-q') return;
    var kit = askKit(), files = kit && kit.askOn() ? kit.pasted(e) : null;
    if (files) { e.preventDefault(); addAskFiles(files); }
  });
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (type) {
    var sheet = $('ask-sheet'); if (!sheet) return;
    sheet.addEventListener(type, function (e) {
      var kit = askKit(), zone = sheet.querySelector('.sheet'); if (!kit || !zone || !kit.askOn()) return;
      var files = kit.dragged(e, zone); if (files) addAskFiles(files);
    });
  });
  document.addEventListener('input', function (e) {
    if (e.target.tagName === 'TEXTAREA') autoGrow(e.target);
    if (e.target.id === 'ask-q') renderAsk();
    if (e.target.hasAttribute && e.target.hasAttribute('data-next-prep-steer')) nextPrepInput(e.target);
    if (e.target.id === 'sessions-q' && !e.target.value.trim()) renderSessionGroups(state.sessions);
  });
  document.addEventListener('keydown', function (e) {
    if (window.COSWeb.readerMedia && window.COSWeb.readerMedia.isOpen()) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openAsk(); return; }
    if (e.key === 'Escape' && !$('ask-sheet').classList.contains('hidden')) { closeAsk(); return; }
    if (e.key === 'Escape' && !$('section-menu').classList.contains('hidden')) { closeMenu(); $('section-btn').focus(); return; }
    if (e.key === 'Escape' && NEXT_PREP.open && closeNextPrep(false)) { e.preventDefault(); return; }
    if (returnSends(e)) { e.preventDefault(); var form = e.target.closest('form'); if (form) form.requestSubmit(); }
  });
  document.querySelectorAll('[data-mode]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.sessionsMode = b.getAttribute('data-mode');
      document.querySelectorAll('[data-mode]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      if ($('sessions-q').value.trim().length >= 2) searchSessions();
    });
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('scroll', onScroll, { passive: true });
  // 6.99.30: back from the browser's back-forward cache (a swipe back, the app switcher) the open reader's live stream
  // is closed and the page's last reading is however old the visit was. Open the stream again and read the turns.
  window.addEventListener('pageshow', function (e) {
    if (!e || !e.persisted) return;
    liveResume();   // 7.0.1: re-read the list now, then resume the live stream from its last id
    var r = state.reading;
    if (r && r.provider && r.id) {
      if (state.stream) { try { state.stream.close(); } catch (_e) {} state.stream = null; }
      watchSession(r.provider, r.id); refreshTurns(r.provider, r.id);
    }
    if (state.pane === 'today' && !$('app-shell').classList.contains('hidden')) loadToday();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { liveHide(); return; }
    if ($('app-shell').classList.contains('hidden')) return;
    liveResume();   // 7.0.1: re-read the list now, then resume the live stream from its last id
    // Coming back to the page refreshes Today in place. Other panes keep what is on screen:
    // rebuilding them here moved the page under Miles's finger ("it reloads the section").
    if (state.pane === 'today' && Date.now() - (state.lastLoad.today || 0) > 60000) { state.lastLoad.today = Date.now(); loadToday(); }
    // Back within the minute: Today keeps its data, but the pet's loop stopped while hidden, so restart it.
    else if (state.pane === 'today' && PET.pose && !PET.timer) renderPet(state.sessions || []);
  });
  // 7.0.1: back on the network, the same as coming back to the page.
  window.addEventListener('online', function () { if (!document.hidden) liveResume(); });
  // 7.0.1: Today's Refresh (todayRefresh).
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-today-refresh]');
    if (!b) return;
    e.preventDefault();
    todayRefresh();
  });
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin) return;
    var d = e.data;
    if (d && d.type === 'cos-control-nav' && d.op === 'open.section' && d.args && d.args.section) {
      var target = String(d.args.section).toLowerCase();
      if (ROOT_PANES.indexOf(target) >= 0) go(target);
    }
  });

  // ── boot ────────────────────────────────────────────────
  // Copy that tells the truth: a plain-http tailnet page is not a secure context, so
  // navigator.clipboard is missing there. Fall back to a selected textarea, and reject when both
  // fail so no toast claims a copy that did not happen.
  function copyText(text) {
    return new Promise(function (resolve, reject) {
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = String(text == null ? '' : text);
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, ta.value.length);
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (_e) { ok = false; }
        document.body.removeChild(ta);
        if (ok) resolve(); else reject(new Error('This browser would not copy. Select the text and copy it yourself.'));
      }
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) navigator.clipboard.writeText(String(text)).then(resolve, fallback);
      else fallback();
    });
  }

  // ── the visible viewport, read one way (6.99.30) ──────
  // Today's session sheet (panes/today-actions.js) and the question card's footer on Today (panes/questions.js) both
  // place things above whatever covers the bottom of the page: an on-screen keyboard, a hardware keyboard's strip, or a
  // browser's own bottom bar (Comet, Chrome, Safari's, whichever: nothing here knows any browser's bar). Only what the
  // browser reports is used: window.visualViewport's height, offsetTop and scale against the layout viewport.
  //   layoutH  the layout viewport's height. Read whenever the page is not pinch-zoomed (then innerHeight is the layout
  //            viewport everywhere) and kept while it is, since some browsers report the zoomed size there.
  //   inset    what covers the bottom, in unzoomed CSS px: layoutH less the visible height times the zoom. A pinch
  //            zoom alone is no inset (half the height at 2x is all of the page).
  //   top, height  the box to fill, in layout px. Unzoomed it is the visible viewport itself (offsetTop is where a
  //            browser panned the page to keep a focused field in view). Zoomed it is the layout viewport less the
  //            inset, so a pinch zoom magnifies the sheet instead of shrinking its layout into the zoomed window.
  //   below    what of the layout viewport lies under that box: the backdrop alone reaches down over it.
  // No visualViewport (old browsers): the whole layout viewport, nothing covered.
  // 7.0.2 (A3, the Duo audit): some web views shrink innerHeight itself while the keyboard is up (WKWebView in Comet or
  // Chrome on iOS may), and re-reading it then measured a covered area of 0, so no keyboard was ever seen. So on a touch
  // screen, while a field that types has focus, layoutH is the tallest unzoomed innerHeight seen at this width (so this
  // orientation): the keyboard is the same inset whether the browser shrinks visualViewport only or the whole web view.
  //   - It never goes past the last height read with no field focused (free) plus VP_SLACK_PX, so a browser bar that
  //     comes back while typing is never an 80 px keyboard (QA W1). It never goes under innerHeight itself.
  //   - It starts, on focus, from free: the full height, never a height read while a keyboard was still closing. For
  //     VP_SETTLE_MS after a blur, free only grows (QA W2).
  //   - With no field focused, or on a fine pointer (a Mac window resized or DevTools docked while typing, QA N3), it
  //     follows innerHeight exactly as before 7.0.2. A select is not typing: its picker never counts as a keyboard.
  //   - A new width (a turn) starts over. Pinch zoom keeps the height read before the zoom.
  //   dock     the CURRENT layout viewport under the visible box (innerHeight less top and height): what a sticky or
  //            fixed composer clears to sit above the keyboard. 0 when the web view itself shrank.
  var VP = { layoutH: 0 };
  VP.maxH = 0; VP.w = -1; VP.free = 0; VP.typing = false; VP.blurAt = 0;
  var VP_SLACK_PX = 20, VP_SETTLE_MS = 1000;
  function vpTyping() {
    var a = document.activeElement;
    if (!a || !a.tagName) return false;
    var tag = String(a.tagName).toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return !/^(checkbox|radio|button|submit|reset|range|color|file|image|hidden)$/i.test(String(a.type || 'text'));
    return !!a.isContentEditable;
  }
  function viewportFit() {
    var vv = window.visualViewport, de = document.documentElement;
    var inner = window.innerHeight || (de && de.clientHeight) || 0;
    var scale = vv && vv.scale > 0 ? vv.scale : 1, zoomed = scale > 1.01;
    // A turn always changes the width. The orientation type is not read: an engine that derives it from the viewport's
    // aspect flips it when the keyboard shrinks a web view wider than it is then tall (WebKit, 382x266), which would
    // throw away the very height the keyboard is measured against.
    var w = window.innerWidth || 0;
    if (w !== VP.w) { VP.w = w; VP.maxH = 0; VP.free = 0; }
    if (!zoomed) {
      var coarse = !window.matchMedia || !!window.matchMedia('(any-pointer: coarse)').matches;
      var typing = coarse && vpTyping(), now = Date.now();
      if (!typing) {
        if (VP.typing) VP.blurAt = now;
        VP.free = VP.free && now - VP.blurAt < VP_SETTLE_MS ? Math.max(VP.free, inner) : inner;
        VP.maxH = inner;
        VP.layoutH = inner;
      } else {
        if (!VP.free) VP.free = inner;
        VP.maxH = Math.max(VP.typing ? VP.maxH : VP.free, inner);
        VP.layoutH = Math.max(inner, Math.min(VP.maxH, VP.free + VP_SLACK_PX));
      }
      VP.typing = typing;
    }
    else if (!VP.layoutH) VP.layoutH = Math.max(inner, (de && de.clientHeight) || 0);
    var H = VP.layoutH;
    if (!vv || !(vv.height > 0)) return { layoutH: H, top: 0, height: H, inset: 0, below: 0, dock: 0, scale: 1, zoomed: false, vv: false };
    var inset = Math.max(0, Math.round(H - vv.height * scale));
    var top, height;
    if (!zoomed) { top = Math.max(0, Math.round(vv.offsetTop || 0)); height = Math.min(Math.round(vv.height), H); }
    else { height = H - inset; top = Math.min(Math.max(0, Math.round(vv.offsetTop || 0)), inset); }
    if (top + height > H) top = Math.max(0, H - height);
    var below = Math.max(0, H - top - height);
    return { layoutH: H, top: top, height: height, inset: inset, below: below, dock: zoomed ? below : Math.max(0, Math.round(inner) - top - height), scale: scale, zoomed: zoomed, vv: true };
  }

  // ── layout breadcrumbs (6.99.30) ──────────────────────
  // When a sheet lands wrong on a phone nobody here holds, the numbers have to come back on their own. A breadcrumb
  // goes to the server's existing client diagnostics log (POST /api/diag/client, routes/diag.ts: 10 MB with one
  // rotation, 30 lines per 10 s per client) when an overlay opens and each time its keyboard state changes. Numbers and
  // a browser family only: no address, no text, no ids, never the user agent string itself. At most one identical
  // line per 2 s and LAYOUT_CRUMB_MAX a page load, fire and forget.
  // 7.0.2 (A1): every pane reports now (focus, keyboard open and close, the gap after it closes), so the cap is 80 a
  // page load, in two budgets: focus lines have LAYOUT_FOCUS_MAX of them, everything else the rest, so a page of typing
  // never starves the keyboard reports (QA W3). At most LAYOUT_CRUMB_RATE leave in any 10 s, under the server's 30
  // (routes/diag.ts), and a focus line only while that window is under half full.
  var LAYOUT_CRUMB_MAX = 80, LAYOUT_FOCUS_MAX = 20, LAYOUT_CRUMB_GAP_MS = 2000, LAYOUT_CRUMB_RATE = 20, LAYOUT_CRUMB_WINDOW_MS = 10000;
  var crumbs = { sent: 0, focus: 0, last: '', lastAt: 0, recent: [] };
  /** The browser family, from the UA string, for the breadcrumb. Comet first: it says Chrome or Safari too. */
  function uaClass(ua) {
    ua = String(ua == null ? (navigator && navigator.userAgent) || '' : ua);
    var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
    var android = /Android/.test(ua);
    var os = ios ? 'ios' : android ? 'android' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : /Linux|CrOS/.test(ua) ? 'linux' : 'other';
    var hints = typeof navigator !== 'undefined' && navigator.userAgentData && navigator.userAgentData.brands ? navigator.userAgentData.brands.map(function (b) { return b && b.brand; }).join(' ') : '';
    var brand = /Comet\//i.test(ua) || /\bComet\b/i.test(ua) || /\bComet\b/i.test(hints) ? 'comet'
      : /CriOS\//.test(ua) ? 'crios' : /FxiOS\//.test(ua) ? 'firefox' : /EdgiOS\/|Edg\//.test(ua) ? 'edge'
      : /Firefox\//.test(ua) ? 'firefox' : /Chrome\/|Chromium\//.test(ua) ? 'chrome'
      : /Safari\//.test(ua) ? 'safari' : 'other';
    return { os: os, brand: brand };
  }
  /** One breadcrumb: `event` (open, kb), the viewport as the browser reports it, and the overlay's own state. */
  function layoutCrumb(event, extra) {
    try {
      var vv = window.visualViewport, de = document.documentElement, ua = uaClass();
      var r = function (n) { return typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null; };
      var o = (screen && screen.orientation && screen.orientation.type) || (typeof window.orientation === 'number' ? 'deg' + window.orientation : '');
      var data = { what: String(event || ''), ua: ua.brand, os: ua.os, iw: r(window.innerWidth), ih: r(window.innerHeight), ch: r(de && de.clientHeight),
        vvh: vv ? r(vv.height) : null, vvw: vv ? r(vv.width) : null, vvt: vv ? r(vv.offsetTop) : null, vvs: vv ? r(vv.scale) : null,
        orient: String(o).slice(0, 24), coarse: !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) };
      var x = extra || {};
      Object.keys(x).forEach(function (k) { var v = x[k]; if (/^[a-z][a-zA-Z0-9]{0,15}$/.test(k) && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 24))) data[k] = typeof v === 'number' ? r(v) : v; });
      var key = JSON.stringify(data), now = Date.now();
      var focusLine = data.what === 'focus';
      if (focusLine ? crumbs.focus >= LAYOUT_FOCUS_MAX : crumbs.sent - crumbs.focus >= LAYOUT_CRUMB_MAX - LAYOUT_FOCUS_MAX) return false;
      if (key === crumbs.last && now - crumbs.lastAt < LAYOUT_CRUMB_GAP_MS) return false;
      crumbs.recent = crumbs.recent.filter(function (t) { return now - t < LAYOUT_CRUMB_WINDOW_MS; });
      if (crumbs.recent.length >= (focusLine ? LAYOUT_CRUMB_RATE / 2 : LAYOUT_CRUMB_RATE)) return false;
      crumbs.sent++; if (focusLine) crumbs.focus++;
      crumbs.last = key; crumbs.lastAt = now; crumbs.recent.push(now);
      api('/api/diag/client', { method: 'POST', body: { ts: now, level: 'info', event: 'web.layout', data: data }, timeoutMs: 5000 }).catch(function () {});
      return true;
    } catch (_e) { return false; }
  }

  // ── the shared kit for pane modules (panes/*.js) ───────
  window.COSWeb = {
    $: $, esc: esc, md: md, plain: plain, structureLensAnswer: structureLensAnswer, tableFit: tableFit, api: api, toast: toast, ago: ago, clock: clock, toDate: toDate,
    plural: plural, countWord: countWord, dayWord: dayWord, plainDay: plainDay, providerLabel: providerLabel, domainLabel: domainLabel,
    skeletonRows: skeletonRows, emptyBox: emptyBox, setStatus: setStatus, autoGrow: autoGrow,
    readStore: readStore, writeStore: writeStore, copyText: copyText, isPhone: isPhone,
    state: state, titles: TITLES, go: go, parseRoute: parseRoute, goBack: goBack,
    registerPane: function (name, def) { PANES[name] = def; },
    sessionList: sessionList,
    petPrefs: petPrefs,
    setPetPrefs: setPetPrefs,
    resetTodayBrief: resetBrief,
    onRoute: function (fn) { routeHooks.push(fn); },
    onShell: function (fn) { shellHooks.push(fn); },
    // The detail title after "COS Control > Section" (Control's breadcrumb). Pane modules set it
    // once a detail has loaded; route() clears it on every navigation.
    setCrumb: function (text) { crumbDetail = String(text || ''); runHooks(routeHooks, parseRoute()); },
    crumb: function () { return crumbDetail; },
    // Panes that read with their own fetch call this on a 401 so the sign-in screen shows.
    showAuth: function (message) { showAuth(message); },
    // Control's session state (the Sessions pane's sxState) and warm-up test, so the rail's
    // "N waiting on you, N working" counts exactly what the pane lists.
    sessionState: function (s) { return sxState(s); },
    isKeepWarm: function (s) { return sxKeepWarm(s); },
    // 6.99.30: the visible viewport read one way, layout breadcrumbs, the one unreachable sentence, Return-sends.
    viewportFit: viewportFit, layoutCrumb: layoutCrumb, uaClass: uaClass, unreachableCopy: UNREACHABLE_COPY, keyboardFirst: keyboardFirst,
    serverUp: function () { return SERVER.up; },
    // Panes with their own fetch (the questions poll) say whether the Mac answered, so a "down" mark never outlives it.
    noteServer: function (up) { noteServer(up); },
    onServer: function (fn) { SERVER.hooks.push(fn); },
    // Duo tables: the resizable divider between a list and its reader (splitKit above), for panes/*.js.
    splitKit: { mount: mountSplit, handle: splitHandleHtml, fullButton: splitFullButton },
    // 7.0.1: the one live stream (docs/live-events-contract.md). mode(): idle, connecting, live, reconnecting, busy or
    // absent. on(fn) hears each applied frame ({ kind, key, session, previous }). session(provider, id): the live
    // record, or null. age(): "As of 2 min ago" when the counts are not live, else ''.
    live: {
      mode: function () { return LIVE.mode; },
      on: function (fn) { if (typeof fn === 'function') LIVE.hooks.push(fn); },
      session: function (provider, id) {
        if (!liveCanOverlay()) return null;   // outside live the list is the truth (review W1)
        var byKey = {};
        Object.keys(LIVE.sessions).forEach(function (k) { var ls = LIVE.sessions[k]; byKey[liveKey(ls.provider, ls.sessionId)] = ls; });
        var j = liveMatch(liveKey(provider, id), Object.keys(byKey));
        return j ? byKey[j] : null;
      },
      age: function () { return liveAge(); },
      clock: liveClock
    }
  };
  // Today as a place to act (panes/today-actions.js, Miles 11/06): what the Today cards show, a repaint after a
  // decision, and the Sessions reader's own pieces, so the overlay sends and reads through the reader's code.
  window.COSWeb.pane = function (name) { return PANES[name] || null; };
  // Tap, then tap again (Today's Dismiss, Stop and Send anyway; a question card's Allow, Deny and Send): the second tap
  // counts only once the first has been on screen ARM_CONFIRM_MS, so a double tap or a finger bounce arms and never
  // confirms (W2-r2). The one rule both panes/today-actions.js and panes/questions.js read.
  var ARM_CONFIRM_MS = 400;
  window.COSWeb.armConfirmMs = ARM_CONFIRM_MS;
  window.COSWeb.confirmReady = function (armedAt) { return typeof armedAt === 'number' && Date.now() - armedAt >= ARM_CONFIRM_MS; };
  window.COSWeb.today = {
    data: function () {
      return { needs: TODAY.needs, working: TODAY.working, open: TODAY.open, welcome: TODAY.welcome, offline: TODAY.offline, at: TODAY.at,
        sessions: state.sessions || [], intake: todayIntakeOpen(), intakeCaps: TODAY.intakeCaps, intakeLoaded: TODAY.intake !== null };
    },
    needWhy: needWhy, sessionTitle: sessionTitle, badge: badge, span: span, splitSessionId: splitSessionId,
    // Needs you as Today lists it (all four sources), for the overlay's summary and the rail.
    needs: function () { return TODAY.model; },
    railLine: function () { return TODAY.model ? { text: todayRailLine(TODAY.model), hot: TODAY.model.now.length > 0 } : null; },
    markGone: function (id, gone) { if (gone) TODAY.gone[id] = 1; else delete TODAY.gone[id]; paintTodayIntake(); },
    reloadIntake: function () { return loadTodayIntake(); },
    refresh: function () { if (state.pane === 'today') loadToday(); },
    // 6.99.26: the pet's sessions (petPlay), and a repaint of Needs you when the held questions change.
    petPlay: function () { return petPlay(state.sessions || []); },
    // 6.99.27: the pet's caption and pose follow the held questions too.
    questionsChanged: function () { if (TODAY.at) { paintNeeds(); if (state.pane === 'today' && !TODAY.offline) renderPet(state.sessions || []); } }
  };
  window.COSWeb.sessionKit = {
    phoneOffer: paintWebKeyOffer, approvePhone: approveOnPhone,
    // A session object for continueSession, with the overlay's own view (READER_VIEW's methods).
    session: function (provider, id, view) {
      return { provider: provider, id: id, draft: null, held: [], view: view, verdict: null, refusal: null, cautionAck: false, feed: newFeed(), live: null, queued: 0 };
    },
    send: function (r, text, opts) { return continueSession(r, text, opts || {}); },
    newKey: newTurnKey,
    probe: function (r) { return sxProbeAttach(r); },
    path: sessionPath, answer: apiAnswer,
    notSent: { rows: notSentRows, line: notSentLine, label: notSentLabel, note: noteNotSent, get: notSentFor },
    imageHtml: readerImagesHtml, imagesMount: readerImagesMount, imagesStop: readerImagesStop, linksAttr: function (t) { return sxMd.linksAttr(t); },
    feed: { fresh: newFeed, apply: applyFeed, word: sxFeedWord, detail: sxFeedDetail, tool: sxToolLine, elapsed: sxElapsed, fallback: sxFallbackLine,
      truth: sxTruth, settle: sxSettle, noteList: sxNoteList, noteGate: sxNoteGate, gateStale: sxGateStale, promptLine: sxPromptLine, parkNoteShows: sxParkNoteShows },
    title: sxTitle, stateOf: sxState, stateLabel: function (s) { return sxStateLabel(s, sxState(s)); },
    parkCopy: function (p, r, hasFiles) { return r ? sxParkLine(r, hasFiles) : SX_PARK[sxProvider(p)]; }, providerLabel: sxProviderLabel, markdown: sxMd
  };

  // ── layout reports and the visible box, every pane (7.0.2) ──
  // The Duo audit (11/07): only Today's session sheet ever sent a layout report, and only when its classes flipped, so
  // the COS chat composer, the front screen Miles types on most, never sent one, and a keyboard the code failed to see
  // sent nothing at all. Now, through layoutCrumb (numbers and fixed labels only, never text or ids):
  //   device     once per page load, after sign-in: the screen, the pixel ratio, safe areas, pointer kind
  //   focus      a field that types gets focus, on any pane, on a touch screen: its computed font size, the scroll
  //              position and range, and innerWidth against scrollWidth, as scw (zoom vs pan vs a wider page)
  //   kb-open, kb-close  EVERY keyboard open and close, numbered, so a repeat is never dropped as a duplicate; with
  //              innerHeight against the layout height (shrank: the web view itself got shorter)
  //   kb-after   KB_AFTER_MS after a close: the gap below the composer that had the keyboard, scrollY against its
  //              range, and 100dvh, 100svh and 100lvh in px; measured before and after the panes settle
  // The same pass publishes the visible box for CSS on <html>: --vv-top, --vv-h, --vv-below (the layout viewport under
  // the visible box, viewportFit's dock) and html.kb-up while an on-screen keyboard is up (KB_UP_PX or more covered
  // with a typing field focused). Panes hear open, close, move (the visible box changed while it is up) and after
  // through COSWeb.onKeyboard; COSWeb.keyboardUp says whether it is up now. Which composer the keyboard is for is the
  // pane's to mark (panes/cos-chat.js sets html.kb-chat and .cc-kb).
  var KB_UP_PX = 120, KB_AFTER_MS = 300;
  var LR = { up: false, frame: 0, after: 0, cycle: 0, focusN: 0, device: false, field: null, hooks: [], box: '' };
  function lrPane() { var r = parseRoute(); return String(r.pane + (r.args[0] === 'cos' ? '.cos' : '')).slice(0, 24); }
  function lrKind(a) {
    var tag = String((a && a.tagName) || '').toLowerCase();
    return (tag === 'input' ? 'input.' + String(a.type || 'text').toLowerCase() : tag || 'other').slice(0, 24);
  }
  function lrScroll() {
    var se = document.scrollingElement || document.documentElement;
    var sy = Math.round(window.scrollY || window.pageYOffset || 0);
    var smax = se ? Math.max(0, Math.round((se.scrollHeight || 0) - (window.innerHeight || se.clientHeight || 0))) : 0;
    return { sy: sy, smax: smax, sw: se ? Math.round(se.scrollWidth || 0) : 0 };
  }
  // One hidden element, measured and removed: its height (h) or a computed padding in px. Null where it cannot be read.
  function lrProbe(css, prop) {
    var b = document.body;
    if (!b || !document.createElement) return null;
    var el = document.createElement('div'), v = null;
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:0;top:0;width:1px;visibility:hidden;pointer-events:none;' + css;
    b.appendChild(el);
    try { v = prop === 'h' ? el.offsetHeight : parseFloat(getComputedStyle(el)[prop]); } catch (_e) { v = null; }
    b.removeChild(el);
    return typeof v === 'number' && isFinite(v) ? v : null;
  }
  function lrMatch(q) { try { return !!window.matchMedia(q).matches; } catch (_e) { return false; } }
  function lrDevice() {
    if (LR.device) return;
    LR.device = true;
    var sc = window.screen || {};
    layoutCrumb('device', { sw: sc.width, sh: sc.height, sah: sc.availHeight, oh: window.outerHeight, ow: window.outerWidth, dpr: window.devicePixelRatio,
      sat: lrProbe('padding-top:env(safe-area-inset-top)', 'paddingTop'), sab: lrProbe('padding-bottom:env(safe-area-inset-bottom)', 'paddingBottom'),
      anyCoarse: lrMatch('(any-pointer: coarse)'), shortTouch: lrMatch(SHORT_TOUCH_MQ), phone: isPhone() });
  }
  // The focus line is for touch screens only (QA W3): on a Mac it would only spend the budget.
  function lrFocus() {
    if (!vpTyping()) return;
    var a = document.activeElement, fs = null;
    LR.field = a;
    if (!lrMatch('(pointer: coarse)')) return;
    try { fs = parseFloat(getComputedStyle(a).fontSize); } catch (_e) { fs = null; }
    var s = lrScroll();
    layoutCrumb('focus', { pane: lrPane(), field: lrKind(a), fs: fs, sy: s.sy, smax: s.smax, scw: s.sw, kb: LR.up, n: ++LR.focusN });
  }
  function lrHooks(what, v) { LR.hooks.forEach(function (fn) { try { fn(what, v); } catch (err) { console.error(err); } }); }
  function lrGap(v) {
    var f = LR.field, box = f && f.closest ? (f.closest('form') || f) : f;
    if (!box || box.isConnected === false || !box.getBoundingClientRect) return null;
    return Math.round(v.top + v.height - box.getBoundingClientRect().bottom);
  }
  function lrAfter() {
    LR.after = 0;
    if (LR.up) return;
    var v = viewportFit(), s = lrScroll(), gap = lrGap(v);
    lrHooks('after', v);
    var s2 = lrScroll();
    layoutCrumb('kb-after', { pane: lrPane(), n: LR.cycle, gap: gap, sy: s.sy, smax: s.smax, over: s.sy > s.smax, gapNow: lrGap(viewportFit()), syNow: s2.sy,
      dvh: lrProbe('height:100dvh', 'h'), svh: lrProbe('height:100svh', 'h'), lvh: lrProbe('height:100lvh', 'h'), lh: v.layoutH });
  }
  function lrApply() {
    LR.frame = 0;
    var v = viewportFit(), de = document.documentElement;
    // Written only when they change: a pinch or pan fires this every frame, and each write restyles the page.
    var box = v.top + '|' + v.height + '|' + v.dock, moved = box !== LR.box;
    if (moved && de && de.style && de.style.setProperty) {
      LR.box = box;
      de.style.setProperty('--vv-top', v.top + 'px'); de.style.setProperty('--vv-h', v.height + 'px'); de.style.setProperty('--vv-below', v.dock + 'px');
    }
    var up = !!(v.vv && v.inset >= KB_UP_PX && vpTyping());
    if (de && de.classList) de.classList.toggle('kb-up', up);
    if (up === LR.up) { if (up && moved) lrHooks('move', v); return v; }
    LR.up = up; LR.cycle++;
    layoutCrumb(up ? 'kb-open' : 'kb-close', { pane: lrPane(), n: LR.cycle, inset: v.inset, below: v.below, dock: v.dock, lh: v.layoutH, top: v.top, h: v.height,
      zoomed: v.zoomed, shrank: Math.round(window.innerHeight || 0) < v.layoutH });
    if (LR.after) { clearTimeout(LR.after); LR.after = 0; }
    if (!up) LR.after = setTimeout(lrAfter, KB_AFTER_MS);
    lrHooks(up ? 'open' : 'close', v);
    return v;
  }
  function lrFit() {
    if (LR.frame) return;
    if (!window.requestAnimationFrame) { lrApply(); return; }
    LR.frame = window.requestAnimationFrame(lrApply);
  }
  (function lrListen() {
    var vv = window.visualViewport;
    if (vv && vv.addEventListener) { vv.addEventListener('resize', lrFit); vv.addEventListener('scroll', lrFit); }
    window.addEventListener('resize', lrFit); window.addEventListener('orientationchange', lrFit); window.addEventListener('pageshow', lrFit);
    document.addEventListener('focusin', function () { lrFocus(); lrFit(); });
    document.addEventListener('focusout', function () { setTimeout(lrFit, 0); });
    shellHooks.push(function () { lrDevice(); lrFit(); });
  })();
  window.COSWeb.keyboardUp = function () { return LR.up; };
  window.COSWeb.onKeyboard = function (fn) { if (typeof fn === 'function') LR.hooks.push(fn); };
  // ── end layout reports

  // Every pane module is a plain script after this one; boot waits for all of them.
  function boot() {
    var params = new URLSearchParams(location.search);
    var linkCode = params.get('code');
    if (linkCode && !params.get('handoff')) {
      history.replaceState({}, document.title, location.pathname + location.hash);
      api('/api/web-session/login', { method: 'POST', body: { code: linkCode } }).then(showShell)
        .catch(function (err) {
          showAuth(err && err.status ? err.message : UNREACHABLE_COPY);
          var box = $('auth-code'); if (box) box.value = linkCode;
        });
      return;
    }
    var handoff = params.get('handoff');
    if (handoff) {
      history.replaceState({}, document.title, location.pathname + location.hash);
      api('/api/web-session/login', { method: 'POST', body: { handoff: handoff } }).then(showShell)
        .catch(function (err) { showAuth(err && err.status ? err.message : 'That sign-in link did not work. Get a new one from COS Control on your Mac or the COS Glasses app, or use a code or the token.'); });
      return;
    }
    api('/api/web-session/status').then(function (st) { if (st && st.authenticated) showShell(st); else showAuth(); }).catch(function (err) {
      // F23: a Mac that did not answer is not a sign-in problem. Say so, offer Try again, keep the form out of the way.
      if (err && err.status) showAuth(err.message); else { showAuth(); authOffline(true); }
    });
  }
  // The sign-in card's "Your Mac is not answering" state (boot only): the form hides until the Mac answers.
  function authOffline(on) {
    var box = $('auth-offline'), form = $('auth-form');
    if (!box || !form) return;
    box.classList.toggle('hidden', !on); form.classList.toggle('hidden', !!on);
    var title = $('auth-title'), intro = $('auth-intro');
    if (title) title.textContent = on ? 'Your Mac is not answering' : 'Connect this browser';
    if (intro) intro.classList.toggle('hidden', !!on);
    if (on) { var err = $('auth-error'); if (err) { setStatus(err, '', true); err.classList.add('hidden'); } }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
