/* COS Control Web: Meetings, the same pane as Control's (ActivityMeetings.swift MeetingLibraryBody 7-398,
   MeetingMonthCalendar 400-500, MeetingLibraryDetailPane 540-745, LiveNowRows 2110-2209, LiveTranscriptPane 2241-2719;
   ActivityWindow.swift meetingsList and meetingsStats 2232-2287; MeetingAsk.swift LiveAskPanel 1388-1560,
   MeetingSidePanel 2240-2300; LiveTranscript.swift; COSMarkdownParser.swift).
   Data: GET /api/meetings?limit=200&domain=all&month=, /api/meetings/search, /api/meetings/detail,
   /api/meetings/live-chunks, /api/meeting/sessions/:id/status, /api/meeting/orphans, /api/meeting-ask/*,
   /api/live-cues/history, /api/context/status. Writes only on a tap: Meeting Ask, Stop and save, End and save,
   Recover, Save, Save as follow-up.
   Routes: #/meetings, #/meetings/<domain>/<month>/<filename>, #/meetings/live/<sessionId>. */
(function () {
  'use strict';
  var W = window.COSWeb;
  var $ = W.$, esc = W.esc, api = W.api;
  var pane = $('pane-meetings');
  if (!pane) return;

  // ── small helpers ─────────────────────────────────────
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function monthKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
  function dayKey(d) { return monthKey(d) + '-' + pad2(d.getDate()); }
  function parseMonth(m) { var p = /^(\d{4})-(\d{2})$/.exec(m || ''); return p ? new Date(Number(p[1]), Number(p[2]) - 1, 1) : null; }
  function monthTitle(m) { var d = parseMonth(m); return d ? d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : m; }
  function clockOf(d) { return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  // Control's clock.format("21:05"): "9:05 PM" on a 12-hour Mac.
  function fmtTime(t) {
    var m = /^(\d{1,2}):(\d{2})/.exec(t || '');
    return m ? clockOf(new Date(2000, 0, 1, Number(m[1]), Number(m[2]))) : (t || '');
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmtCount(n) { return Number(n || 0).toLocaleString(); }
  function plural(n, one, many) { return n === 1 ? one : many; }
  function cap(s) { return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function icon(name) { return '<svg class="icon"><use href="#i-' + name + '"/></svg>'; }
  function safeId(s) { return String(s || '').replace(/[^A-Za-z0-9_-]/g, '_'); }
  function uuid() {
    // crypto.randomUUID needs a secure context; a plain-http tailnet page is not one.
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function routeArgs() { var r = W.parseRoute(); return r.pane === 'meetings' ? r.args : null; }
  function readDrafts() { try { var v = JSON.parse(localStorage.getItem('cos_web_meeting_ask_drafts') || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_e) { return {}; } }
  function writeDraft(sid, text) {
    try { var all = readDrafts(); if (text) all[sid] = String(text).slice(0, 2000); else delete all[sid]; localStorage.setItem('cos_web_meeting_ask_drafts', JSON.stringify(all)); } catch (_e) {}
  }

  // ── sessions (PhoneMeetingCapture, G2MeetingStop) ─────
  var PHONE_ID = /^phone_(?:[0-9]{13}_)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  var CONTEXT_KEY = /^(?:(?:g2|ff|mac):(?!phone_)[A-Za-z0-9:_-]{3,96}|phone:phone_(?:[0-9]{13}_)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
  function isPhone(id, sourceType) { return String(id || '').indexOf('phone_') === 0 || sourceType === 'iphone_microphone'; }
  function isMac(id) { return String(id || '').indexOf('mac_') === 0; }
  function isGlasses(id) { return !isPhone(id) && !isMac(id) && /^[A-Za-z0-9:_-]{3,96}$/.test(String(id || '')); }
  function askSessionForKey(key) {
    if (!CONTEXT_KEY.test(key || '')) return null;
    var at = key.indexOf(':'), prefix = key.slice(0, at), id = key.slice(at + 1);
    if (prefix === 'phone') return PHONE_ID.test(id) ? id : null;
    if (prefix === 'mac') return /^mac_[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/.test(id) ? id : null;
    if (prefix === 'g2') return /^meeting_[A-Za-z0-9_-]{1,89}$/.test(id) ? id : null;
    return null;
  }
  function captureKey(id) { if (isPhone(id)) return PHONE_ID.test(id) ? 'phone:' + id : ''; return (isMac(id) ? 'mac:' : 'g2:') + id; }
  function contextKeys(keys, row) {
    return (keys || []).filter(function (k) {
      if (typeof k !== 'string' || !CONTEXT_KEY.test(k)) return false;
      if (isPhone(row.sessionId, row.sourceType)) return row.sourceType === 'iphone_microphone' && PHONE_ID.test(row.sessionId) && k === 'phone:' + row.sessionId;
      return k.indexOf('phone:') !== 0;
    });
  }
  // LibraryMeeting.meetingAskSessions(keys:)
  function askSessions(row, keys) {
    var seen = {}, out = [];
    var cands = keys.map(askSessionForKey).filter(Boolean).concat(row.g2SessionIds || []).concat([row.sourceSessionId || row.sessionId || '']);
    cands.forEach(function (id) {
      if (!id || seen[id]) return;
      if (isPhone(row.sessionId, row.sourceType) && !isPhone(id)) return;
      if (isPhone(id)) { if (row.sourceType === 'iphone_microphone' && id === row.sessionId && PHONE_ID.test(id)) { seen[id] = 1; out.push(id); } return; }
      if (askSessionForKey(captureKey(id))) { seen[id] = 1; out.push(id); }
    });
    return out;
  }

  // ── rows (LibraryMeeting) ─────────────────────────────
  function domainLabel(m) {
    if (m.domainAbbr) return m.domainAbbr;
    var name = m.domain === 'imported' ? (m.originDomain || m.domain) : m.domain;
    return name ? cap(name) : '';
  }
  // "2026-11-03 · 9:05 PM · P · 60 minutes · Mac System Audio"
  function subtitle(m) {
    var parts = [];
    if (m.date) parts.push(m.date);
    if (m.time) parts.push(fmtTime(m.time));
    var d = domainLabel(m); if (d) parts.push(d);
    if (m.duration) parts.push(m.duration); else if (num(m.durationMinutes) > 0) parts.push(num(m.durationMinutes) + ' min');
    if (isPhone(m.sessionId, m.sourceType)) parts.push('iPhone Microphone'); else if (m.source) parts.push(m.source);
    return parts.join(' · ');
  }
  function stampOf(m) {
    var day = (m.date && m.date.length >= 10 ? m.date : m.filename || '').slice(0, 10);
    var p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day); if (!p) return null;
    var t = /^(\d{1,2}):(\d{2})/.exec(m.time || '');
    return new Date(Number(p[1]), Number(p[2]) - 1, Number(p[3]), t ? Number(t[1]) : 0, t ? Number(t[2]) : 0).getTime();
  }
  function canReviewVoices(m) { return !!m.sessionId && m.librarySource !== 'imported' && m.derivedKind !== 'split' && !isPhone(m.sessionId, m.sourceType); }
  // MeetingStatusPills: the voice tag the row's own voiceReview carries (Control's voiceTag(for:)).
  function voiceTag(m) {
    var r = m && m.voiceReview; if (!r) return null;
    var un = r.unattributedVoices == null ? null : num(r.unattributedVoices);
    if (un === 0 && r.humanTouched === true) return { cls: 'ok', text: 'REVIEWED' };
    if (un != null && un > 0) return { cls: 'warn', text: un + ' TO NAME' };
    return null;
  }
  function pillsHtml(m, isNew) {
    var out = '';
    if (isNew) out += '<span class="cx-pill warn">NEW</span>';
    var t = voiceTag(m); if (t) out += '<span class="cx-pill ' + t.cls + '">' + esc(t.text) + '</span>';
    return out;
  }
  function matchLabel(m) { return m === 'both' ? 'Keyword + meaning' : m === 'semantic' ? 'Meaning' : 'Keyword'; }

  // ── Markdown (COSMarkdownParser.swift) ────────────────
  // Escape first, then add only our own tags, so server text can never become markup.
  function inline(text) {
    return String(text == null ? '' : text).split(/(`[^`\n]+`)/g).map(function (p, i) {
      if (i % 2 === 1) return '<code>' + esc(p.slice(1, -1)) + '</code>';
      var s = esc(p);
      s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_m, label, url) {
        return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
      });
      s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
      s = s.replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>');
      s = s.replace(/\[([THFW]\d+)\]/g, '<span class="mt-cite">[$1]</span>');
      return s;
    }).join('');
  }
  var MD = (function () {
    function headingLevel(line) { var m = /^(#{1,6})(?: |$)/.exec(line); return m ? m[1].length : 0; }
    function isRule(line) { var c = line.replace(/ /g, ''); return c.length >= 3 && (/^-+$/.test(c) || /^\*+$/.test(c) || /^_+$/.test(c)); }
    function isSep(raw) { var l = raw.trim(); if (l.charAt(0) !== '|') return false; var inner = l.replace(/[|: ]/g, ''); return inner.length > 0 && /^-+$/.test(inner); }
    function cells(line) { var t = line.trim(); if (t.charAt(0) === '|') t = t.slice(1); if (t.slice(-1) === '|') t = t.slice(0, -1); return t.split('|').map(function (c) { return c.trim(); }); }
    function indent(raw) { var n = 0; for (var i = 0; i < raw.length; i++) { var c = raw.charAt(i); if (c === ' ') n++; else if (c === '\t') n += 4; else break; } return n; }
    function bullet(raw) { var t = raw.trim(); if (/^[-*+] /.test(t)) return t.slice(0, 2); if (t === '-' || t === '*') return t; return null; }
    function ordered(line) { var m = /^\d{1,3}[.)]\s+/.exec(line); return m ? m[0] : null; }
    function itemText(raw) {
      var line = raw.trim(), rest, b = bullet(raw);
      if (b) rest = line.slice(b.length);
      else { var o = ordered(line); if (!o) return null; rest = line.slice(o.length); }
      rest = rest.trim();
      if (rest.indexOf('[ ] ') === 0 || rest === '[ ]') return { text: rest.slice(4).trim(), checked: false };
      if (/^\[x\]( |$)/i.test(rest)) return { text: rest.slice(4).trim(), checked: true };
      return { text: rest, checked: null };
    }
    function stripTag(line, open, close) {
      var s = line.toLowerCase().indexOf(open); if (s < 0) return null;
      var inner = line.slice(s + open.length), e = inner.toLowerCase().indexOf(close);
      if (e >= 0) inner = inner.slice(0, e);
      return inner.trim();
    }
    function speakerLines(lines) {
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var m = /^\[([^\]]{1,64})\]:\s?/.exec(lines[i]);
        if (!m) return null;
        out.push({ speaker: m[1], text: lines[i].slice(m[0].length) });
      }
      return out.length ? out : null;
    }
    function parseBlocks(lines) {
      var blocks = [], i = 0, para = [];
      function flush() {
        if (!para.length) return;
        var sp = speakerLines(para);
        blocks.push(sp ? { t: 'speakers', lines: sp } : { t: 'p', text: para.join(' ') });
        para = [];
      }
      while (i < lines.length) {
        var raw = lines[i], line = raw.trim();
        if (!line) { flush(); i++; continue; }
        if (line.indexOf('```') === 0) {
          flush();
          var body = [], j = i + 1;
          while (j < lines.length && lines[j].trim().indexOf('```') !== 0) { body.push(lines[j]); j++; }
          blocks.push({ t: 'code', text: body.join('\n') }); i = Math.min(j + 1, lines.length); continue;
        }
        if (line.toLowerCase().indexOf('<details') === 0) {
          flush();
          var summary = stripTag(line, '<summary>', '</summary>') || 'Details', inner = [], k = i + 1, depth = 1;
          while (k < lines.length) {
            var t = lines[k].trim(), lower = t.toLowerCase();
            if (lower.indexOf('<details') === 0) depth++;
            if (lower.indexOf('</details>') === 0) { depth--; if (depth === 0) break; }
            var s = depth === 1 && lower.indexOf('<summary>') === 0 ? stripTag(t, '<summary>', '</summary>') : null;
            if (s != null) summary = s; else inner.push(lines[k]);
            k++;
          }
          blocks.push({ t: 'details', summary: summary, blocks: parseBlocks(inner) }); i = Math.min(k + 1, lines.length); continue;
        }
        var level = headingLevel(line);
        if (level) {
          flush();
          blocks.push({ t: 'h', level: level, text: line.replace(/^#+/, '').trim().replace(/\s+#+$/, '') }); i++; continue;
        }
        if (isRule(line)) { flush(); blocks.push({ t: 'hr' }); i++; continue; }
        if (line.charAt(0) === '|' && i + 1 < lines.length && isSep(lines[i + 1])) {
          flush();
          var header = cells(line), rows = [], r = i + 2;
          while (r < lines.length && lines[r].trim().charAt(0) === '|') { rows.push(cells(lines[r].trim())); r++; }
          blocks.push({ t: 'table', header: header, rows: rows }); i = r; continue;
        }
        if (line.charAt(0) === '>') {
          flush();
          var q = [], qi = i;
          while (qi < lines.length && lines[qi].trim().charAt(0) === '>') { q.push(lines[qi].trim().slice(1).trim()); qi++; }
          blocks.push({ t: 'quote', blocks: parseBlocks(q) }); i = qi; continue;
        }
        if (bullet(raw) != null || ordered(line) != null) {
          flush();
          var res = parseList(lines, i); blocks.push(res.block); i = res.next; continue;
        }
        para.push(line); i++;
      }
      flush();
      return blocks;
    }
    function parseList(lines, start) {
      var base = indent(lines[start]), isOrdered = ordered(lines[start].trim()) != null, items = [], i = start;
      while (i < lines.length) {
        var raw = lines[i];
        if (!raw.trim()) {
          var j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && indent(lines[j]) === base && itemText(lines[j])) { i = j; continue; }
          break;
        }
        var it = indent(raw) === base ? itemText(raw) : null;
        if (!it) break;
        var children = [], n = i + 1;
        while (n < lines.length) {
          var next = lines[n];
          if (!next.trim()) {
            var k = n + 1; while (k < lines.length && !lines[k].trim()) k++;
            if (k < lines.length && indent(lines[k]) > base) { children.push(''); n++; continue; }
            break;
          }
          if (indent(next) > base) { children.push(next.slice(Math.min(indent(next), base + 2))); n++; continue; }
          break;
        }
        var item = { text: it.text, checked: it.checked, children: [] };
        if (children.length) {
          var nestedHasList = children.some(function (c) { return bullet(c) != null || ordered(c.trim()) != null; });
          parseBlocks(children).forEach(function (b) {
            if (b.t === 'p' && !item.children.length && !nestedHasList) item.text += ' ' + b.text; else item.children.push(b);
          });
        }
        items.push(item); i = n;
      }
      return { block: { t: 'list', ordered: isOrdered, items: items }, next: i };
    }
    function parse(text, dropTitle) {
      var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
      if (dropTitle) {
        for (var i = 0; i < lines.length; i++) { if (lines[i].trim()) { if (lines[i].indexOf('# ') === 0) lines.splice(i, 1); break; } }
      }
      return parseBlocks(lines);
    }
    function looksLikeDocument(text) {
      var lines = String(text || '').split('\n').slice(0, 400);
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (l.charAt(0) === '#' && headingLevel(l)) return true;
        if (l.charAt(0) === '|' && l.slice(-1) === '|' && l.length > 1) return true;
        if (l.indexOf('```') === 0 || l.indexOf('<details') === 0) return true;
        if (l.indexOf('- ') === 0 || l.indexOf('* ') === 0 || ordered(l)) return true;
      }
      return false;
    }
    // meetingParagraphs: bounded paragraphs, preferring a sentence end, never rewriting words.
    function meetingParagraphs(text) {
      var chars = Array.from(String(text)), start = 0, out = [];
      while (start < chars.length) {
        var end = Math.min(start + 420, chars.length), cut = end;
        if (end < chars.length) {
          var sentence = null, space = null;
          for (var i = start; i < end; i++) {
            if (/\s/.test(chars[i])) space = i;
            if (i - start >= 160 && '.!?。！？'.indexOf(chars[i]) >= 0 && /\s/.test(chars[i + 1] || '')) sentence = i + 1;
          }
          cut = sentence != null ? sentence : (space != null && space > start ? space : end);
        }
        var part = chars.slice(start, cut).join('').trim();
        if (part) out.push(part);
        start = cut;
        while (start < chars.length && /\s/.test(chars[start])) start++;
      }
      return out.join('\n\n');
    }
    function splitSpeakers(text) {
      var re = /(?:^|\s)\[([^\]\n]{1,64})\]:\s*/g, matches = [], m;
      while ((m = re.exec(text))) { matches.push({ index: m.index, end: re.lastIndex, speaker: m[1] }); if (m[0] === '') re.lastIndex++; }
      if (!matches.length || matches[0].index !== 0) return null;
      return matches.map(function (x, i) {
        var stop = i + 1 < matches.length ? matches[i + 1].index : text.length;
        return { speaker: x.speaker, text: text.slice(x.end, stop).trim() };
      });
    }
    function formatMeeting(blocks, transcript) {
      var inT = transcript, out = [], pending = [];
      function add(line) {
        var last = pending[pending.length - 1];
        if (last && last.speaker === line.speaker && last.text.length + line.text.length + 1 <= 600) last.text += ' ' + line.text;
        else pending.push({ speaker: line.speaker, text: line.text });
      }
      function flush() {
        if (!pending.length) return;
        out.push({ t: 'speakers', lines: pending.map(function (l) { return { speaker: l.speaker, text: meetingParagraphs(l.text) }; }) });
        pending = [];
      }
      blocks.forEach(function (b) {
        if (b.t === 'speakers') {
          b.lines.forEach(function (row) { (splitSpeakers('[' + row.speaker + ']: ' + row.text) || [row]).forEach(add); });
        } else if (b.t === 'p') {
          var rows = splitSpeakers(b.text);
          if (rows) rows.forEach(add);
          else if (inT) {
            flush();
            var mm = /(?:^|\s)\[([^\]\n]{1,64})\]:\s*/.exec(b.text);
            if (mm && mm.index > 0) {
              out.push({ t: 'p', text: meetingParagraphs(b.text.slice(0, mm.index)) });
              (splitSpeakers(b.text.slice(mm.index).trim()) || []).forEach(add);
            } else out.push({ t: 'p', text: meetingParagraphs(b.text) });
          } else { flush(); out.push(b); }
        } else if (b.t === 'h') {
          flush();
          if (b.level <= 3) inT = b.text.toLowerCase().indexOf('transcript') >= 0;
          out.push(b);
        } else if (b.t === 'details') {
          flush();
          out.push({ t: 'details', summary: b.summary, blocks: formatMeeting(b.blocks, inT || b.summary.toLowerCase().indexOf('transcript') >= 0) });
        } else { flush(); out.push(b); }
      });
      flush();
      return out;
    }
    function paras(text) { return String(text).split(/\n{2,}/).map(function (p) { return '<p>' + inline(p) + '</p>'; }).join(''); }
    function unnamed(s) { s = String(s).toLowerCase(); return s === 'ext' || s.indexOf('speaker ') === 0 || s.indexOf('unknown') === 0; }
    function render(blocks) {
      return blocks.map(function (b) {
        switch (b.t) {
          case 'h': return '<div class="md-h md-h' + Math.min(b.level, 4) + '">' + inline(b.text) + '</div>';
          case 'p': return paras(b.text);
          case 'code': return '<pre class="md-code"><code>' + esc(b.text) + '</code></pre>';
          case 'hr': return '<hr class="md-hr">';
          case 'quote': return '<blockquote class="md-quote">' + render(b.blocks) + '</blockquote>';
          case 'list':
            return '<' + (b.ordered ? 'ol' : 'ul') + ' class="md-list">' + b.items.map(function (it) {
              var box = it.checked == null ? '' : '<span class="md-check' + (it.checked ? ' on' : '') + '" aria-label="' + (it.checked ? 'done' : 'open') + '"></span>';
              return '<li>' + box + inline(it.text) + (it.children.length ? render(it.children) : '') + '</li>';
            }).join('') + '</' + (b.ordered ? 'ol' : 'ul') + '>';
          case 'table': {
            var kv = b.header.length === 2 && b.rows.length && b.rows.every(function (r) { return r.length === 2 && r[0].indexOf('**') === 0; });
            var cols = Math.max(b.header.length, b.rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0));
            function row(r, tag, key) {
              var h = '<tr>';
              for (var c = 0; c < cols; c++) h += '<' + tag + (key && c === 0 ? ' class="md-key"' : '') + '>' + inline(r[c] || '') + '</' + tag + '>';
              return h + '</tr>';
            }
            return '<div class="md-table-wrap"><table class="md-table' + (kv ? ' kv' : '') + '">' + (kv ? '' : '<thead>' + row(b.header, 'th') + '</thead>') +
              '<tbody>' + b.rows.map(function (r) { return row(r, 'td', kv); }).join('') + '</tbody></table></div>';
          }
          case 'details': {
            var sp = b.blocks.filter(function (x) { return x.t === 'speakers'; })[0];
            var note = '';
            if (sp) { var who = {}; sp.lines.forEach(function (l) { who[l.speaker] = 1; }); var n = sp.lines.length, k = Object.keys(who).length; note = n + ' line' + (n === 1 ? '' : 's') + ' · ' + k + ' speaker' + (k === 1 ? '' : 's'); }
            return '<details class="md-details"><summary><span>' + inline(b.summary) + '</span>' + (note ? '<span class="md-note">' + esc(note) + '</span>' : '') + '</summary><div class="md-details-body">' + render(b.blocks) + '</div></details>';
          }
          case 'speakers':
            return '<div class="md-speakers">' + b.lines.map(function (l) {
              return '<div class="md-turn"><div class="md-who' + (unnamed(l.speaker) ? ' unnamed' : '') + '">' + esc(l.speaker) + '</div>' + paras(l.text) + '</div>';
            }).join('') + '</div>';
          default: return '';
        }
      }).join('');
    }
    return {
      paragraphs: meetingParagraphs,
      looksLikeDocument: looksLikeDocument,
      doc: function (text, dropTitle) { return render(parse(text, dropTitle)); },
      meeting: function (text, dropTitle) { return render(formatMeeting(parse(text, dropTitle), !looksLikeDocument(text))); }
    };
  })();
  // MeetingAskText.transcript: the Transcript section of a scribe file, else the whole text (a document when it has headings).
  function transcriptPart(raw) {
    var lines = String(raw || '').split('\n'), start = null, level = 0, end = lines.length, fenced = false, doc = false;
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t.indexOf('```') === 0 || t.indexOf('~~~') === 0) { fenced = !fenced; continue; }
      var m = fenced ? null : /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
      if (!m) continue;
      doc = true;
      var depth = m[1].length, title = m[2].toLowerCase().replace(/^[ *_:]+|[ *_:]+$/g, '');
      if (start != null && depth <= level) { end = i; break; }
      if (['transcript', 'full transcript', 'meeting transcript', 'raw transcript'].indexOf(title) >= 0) { start = i + 1; level = depth; }
    }
    if (start != null) return { text: lines.slice(start, end).join('\n').trim(), document: false };
    return { text: String(raw || ''), document: doc };
  }

  // ── state ─────────────────────────────────────────────
  var S = {
    view: '', month: monthKey(new Date()), day: null, autoDay: false, domain: 'all', recency: 'newest', q: '',
    rows: null, days: [], dayRows: {}, loading: false, error: '', loadSeq: 0,
    hits: null, searching: false, ranFor: '', semantic: null, searchError: '', searchSeq: 0,
    orphans: { items: [], stranded: [], recovering: [], loaded: false, busy: false, notice: '', confirm: '' },
    files: [], feeds: {}, listTimer: null, liveTimer: null, liveSid: '', follow: true,
    stop: null, confirm: '', liveNote: '',
    detail: null, detailKey: '', detailSeq: 0, copyNote: '',
    ask: {}, conf: { config: null, reach: 'checking', notice: '', pending: null }
  };
  function queryActive() { return S.q.trim().length >= 2; }
  // A month read stops at 200 rows (October 2026 held more), so a day picked in a full month is read on its own.
  function visibleRows() {
    var src = S.day && S.dayRows[S.day] ? S.dayRows[S.day] : (S.rows || []);
    return src.filter(function (m) { return (!S.day || m.date === S.day) && (S.domain === 'all' || m.domain === S.domain); });
  }
  // SearchRecency.sorted
  function visibleHits() {
    var hits = (S.hits || []).slice();
    function score(h) { return h.score != null ? num(h.score) : Math.max(num(h.keywordScore), num(h.semanticScore)); }
    hits.sort(function (a, b) {
      var da = stampOf(a), db = stampOf(b);
      if (S.recency === 'match') { if (score(a) !== score(b)) return score(b) - score(a); return (db || -Infinity) - (da || -Infinity); }
      if (S.recency === 'oldest') { var x = da == null ? Infinity : da, y = db == null ? Infinity : db; if (x !== y) return x - y; return score(b) - score(a); }
      var p = da == null ? -Infinity : da, q = db == null ? -Infinity : db; if (p !== q) return q - p; return score(b) - score(a);
    });
    return hits;
  }
  function rowKey(m) { return [m.domain || '', m.month || '', m.filename || ''].join('|'); }

  // ── list: hero ────────────────────────────────────────
  function paintHero() {
    var el = $('mt-hero'); if (!el) return;
    var detail = queryActive() ? (S.searching ? 'Looking up…' : 'Lookup across stored calls')
      : (S.loading ? 'Loading…' : (S.error || 'Saved calls by day · transcript and summary'));
    var stats = [];
    if (S.rows) {
      stats.push([fmtCount(visibleRows().length), S.day ? 'ON ' + S.day : monthTitle(S.month).toUpperCase()]);
      var withCalls = S.days.filter(function (d) { return num(d.count) > 0; }).length;
      if (withCalls > 0) stats.push([fmtCount(withCalls), 'DAYS WITH CALLS']);
    }
    el.innerHTML = '<header class="cx-hero" data-tint="meetings"><span class="cx-glyph">' + icon('meetings') + '</span>' +
      '<div class="cx-hero-text"><h1 class="cx-title">Meetings</h1><p class="cx-detail-line">' + esc(detail) + '</p></div>' +
      '<div class="cx-actions"><button type="button" class="cx-btn quiet" data-mt="refresh"' + (S.loading ? ' disabled' : '') + '>' + icon('refresh') + 'Refresh</button></div>' +
      (stats.length ? '<div class="cx-stats">' + stats.map(function (s) { return '<span class="cx-stat"><b>' + esc(s[0]) + '</b><span>' + esc(s[1]) + '</span></span>'; }).join('') + '</div>' : '') +
      '</header>';
  }

  // ── list: month calendar (MeetingMonthCalendar) ───────
  function weekStart() {
    try {
      var loc = new Intl.Locale(navigator.language || 'en-US');
      var info = loc.weekInfo || (typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : null);
      if (info && info.firstDay) return info.firstDay % 7;
    } catch (_e) {}
    return 0;
  }
  function paintCal() {
    var el = $('mt-cal'); if (!el) return;
    if (queryActive()) { el.innerHTML = ''; return; }
    var start = parseMonth(S.month); if (!start) { el.innerHTML = ''; return; }
    var counts = {}; S.days.forEach(function (d) { counts[d.date] = num(d.count); });
    var ws = weekStart(), lead = (start.getDay() - ws + 7) % 7;
    var dim = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    var heads = '';
    for (var w = 0; w < 7; w++) heads += '<span class="mt-wd" aria-hidden="true">' + esc(new Date(2023, 0, 1 + (ws + w) % 7).toLocaleDateString(undefined, { weekday: 'narrow' })) + '</span>';
    var cells = '', n = 0;
    for (var i = 0; i < lead; i++) { cells += '<span class="mt-blank"></span>'; n++; }
    for (var day = 1; day <= dim; day++) {
      var key = S.month + '-' + pad2(day), c = counts[key] || 0, on = S.day === key;
      cells += '<button type="button" class="mt-day" data-mt="day" data-day="' + key + '" aria-pressed="' + on + '"' + (c === 0 ? ' disabled' : '') +
        ' aria-label="' + esc(key + (c === 0 ? ', no meetings' : ', ' + c + ' meetings')) + '"><span class="mt-dnum">' + day + '</span><span class="mt-dot' + (c > 0 ? ' on' : '') + '"></span></button>';
      n++;
    }
    while (n % 7 !== 0) { cells += '<span class="mt-blank"></span>'; n++; }
    el.innerHTML = '<section class="mt-cal" aria-label="' + esc(monthTitle(S.month)) + '"><div class="mt-cal-head">' +
      '<button type="button" class="mt-nav" data-mt="month" data-delta="-1" aria-label="Previous month">' + icon('back') + '</button>' +
      '<span class="mt-cal-title">' + esc(monthTitle(S.month)) + '</span>' +
      '<button type="button" class="mt-nav next" data-mt="month" data-delta="1" aria-label="Next month">' + icon('chev') + '</button></div>' +
      '<div class="mt-grid">' + heads + cells + '</div>' +
      (S.day ? '<button type="button" class="cx-btn quiet mt-all" data-mt="all-month">All month</button>' : '') + '</section>';
  }

  // ── list: toolbar ─────────────────────────────────────
  function paintToolbar() {
    var el = $('mt-toolbar'); if (!el) return;
    var rec = [['newest', 'Newest'], ['oldest', 'Oldest'], ['match', 'Best match']];
    el.innerHTML = '<div class="mt-toolbar"><form class="cx-search mt-search" data-mt-form role="search">' +
      '<input class="field" type="search" id="mt-q" placeholder="Search topics, ideas…" value="' + esc(S.q) + '" autocomplete="off" enterkeyhint="search" aria-label="Search topics, ideas">' +
      '<button type="button" class="cx-clear" id="mt-clear" data-mt="clear" aria-label="Clear search"' + (S.q ? '' : ' hidden') + '>Clear</button></form>' +
      '<span id="mt-domain" class="mt-slot"></span>' +
      '<select class="mt-select" id="mt-recency" aria-label="Recency">' + rec.map(function (r) { return '<option value="' + r[0] + '"' + (S.recency === r[0] ? ' selected' : '') + '>' + r[1] + '</option>'; }).join('') + '</select>' +
      '<span class="mt-count" id="mt-count"></span></div><p class="mt-note" id="mt-note" hidden></p>';
    paintToolbarBits();
  }
  function domainOptions() {
    var set = {};
    (S.rows || []).concat(queryActive() ? (S.hits || []) : []).forEach(function (m) { if (m.domain) set[m.domain] = 1; });
    if (S.domain !== 'all') set[S.domain] = 1;
    return Object.keys(set).sort();
  }
  function paintToolbarBits() {
    var active = queryActive(), slot = $('mt-domain');
    if (slot) {
      var opts = domainOptions();
      slot.innerHTML = opts.length + 1 > 2 || active
        ? '<select class="mt-select" id="mt-dom" aria-label="Domain"><option value="all">All domains</option>' + opts.map(function (d) { return '<option value="' + esc(d) + '"' + (S.domain === d ? ' selected' : '') + '>' + esc(cap(d)) + '</option>'; }).join('') + '</select>'
        : '';
    }
    var count = $('mt-count');
    if (count) {
      count.textContent = active
        ? (S.searching && !(S.hits || []).length ? 'Looking up…' : visibleHits().length + ' across stored calls')
        : (S.day ? visibleRows().length + ' on ' + S.day : visibleRows().length + ' in ' + monthTitle(S.month));
    }
    var note = $('mt-note');
    if (note) {
      var show = active && S.ranFor === S.q.trim() && S.semantic === false;
      note.hidden = !show;
      note.textContent = show ? 'Keyword only. Meaning search needs the COS meeting index' : '';
    }
    var clear = $('mt-clear'); if (clear) clear.hidden = !S.q;
  }

  // ── list: rows ────────────────────────────────────────
  function rowHtml(m, hit) {
    return '<button type="button" class="cx-row mt-row" data-mt="open" data-key="' + esc(rowKey(m)) + '">' +
      '<span class="cx-row-glyph">' + icon('meetings') + '</span>' +
      '<span class="cx-row-body"><span class="cx-row-title strong">' + esc(m.title || 'Untitled meeting') + '</span>' +
      (hit && m.snippet ? '<span class="cx-row-sub mt-snippet">' + esc(m.snippet) + '</span>' : '') +
      '<span class="mt-sub' + (hit ? ' dim' : '') + '">' + esc(subtitle(m)) + '</span></span>' +
      '<span class="mt-side">' + (hit ? '<span class="mt-match">' + esc(matchLabel(m.match)) + '</span>' : '') +
      (m.sessionId ? pillsHtml(m, isNew(m.sessionId)) : '') + '</span><span class="chev"></span></button>';
  }
  function emptyBox(text) { return '<div class="cx-list"><p class="cx-empty mt-empty">' + esc(text) + '</p></div>'; }
  function paintList() {
    var el = $('mt-list'); if (!el) return;
    var html;
    if (queryActive()) {
      var hits = visibleHits();
      if (S.searching && !hits.length && !S.searchError) html = '<p class="cx-note mt-wait">Looking up…</p>';
      else if (S.searchError && !hits.length) html = emptyBox(S.searchError);
      else if (!hits.length) html = S.ranFor === S.q.trim() ? emptyBox('No meetings match that lookup.') : '<p class="cx-note mt-wait">Looking up…</p>';
      else html = '<div class="cx-list">' + hits.map(function (h) { return rowHtml(h, true); }).join('') + '</div>';
    } else if (S.loading && !(S.rows || []).length) {
      html = '<p class="cx-note mt-wait">Loading meetings…</p>' + W.skeletonRows(6);
    } else if (S.error && !(S.rows || []).length) {
      html = emptyBox(S.error);
    } else {
      var rows = visibleRows();
      html = rows.length ? '<div class="cx-list">' + rows.map(function (m) { return rowHtml(m, false); }).join('') + '</div>'
        : emptyBox(S.day ? 'No meetings stored on ' + S.day + '. Pick another day, or show the whole month.' : 'No meetings stored in ' + monthTitle(S.month) + '.');
    }
    el.innerHTML = html;
  }
  function paintBrowse() { paintHero(); paintCal(); paintToolbarBits(); paintList(); }

  function loadMonth() {
    var id = ++S.loadSeq;
    S.loading = true; S.dayRows = {};
    if (S.view === 'list') paintBrowse();
    api('/api/meetings?limit=200&domain=all&month=' + encodeURIComponent(S.month)).then(function (d) {
      if (id !== S.loadSeq) return;
      S.rows = (d && d.meetings) || [];
      var days = (d && d.days) || [];
      if (!days.length) {
        var counts = {}; S.rows.forEach(function (m) { if (m.date) counts[m.date] = (counts[m.date] || 0) + 1; });
        days = Object.keys(counts).sort().map(function (k) { return { date: k, count: counts[k] }; });
      }
      S.days = days;
      if (!S.autoDay && S.month === monthKey(new Date())) {
        var today = dayKey(new Date());
        if (days.some(function (x) { return x.date === today && num(x.count) > 0; })) S.day = today;
        S.autoDay = true;
      }
      S.error = ''; S.loading = false;
      if (S.view === 'list') paintBrowse();
      ensureDay();
    }, function (err) {
      if (id !== S.loadSeq) return;
      S.rows = []; S.error = (err && err.message) || 'Meetings could not be loaded.'; S.loading = false;
      if (S.view === 'list') paintBrowse();
    });
  }
  function ensureDay() {
    var day = S.day;
    if (!day || !S.rows || S.rows.length < 200 || S.dayRows[day]) return;
    api('/api/meetings?limit=200&domain=all&day=' + encodeURIComponent(day)).then(function (d) {
      S.dayRows[day] = (d && d.meetings) || [];
      if (S.view === 'list' && S.day === day) paintBrowse();
    }, function () {});
  }
  function shiftMonth(delta) {
    var d = parseMonth(S.month); if (!d) return;
    S.month = monthKey(new Date(d.getFullYear(), d.getMonth() + delta, 1));
    S.day = null; S.rows = null; S.days = [];
    loadMonth();
  }
  function runSearch() {
    var q = S.q.trim();
    if (q.length < 2) { S.hits = null; S.ranFor = ''; S.searching = false; S.searchError = ''; paintBrowse(); return; }
    var id = ++S.searchSeq;
    S.searching = true;
    paintBrowse();
    api('/api/meetings/search?q=' + encodeURIComponent(q) + '&limit=20' + (S.domain !== 'all' ? '&domain=' + encodeURIComponent(S.domain) : '')).then(function (d) {
      if (id !== S.searchSeq) return;
      S.searching = false; S.ranFor = q; S.searchError = '';
      S.hits = (d && d.hits) || [];
      S.semantic = !!(d && d.semanticAvailable === true);
      if (S.view === 'list') paintBrowse();
    }, function (err) {
      if (id !== S.searchSeq) return;
      S.searching = false; S.ranFor = q; S.hits = [];
      S.searchError = (err && err.message) || 'The lookup failed.';
      if (S.view === 'list') paintBrowse();
    });
  }

  // NEW is Speakers' memory (Control's isInboxNew). It is read here, never written.
  function isNew(_sessionId) { return false; }

  // A write whose refusal is an answer to read ({status, body}), never an error to throw. W.api handles sign-out.
  function answer(path, opts) {
    var o = opts || {};
    var headers = { 'X-COS-Web': '1' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: o.method || 'GET', headers: headers, credentials: 'same-origin', body: o.body !== undefined ? JSON.stringify(o.body) : undefined })
      .then(function (res) {
        return res.text().then(function (t) { var b = null; try { b = t ? JSON.parse(t) : {}; } catch (_e) { b = null; } return { status: res.status, body: b || {}, json: b !== null }; });
      }, function () { return { status: 0, body: {}, json: false }; });
  }

  // ── live recordings (LiveTranscript.swift) ────────────
  var QUIET_MS = 120000, RETENTION_MS = 4 * 3600000, STATUS_QUIET_MS = 15000, STATUS_ENDED_MS = 3000;
  var UNSAVED_GRACE_MS = 20000, FINAL_DEADLINE_MS = 180000, ENDED_ROW_MS = 600000;
  var LIVE_HEADER = 'Live transcript · preliminary · may change when saved';
  function newFeed(sid) {
    return { sid: sid, start: null, last: null, mtime: 0, stamp: null, cursor: -1, rev: null, chunks: {}, turns: [], turnOf: {},
      endedAt: null, phase: 'live', serverState: null, statusAt: 0, statusBusy: false, leftover: false, seenLive: false, probed: false, titleSteer: null };
  }
  function feedFor(sid) { return S.feeds[sid] || (S.feeds[sid] = newFeed(sid)); }
  function savesMeeting(st) { return st === 'saved' || st === 'recovered'; }
  function markEnded(f, now) { if (f.endedAt) return false; f.endedAt = now; if (f.phase === 'live') f.phase = 'finalizing'; return true; }
  function durationLabel(start, now, endedAt) {
    if (!start) return null;
    var end = endedAt ? Math.min(endedAt, now) : now, min = Math.max(0, Math.floor((end - start) / 60000));
    if (min < 1) return 'Just started';
    if (min < 60) return min + ' min';
    return min % 60 === 0 ? (min / 60) + ' h' : Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
  }
  // "Started 7:27 AM · 12 min", or "Starting" before the first read.
  function liveSubtitle(start, now, endedAt) {
    if (!start) return 'Starting';
    var started = 'Started ' + clockOf(new Date(start)), d = durationLabel(start, now, endedAt);
    return d ? started + ' · ' + d : started;
  }
  function quietLabel(last, now) { if (!last) return null; var q = now - last; return q >= QUIET_MS ? 'No audio for ' + Math.floor(q / 60000) + 'm' : null; }
  function phaseLabel(p) {
    return { finalizing: 'Finalizing', saved: 'Saved', endedUnsaved: 'Recording ended without saving', notFoundYet: 'Saved meeting not found yet', ended: 'Recording ended' }[p] || 'Live now';
  }
  function sourceLabel(sid, start) {
    var kind = isPhone(sid) ? 'iPhone microphone' : isMac(sid) ? 'Mac recording' : 'Glasses meeting';
    return start ? kind + ' ' + clockOf(new Date(start)) : kind;
  }
  function cleanTitle(raw) {
    return String(raw || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[​-‏‪-‮⁠-⁩﻿]/g, '').replace(/\s+/g, ' ').trim();
  }
  function statusPath(sid) { return '/api/meeting/sessions/' + encodeURIComponent(sid) + '/status' + (isPhone(sid) ? '?sourceType=iphone_microphone&speakerPolicy=anonymous' : ''); }
  // The server's word on one session: saved, active, closed, missing, receipted, recovered, quarantined, else unknown.
  function askStatus(f, now) {
    if (f.statusBusy) return;
    f.statusBusy = true; f.statusAt = now;
    answer(statusPath(f.sid)).then(function (a) {
      f.statusBusy = false;
      var st = null;
      if (a.status === 404 && !isPhone(f.sid)) st = 'unknown';
      else if (a.status === 200) {
        var s = a.body.state;
        st = ['saved', 'active', 'closed', 'missing', 'receipted', 'recovered', 'quarantined'].indexOf(s) >= 0 ? s : 'unknown';
      }
      if (st == null) return;
      var t = Date.now();
      if (!f.endedAt) {
        if (st === 'active') { if (!f.seenLive) { f.seenLive = true; liveChanged(); } return; }
        f.leftover = true; f.serverState = st; markEnded(f, t);
      } else f.serverState = st;
      handoff(f, t);
      liveChanged();
    });
  }
  // LiveTranscript.handoff, once the file is gone or the server finished it.
  function handoff(f, now) {
    if (!f.endedAt) return;
    var st = f.serverState, waited = now - (f.retryAt || f.endedAt), before = f.phase;
    var pastRetention = f.last && (f.endedAt - f.last) >= RETENTION_MS;
    if (savesMeeting(st)) f.phase = 'saved';
    else if (st === 'closed' || st === 'missing') f.phase = f.leftover || pastRetention ? 'ended' : (waited >= UNSAVED_GRACE_MS ? 'endedUnsaved' : 'finalizing');
    else if (st === 'receipted') f.phase = 'ended';
    else if (f.leftover && st && st !== 'active') f.phase = 'ended';
    else f.phase = waited >= FINAL_DEADLINE_MS + (f.start ? Math.max(0, f.endedAt - f.start) / 12 : 0) ? 'notFoundYet' : 'finalizing';
    if (f.phase === 'saved' && before !== 'saved' && f.seenLive && !f.leftover && S.view === 'list') { S.rows = null; loadMonth(); }
  }
  // One read of a listed file for its start and last activity, without moving the transcript cursor.
  function probe(f) {
    f.probed = true;
    api('/api/meetings/live-chunks?sessionId=' + encodeURIComponent(f.sid) + '&since=1000000').then(function (d) {
      var r = d && d.read; if (!r) return;
      if (r.ended) { if (f.seenLive) { markEnded(f, Date.now()); handoff(f, Date.now()); } liveChanged(); return; }
      if (r.startTime != null) f.start = r.startTime;
      if (r.lastActivityAt != null) f.last = Math.max(f.last || 0, r.lastActivityAt);
      if (typeof r.titleSteer === 'string') f.titleSteer = cleanTitle(r.titleSteer) || null;
      liveChanged();
    }, function () {});
  }
  function strandedIds() { var out = {}; S.orphans.stranded.forEach(function (s) { out[s.sessionId] = 1; }); return out; }
  function pollFiles() {
    if (document.hidden) return Promise.resolve();
    return api('/api/meetings/live-chunks').then(function (d) {
      var now = Date.now(), listed = {}, stranded = strandedIds();
      S.files = (d && d.sessions) || [];
      S.files.forEach(function (file) {
        var f = feedFor(file.sessionId), mtime = num(file.mtimeMs);
        listed[file.sessionId] = 1;
        if (f.leftover && f.endedAt && mtime > f.endedAt) { f.leftover = false; f.endedAt = null; f.phase = 'live'; f.serverState = null; }
        f.mtime = mtime;
        var quiet = now - Math.max(f.last || 0, mtime);
        if (quiet >= RETENTION_MS || stranded[file.sessionId] || f.leftover) return;
        if (!f.probed) probe(f);
        if (quiet < QUIET_MS) { if (!f.endedAt) f.seenLive = true; }
        else if (!f.endedAt && now - f.statusAt >= STATUS_QUIET_MS) askStatus(f, now);
      });
      Object.keys(S.feeds).forEach(function (sid) {
        var f = S.feeds[sid];
        if (!listed[sid] && f.seenLive && !f.endedAt && S.liveSid !== sid) markEnded(f, now);
        if (f.endedAt && f.seenLive && ['finalizing', 'notFoundYet'].indexOf(f.phase) >= 0) {
          handoff(f, now);
          if (now - f.statusAt >= STATUS_ENDED_MS) askStatus(f, now);
        }
      });
      liveChanged();
    }, function () {});
  }
  function liveRows(now) {
    var stranded = strandedIds(), out = [], seen = {};
    S.files.forEach(function (file) {
      var f = S.feeds[file.sessionId];
      if (!f || !f.seenLive || f.endedAt || f.leftover || stranded[f.sid]) return;
      var last = Math.max(f.last || 0, num(file.mtimeMs));
      if (now - last >= RETENTION_MS) return;
      seen[f.sid] = 1;
      out.push({ sid: f.sid, start: f.start, last: last, phase: 'live' });
    });
    Object.keys(S.feeds).forEach(function (sid) {
      var f = S.feeds[sid];
      if (seen[sid] || !f.endedAt || !f.seenLive || stranded[sid] || f.phase === 'saved' || f.phase === 'ended' || f.phase === 'live') return;
      if (f.leftover && !savesMeeting(f.serverState)) return;
      if (f.phase === 'endedUnsaved' && now - f.endedAt > ENDED_ROW_MS) return;
      out.push({ sid: sid, start: f.start, last: f.last, phase: f.phase, endedAt: f.endedAt });
    });
    return out.sort(function (a, b) {
      if ((a.phase === 'live') !== (b.phase === 'live')) return a.phase === 'live' ? -1 : 1;
      var x = a.start || a.last || 0, y = b.start || b.last || 0;
      return x !== y ? y - x : (a.sid < b.sid ? -1 : 1);
    });
  }
  function confirmCard(title, line, yesAct, yesLabel, noLabel, sid) {
    return '<div class="mt-confirm" role="group" aria-label="' + esc(title) + '"><p class="mt-confirm-title">' + esc(title) + '</p><p class="mt-confirm-line">' + esc(line) + '</p>' +
      '<div class="mt-confirm-actions"><button type="button" class="cx-btn primary" data-mt="' + yesAct + '"' + (sid ? ' data-sid="' + esc(sid) + '"' : '') + '>' + esc(yesLabel) + '</button>' +
      '<button type="button" class="cx-btn quiet" data-mt="confirm-no">' + esc(noLabel) + '</button></div></div>';
  }
  var STOP_TITLE = 'Stop and save this glasses meeting?';
  var STOP_LINE = 'COS asks the glasses to stop recording and save the meeting. Nothing stops unless the glasses answer.';
  var END_TITLE = 'End this recording and save it?';
  var END_LINE = 'Saves everything the server received as a meeting. Audio the glasses or phone still hold is not added after this.';
  function liveActionHtml(r, now) {
    if (r.phase === 'notFoundYet') return '<button type="button" class="cx-btn quiet" data-mt="handoff-refresh" data-sid="' + esc(r.sid) + '">Refresh</button>';
    if (r.phase !== 'live') return '';
    if (isPhone(r.sid)) return '<span class="mt-side-note">Stop on iPhone</span>';
    var quiet = r.last && now - r.last >= QUIET_MS;
    if (quiet && isGlasses(r.sid)) return '<button type="button" class="cx-btn quiet" data-mt="end-ask" data-sid="' + esc(r.sid) + '">End and save</button>';
    if (!quiet && isGlasses(r.sid)) return '<button type="button" class="cx-btn quiet" data-mt="stop-ask" data-sid="' + esc(r.sid) + '"' + (stopping(r.sid) ? ' disabled' : '') + '>Stop and save</button>';
    return '';
  }
  function liveRowHtml(r, now) {
    var quiet = r.phase === 'live' ? quietLabel(r.last, now) : null;
    var html = '<div class="mt-liverow"><button type="button" class="cx-row mt-row" data-mt="live" data-sid="' + esc(r.sid) + '" aria-label="' + esc(r.phase === 'live' ? 'Live meeting. Open the live transcript' : phaseLabel(r.phase)) + '">' +
      '<span class="cx-row-glyph mt-dotwrap"><span class="mt-livedot' + (r.phase === 'live' ? ' on' : '') + '"></span></span>' +
      '<span class="cx-row-body"><span class="cx-row-title strong">' + esc(r.phase === 'live' ? 'Live now' : phaseLabel(r.phase)) + '</span>' +
      '<span class="mt-sub">' + esc(liveSubtitle(r.start, now, r.endedAt)) + (quiet ? '<span class="mt-amber"> · ' + esc(quiet) + '</span>' : '') + '</span></span>' +
      '<span class="mt-side"><span class="mt-side-note">Live transcript</span></span><span class="chev"></span></button>' +
      '<span class="mt-liveact">' + liveActionHtml(r, now) + '</span></div>';
    var line = stopLineFor(r.sid);
    if (line) html += '<p class="mt-stopline' + (S.stop && S.stop.nothing ? ' bad' : '') + '">' + esc(line) + '</p>';
    if (S.confirm === 'stop:' + r.sid) html += confirmCard(STOP_TITLE, STOP_LINE, 'stop-yes', 'Stop and save', 'Cancel', r.sid);
    if (S.confirm === 'end:' + r.sid) html += confirmCard(END_TITLE, END_LINE, 'end-yes', 'End and save', 'Keep it open', r.sid);
    return html;
  }
  function paintLive() {
    var el = $('mt-live'); if (!el) return;
    var now = Date.now(), rows = liveRows(now);
    var html = rows.length || S.liveNote
      ? '<section class="mt-livebox">' + rows.map(function (r) { return liveRowHtml(r, now); }).join('') + (S.liveNote ? '<p class="mt-notice">' + esc(S.liveNote) + '</p>' : '') + '</section>'
      : '';
    if (html !== S.liveHtml || !el.firstChild !== !html) { S.liveHtml = html; el.innerHTML = html; }
  }
  function liveChanged() {
    if (S.view === 'list') paintLive();
    else if (S.view === 'live') paintLiveHead();
  }
  // End and save: POST /api/meeting/save, the helper's meeting-stranded-save.
  function endAndSave(sid) {
    S.confirm = ''; S.liveNote = 'Saving…'; liveChanged();
    answer('/api/meeting/save', { method: 'POST', body: { sessionId: sid } }).then(function (a) {
      var b = a.body;
      if (a.status === 200 && b.filename) S.liveNote = 'Saved capture as a meeting.';
      else if (a.status === 200 && b.alreadySaved === true) S.liveNote = 'Already saved';
      else if (a.status === 409) S.liveNote = 'Save already in progress for this capture.';
      else if (a.status === 404) S.liveNote = typeof b.error === 'string' ? b.error : 'No transcript for this capture. Session files were not deleted.';
      else if (a.status === 0) S.liveNote = 'Server stopped';
      else S.liveNote = (typeof b.error === 'string' && b.error) || (typeof b.reason === 'string' && b.reason) || 'Save failed (' + a.status + ')';
      liveChanged(); loadOrphans(); pollFiles();
      if (a.status === 200 && S.view === 'list') { S.rows = null; loadMonth(); }
    });
  }

  // ── Stop and save on a glasses meeting (G2MeetingStop) ─
  function stopLineText(p) {
    switch (p.k) {
      case 'asking': return 'Asking the glasses to stop…';
      case 'stopping': return 'The glasses are stopping. Saving the meeting…';
      case 'finalizing': return 'Saving the meeting…';
      case 'saved': {
        var name = p.filename ? String(p.filename).replace(/\.md$/, '') : null;
        if (name && p.minutes != null) return 'Saved: ' + name + ', ' + p.minutes + ' min.';
        if (name) return 'Saved: ' + name + '.';
        if (p.minutes != null) return 'Saved, ' + p.minutes + ' min.';
        return 'Saved.';
      }
      case 'notConnected': return 'Glasses not connected. Nothing was stopped. Stop it on the glasses (hold menu, Stop Meeting) or on the phone.';
      case 'notRecordingHere': return 'The glasses are not recording this meeting. Nothing was stopped.';
      case 'otherMeeting': return 'The glasses are recording a different meeting. Nothing was stopped.';
      case 'alreadyStopped': return 'This meeting already stopped.';
      case 'serverUnreachable': return 'COS server unreachable. Nothing was stopped.';
      case 'serverTooOld': return 'This COS server cannot stop glasses meetings yet. Update the server, or stop it on the glasses or phone.';
      case 'unauthorized': return 'Reconnect COS Control to the server. Nothing was stopped.';
      case 'stillSaving': return 'The glasses stopped. The save is still running; check Meetings in a minute.';
      case 'serverRestarted': return 'The COS server restarted before the glasses answered. Nothing was stopped.';
      default: return 'The server could not ask the glasses (HTTP ' + p.status + '). Nothing was stopped.';
    }
  }
  var STOP_ACTIVE = { asking: 1, stopping: 1, finalizing: 1 };
  var STOP_NOTHING = { notConnected: 1, notRecordingHere: 1, otherMeeting: 1, serverUnreachable: 1, serverTooOld: 1, unauthorized: 1, serverRestarted: 1, failed: 1 };
  function stopping(sid) { return !!(S.stop && S.stop.sid === sid && STOP_ACTIVE[S.stop.phase.k]); }
  function stopLineFor(sid) { return S.stop && S.stop.sid === sid ? stopLineText(S.stop.phase) : null; }
  function savedPhase(b) { var r = b.saveReceipt || {}; return { k: 'saved', filename: r.filename || null, minutes: r.durationMin != null ? num(r.durationMin) : null }; }
  function afterRequest(a) {
    var b = a.body;
    if (a.status === 0) return { phase: { k: 'serverUnreachable' } };
    var win = b.claimWindowMs != null ? num(b.claimWindowMs) : 10000;
    if (a.status === 202) return b.requestId ? { phase: { k: 'asking' }, requestId: String(b.requestId), win: win } : { phase: { k: 'serverTooOld' } };
    if (a.status === 200 && b.state === 'saved') return { phase: savedPhase(b) };
    if (a.status === 200 && b.state === 'finalizing') return { phase: { k: 'stillSaving' } };
    if (a.status === 409 && b.reason === 'not_live') return { phase: { k: 'alreadyStopped' } };
    if (a.status === 401 || a.status === 403) return { phase: { k: 'unauthorized' } };
    if (a.status === 404) return { phase: { k: 'serverTooOld' } };
    return { phase: { k: 'failed', status: a.status } };
  }
  function afterPoll(a, elapsed, win, claimed) {
    var deadline = win + 3000, saveWait = 180000, b = a.body;
    if (a.status === 0) { if (claimed) return { k: elapsed > saveWait ? 'stillSaving' : 'stopping' }; return { k: elapsed > deadline ? 'serverUnreachable' : 'asking' }; }
    if (a.status === 404) return { k: claimed ? 'stillSaving' : 'serverRestarted' };
    if (a.status === 401 || a.status === 403) return { k: claimed ? 'stillSaving' : 'unauthorized' };
    if (a.status < 200 || a.status >= 300) return claimed ? { k: 'stopping' } : (elapsed > deadline ? { k: 'failed', status: a.status } : { k: 'asking' });
    switch (b.state) {
      case 'saved': return savedPhase(b);
      case 'claimed': return elapsed > saveWait ? { k: 'stillSaving' } : { k: b.finalizing === true ? 'finalizing' : 'stopping' };
      case 'refused':
        if (b.refusal === 'not_recording') return { k: 'notRecordingHere' };
        if (b.refusal === 'other_session') return { k: 'otherMeeting' };
        if (b.refusal === 'stop_in_progress') return { k: elapsed > saveWait ? 'stillSaving' : 'finalizing' };
        return { k: 'notConnected' };
      case 'expired': return { k: 'notConnected' };
      default: return { k: elapsed > deadline ? 'notConnected' : 'asking' };
    }
  }
  function setStop(sid, phase) { S.stop = { sid: sid, phase: phase, nothing: !!STOP_NOTHING[phase.k] }; liveChanged(); }
  function stopGlasses(sid) {
    if (!isGlasses(sid) || (S.stop && STOP_ACTIVE[S.stop.phase.k])) return;
    S.confirm = '';
    setStop(sid, { k: 'asking' });
    var base = '/api/meeting/sessions/' + encodeURIComponent(sid) + '/stop-request';
    answer(base, { method: 'POST', body: { source: 'web' } }).then(function (a) {
      var asked = afterRequest(a);
      setStop(sid, asked.phase);
      if (!STOP_ACTIVE[asked.phase.k] || !asked.requestId) { if (asked.phase.k === 'saved') pollFiles(); return; }
      var started = Date.now(), claimed = false;
      (function tick() {
        setTimeout(function () {
          answer(base + '/' + encodeURIComponent(asked.requestId)).then(function (p) {
            var next = afterPoll(p, Date.now() - started, asked.win, claimed);
            if (next.k === 'stopping' || next.k === 'finalizing') claimed = true;
            setStop(sid, next);
            if (STOP_ACTIVE[next.k]) tick(); else if (next.k === 'saved') pollFiles();
          });
        }, claimed ? 2000 : 1000);
      })();
    });
  }

  // ── Unsaved recordings (unsavedCaptureBanner) ─────────
  function orphanRecoverable(o) {
    var phoneOk = !isPhone(o.sessionId, o.sourceType) || (PHONE_ID.test(o.sessionId) && o.sourceType === 'iphone_microphone' && o.provenanceState === 'admitted');
    var rec = o.recoverable != null ? o.recoverable === true : (o.recovered !== true && num(o.chunkFiles) >= 2);
    return phoneOk && rec;
  }
  function shortId(id) { return id.length > 18 ? id.slice(0, 18) + '…' : id; }
  function orphanLabel(o, recovering) {
    var src = isPhone(o.sessionId, o.sourceType) ? 'iPhone microphone · ' : '', n = num(o.chunkFiles), chunks = n === 1 ? '1 chunk' : n + ' chunks';
    if (recovering) return src + shortId(o.sessionId) + ' · recovering · ' + chunks;
    if (o.ageHours != null) return src + shortId(o.sessionId) + ' · ' + chunks + ' · ' + o.ageHours + 'h';
    return src + shortId(o.sessionId) + ' · ' + chunks;
  }
  function strandedCanSave(s) { return !isPhone(s.sessionId, s.sourceType) && (s.canSave != null ? s.canSave === true : num(s.chunks) > 0); }
  function strandedLabel(s) {
    if (isPhone(s.sessionId, s.sourceType)) return 'iPhone microphone · audio retained · finish on iPhone';
    var idle = num(s.idleMinutes) === 1 ? '1 min idle' : num(s.idleMinutes) + ' min idle';
    var state = s.transcriptState || (num(s.chunks) > 0 ? 'ready' : 'unknown');
    if (state === 'no_speech') return shortId(s.sessionId) + ' · No usable speech detected; audio retained';
    if (!strandedCanSave(s)) return shortId(s.sessionId) + ' · Transcript unavailable; audio retained';
    return shortId(s.sessionId) + ' · ' + idle + ' · ready to save';
  }
  function loadOrphans() {
    return api('/api/meeting/orphans').then(function (d) {
      var O = S.orphans;
      O.recovering = (d && d.recovering) || [];
      O.items = ((d && d.items) || []).filter(function (o) { return o && o.sessionId; });
      O.stranded = ((d && d.stranded) || []).filter(function (s) { return s && s.sessionId; });
      O.loaded = true;
      if (S.view === 'list') { paintOrphans(); paintLive(); }
    }, function () { /* quiet, as Control's loadOrphans(quiet: true) */ });
  }
  function paintOrphans() {
    var el = $('mt-orphans'); if (!el) return;
    var O = S.orphans, rec = O.items.filter(orphanRecoverable), busy = O.busy;
    if (!rec.length && !O.stranded.length) { el.innerHTML = O.notice ? '<p class="mt-notice">' + esc(O.notice) + '</p>' : ''; return; }
    var html = '<section class="mt-orphans"><p class="mt-orphans-title">Unsaved recordings</p>' +
      '<p class="mt-orphans-line">Audio that never became a meeting. This is not Speakers’ Meetings to review.</p>';
    rec.forEach(function (o) {
      var recovering = O.recovering.indexOf(o.sessionId) >= 0;
      html += '<div class="mt-orow"><span class="mt-olabel">' + esc(orphanLabel(o, recovering)) + '</span>' +
        '<button type="button" class="cx-btn quiet" data-mt="recover" data-sid="' + esc(o.sessionId) + '"' + (busy || recovering ? ' disabled' : '') + '>Recover</button></div>';
    });
    if (rec.length > 1) html += '<div class="mt-orow"><button type="button" class="cx-btn quiet" data-mt="recover-all-ask"' + (busy ? ' disabled' : '') + '>Recover all</button></div>';
    if (O.confirm === 'recover-all') html += confirmCard('Recover all unsaved recordings?', 'Turns each unsaved recording into a meeting, one at a time. The files are kept.', 'recover-all-yes', 'Recover all', 'Cancel');
    O.stranded.forEach(function (s) {
      var act;
      if (isPhone(s.sessionId, s.sourceType)) act = '<span class="mt-side-note">Stop on iPhone</span>';
      else if (isMac(s.sessionId)) act = '<span class="mt-side-note">Finish on your Mac</span>';
      else act = '<button type="button" class="cx-btn quiet" data-mt="save-stranded" data-sid="' + esc(s.sessionId) + '"' + (busy ? ' disabled' : '') + '>Save</button>';
      html += '<div class="mt-orow"><span class="mt-olabel dim">' + esc(strandedLabel(s)) + '</span>' + act + '</div>';
    });
    if (O.stranded.length > 1) html += '<div class="mt-orow"><button type="button" class="cx-btn quiet" data-mt="save-all-ask"' + (busy ? ' disabled' : '') + '>Save all still-live</button></div>';
    if (O.confirm === 'save-all') html += confirmCard('Save live recordings as meetings?', 'Ends each live glasses recording and saves it, like Stop on the phone. The files are kept.', 'save-all-yes', 'Save all', 'Cancel');
    if (O.notice) html += '<p class="mt-notice">' + esc(O.notice) + '</p>';
    el.innerHTML = html + '</section>';
  }
  function recoverOne(sid) {
    return answer('/api/meeting/orphans/' + encodeURIComponent(sid) + '/recover', { method: 'POST', body: {} }).then(function (a) {
      var b = a.body;
      if (a.status === 202 && b.accepted === true) return { ok: true, text: 'Recovery started' };
      if (a.status === 200 && b.alreadySaved === true) return { ok: true, text: 'Already saved' };
      if (a.status === 409) return { ok: false, skip: true, text: 'Recovery already in progress for this capture.' };
      if (a.status === 404) return { ok: false, text: 'No quarantined audio for this capture. Session files were not deleted.' };
      if (a.status === 503) return { ok: false, text: (typeof b.error === 'string' && b.error) || 'Server is busy with another recovery. Wait, then retry.' };
      if (a.status === 0) return { ok: false, text: 'Server stopped' };
      return { ok: false, text: (typeof b.error === 'string' && b.error) || (typeof b.reason === 'string' && b.reason) || 'Recovery failed (' + a.status + ')' };
    });
  }
  function saveOne(sid) {
    return answer('/api/meeting/save', { method: 'POST', body: { sessionId: sid } }).then(function (a) {
      var b = a.body;
      if (a.status === 200 && (b.filename || b.alreadySaved === true)) return { ok: true, text: b.filename ? 'Saved capture as a meeting.' : 'Already saved' };
      if (a.status === 409) return { ok: false, text: 'Save already in progress for this capture.' };
      if (a.status === 404) return { ok: false, text: (typeof b.error === 'string' && b.error) || 'No transcript for this capture. Session files were not deleted.' };
      if (a.status === 0) return { ok: false, text: 'Server stopped' };
      return { ok: false, text: (typeof b.error === 'string' && b.error) || (typeof b.reason === 'string' && b.reason) || 'Save failed (' + a.status + ')' };
    });
  }
  function orphanTask(run) {
    var O = S.orphans;
    if (O.busy) return;
    O.busy = true; O.confirm = ''; O.notice = ''; paintOrphans();
    run().then(function (text) {
      O.busy = false; O.notice = text; paintOrphans();
      loadOrphans(); pollFiles();
      if (S.view === 'list') { S.rows = null; loadMonth(); }
    });
  }
  function recoverAll() {
    var ids = S.orphans.items.filter(orphanRecoverable).map(function (o) { return o.sessionId; }), done = 0, failed = 0;
    return ids.reduce(function (p, sid) {
      return p.then(function () { return recoverOne(sid).then(function (r) { if (r.ok) done++; else if (!r.skip) failed++; }); });
    }, Promise.resolve()).then(function () {
      return failed ? 'Recovered ' + done + '. ' + failed + ' failed. Session files were not deleted.' : (done === 1 ? 'Started recovery for 1 capture.' : 'Started recovery for ' + done + ' capture(s).');
    });
  }
  function saveAllStranded() {
    var st = S.orphans.stranded, ids = st.filter(function (s) { return strandedCanSave(s) && !isMac(s.sessionId) && !isPhone(s.sessionId); }).map(function (s) { return s.sessionId; });
    var macLeft = st.filter(function (s) { return strandedCanSave(s) && isMac(s.sessionId); }).length;
    var phoneLeft = st.filter(function (s) { return isPhone(s.sessionId); }).length;
    if (!ids.length) return Promise.resolve(phoneLeft > 0 ? 'Stop on iPhone. Its retained uploads finish there.' : macLeft > 0 ? 'Mac recordings finish from Record on Mac, then Recover.' : 'No still-live captures');
    var saved = 0, failed = 0;
    return ids.reduce(function (p, sid) {
      return p.then(function () { return saveOne(sid).then(function (r) { if (r.ok) saved++; else failed++; }); });
    }, Promise.resolve()).then(function () {
      if (failed) return 'Saved ' + saved + '. ' + failed + ' failed. Session files were not deleted.';
      return (saved === 1 ? 'Saved 1 capture as a meeting.' : 'Saved ' + saved + ' captures as meetings.') +
        (macLeft > 0 ? ' Mac recordings finish from Record on Mac, then Recover.' : '') + (phoneLeft > 0 ? ' iPhone microphone captures finish on iPhone.' : '');
    });
  }

  // ── detail (MeetingLibraryDetailPane) ─────────────────
  function findRow(key) {
    var all = (S.rows || []).concat(S.hits || []);
    Object.keys(S.dayRows).forEach(function (k) { all = all.concat(S.dayRows[k]); });
    return all.filter(function (m) { return rowKey(m) === key; })[0] || null;
  }
  function detailRow() {
    var d = S.detail || {}, base = {};
    Object.keys(d).forEach(function (k) { if (['transcript', 'sourceContent', 'summary'].indexOf(k) < 0) base[k] = d[k]; });
    return Object.assign(base, S.detailRow || {});
  }
  function detailSessions() {
    if (!S.detail) return [];
    var row = detailRow(), keys = contextKeys(S.detail.contextKeys && S.detail.contextKeys.length ? S.detail.contextKeys : row.contextKeys, row);
    return askSessions(row, keys);
  }
  function openDetail(domain, month, filename) {
    var key = [domain, month, filename].join('|');
    S.view = 'detail';
    if (S.detailKey !== key) {
      S.detailKey = key; S.detail = null; S.detailError = ''; S.copyNote = ''; S.detailRow = findRow(key);
    } else if (!S.detailRow) S.detailRow = findRow(key);
    if (S.detailRow) W.setCrumb(S.detailRow.title || 'Meeting');
    paintDetail();
    if (S.detail) { W.setCrumb(detailRow().title || 'Meeting'); detailSessions().forEach(function (sid) { panelOpen(sid); }); return; }
    var id = ++S.detailSeq;
    S.detailLoading = true;
    api('/api/meetings/detail?domain=' + encodeURIComponent(domain) + '&month=' + encodeURIComponent(month) + '&filename=' + encodeURIComponent(filename)).then(function (d) {
      if (id !== S.detailSeq) return;
      S.detailLoading = false; S.detail = d || {}; S.detailError = '';
      if (S.view !== 'detail' || S.detailKey !== key) return;
      W.setCrumb(detailRow().title || 'Meeting');
      paintDetail();
      detailSessions().forEach(function (sid) { panelOpen(sid); });
      // A deep link has no list row; Control always opens one (its session, voices and captures). Read that day's list.
      if (!S.detailRow && /^\d{4}-\d{2}-\d{2}$/.test(S.detail.date || '')) {
        api('/api/meetings?limit=200&domain=all&day=' + S.detail.date).then(function (l) {
          var hit = ((l && l.meetings) || []).filter(function (m) { return rowKey(m) === key; })[0];
          if (!hit || S.detailKey !== key || S.view !== 'detail') return;
          var before = detailSessions();
          S.detailRow = hit;
          paintDetail();
          detailSessions().forEach(function (sid) { if (before.indexOf(sid) < 0) panelOpen(sid); });
        }, function () {});
      }
    }, function (err) {
      if (id !== S.detailSeq) return;
      S.detailLoading = false;
      S.detailError = err && err.status === 404 ? 'That meeting is no longer stored.' : ((err && err.message) || 'The meeting could not be read.');
      if (S.view === 'detail' && S.detailKey === key) paintDetail();
    });
  }
  function labeled(title, body) {
    return '<div class="mt-section"><div class="mt-label">' + esc(title.toUpperCase()) + '</div><div class="mt-md">' + MD.doc(body) + '</div></div>';
  }
  // 0.5.232: the scribe file is the body; a record that is not a document keeps its labelled fields.
  function documentHtml(d) {
    var tr = typeof d.transcript === 'string' ? d.transcript : '', sm = typeof d.summary === 'string' ? d.summary : '', out = '';
    if (MD.looksLikeDocument(tr)) out = '<div class="mt-md">' + MD.meeting(tr, true) + '</div>';
    else {
      var att = Array.isArray(d.attendees) ? d.attendees.filter(function (a) { return typeof a === 'string'; }) : [];
      if (att.length) out += labeled('Attendees', att.join(', '));
      if (sm) out += labeled('Summary', sm);
      if (tr) out += '<div class="mt-section"><div class="mt-tlabel">Transcript</div><div class="mt-md">' + MD.meeting(tr, false) + '</div></div>';
    }
    if (!sm && !tr) out += '<p class="mt-none">This record has no summary or transcript stored.</p>';
    return out;
  }
  function detailBarHtml(row, d) {
    var tr = transcriptPart(d.transcript || '');
    var html = '<div class="mt-bar"><button type="button" class="cx-btn primary" data-mt="copy-context">Copy full context</button>' +
      '<button type="button" class="cx-btn quiet" data-mt="copy-summary"' + (d.summary ? '' : ' disabled') + '>Copy summary</button>' +
      '<button type="button" class="cx-btn quiet" data-mt="copy-transcript"' + (d.transcript ? '' : ' disabled') + '>' + (tr.document ? 'Copy meeting document' : 'Copy transcript') + '</button>' +
      '<button type="button" class="cx-btn quiet" data-mt="download"' + (d.transcript || d.sourceContent ? '' : ' disabled') + '>' + icon('doc') + 'Download .md</button>';
    if (canReviewVoices(row)) {
      var fresh = isNew(row.sessionId);
      html += '<span class="mt-bar-gap"></span><button type="button" class="cx-btn quiet' + (fresh ? ' featured' : '') + '" data-mt="review" data-sid="' + esc(row.sessionId) + '">' + icon('speakers') + 'Review voices' + (fresh ? '<span class="cx-pill warn">NEW</span>' : '') + '</button>';
      var others = (row.g2SessionIds || []).filter(function (s) { return s !== row.sessionId; });
      if ((row.g2SessionIds || []).length > 1 && others.length) {
        html += '<details class="mt-menu"><summary class="cx-btn quiet">Other recordings</summary><div class="mt-menu-list">' +
          others.map(function (s) { return '<button type="button" data-mt="review" data-sid="' + esc(s) + '">' + esc(s) + '</button>'; }).join('') + '</div></details>';
      }
      html += pillsHtml(row, false);
    }
    return html + '</div>' + (S.copyNote ? '<p class="mt-copynote" role="status">' + esc(S.copyNote) + '</p>' : '');
  }
  function paintDetail() {
    if (S.view !== 'detail') return;
    var d = S.detail, row = d ? detailRow() : (S.detailRow || {});
    var head = '<div class="mt-dhead"><h2 class="mt-dtitle">' + esc(row.title || (S.detailError ? 'Meeting' : 'Loading meeting…')) + '</h2>' +
      (row.date || row.time ? '<p class="mt-dsub">' + esc(subtitle(row)) + '</p>' : '') + '</div>';
    var body;
    if (!d && S.detailError) body = '<p class="mt-none">' + esc(S.detailError) + '</p><button type="button" class="cx-btn quiet" data-mt="detail-retry">Retry</button>';
    else if (!d) body = '<p class="cx-note mt-wait">Loading meeting…</p>' + W.skeletonRows(5);
    else {
      var sessions = detailSessions();
      body = detailBarHtml(row, d) + '<div class="mt-dbody">' +
        (row.sourceSessionId && sessions.length ? '<p class="mt-note-line">Ask history covers the whole original capture, including its other split pieces.</p>' : '') +
        sessions.map(function (sid, i) {
          A(sid).ctx = { saved: true, meeting: row, captureLabel: 'Original recording ' + (i + 1) + '. Questions use its saved cutoff; each recording keeps its own history.' };
          return '<div class="mt-side-panel" id="mt-ask-' + safeId(sid) + '">' + sidePanelHtml(sid) + '</div>';
        }).join('') +
        '<article class="mt-doc">' + documentHtml(d) + '</article></div>';
    }
    pane.innerHTML = '<div class="cx mt mt-detail" data-tint="meetings">' + head + body + '</div>';
  }
  function setCopyNote(text) {
    S.copyNote = text;
    var bar = pane.querySelector('.mt-copynote');
    if (S.view === 'detail' && S.detail) {
      if (bar) bar.textContent = text;
      else { var b = pane.querySelector('.mt-bar'); if (b) b.insertAdjacentHTML('afterend', '<p class="mt-copynote" role="status">' + esc(text) + '</p>'); }
    }
  }
  function copyOut(text, done) {
    W.copyText(text).then(function () { setCopyNote(done); }, function (err) { setCopyNote((err && err.message) || 'This browser would not copy.'); });
  }
  function copyDetail(kind) {
    var d = S.detail; if (!d) return;
    var row = detailRow();
    if (kind === 'summary' || kind === 'transcript') {
      var body = kind === 'summary' ? (d.summary || '') : transcriptPart(d.transcript || '').text;
      if (!body.trim()) { setCopyNote('Nothing to copy'); return; }
      copyOut(body.trim(), kind === 'summary' ? 'Copied summary' : 'Copied transcript');
      return;
    }
    // Copy full context: the transcript, every Meeting Ask answer with its sources, the cues and the files (MeetingAskText.fullContext).
    var source = transcriptPart(d.transcript || ''), sessions = detailSessions();
    var title = (row.title || 'Meeting') + (source.document ? ' · meeting document' : '') + (row.derivedKind === 'split' ? ' · Ask history covers the whole original capture' : '');
    setCopyNote('Preparing full context…');
    var work = sessions.length ? loadConfig().then(function () {
      if (!S.conf.config) return null;
      return Promise.all(sessions.map(function (sid) { return askOpen(sid, true); })).then(function () {
        return Promise.all(sessions.filter(function (sid) { return isGlasses(sid) || isMac(sid); }).map(function (sid) { return loadCues(sid, true); }));
      });
    }) : Promise.resolve(true);
    work.then(function (ok) {
      if (sessions.length && ok === null) { setCopyNote('Refresh meeting assistance before copying its full context.'); return; }
      var seen = {}, rows = [], files = [], cues = [], cueNote = null, coverage = [];
      sessions.forEach(function (sid) {
        var a = A(sid);
        a.history.forEach(function (e) { if (!seen[e.requestId]) { seen[e.requestId] = 1; rows.push(e); } });
        files = files.concat(a.files || []);
        if (a.error) coverage.push('Context coverage: ' + a.error);
        if (a.cues) cues = cues.concat(a.cues); else if (a.cuesState && a.cuesState !== 'older' && (isGlasses(sid) || isMac(sid))) cueNote = 'Context coverage: cues could not be read from the server.';
      });
      var text = fullContext(title, source.text, rows, evidenceFiles(rows, files), cues, cueNote) + (coverage.length ? '\n\n' + coverage.join('\n') : '');
      if (new Blob([text]).size > 4000000) { setCopyNote('Full context exceeds the 4 MB clipboard limit. Nothing was copied; saved history remains available.'); return; }
      copyOut(text, 'Copied full meeting context');
    });
  }
  function downloadDetail() {
    var d = S.detail; if (!d) return;
    var text = d.sourceContent || d.transcript || '', row = detailRow();
    var name = String(row.filename || 'meeting.md').replace(/[\/\\]/g, '_');
    var url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url; a.download = /\.md$/i.test(name) ? name : name + '.md';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    setCopyNote('Downloaded ' + a.download);
  }
  function stampMs(ms, hours) {
    var total = Math.floor(Math.max(0, num(ms)) / 1000), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return hours ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }
  function modelLabel(e) { var m = e.selectedModel || {}; return e.model || (cap(m.engine) + ' · ' + (m.model || '')); }
  function safeUrl(u) { try { var x = new URL(String(u || '')); return x.protocol === 'https:' && x.hostname ? x.href : null; } catch (_e) { return null; } }
  function exportStatusLine(e) {
    return 'Model: ' + modelLabel(e) + ' · Through ' + stampMs(e.throughMs, num(e.throughMs) >= 3600000) + ' · ' + e.status +
      (e.timings && e.timings.totalMs != null ? ' · Answer time: ' + (num(e.timings.totalMs) / 1000).toFixed(1) + ' s' : '');
  }
  function evidenceFiles(exchanges, current) {
    var seen = {}, out = [];
    exchanges.reduce(function (all, e) { return all.concat(e.files || []); }, []).concat(current).forEach(function (f) { var k = f.id + '@' + f.revision; if (!seen[k]) { seen[k] = 1; out.push(f); } });
    return out;
  }
  function fullContext(title, transcript, exchanges, files, cues, cueNote) {
    var sections = ['# ' + title, '## Transcript\n' + transcript];
    exchanges.forEach(function (e, i) {
      var ns = 'Q' + (i + 1), ans = e.answer != null ? e.answer : 'No answer (' + e.status + ').';
      (e.sources || []).forEach(function (s) { ans = ans.split('[' + s.id + ']').join('[' + ns + ':' + s.id + ']'); });
      var part = '## ' + ns + ' · ' + e.question + '\n' + ans + '\n' + exportStatusLine(e);
      (e.sources || []).forEach(function (s) { part += '\n[' + ns + ':' + s.id + '] ' + s.kind + ': ' + s.title + '\n' + s.text; var u = safeUrl(s.url); if (u) part += '\n' + u; });
      if ((e.notices || []).length) part += '\n' + e.notices.join('\n');
      sections.push(part);
    });
    var cueText = cuesSection(cues, cueNote); if (cueText) sections.push(cueText);
    if (files.length) sections.push('## Files\n' + files.map(function (f) { return '### ' + f.name + ' [' + f.id + '@' + f.revision + '] · ' + f.status + '\n' + (f.status === 'ready' ? f.text : 'Text unavailable: ' + (f.notice || f.status)); }).join('\n\n'));
    return sections.join('\n\n');
  }

  // ── Meeting Ask (MeetingAskStore, LiveAskPanel) ───────
  var FACT_CHECK_Q = 'Fact check the latest public factual claim in this meeting. Find a readable source and say whether it supports the claim.';
  var CHALLENGE_Q = 'For my own thinking, challenge one assumption supported by this recording. Give one short reason. If no assumption is clear, say so.';
  var DECISION_Q = 'For my own thinking, identify one unresolved decision from this recording and one useful question to move it forward. Do not invent a decision.';
  var ACTIONS = [['catch_up', 'Catch me up'], ['summary', 'Summarize so far'], ['questions', 'What to ask'], ['actions', 'Action items']];
  var KNOWN_LABELS = ['So what', 'Decided', 'Open', 'You owe', 'Next', 'Covered', 'Others owe', 'Unowned', 'Proposed', 'Ask', 'Details', 'Confidence'];
  function A(sid) {
    return S.ask[sid] || (S.ask[sid] = { sid: sid, history: [], files: [], loading: false, error: '', note: '', running: false, outbox: null,
      snapshot: null, health: '', view: 'ask', cues: null, cuesState: '', cuesCount: null, follow: null, followText: '', followBusy: false,
      draft: readDrafts()[sid] || '', ctx: {}, openP: null });
  }
  function terminal(e) { return ['completed', 'failed', 'cancelled', 'interrupted'].indexOf(e.status) >= 0; }
  function online() { return S.conf.reach === 'online'; }
  function helperMsg(status, op) {
    if (status === 404) return op === 'config' ? 'Update the COS server to use saved meeting assistance.' : 'This request or meeting is unavailable.';
    if (status === 401 || status === 403) return 'Reconnect COS Control to the server.';
    if (status === 409) return 'Meeting assistant could not accept this request. Refresh its history before retrying.';
    if (status === 429) return 'Meeting assistant is busy or has reached its usage limit. Your question is retained.';
    if (!status) return 'Meeting assistant is offline. Your question is retained; nothing retries automatically.';
    return 'Meeting assistant could not finish. Check the selected model and server, then retry.';
  }
  function failureText(reason) {
    switch (reason) {
      case 'provider_timeout': return 'The selected model took too long. Retry when you’re ready.';
      case 'provider_unavailable': case 'model_unavailable': return 'The selected model is unavailable. Check Meeting assistant settings, then retry.';
      case 'invalid_answer': case 'invalid_provider_output': return 'The model returned an unreadable answer. Your question is saved; you can retry.';
      case 'journal_write_failed': return 'This answer could not be saved. Copy available context before restarting COS.';
      case 'server_restarted': return 'COS restarted before this answer finished. Retry to ask again.';
      case 'cancelled': case 'cancelled_by_user': return 'This answer was stopped. Your question remains saved.';
      default: return 'Meeting assistance could not finish. Check the connected model and retry.';
    }
  }
  function loadConfig(force) {
    if (S.conf.pending) return S.conf.pending;
    if (S.conf.config && !force) return Promise.resolve(S.conf.config);
    S.conf.pending = api('/api/meeting-ask/config').then(function (c) {
      S.conf.pending = null;
      if (!c || c.protocolVersion !== 2 || !c.serverInstanceId) {
        S.conf.config = null; S.conf.reach = 'outdated'; S.conf.notice = 'Update COS Control and the server together to use meeting assistance.'; return null;
      }
      S.conf.config = c; S.conf.reach = 'online'; S.conf.notice = '';
      return c;
    }, function (err) {
      S.conf.pending = null;
      S.conf.reach = err && err.status === 404 ? 'outdated' : 'offline';
      S.conf.notice = helperMsg(err && err.status, 'config');
      return null;
    });
    return S.conf.pending;
  }
  function accept(sid, ex) {
    var a = A(sid), conf = S.conf.config;
    if (!ex || ex.sessionId !== sid || !conf || ex.serverInstanceId !== conf.serverInstanceId) return false;
    var i = -1;
    a.history.forEach(function (e, j) { if (e.requestId === ex.requestId) i = j; });
    if (i >= 0) { var cur = a.history[i]; if (cur.updatedAt > ex.updatedAt || (terminal(cur) && !terminal(ex))) return true; a.history[i] = ex; }
    else a.history.push(ex);
    return true;
  }
  function askOpen(sid, quiet) {
    var a = A(sid);
    if (a.openP) return a.openP;
    a.loading = true; if (!quiet) repaintAsk(sid);
    a.openP = loadConfig().then(function (conf) {
      if (!conf) return;
      var inst = encodeURIComponent(conf.serverInstanceId), offset = 0, all = [], files = [];
      function page() {
        return api('/api/meeting-ask/history?sessionId=' + encodeURIComponent(sid) + '&serverInstanceId=' + inst + '&offset=' + offset + '&limit=50').then(function (p) {
          all = all.concat((p && p.exchanges) || []); files = (p && p.files) || [];
          if (p && p.nextOffset != null && p.nextOffset > offset && all.length < 10000) { offset = p.nextOffset; return page(); }
        });
      }
      return page().then(function () {
        all.forEach(function (e) { accept(sid, e); });
        a.history.sort(function (x, y) { return x.createdAt === y.createdAt ? (x.requestId < y.requestId ? -1 : 1) : (x.createdAt < y.createdAt ? -1 : 1); });
        a.files = files; a.error = '';
        if (a.outbox) {
          if (a.history.some(function (e) { return e.requestId === a.outbox.req.requestId; })) { if (a.outbox.consumes && a.draft.trim() === a.outbox.req.question) setDraft(sid, ''); a.outbox = null; }
          else a.error = 'The last question’s admission is uncertain. Check its status before sending another.';
        }
        var active = a.history.filter(function (e) { return !terminal(e); })[0];
        if (active && !a.running) poll(sid, active);
      }, function (err) { a.error = helperMsg(err && err.status); });
    }).then(function () { a.loading = false; a.openP = null; repaintAsk(sid); });
    return a.openP;
  }
  // The panel's open: history, then (saved) the saved transcript, then the source line, then the cue count.
  function panelOpen(sid) {
    var a = A(sid);
    return askOpen(sid).then(function () {
      if (!S.conf.config) return;
      return (a.ctx.saved ? loadSnapshot(sid) : Promise.resolve()).then(function () { return checkSources(sid); });
    }).then(function () { if (isGlasses(sid) || isMac(sid)) return loadCues(sid); });
  }
  function loadSnapshot(sid) {
    var a = A(sid), conf = S.conf.config; if (!conf) return Promise.resolve();
    return api('/api/meeting-ask/transcript?sessionId=' + encodeURIComponent(sid) + '&serverInstanceId=' + encodeURIComponent(conf.serverInstanceId)).then(function (s) {
      var turns = (s && s.turns) || [], ids = {}, elapsed = num(s && s.elapsedMs);
      var valid = s && s.ended === true && elapsed >= 0 && turns.length > 0 && turns.every(function (t) {
        if (ids[t.id] || !(t.id >= 0) || !(t.elapsedMs >= 0) || t.elapsedMs > elapsed || !String(t.text || '').trim()) return false;
        ids[t.id] = 1; return true;
      });
      if (valid) { a.snapshot = { turns: turns, elapsedMs: elapsed }; a.error = a.error === SNAP_ERR ? '' : a.error; }
      else { a.snapshot = null; a.error = SNAP_ERR; }
      repaintAsk(sid);
    }, function (err) { a.snapshot = null; a.error = helperMsg(err && err.status); repaintAsk(sid); });
  }
  var SNAP_ERR = 'This recording is not ready for saved-meeting questions. Open its live transcript or refresh after saving.';
  function checkSources(sid) {
    var a = A(sid), conf = S.conf.config; if (!conf) return Promise.resolve();
    return Promise.all([
      api('/api/context/status'),
      api('/api/meeting-ask/context?sessionId=' + encodeURIComponent(sid) + '&serverInstanceId=' + encodeURIComponent(conf.serverInstanceId))
    ]).then(function (r) {
      var h = r[0] || {}, o = (r[1] && r[1].orientation) || {};
      function part(x) { return x && x.available ? fmtCount(x.total) + ' available' : 'unavailable'; }
      a.health = 'Memory: ' + part(h.memory) + '. Threads: ' + part(h.threads) + '. Domain: ' + (o.domain || 'not confirmed') + '. Checked ' + clockOf(new Date()) + '. Last sync is not reported by this source.';
      repaintAsk(sid);
    }, function () { a.health = 'Source status could not be checked. Refresh to retry.'; repaintAsk(sid); });
  }
  function setDraft(sid, text) { var a = A(sid); a.draft = String(text || '').slice(0, 2000); writeDraft(sid, a.draft); }
  function askEnabled(sid) {
    var a = A(sid);
    if (a.ctx.live) { var f = S.feeds[sid]; return !!(f && f.turns.length); }
    return !!a.snapshot;
  }
  function askBlocked(sid) { var a = A(sid); return !online() || a.running || !!a.outbox || !askEnabled(sid); }
  function submit(sid, action, question, retryOf) {
    var a = A(sid), conf = S.conf.config;
    question = String(question || '').trim().slice(0, 2000);
    if (!conf || askBlocked(sid) || !question) return;
    var turns, elapsed;
    if (a.ctx.live) {
      var f = S.feeds[sid], end = f.endedAt || Date.now();
      turns = f.turns.map(function (t) { return { id: t.id, elapsedMs: t.elapsedMs, speaker: t.speaker, text: t.text }; });
      elapsed = Math.max(turns.reduce(function (m, t) { return Math.max(m, t.elapsedMs); }, 0), f.start ? Math.max(0, end - f.start) : 0);
    } else { turns = a.snapshot.turns; elapsed = a.snapshot.elapsedMs; }
    if (!turns.length) return;
    var req = { requestId: uuid(), sessionId: sid, serverInstanceId: conf.serverInstanceId, action: action, question: question, elapsedMs: Math.round(elapsed), turns: turns, model: conf.selected,
      files: (a.files || []).filter(function (x) { return x.status !== 'removed'; }).map(function (x) { return { id: x.id, revision: x.revision }; }) };
    if (retryOf) req.retryOf = retryOf;
    a.outbox = { req: req, consumes: action === 'ask' && !retryOf };
    a.error = ''; a.note = '';
    send(sid);
  }
  function send(sid) {
    var a = A(sid), box = a.outbox; if (!box) return;
    a.running = true; repaintAsk(sid);
    answer('/api/meeting-ask/requests', { method: 'POST', body: box.req }).then(function (res) {
      if (res.status >= 200 && res.status < 300) {
        var ex = res.body.exchange;
        if (!ex || ex.requestId !== box.req.requestId || !accept(sid, ex)) { a.running = false; a.error = 'Question identity did not match. Local recovery is preserved.'; repaintAsk(sid); return; }
        a.outbox = null;
        if (box.consumes && a.draft.trim() === box.req.question) setDraft(sid, '');
        a.running = false; poll(sid, ex);
        return;
      }
      a.running = false;
      if ([400, 401, 403, 404, 413, 422, 429].indexOf(res.status) >= 0) a.outbox = null;
      a.error = helperMsg(res.status);
      repaintAsk(sid);
    });
  }
  function poll(sid, first) {
    var a = A(sid), row = first, deadline = Date.now() + 180000;
    a.running = true; repaintAsk(sid);
    (function tick() {
      if (terminal(row)) { a.running = false; repaintAsk(sid); return; }
      if (Date.now() > deadline) { a.running = false; a.error = 'Answer is still pending on the server. Refresh to check its status; nothing was resubmitted.'; repaintAsk(sid); return; }
      setTimeout(function () {
        api('/api/meeting-ask/requests/' + encodeURIComponent(row.requestId)).then(function (r) {
          var ex = r && r.exchange;
          if (!ex || ex.requestId !== row.requestId || !accept(sid, ex)) { a.running = false; a.error = 'Answer identity did not match. Saved context is preserved.'; repaintAsk(sid); return; }
          row = ex; repaintAsk(sid); tick();
        }, function (err) { a.running = false; a.error = helperMsg(err && err.status); repaintAsk(sid); });
      }, 2000);
    })();
  }
  function cancelAnswer(sid, requestId) {
    var e = A(sid).history.filter(function (x) { return x.requestId === requestId; })[0]; if (!e) return;
    answer('/api/meeting-ask/requests/' + encodeURIComponent(requestId) + '/cancel', { method: 'POST', body: { serverInstanceId: e.serverInstanceId } }).then(function (res) {
      if (res.status >= 200 && res.status < 300 && res.body.exchange) accept(sid, res.body.exchange); else A(sid).error = helperMsg(res.status);
      repaintAsk(sid);
    });
  }
  function reconcile(sid) {
    var a = A(sid), box = a.outbox; if (!box) return;
    api('/api/meeting-ask/requests/' + encodeURIComponent(box.req.requestId)).then(function (r) {
      var ex = r && r.exchange;
      if (!ex || ex.requestId !== box.req.requestId || !accept(sid, ex)) { a.error = 'Question identity did not match. Local recovery is preserved.'; repaintAsk(sid); return; }
      a.outbox = null; if (box.consumes && a.draft.trim() === box.req.question) setDraft(sid, '');
      a.error = ''; if (!terminal(ex)) poll(sid, ex); else repaintAsk(sid);
    }, function (err) {
      a.error = err && err.status === 404
        ? 'The server has not confirmed this question yet. Retry the same question to reconcile its original request; your draft is retained.'
        : helperMsg(err && err.status) + ' The question remains recoverable. No automatic resend occurred.';
      repaintAsk(sid);
    });
  }
  function saveFollowUp(sid) {
    var a = A(sid), conf = S.conf.config, m = a.ctx.meeting;
    var e = a.history.filter(function (x) { return x.requestId === a.follow; })[0];
    var text = a.followText.trim();
    if (!e || !conf || !m || !text || text.length > 600 || !online()) return;
    a.followBusy = true; repaintAsk(sid);
    answer('/api/work-intake/meeting-ask', { method: 'POST', body: { serverInstanceId: conf.serverInstanceId, requestId: e.requestId, text: text,
      meeting: { domain: m.domain, month: m.month, filename: m.filename, recordId: m.recordId } } }).then(function (res) {
      a.followBusy = false;
      var b = res.body;
      if (res.status >= 200 && res.status < 300 && b.ok && b.item && b.item.id) {
        a.follow = null; a.error = '';
        a.note = b.item.status === 'review' ? 'Saved in Work Review. Review it before adding it to your work.' : 'This follow-up was already reviewed.';
      } else a.error = 'Save was not confirmed. Your follow-up draft is retained; retry the same words after checking COS.';
      repaintAsk(sid);
    });
  }

  // ── Cues (MeetingCuesPanel, read only) ────────────────
  function loadCues(sid, force) {
    var a = A(sid), days = a.ctx.live ? 2 : 30;
    if (a.cuesState === 'loaded' && !force) return Promise.resolve();
    return api('/api/live-cues/history?days=' + days + '&limit=200&sessionId=' + encodeURIComponent(sid)).then(function (d) {
      a.cues = ((d && d.cues) || []).filter(function (c) { return c && c.sessionId === sid; });
      var m = d && d.meetings && d.meetings[sid];
      a.cuesCount = { cues: m && m.cues != null ? num(m.cues) : a.cues.length, cap: m && m.cap != null ? num(m.cap) : null };
      a.cuesState = 'loaded'; repaintAsk(sid);
    }, function (err) { a.cuesState = err && err.status === 404 ? 'older' : 'failed'; a.cuesStatus = err && err.status; repaintAsk(sid); });
  }
  function cuesOffered(sid) { var a = A(sid); return a.cuesState === 'loaded' && (isGlasses(sid) || (isMac(sid) && (a.cues || []).length > 0)); }
  var KIND = { challenge: 'Challenge', reinforce: 'Reinforce', decision: 'Decision', promise: 'Promise', followUp: 'Follow-up', insight: 'Insight' };
  function cueStart(c) { if (c.armedAt) return num(c.armedAt); var m = /^meeting_(\d{13})_/.exec(c.sessionId || ''); return m ? Number(m[1]) : null; }
  function cueMinutes(c) { var s = cueStart(c); if (!s) return null; var sec = (num(c.createdAt) - s) / 1000; return sec >= 0 && sec < 43200 ? Math.floor(sec / 60) : null; }
  function cueSourceText(s) {
    var host = null; try { var u = new URL(s.url || ''); if (u.protocol === 'https:') host = u.hostname.replace(/^www\./, ''); } catch (_e) {}
    if (host) return (s.title || host) + ' (' + host + ')';
    return s.date ? (s.title || '') + ' (' + s.date + ')' : (s.title || '');
  }
  function cueSources(c) { var src = c.sources || []; return src.length ? 'Sources: ' + src.map(cueSourceText).join('; ') : 'Sources: none, from the room only'; }
  function cueRated(r) {
    if (!r || !r.verdict) return null;
    var label = cap(r.verdict);
    return r.note ? 'Rated ' + label + ' · “' + r.note + '”' : 'Rated ' + label;
  }
  function cueVote(r) { return r && r.vote === 'up' ? 'Voted up on the glasses' : r && r.vote === 'down' ? 'Voted down on the glasses' : null; }
  function cuesSection(cues, note) {
    var seen = {}, rows = cues.filter(function (c) { if (seen[c.cueId]) return false; seen[c.cueId] = 1; return true; })
      .sort(function (x, y) { return num(x.createdAt) - num(y.createdAt) || (x.cueId < y.cueId ? -1 : 1); });
    if (!rows.length && !note) return null;
    var parts = ['## Cues'];
    rows.forEach(function (c, i) {
      var mins = cueMinutes(c), d = new Date(num(c.createdAt));
      var when = mins != null ? mins + ' min in' : dayKey(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      var lines = ['### C' + (i + 1) + ' · ' + (KIND[c.kind] || c.kind) + ' · ' + when];
      if (c.headline && c.headline !== c.detail) lines.push(c.headline);
      lines.push(c.detail || '');
      if (c.general && c.general.query) lines.push('Searched the web for: ' + c.general.query);
      lines.push(cueSources(c));
      (c.sources || []).forEach(function (s) { var u = safeUrl(s.url); if (u) lines.push(u); });
      var rated = cueRated(c.rating); if (rated) lines.push(rated);
      var vote = cueVote(c.rating); if (vote) lines.push(vote);
      parts.push(lines.join('\n'));
    });
    if (note) parts.push(note);
    return parts.join('\n\n');
  }

  // ── side panel rendering ──────────────────────────────
  // MeetingAskAnswerRows: the server's sections (So what first), or **Label:** lines of an older answer, else nil.
  function answerRows(e) {
    var given = (e.sections || []).map(function (s) { return { label: String(s.label || '').trim(), text: String(s.text || '').trim() }; }).filter(function (r) { return r.label && r.text; });
    if (!given.length && typeof e.answer === 'string') {
      var rows = [], gap = false, ok = true;
      e.answer.split('\n').forEach(function (raw) {
        if (!ok) return;
        var line = raw.trim();
        if (!line) { gap = true; return; }
        var m = /^\*\*([^*]+?):\*\*\s*(.*)$/.exec(line) || /^\*\*([^*]+?)\*\*:\s*(.*)$/.exec(line);
        if (m && KNOWN_LABELS.indexOf(m[1].trim()) >= 0) rows.push({ label: m[1].trim(), lines: m[2] ? [m[2]] : [] });
        else if (!rows.length) ok = false;
        else { var last = rows[rows.length - 1]; if (gap && last.lines.length) last.lines.push(''); last.lines.push(raw.replace(/\s+$/, '')); }
        gap = false;
      });
      if (!ok || !rows.length) return null;
      given = rows.map(function (r) { return { label: r.label, text: r.lines.join('\n').trim() }; }).filter(function (r) { return r.text; });
      if (!given.length) return null;
    }
    if (!given.length) return null;
    var first = given.filter(function (r) { return r.label === 'So what'; });
    return first.concat(given.filter(function (r) { return r.label !== 'So what'; }));
  }
  function answerHtml(sid, e) {
    var a = A(sid), rows = answerRows(e), body = '';
    if (!terminal(e) && e.answer == null && !rows) body += '<p class="mt-working">Working: COS is answering.</p>';
    if (rows) {
      body += '<div class="mt-arows">' + rows.map(function (r) {
        var parts = r.text.split(/\n{2,}/), lead = parts.shift();
        return '<div class="mt-arow"><p><strong>' + esc(r.label) + ':</strong> ' + inline(lead) + '</p>' + (parts.length ? '<div class="mt-md">' + MD.doc(parts.join('\n\n')) + '</div>' : '') + '</div>';
      }).join('') + '</div>';
    } else if (e.answer != null) body += '<div class="mt-md">' + MD.doc(e.answer) + '</div>';
    else if (terminal(e)) body += '<p class="mt-muted">No answer · ' + esc(e.status) + '</p>';
    if (e.error) body += '<p class="mt-amber-line">' + esc(failureText(e.error)) + '</p>';
    (e.sources || []).forEach(function (s) {
      var url = s.kind === 'web' ? safeUrl(s.url) : null, host = '';
      if (url) { try { host = new URL(url).hostname; } catch (_e) {} }
      body += '<details class="mt-source" data-k="' + esc(e.requestId + ':' + s.id) + '"><summary>[' + esc(s.id) + '] ' + esc(cap(s.kind)) + ' · ' + esc(s.title) + '</summary>' +
        '<div class="mt-source-body"><p>' + esc(s.text) + '</p>' +
        (url ? '<p><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(host || 'Open source') + '</a></p><p class="mt-muted">Retained search evidence' + (s.retrievedAt ? ' · ' + esc(s.retrievedAt) : '') + '</p>' : '') +
        (s.recordId ? '<p class="mt-muted">Retained source excerpt</p>' : '') + '</div></details>';
    });
    (e.notices || []).forEach(function (n) { body += '<p class="mt-amber-line">' + esc(n) + '</p>'; });
    var conf = S.conf.config, caps = (conf && conf.capabilities) || {};
    var acts = '';
    if (terminal(e) && ['failed', 'cancelled', 'interrupted'].indexOf(e.status) >= 0 && askEnabled(sid))
      acts += '<button type="button" class="mt-link" data-mt="ask-retry" data-sid="' + esc(sid) + '" data-req="' + esc(e.requestId) + '"' + (a.running || a.outbox || !online() ? ' disabled' : '') + '>Retry</button>';
    if (!terminal(e)) acts += '<button type="button" class="mt-link" data-mt="ask-stop" data-sid="' + esc(sid) + '" data-req="' + esc(e.requestId) + '">Stop</button>';
    if (e.status === 'completed' && caps.followUpReview === true)
      acts += '<button type="button" class="mt-link" data-mt="follow-open" data-sid="' + esc(sid) + '" data-req="' + esc(e.requestId) + '"' + (!a.ctx.saved || !a.ctx.meeting || !online() ? ' disabled title="Save this meeting before adding a follow-up"' : '') + '>Save as follow-up</button>';
    acts += '<button type="button" class="mt-link" data-mt="ask-copy" data-sid="' + esc(sid) + '" data-req="' + esc(e.requestId) + '">Copy</button>';
    body += '<div class="mt-afoot"><span class="mt-muted">Through ' + esc(stampMs(e.throughMs, false)) + ' · ' + esc(modelLabel(e)) + '</span><span class="mt-afoot-acts">' + acts + '</span></div>';
    if (a.follow === e.requestId) {
      var t = a.followText.trim();
      body += '<div class="mt-confirm mt-follow"><p class="mt-confirm-title">Save as follow-up</p>' +
        '<p class="mt-confirm-line">Review these words. This creates a Work Review item with the original answer and sources; it does not commit a task.</p>' +
        '<textarea class="field mt-follow-text" rows="4" data-sid="' + esc(sid) + '" aria-label="Follow-up"' + (a.followBusy ? ' disabled' : '') + '>' + esc(a.followText) + '</textarea>' +
        '<div class="mt-confirm-actions"><button type="button" class="cx-btn quiet" data-mt="follow-cancel" data-sid="' + esc(sid) + '"' + (a.followBusy ? ' disabled' : '') + '>Cancel</button>' +
        '<button type="button" class="cx-btn primary" data-mt="follow-save" data-sid="' + esc(sid) + '"' + (a.followBusy || !t || t.length > 600 || !online() ? ' disabled' : '') + '>' + (a.followBusy ? 'Saving…' : 'Save in Work Review') + '</button></div></div>';
    }
    return '<div class="mt-answer"><p class="mt-q">' + esc(e.question || e.action) + '</p>' + body + '</div>';
  }
  function askHtml(sid) {
    var a = A(sid), live = !!a.ctx.live, conf = S.conf.config, caps = (conf && conf.capabilities) || {}, blocked = askBlocked(sid);
    var dis = blocked ? ' disabled' : '';
    var html = '<div class="mt-ask-head"><h3 class="mt-ask-title">' + (live ? 'Live COS Ask' : 'Meeting Ask') + '</h3>' +
      '<button type="button" class="mt-iconbtn" data-mt="ask-refresh" data-sid="' + esc(sid) + '" title="Refresh saved answers" aria-label="Refresh saved answers">' + icon('refresh') + '</button></div>' +
      '<p class="mt-ask-line">Ask when you need it. Uses this meeting first.</p>' +
      '<details class="mt-ask-sources" data-k="sources"><summary>Sources and context</summary><p>' + esc(a.health || 'Source status has not been checked.') + '</p></details>' +
      (a.ctx.captureLabel ? '<p class="mt-muted">' + esc(a.ctx.captureLabel) + '</p>' : '');
    html += '<div class="mt-ask-acts">' + ACTIONS.map(function (x) {
      return '<button type="button" class="cx-btn quiet" data-mt="ask-act" data-sid="' + esc(sid) + '" data-action="' + x[0] + '" data-q="' + esc(x[1] === 'Catch me up' ? 'Catch me up on this recording' : x[1]) + '"' + dis + '>' + esc(x[1]) + '</button>';
    }).join('') + (caps.factCheck === true ? '<button type="button" class="cx-btn quiet" data-mt="ask-act" data-sid="' + esc(sid) + '" data-action="ask" data-q="' + esc(FACT_CHECK_Q) + '"' + dis + '>Fact check</button>' : '') + '</div>';
    html += '<div class="mt-history">';
    if (!a.history.length) {
      var failed = !!a.error || !online();
      html += '<p class="mt-muted">' + esc(a.loading ? 'Loading saved questions…' : failed ? 'Saved questions could not be checked. Refresh to retry.' : live ? 'No questions yet. Answers are saved with this recording.' : 'No saved questions found for this recording.') + '</p>';
    }
    html += a.history.map(function (e) { return answerHtml(sid, e); }).join('') + '</div>';
    var err = a.error || (!online() && S.conf.reach !== 'checking' ? S.conf.notice : '');
    if (err) html += '<p class="mt-amber-line">' + esc(err) + '</p>';
    if (a.outbox) {
      html += '<div class="mt-ask-acts"><button type="button" class="cx-btn quiet" data-mt="ask-check" data-sid="' + esc(sid) + '">Check pending question</button>' +
        '<button type="button" class="cx-btn quiet" data-mt="ask-resend" data-sid="' + esc(sid) + '"' + (!online() || a.running ? ' disabled' : '') + '>Retry same question</button></div>';
    }
    if (a.note) html += '<p class="mt-muted">' + esc(a.note) + '</p>';
    html += '<form class="mt-composer" data-mt-ask="' + esc(sid) + '"><textarea class="field mt-ask-input" rows="1" data-sid="' + esc(sid) + '" placeholder="Ask about this meeting" aria-label="Ask about this meeting" enterkeyhint="send"' + (conf ? '' : ' disabled') + '>' + esc(a.draft) + '</textarea>' +
      '<button type="submit" class="cx-btn primary"' + (blocked || !a.draft.trim() ? ' disabled' : '') + '>Ask</button></form>' +
      '<div class="mt-ask-more"><button type="button" class="mt-link" data-mt="ask-act" data-sid="' + esc(sid) + '" data-action="ask" data-q="' + esc(CHALLENGE_Q) + '"' + dis + '>Challenge an assumption</button>' +
      '<button type="button" class="mt-link" data-mt="ask-act" data-sid="' + esc(sid) + '" data-action="ask" data-q="' + esc(DECISION_Q) + '"' + dis + '>Find my next decision</button></div>' +
      (conf && conf.selected ? '<p class="mt-muted mt-model">Model: ' + esc(cap(conf.selected.engine) + ' · ' + conf.selected.model) + '</p>' : '');
    return html;
  }
  function cuesHtml(sid) {
    var a = A(sid), cues = (a.cues || []).slice().sort(function (x, y) { return num(y.createdAt) - num(x.createdAt); });
    var count = a.cuesCount || { cues: cues.length, cap: null };
    var html = '<div class="mt-ask-head"><span class="mt-muted">' + esc(count.cap != null ? count.cues + ' of ' + count.cap + ' used' : count.cues + ' used') + '</span>' +
      '<button type="button" class="mt-iconbtn" data-mt="cues-refresh" data-sid="' + esc(sid) + '" title="Check again" aria-label="Check again">' + icon('refresh') + '</button></div>';
    if (a.cuesState === 'failed') html += '<p class="mt-amber-line">' + esc(a.cuesStatus ? 'The server could not list cues (HTTP ' + a.cuesStatus + '). Check again.' : 'COS server unreachable. Cues show here once it answers.') + '</p>';
    if (!cues.length) html += '<p class="mt-muted">' + (a.ctx.live ? 'No cues yet in this meeting.' : 'No cues were shown in this meeting.') + '</p>';
    html += cues.map(function (c) {
      var line = [clockOf(new Date(num(c.createdAt))), KIND[c.kind] || c.kind].concat(c.gate != null ? [num(c.gate).toFixed(2)] : []).join(' · ');
      var rated = cueRated(c.rating), vote = cueVote(c.rating);
      return '<div class="mt-cue"><p class="mt-cue-line">' + esc(line) + '</p>' +
        (c.headline && c.headline !== c.detail ? '<p class="mt-cue-head">' + esc(c.headline) + '</p>' : '') +
        '<p class="mt-cue-detail">' + esc(c.detail || '') + '</p><p class="mt-muted">' + esc(cueSources(c)) + '</p>' +
        (rated ? '<p class="mt-muted">' + esc(rated) + '</p>' : '') + (vote ? '<p class="mt-muted">' + esc(vote) + '</p>' : '') + '</div>';
    }).join('');
    return html;
  }
  function sidePanelHtml(sid) {
    var a = A(sid), offered = cuesOffered(sid), view = offered ? a.view : 'ask';
    var sw = offered ? '<div class="cx-switch mt-pswitch" role="group" aria-label="Meeting panel">' +
      '<button type="button" data-mt="panel" data-view="ask" data-sid="' + esc(sid) + '" aria-pressed="' + (view === 'ask') + '">' + (a.ctx.live ? 'Live COS Ask' : 'Meeting Ask') + '</button>' +
      '<button type="button" data-mt="panel" data-view="cues" data-sid="' + esc(sid) + '" aria-pressed="' + (view === 'cues') + '">Cues ' + ((a.cues || []).length) + '</button></div>' : '';
    return '<section class="mt-panel">' + sw + (view === 'cues' ? cuesHtml(sid) : askHtml(sid)) + '</section>';
  }
  // Repaint one panel in place, keeping the caret in its box and which disclosures are open.
  function repaintAsk(sid) {
    var el = $('mt-ask-' + safeId(sid)); if (!el) return;
    var act = document.activeElement, inBox = act && el.contains(act) && act.tagName === 'TEXTAREA' ? act.className : null;
    var caret = inBox ? [act.selectionStart, act.selectionEnd] : null;
    var open = {}; el.querySelectorAll('details[open][data-k]').forEach(function (d) { open[d.getAttribute('data-k')] = 1; });
    el.innerHTML = sidePanelHtml(sid);
    el.querySelectorAll('details[data-k]').forEach(function (d) { if (open[d.getAttribute('data-k')]) d.open = true; });
    if (inBox) {
      var box = el.querySelector('textarea.' + inBox.split(' ').filter(Boolean).join('.'));
      if (box) { box.focus(); try { box.setSelectionRange(caret[0], caret[1]); } catch (_e) {} grow(box); }
    }
  }
  function grow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; }

  // ── live transcript view (LiveTranscriptPane) ─────────
  function displaySpeaker(raw) {
    var name = String(raw || '').trim();
    return ['', 'unknown', 'speaker', 'unidentified', '?', 'none', 'null'].indexOf(name.toLowerCase()) >= 0 ? 'Speaker' : name;
  }
  function sameChunk(a, b) { return !!a && !!b && a.i === b.i && a.elapsedMs === b.elapsedMs && a.speaker === b.speaker && a.text === b.text; }
  // LiveTranscriptFeed.build: index order, same-speaker chunks merged into 30 s / 600 character sections, stable ids.
  function buildTurns(f) {
    var runs = [];
    Object.keys(f.chunks).map(Number).sort(function (x, y) { return x - y; }).forEach(function (i) {
      var c = f.chunks[i], text = String(c.text || '').trim(); if (!text) return;
      var sp = displaySpeaker(c.speaker), last = runs[runs.length - 1];
      if (last && last.speaker === sp && c.elapsedMs >= last.members[0].elapsedMs && c.elapsedMs - last.members[0].elapsedMs < 30000 && last.chars + 1 + text.length <= 600) {
        last.members.push(c); last.chars += 1 + text.length;
      } else runs.push({ speaker: sp, members: [c], chars: text.length });
    });
    var used = {}, turns = [], map = {};
    runs.forEach(function (run) {
      var first = run.members[0], id = null;
      for (var k = 0; k < run.members.length; k++) { var p = f.turnOf[run.members[k].i]; if (p != null && !used[p]) { id = p; break; } }
      if (id == null) id = first.i;
      if (used[id]) { id = -(first.i + 1); while (used[id]) id--; }
      used[id] = 1;
      turns.push({ id: id, speaker: run.speaker, elapsedMs: num(first.elapsedMs), text: MD.paragraphs(run.members.map(function (m) { return String(m.text).trim(); }).join(' ')) });
      run.members.forEach(function (m) { map[m.i] = id; });
    });
    f.turns = turns; f.turnOf = map;
  }
  // LiveTranscriptFeed.apply: true when anything the pane draws changed.
  function applyRead(f, r, now) {
    if (!r || r.sessionId !== f.sid) return false;
    if (r.fullSnapshot === true && (r.speakerRevision == null || !r.turns)) return false;
    if (r.speakerRevision != null) {
      var rev = num(r.speakerRevision);
      if (!(rev >= 0 && rev < 1e7) || (f.rev != null && rev < f.rev)) return false;
      if (rev !== f.rev && r.fullSnapshot !== true) return false;
    } else if (f.rev != null && !r.ended && !r.unchanged) return false;
    if (r.ended) return markEnded(f, now);
    if (f.leftover) return false;
    var changed = false;
    if (f.endedAt) { f.endedAt = null; f.phase = 'live'; f.serverState = null; changed = true; }
    if (r.unchanged) return changed;
    f.stamp = r.stamp || f.stamp;
    var steer = cleanTitle(r.titleSteer || '') || null;
    if (steer !== f.titleSteer) { f.titleSteer = steer; changed = true; }
    if (r.startTime != null && r.startTime !== f.start) { f.start = num(r.startTime); changed = true; }
    if (r.lastActivityAt != null && r.lastActivityAt !== f.last) { f.last = num(r.lastActivityAt); changed = true; }
    if (r.settledThrough != null) f.cursor = Math.max(f.cursor, num(r.settledThrough));
    var dirty = false;
    if (r.fullSnapshot === true) {
      var rep = {};
      (r.turns || []).forEach(function (c) { if (c.i >= 0) rep[c.i] = c; });
      var a = Object.keys(rep), b = Object.keys(f.chunks);
      dirty = a.length !== b.length || a.some(function (k) { return !sameChunk(rep[k], f.chunks[k]); });
      f.chunks = rep;
    }
    if (r.speakerRevision != null) f.rev = num(r.speakerRevision);
    (r.turns || []).forEach(function (c) { if (c.i >= 0 && !sameChunk(f.chunks[c.i], c)) { f.chunks[c.i] = c; dirty = true; } });
    if (dirty) { buildTurns(f); changed = true; }
    return changed;
  }
  function liveCopyText(f) {
    var header = 'COS preliminary transcript';
    if (f.start) { var d = new Date(f.start); header += ' · ' + dayKey(d) + ' ' + clockOf(d); }
    var hours = f.turns.some(function (t) { return t.elapsedMs >= 3600000; });
    return [header].concat(f.turns.map(function (t) { return '[' + stampMs(t.elapsedMs, hours) + '] ' + t.speaker + ': ' + t.text; })).join('\n');
  }
  function openLive(sid) {
    S.view = 'live';
    if (S.liveSid !== sid) { S.liveSid = sid; S.follow = true; S.confirm = ''; S.liveCopy = ''; S.liveReason = ''; }
    var f = feedFor(sid);
    A(sid).ctx = { live: true };
    W.setCrumb(liveTitle(f));
    pane.innerHTML = '<div class="cx mt mt-livev" data-tint="meetings"><div id="mt-lhead"></div><div class="mt-lgrid"><div class="mt-lmain">' +
      '<div id="mt-turns" class="mt-turns" aria-live="polite"></div><div id="mt-lfoot"></div></div>' +
      '<aside class="mt-side-panel" id="mt-ask-' + safeId(sid) + '">' + sidePanelHtml(sid) + '</aside></div></div>';
    S.headHtml = S.footHtml = null;
    paintLiveHead(); paintTurns(true); paintLiveFoot();
    clearInterval(S.liveTimer);
    livePoll();
    S.liveTimer = setInterval(livePoll, 1500);
    panelOpen(sid);
  }
  function liveTitle(f) { return f.titleSteer || sourceLabel(f.sid, f.start); }
  function livePoll() {
    if (document.hidden || S.livePolling || S.view !== 'live') return;
    var f = S.feeds[S.liveSid]; if (!f) return;
    var now = Date.now();
    if (f.endedAt) {
      handoff(f, now);
      if (now - f.statusAt >= STATUS_ENDED_MS && f.phase !== 'saved') askStatus(f, now);
      if (f.phase === 'saved') findSaved(f);
      paintLiveHead();
      return;
    }
    S.livePolling = true;
    answer('/api/meetings/live-chunks?sessionId=' + encodeURIComponent(f.sid) + '&since=' + f.cursor + (f.stamp ? '&stamp=' + encodeURIComponent(f.stamp) : '') + (f.rev != null ? '&speakerRevision=' + f.rev : '')).then(function (a) {
      S.livePolling = false;
      if (S.view !== 'live' || S.liveSid !== f.sid) return;
      if (a.status !== 200) { S.liveReason = a.status === 0 ? 'server_stopped' : (typeof a.body.reason === 'string' && /^[a-z0-9_]{1,40}$/.test(a.body.reason) ? a.body.reason : 'unavailable'); paintLiveFoot(); return; }
      S.liveReason = '';
      var t = Date.now(), files = a.body.sessions || [];
      S.files = files;
      var file = files.filter(function (s) { return s.sessionId === f.sid; })[0];
      var changed = applyRead(f, a.body.read, t);
      if (file) { var m = num(file.mtimeMs); if (!f.last || m > f.last) f.last = m; }
      else if (!f.endedAt) changed = markEnded(f, t) || changed;
      if (!f.endedAt && f.last && t - f.last >= QUIET_MS && t - f.statusAt >= STATUS_QUIET_MS) askStatus(f, t);
      paintLiveHead(); paintLiveFoot();
      if (changed) paintTurns(false);
    });
  }
  // Once saved, the saved meeting opens here (found by its session on the start day or today).
  function findSaved(f) {
    var now = Date.now();
    if (f.lookupBusy || now - (f.lookupAt || 0) < 5000) return;
    f.lookupBusy = true; f.lookupAt = now;
    var days = [];
    [f.start, now].forEach(function (v) { if (v) { var k = dayKey(new Date(v)); if (days.indexOf(k) < 0) days.push(k); } });
    Promise.all(days.map(function (day) { return api('/api/meetings?limit=200&domain=all&day=' + day).then(function (d) { return (d && d.meetings) || []; }, function () { return []; }); })).then(function (lists) {
      f.lookupBusy = false;
      var hit = lists.reduce(function (all, l) { return all.concat(l); }, []).filter(function (m) { return m.sessionId === f.sid || (m.g2SessionIds || []).indexOf(f.sid) >= 0; })[0];
      if (hit && S.view === 'live' && S.liveSid === f.sid) {
        S.rows = null;
        location.replace('#/meetings/' + [hit.domain, hit.month, hit.filename].map(encodeURIComponent).join('/'));
      } else if (!hit && f.endedAt && now - (f.retryAt || f.endedAt) >= FINAL_DEADLINE_MS + (f.start ? Math.max(0, f.endedAt - f.start) / 12 : 0)) {
        f.notFound = true; paintLiveHead();
      }
    });
  }
  function liveHandoffLine(f) {
    if (!f.endedAt) return '';
    if (f.phase === 'saved' && !f.notFound || f.phase === 'finalizing') return '<p class="mt-muted mt-handoff">Finalizing · the saved meeting opens here when it is ready</p>';
    if (f.phase === 'notFoundYet' || f.notFound) return '<p class="mt-handoff"><span class="mt-amber">Saved meeting not found yet</span> <button type="button" class="cx-btn quiet" data-mt="handoff-refresh" data-sid="' + esc(f.sid) + '">Refresh</button></p>';
    if (f.phase === 'endedUnsaved') return '<p class="mt-handoff mt-amber"><strong>Recording ended without saving</strong></p>';
    return '<p class="mt-muted mt-handoff">Recording ended</p>';
  }
  function paintLiveHead() {
    var el = $('mt-lhead'); if (!el || S.view !== 'live') return;
    var f = S.feeds[S.liveSid]; if (!f) return;
    var now = Date.now(), ended = !!f.endedAt, sid = f.sid;
    var status = isPhone(sid) ? (ended ? 'iPhone microphone recording ended' : 'Recording on iPhone microphone')
      : (ended ? '' : (isMac(sid) ? 'Recording on this Mac' : 'Recording on the glasses') + (f.titleSteer && f.start ? ' · started ' + clockOf(new Date(f.start)) : ''));
    var quiet = ended ? null : quietLabel(f.last, now);
    var sub = f.titleSteer && f.start && !isPhone(sid) ? (durationLabel(f.start, now, f.endedAt) || 'Starting') : liveSubtitle(f.start, now, f.endedAt);
    var controls = '';
    if (!ended && isGlasses(sid)) controls = '<button type="button" class="cx-btn quiet" data-mt="stop-ask" data-sid="' + esc(sid) + '"' + (stopping(sid) ? ' disabled' : '') + '>Stop and save</button>';
    else if (!ended && isPhone(sid)) controls = '<span class="mt-side-note">Stop on iPhone</span>';
    var line = stopLineFor(sid);
    var html = '<div class="mt-dhead mt-lhead"><div class="mt-ltitle"><span class="mt-livedot big' + (ended ? '' : ' on') + '"></span><h2 class="mt-dtitle">' + esc(liveTitle(f)) + '</h2></div>' +
      (status ? '<p class="mt-lstatus">' + esc(status) + '</p>' : '') +
      (isPhone(sid) ? '<p class="mt-muted">iPhone microphone recordings are anonymous. Names and voice training are unavailable.</p>' : '') +
      '<p class="mt-muted">' + esc(LIVE_HEADER) + '</p>' +
      (isMac(sid) ? '<p class="mt-muted">Mac playback · microphone off · voice numbers do not identify people</p>' : '') +
      '<p class="mt-lsub">' + esc(sub) + (quiet ? '<span class="mt-amber"> · ' + esc(quiet) + '</span>' : '') + '</p>' +
      liveHandoffLine(f) +
      (line ? '<p class="mt-stopline' + (S.stop && S.stop.nothing ? ' bad' : '') + '">' + esc(line) + '</p>' : '') +
      (controls ? '<div class="mt-bar">' + controls + '</div>' : '') +
      (S.confirm === 'stop:' + sid ? confirmCard(STOP_TITLE, STOP_LINE, 'stop-yes', 'Stop and save', 'Cancel', sid) : '') + '</div>';
    if (html !== S.headHtml) { S.headHtml = html; el.innerHTML = html; }
    if (W.crumb() !== liveTitle(f)) W.setCrumb(liveTitle(f));
  }
  function paintTurns(force) {
    var el = $('mt-turns'); if (!el) return;
    var sel = window.getSelection && window.getSelection();
    // A selection in the transcript holds it still, as Control does while you select.
    if (!force && sel && !sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode)) { S.turnsDirty = true; return; }
    S.turnsDirty = false;
    var f = S.feeds[S.liveSid]; if (!f) return;
    var hours = f.turns.some(function (t) { return t.elapsedMs >= 3600000; });
    el.innerHTML = f.turns.length ? f.turns.map(function (t) {
      return '<div class="mt-lturn" data-turn="' + t.id + '"><div class="mt-lwho"><span class="mt-lname">' + esc(t.speaker) + '</span><span class="mt-lstamp">' + esc(stampMs(t.elapsedMs, hours)) + '</span></div>' +
        t.text.split(/\n{2,}/).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') + '</div>';
    }).join('') : '<p class="mt-lempty">' + esc(f.endedAt ? 'No words were transcribed before the recording ended.' : 'Waiting for the first words. Text appears a few seconds after it is spoken.') + '</p>';
    if (S.follow) jumpToLive(); else paintLiveFoot();
    repaintAskEnabled(f.sid);
  }
  // A question needs words: the panel's buttons follow the transcript's first turn.
  function repaintAskEnabled(sid) {
    var a = A(sid), en = askEnabled(sid);
    if (a.lastEnabled !== en) { a.lastEnabled = en; repaintAsk(sid); }
  }
  function jumpToLive() {
    var el = $('mt-turns'), last = el && el.lastElementChild;
    if (last) { S.autoScroll = Date.now(); last.scrollIntoView({ block: 'end' }); }
    S.follow = true; paintLiveFoot();
  }
  function paintLiveFoot() {
    var el = $('mt-lfoot'); if (!el || S.view !== 'live') return;
    var f = S.feeds[S.liveSid], has = !!(f && f.turns.length);
    var html = '<div class="mt-bar"><button type="button" class="cx-btn primary" data-mt="live-copy"' + (has ? '' : ' disabled') + '>Copy transcript</button>' +
      '<button type="button" class="cx-btn quiet" data-mt="live-context">Copy full context</button>' +
      (!S.follow && has ? '<button type="button" class="cx-btn quiet" data-mt="jump">Jump to live</button>' : '') + '</div>' +
      (S.liveCopy ? '<p class="mt-copynote">' + esc(S.liveCopy) + '</p>' : S.liveReason ? '<p class="mt-copynote mt-amber">' + esc('Live transcript paused · ' + S.liveReason.replace(/_/g, ' ')) + '</p>' : '');
    if (html !== S.footHtml) { S.footHtml = html; el.innerHTML = html; }
  }
  function liveCopy(kind) {
    var f = S.feeds[S.liveSid]; if (!f) return;
    function done(text) { S.liveCopy = text; paintLiveFoot(); }
    if (kind === 'transcript') { W.copyText(liveCopyText(f)).then(function () { done('Copied transcript'); }, function (err) { done(err.message); }); return; }
    done('Preparing full context…');
    loadConfig().then(function (conf) {
      if (!conf) { done('Refresh meeting assistance before copying its full context.'); return; }
      return askOpen(f.sid, true).then(function () { return loadCues(f.sid, true); }).then(function () {
        var a = A(f.sid);
        var cueNote = a.cues ? null : (a.cuesState && a.cuesState !== 'older' ? 'Context coverage: cues could not be read from the server.' : null);
        var text = fullContext('Live meeting', f.turns.length ? liveCopyText(f) : '', a.history, evidenceFiles(a.history, a.files || []), a.cues || [], cueNote) + (a.error ? '\n\nContext coverage: ' + a.error : '');
        W.copyText(text).then(function () { done('Copied full meeting context'); }, function (err) { done(err.message); });
      });
    });
  }
  function onScroll() {
    if (S.view !== 'live' || Date.now() - (S.autoScroll || 0) < 600) return;
    var el = $('mt-turns'), last = el && el.lastElementChild;
    if (!last) return;
    var atEnd = last.getBoundingClientRect().bottom <= window.innerHeight + 40;
    if (atEnd !== S.follow) { S.follow = atEnd; paintLiveFoot(); if (atEnd && S.turnsDirty) paintTurns(false); }
  }

  // ── list shell ────────────────────────────────────────
  function renderList() {
    S.view = 'list';
    S.liveHtml = null;
    pane.innerHTML = '<div class="cx mt" data-tint="meetings"><div id="mt-hero"></div><div id="mt-orphans"></div><div id="mt-live"></div>' +
      '<div id="mt-cal"></div><div id="mt-toolbar"></div><div id="mt-list"></div></div>';
    paintHero(); paintOrphans(); paintLive(); paintCal(); paintToolbar(); paintList();
  }
  function stopTimers() { clearInterval(S.listTimer); clearInterval(S.liveTimer); S.listTimer = null; S.liveTimer = null; }

  // ── events ────────────────────────────────────────────
  function exchangeOf(sid, req) { return A(sid).history.filter(function (x) { return x.requestId === req; })[0]; }
  pane.addEventListener('click', function (e) {
    var t = e.target.closest('[data-mt]');
    if (!t || t.disabled || !pane.contains(t)) return;
    var act = t.getAttribute('data-mt'), sid = t.getAttribute('data-sid') || '', req = t.getAttribute('data-req') || '';
    var ex, a;
    switch (act) {
      case 'refresh': S.rows = null; loadMonth(); loadOrphans(); pollFiles(); if (queryActive()) runSearch(); return;
      case 'month': shiftMonth(Number(t.getAttribute('data-delta')) || 0); return;
      case 'day': { var d = t.getAttribute('data-day'); S.day = S.day === d ? null : d; S.autoDay = true; paintBrowse(); ensureDay(); return; }
      case 'all-month': S.day = null; S.autoDay = true; paintBrowse(); return;
      case 'clear': {
        S.q = ''; S.hits = null; S.ranFor = ''; S.searching = false; S.searchError = ''; clearTimeout(S.qTimer);
        var q = $('mt-q'); if (q) { q.value = ''; q.focus(); }
        paintBrowse(); return;
      }
      case 'open': W.go('meetings', t.getAttribute('data-key').split('|')); return;
      case 'live': W.go('meetings', ['live', sid]); return;
      case 'stop-ask': S.confirm = 'stop:' + sid; S.liveHtml = null; liveChanged(); return;
      case 'end-ask': S.confirm = 'end:' + sid; S.liveHtml = null; liveChanged(); return;
      case 'confirm-no': S.confirm = ''; S.orphans.confirm = ''; S.liveHtml = null; liveChanged(); paintOrphans(); return;
      case 'stop-yes': stopGlasses(sid); return;
      case 'end-yes': endAndSave(sid); return;
      case 'handoff-refresh': {
        var f = S.feeds[sid]; if (!f) return;
        f.retryAt = Date.now(); f.notFound = false; f.lookupAt = 0; f.phase = 'finalizing'; f.statusAt = 0;
        askStatus(f, Date.now()); liveChanged(); return;
      }
      case 'recover': orphanTask(function () { return recoverOne(sid).then(function (r) { return r.text; }); }); return;
      case 'recover-all-ask': S.orphans.confirm = 'recover-all'; paintOrphans(); return;
      case 'recover-all-yes': orphanTask(recoverAll); return;
      case 'save-stranded': orphanTask(function () { return saveOne(sid).then(function (r) { return r.text; }); }); return;
      case 'save-all-ask': S.orphans.confirm = 'save-all'; paintOrphans(); return;
      case 'save-all-yes': orphanTask(saveAllStranded); return;
      case 'detail-retry': { var r = routeArgs() || []; S.detailKey = ''; if (r.length >= 3) openDetail(r[0], r[1], r.slice(2).join('/')); return; }
      case 'copy-context': copyDetail('context'); return;
      case 'copy-summary': copyDetail('summary'); return;
      case 'copy-transcript': copyDetail('transcript'); return;
      case 'download': downloadDetail(); return;
      case 'review': location.hash = '#/speakers/review/' + encodeURIComponent(sid); return;
      case 'panel': {
        a = A(sid); a.view = t.getAttribute('data-view') === 'cues' ? 'cues' : 'ask'; repaintAsk(sid);
        if (a.view === 'cues') loadCues(sid, true);
        return;
      }
      case 'ask-refresh': loadConfig(true).then(function () { panelOpen(sid); }); return;
      case 'ask-act': submit(sid, t.getAttribute('data-action'), t.getAttribute('data-q')); return;
      case 'ask-retry': ex = exchangeOf(sid, req); if (ex) submit(sid, ex.action, ex.question, ex.requestId); return;
      case 'ask-stop': cancelAnswer(sid, req); return;
      case 'ask-copy': ex = exchangeOf(sid, req); if (ex) W.copyText(ex.answer != null ? ex.answer : ex.question).then(function () { W.toast('Copied'); }, function (err) { W.toast(err.message); }); return;
      case 'ask-check': reconcile(sid); return;
      case 'ask-resend': a = A(sid); if (a.outbox && online() && !a.running) { a.error = ''; send(sid); } return;
      case 'follow-open': {
        ex = exchangeOf(sid, req); if (!ex) return;
        a = A(sid);
        var sw = (ex.sections || []).filter(function (s) { return s.label === 'So what'; })[0];
        a.follow = ex.requestId; a.followText = String((sw && sw.text) || ex.answer || '').replace(/\[[A-Za-z][0-9]+\]/g, '').slice(0, 600);
        repaintAsk(sid); return;
      }
      case 'follow-cancel': A(sid).follow = null; repaintAsk(sid); return;
      case 'follow-save': saveFollowUp(sid); return;
      case 'cues-refresh': loadCues(sid, true); return;
      case 'live-copy': liveCopy('transcript'); return;
      case 'live-context': liveCopy('context'); return;
      case 'jump': jumpToLive(); return;
    }
  });
  pane.addEventListener('input', function (e) {
    var t = e.target, sid;
    if (t.id === 'mt-q') {
      var was = queryActive();
      S.q = t.value;
      clearTimeout(S.qTimer);
      if (!queryActive()) { S.hits = null; S.ranFor = ''; S.searching = false; S.searchError = ''; paintBrowse(); return; }
      if (!was) paintBrowse(); else paintToolbarBits();
      S.qTimer = setTimeout(runSearch, 350);
      return;
    }
    if (t.classList.contains('mt-ask-input')) {
      sid = t.getAttribute('data-sid'); setDraft(sid, t.value); grow(t);
      var btn = t.form && t.form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = askBlocked(sid) || !t.value.trim();
      return;
    }
    if (t.classList.contains('mt-follow-text')) {
      sid = t.getAttribute('data-sid'); var a = A(sid); a.followText = t.value;
      var save = t.parentNode.querySelector('[data-mt="follow-save"]');
      if (save) save.disabled = a.followBusy || !t.value.trim() || t.value.trim().length > 600 || !online();
    }
  });
  pane.addEventListener('change', function (e) {
    if (e.target.id === 'mt-recency') { S.recency = e.target.value; paintBrowse(); }
    else if (e.target.id === 'mt-dom') { S.domain = e.target.value; if (queryActive()) runSearch(); else paintBrowse(); }
  });
  pane.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.matches('[data-mt-form]')) { e.preventDefault(); clearTimeout(S.qTimer); var q = $('mt-q'); if (q) q.blur(); runSearch(); return; }
    if (f.hasAttribute('data-mt-ask')) { e.preventDefault(); var sid = f.getAttribute('data-mt-ask'); submit(sid, 'ask', A(sid).draft); }
  });
  // Return sends the question (Control's composer); Shift-Return is a new line.
  pane.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('mt-ask-input') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      var sid = t.getAttribute('data-sid'); submit(sid, 'ask', A(sid).draft);
    }
  });
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (S.view === 'list') { pollFiles(); loadOrphans(); } else if (S.view === 'live') livePoll();
  });

  W.registerPane('meetings', {
    load: function (args) {
      args = args || [];
      stopTimers();
      if (args[0] === 'live' && args[1]) { openLive(args[1]); return; }
      if (args.length >= 3) { openDetail(args[0], args[1], args.slice(2).join('/')); return; }
      renderList();
      if (!S.rows && !S.loading) loadMonth();
      loadOrphans();
      pollFiles();
      S.listTimer = setInterval(function () { if (S.view === 'list') pollFiles(); }, 3000);
      if (queryActive() && S.ranFor !== S.q.trim() && !S.searching) runSearch();
    },
    leave: function () { stopTimers(); S.view = ''; }
  });
})();
