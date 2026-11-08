/* The preview engine's web viewer (phase 1, PLAN_preview_engine_2026-11-08 4d). Link cards where a reply links a local
 * file, and one viewer for what a card or a sent file opens: Markdown rendered with the reply renderer, text and code
 * with line numbers and jump-to-line, CSV and TSV as a table, HTML with scripts off (a per-open "Run scripts" runs them
 * in an opaque origin with no network), a PDF inline on a desktop and in a new tab on a phone, pictures through the
 * normalizer. Only opaque ids reach the server (GET /api/preview/...); a Mac path never reaches this page.
 * The viewer shell (history, Back, focus, scroll restore, the 2-request budget) is panes/reader-media.js. */
(function () {
  'use strict';
  var W = window.COSWeb;
  if (!W) return;
  var LINK_ID = /^al_[a-f0-9]{64}$/, FILE_ID = /^af_[a-f0-9]{64}$/;
  var KINDS = ['image', 'pdf', 'html', 'markdown', 'text', 'code', 'table', 'document', 'slides', 'sheet', 'audio', 'video', 'archive', 'folder', 'file'];
  var OFF = 'Not available on this Mac';
  var REASONS = { outside_workspace: OFF, missing: OFF, secret_file: 'Not shown: this file may hold secrets.', unavailable: 'Not available right now. Reopen the session to check again.' };
  var NORMALIZED = /\.(png|jpe?g|webp|hei[cf]|avif)$/i;
  var THUMBS = { pdf: 1, document: 1, slides: 1, sheet: 1 };
  var style = document.createElement('style');
  style.textContent = '.pv-chip{display:inline-flex;align-items:center;gap:8px;vertical-align:middle;max-width:100%;min-height:44px;margin:2px 0;padding:4px 10px 4px 4px;border:1px solid var(--panel-border);border-radius:10px;background:var(--panel);color:var(--text);font:inherit;text-align:left;cursor:pointer;box-sizing:border-box}' +
    'button.pv-chip:hover{border-color:var(--sub)}button.pv-chip:focus-visible{outline:2px solid var(--accent,currentColor);outline-offset:2px}' +
    '.pv-badge{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:34px;padding:0 4px;border-radius:7px;background:var(--bg);border:1px solid var(--panel-border);font:600 10.5px/1 var(--body);letter-spacing:.04em;color:var(--sub);box-sizing:border-box}' +
    '.pv-chip-text{display:inline-flex;flex-direction:column;min-width:0;line-height:1.25}.pv-chip-label{font:500 14px/1.3 var(--body);overflow-wrap:anywhere}.pv-chip-meta{font:12px/1.3 var(--body);color:var(--sub);overflow-wrap:anywhere}' +
    '.pv-chip.off{cursor:default;opacity:.8;border-style:dashed}.pv-chip.off .pv-chip-meta{color:var(--sub)}.pv-chip.blocked .pv-badge{color:var(--amber,var(--sub))}' +
    '.pv-chip.has-thumb{padding:4px 12px 4px 4px}.pv-thumb{flex:none;display:inline-flex;align-items:center;justify-content:center;width:48px;height:62px;overflow:hidden;border-radius:6px;background:#fff;border:1px solid var(--panel-border);font:600 10.5px/1 var(--body);color:#6e675d}.pv-thumb img{width:100%;height:100%;object-fit:contain;display:block}' +
    '.pv-scroll{flex:1;min-height:0;width:100%;overflow:auto;border:1px solid var(--panel-border);border-radius:10px;background:var(--panel)}' +
    '.pv-md{padding:12px 16px;max-width:none}.pv-code{font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;padding:6px 0;min-width:max-content}.pv-line{display:flex;scroll-margin:40px 0}.pv-line.hit{background:var(--gold-bg,rgba(185,138,62,.14))}' +
    '.pv-n{flex:none;width:4.2em;padding-right:12px;text-align:right;color:var(--sub);user-select:none;-webkit-user-select:none}.pv-t{white-space:pre;padding-right:16px}' +
    '.pv-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;width:100%}.pv-bar .rm-status{flex:1;min-width:12em}.pv-jump{display:flex;gap:6px;align-items:center}.pv-jump input{width:6.5em;min-height:44px;padding:0 10px;border:1px solid var(--panel-border);border-radius:10px;background:var(--panel);color:var(--text);font:14px var(--body);box-sizing:border-box}' +
    '.pv-table{border-collapse:collapse;font:13px/1.4 var(--body);min-width:100%}.pv-table th,.pv-table td{padding:6px 10px;border-bottom:1px solid var(--panel-border);text-align:left;vertical-align:top;max-width:28em;overflow-wrap:anywhere}.pv-table thead th{position:sticky;top:0;background:var(--panel);z-index:1;font-weight:600}.pv-table td.pv-rn,.pv-table th.pv-rn{color:var(--sub);text-align:right;width:1%;white-space:nowrap}' +
    '.pv-frame{flex:1;min-height:0;width:100%;border:1px solid var(--panel-border);border-radius:10px;background:#fff}.pv-other{display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center}.pv-other .pv-thumb{width:160px;height:206px}' +
    '.rm-view-body.pv-body{align-items:stretch;justify-content:flex-start}';
  document.head.appendChild(style);

  function element(tag, cls, text) { var el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; }
  function button(text, action, cls) { var b = element('button', cls || 'cx-btn quiet', text); b.type = 'button'; b.addEventListener('click', action); return b; }
  function kindOf(name) {
    var n = String(name || '');
    var map = [[NORMALIZED, 'image'], [/\.gif$/i, 'image'], [/\.pdf$/i, 'pdf'], [/\.html?$/i, 'html'], [/\.(md|markdown|mdx)$/i, 'markdown'],
      [/\.(csv|tsv)$/i, 'table'], [/\.(txt|log|text)$/i, 'text'],
      [/\.(json|jsonl|ya?ml|toml|xml|svg|tsx?|mts|cts|jsx?|mjs|cjs|py|swift|sh|zsh|bash|s?css|rb|go|rs|java|kt|c|h|cc|cpp|hpp|m|mm|sql|lua|php|plist|ini|conf|cfg|properties)$/i, 'code'],
      [/\.(docx?|pages|rtf)$/i, 'document'], [/\.(xlsx?|numbers)$/i, 'sheet'], [/\.(pptx?|key)$/i, 'slides'],
      [/\.(wav|mp3|m4a|aac|flac|aiff?)$/i, 'audio'], [/\.(mp4|mov|webm|m4v)$/i, 'video'], [/\.(zip|tar|gz|tgz|bz2|xz|7z|ehpk)$/i, 'archive']];
    for (var i = 0; i < map.length; i++) if (map[i][0].test(n)) return map[i][1];
    return 'file';
  }
  // The checked DTO. Anything else from the server is ignored; a card never trusts a field it did not expect.
  function clean(dto) {
    if (!dto || (!LINK_ID.test(dto.id || '') && !FILE_ID.test(dto.id || '')) || ['available', 'unavailable'].indexOf(dto.state) < 0) return null;
    var name = String(dto.name || 'File').slice(0, 120);
    return {
      id: dto.id, name: name, label: String(dto.label || name).slice(0, 120),
      kind: KINDS.indexOf(dto.kind) >= 0 ? dto.kind : kindOf(name), type: String(dto.type || 'File').slice(0, 40),
      size: typeof dto.size === 'number' && dto.size >= 0 ? dto.size : null,
      line: Math.max(0, Math.min(9999999, Math.floor(Number(dto.line)) || 0)) || null,
      state: dto.state, reason: REASONS[dto.reason] ? dto.reason : (dto.state === 'available' ? null : 'unavailable')
    };
  }
  function parts(f) {
    if (f.kind === 'folder' || f.state !== 'available') return [];
    var p = ['raw'];
    if (f.kind === 'pdf' || (f.kind === 'image' && NORMALIZED.test(f.name))) p.push('inline');
    if (['markdown', 'text', 'code', 'html', 'table'].indexOf(f.kind) >= 0) p.push('text');
    if (f.kind === 'table') p.push('table');
    if (f.kind === 'html') p.push('html', 'html-run');
    if (THUMBS[f.kind] || f.kind === 'html' || (f.kind === 'image' && NORMALIZED.test(f.name))) p.push('thumb');
    return p;
  }
  function url(scope, id, part, q) {
    return '/api/preview/agent-sessions/' + encodeURIComponent(scope.provider) + '/' + encodeURIComponent(scope.id) + '/' + encodeURIComponent(id) + '/content?part=' + part + (q || '');
  }
  function bytesWords(n) {
    if (typeof n !== 'number' || !(n >= 0)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }
  function badge(f) {
    if (f.kind === 'folder') return 'DIR';
    if (f.kind === 'markdown') return 'MD';
    var ext = /\.([a-z0-9]{1,4})$/i.exec(f.name); return ext ? ext[1].toUpperCase() : 'FILE';
  }
  function failWords(err) {
    if (err && err.status === 401) return 'Signed out. Connect this browser again to open the file.';
    if (err && err.status === 403) return err.code === 'secret_file_denied' ? REASONS.secret_file : 'Previews are off. Turn them on in Settings, Privacy.';
    if (err && err.status === 404) return 'This file is no longer in the recent turns. Reopen the session to refresh it.';
    if (err && err.status === 413) return 'Too large to open here. Open it on your Mac.';
    if (err && err.status === 415) return 'This file is not text. Download it instead.';
    return 'The file could not load. Check that your Mac is awake, then retry.';
  }
  function metaWords(f) {
    if (f.kind === 'folder') return 'Folder · Open it on your Mac';
    if (f.state !== 'available') return f.type + ' · ' + (REASONS[f.reason] || OFF);
    return [f.type, bytesWords(f.size), f.line ? 'line ' + f.line : ''].filter(Boolean).join(' · ');
  }

  // A card where the link sits. An unavailable, blocked or folder card is words, never a button.
  function chip(scope, dto, words, onOpen) {
    var f = clean(dto); if (!f) return null;
    var open = f.state === 'available' && f.kind !== 'folder';
    var el = element(open ? 'button' : 'span', 'pv-chip' + (open ? '' : ' off') + (f.reason === 'secret_file' ? ' blocked' : ''));
    if (open) { el.type = 'button'; el.setAttribute('aria-label', 'Open ' + f.type + ': ' + f.name + (f.line ? ', line ' + f.line : '')); }
    var lead = element('span', 'pv-badge', badge(f)); lead.setAttribute('aria-hidden', 'true');
    var text = element('span', 'pv-chip-text');
    text.appendChild(element('span', 'pv-chip-label', String(words || f.label).slice(0, 120)));
    text.appendChild(element('span', 'pv-chip-meta', metaWords(f)));
    var card = { el: el, f: f, url: '', generation: 0 };
    if (open && f.kind === 'pdf' && parts(f).indexOf('thumb') >= 0) {
      el.className += ' has-thumb'; lead = element('span', 'pv-thumb', 'PDF'); lead.setAttribute('aria-hidden', 'true'); card.thumb = lead;
    }
    el.appendChild(lead); el.appendChild(text);
    if (open) el.addEventListener('click', function () { onOpen(f, el); });
    return card;
  }

  // ── Renderers. `v` is the viewer shell from reader-media.js: { body, acts, alive(), request(url, foreground, type) } ──
  function status(v, words) { v.body.textContent = ''; var p = element('p', 'rm-status', words); p.setAttribute('role', 'status'); v.body.appendChild(p); return p; }
  function fail(v) { return function (err) { if (v.alive()) status(v, failWords(err)); }; }
  function textPart(v, scope, f, offset, limit) {
    return v.request(url(scope, f.id, 'text', '&offset=' + (offset || 0) + (limit ? '&limit=' + limit : '')), true, 'json').then(function (d) {
      if (!d || typeof d.text !== 'string') throw new Error('No text');
      return d;
    });
  }
  function moreButton(v, words, run) { var b = button(words, function () { b.disabled = true; b.textContent = 'Loading…'; run(b); }); return b; }

  function renderMarkdown(v, scope, f) {
    var all = '';
    var box = element('div', 'pv-scroll'), md = element('div', 'sx-md pv-md'); box.appendChild(md);
    function load(offset) {
      return textPart(v, scope, f, offset).then(function (d) {
        if (!v.alive()) return;
        all += d.text;
        // The reply renderer: everything escaped first, a small subset of Markdown, links only to https.
        md.innerHTML = W.sessionKit && W.sessionKit.markdown ? W.sessionKit.markdown(all) : '';
        if (!md.innerHTML) md.textContent = all;
        if (box.parentNode !== v.body) { v.body.textContent = ''; v.body.appendChild(box); }
        if (d.more) md.appendChild(moreButton(v, 'Show more', function () { load(d.end); }));
      });
    }
    load(0).catch(fail(v));
  }

  function renderCode(v, scope, f) {
    var box = element('div', 'pv-scroll'), code = element('div', 'pv-code'), lines = [], next = 1, carry = '', loaded = false;
    box.appendChild(code);
    var bar = element('div', 'pv-bar'), note = element('span', 'rm-status');
    var jump = element('form', 'pv-jump'), input = element('input'); input.type = 'number'; input.min = '1'; input.inputMode = 'numeric'; input.setAttribute('aria-label', 'Line number'); input.placeholder = 'Line';
    jump.appendChild(input); jump.appendChild(button('Go to line', function () { go(Number(input.value)); }));
    jump.addEventListener('submit', function (e) { e.preventDefault(); go(Number(input.value)); });
    bar.appendChild(jump); bar.appendChild(note);
    var more = null, end = 0;
    function addLines(text, final) {
      var parts = (carry + text).split('\n');
      carry = final ? '' : parts.pop();
      if (final && parts.length && parts[parts.length - 1] === '' ) parts.pop();
      parts.forEach(function (t) {
        var row = element('div', 'pv-line'); row.setAttribute('data-line', String(next));
        row.appendChild(element('span', 'pv-n', String(next))); row.appendChild(element('span', 'pv-t', t || ' '));
        code.appendChild(row); lines.push(row); next++;
      });
    }
    function go(n) {
      n = Math.floor(n);
      if (!(n >= 1)) return;
      if (n > lines.length) { note.textContent = more ? 'Line ' + n + ' is further down. Show more first.' : 'This file has ' + lines.length + ' lines.'; return; }
      lines.forEach(function (r) { r.classList.remove('hit'); });
      var row = lines[n - 1]; row.classList.add('hit');
      try { row.scrollIntoView({ block: 'center' }); } catch (_e) { box.scrollTop = row.offsetTop - 40; }
      note.textContent = 'Line ' + n;
    }
    function load(offset) {
      return textPart(v, scope, f, offset).then(function (d) {
        if (!v.alive()) return;
        addLines(d.text, !d.more); end = d.end;
        if (!loaded) { loaded = true; v.body.textContent = ''; v.body.appendChild(bar); v.body.appendChild(box); }
        if (more) { more.remove(); more = null; }
        if (d.more) { more = moreButton(v, 'Show more', function () { load(end); }); code.appendChild(more); }
        if (f.line && lines.length >= f.line && !box.__jumped) { box.__jumped = true; input.value = String(f.line); go(f.line); }
        else if (f.line && !d.more && !box.__jumped) { box.__jumped = true; go(f.line); }
      });
    }
    load(0).catch(fail(v));
  }

  function renderTable(v, scope, f) {
    var box = element('div', 'pv-scroll'), table = element('table', 'pv-table'), head = element('thead'), body = element('tbody'), note = element('p', 'rm-status');
    table.appendChild(head); table.appendChild(body); box.appendChild(table);
    var more = null, shown = 0;
    function load(offset) {
      return v.request(url(scope, f.id, 'table', '&offset=' + offset), true, 'json').then(function (d) {
        if (!v.alive()) return;
        if (!d || !Array.isArray(d.rows) || !Array.isArray(d.header)) throw new Error('No table');
        if (!shown && !head.firstChild) {
          var tr = element('tr'); tr.appendChild(element('th', 'pv-rn', '#'));
          d.header.forEach(function (c) { var th = element('th', '', String(c)); th.setAttribute('scope', 'col'); tr.appendChild(th); });
          head.appendChild(tr);
          v.body.textContent = ''; v.body.appendChild(box); v.body.appendChild(note);
        }
        d.rows.forEach(function (r) {
          var tr = element('tr'); shown++; tr.appendChild(element('td', 'pv-rn', String(shown)));
          for (var k = 0; k < d.header.length || k < r.length; k++) tr.appendChild(element('td', '', String(r[k] == null ? '' : r[k])));
          body.appendChild(tr);
        });
        if (more) { more.remove(); more = null; }
        var words = [shown + (shown === 1 ? ' row' : ' rows') + ' shown'];
        if (d.capped && !d.more) words.push('The preview stops at 5,000 rows. Download it for the rest.');
        if (d.columnsCut) words.push('Only the first 50 columns are shown.');
        note.textContent = words.join('. ') + (words.length > 1 ? '' : '.');
        if (d.more) { more = moreButton(v, 'Show 200 more rows', function () { load(d.next); }); v.body.appendChild(more); }
      });
    }
    load(0).catch(fail(v));
  }

  // HTML is served by the server under its own sandbox CSP (scripts off, no network), with the same policy injected as a
  // <meta> at the top of the page. The frame is sandboxed too and never gets allow-same-origin. Full length.
  function renderHtml(v, scope, f) {
    var bar = element('div', 'pv-bar'), note = element('span', 'rm-status'), toggle = null, frame = null, on = false;
    function show() {
      if (frame) frame.remove();
      frame = element('iframe', 'pv-frame');
      frame.setAttribute('sandbox', on ? 'allow-scripts' : '');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = 'Preview of ' + f.name + (on ? ' (scripts on, no network)' : ' (scripts off)');
      frame.src = url(scope, f.id, on ? 'html-run' : 'html');
      v.body.appendChild(frame);
      // Honest words: with scripts on, the page still cannot fetch anything or read COS, but a script can move its own
      // frame to another address (no browser can stop that), so "cannot reach the internet" would overclaim.
      note.textContent = on ? 'Scripts are on for this view only. They cannot fetch data or read COS.' : 'Scripts are off. Nothing on this page loads from the internet.';
      toggle.textContent = on ? 'Turn scripts off' : 'Run scripts';
      toggle.setAttribute('aria-pressed', String(on));
    }
    toggle = button('Run scripts', function () { on = !on; show(); });
    bar.appendChild(toggle); bar.appendChild(note);
    v.body.textContent = ''; v.body.appendChild(bar);
    show();
  }

  // Decision 4a: a PDF opens inline on a desktop and in its own tab on a phone. "Phone" here is any touch-first screen,
  // the unfolded Duo (703 wide) included: iOS Safari draws only part of a PDF inside a frame (plan canary 17, unrun).
  function isPhone() {
    try {
      if (typeof W.isPhone === 'function' && W.isPhone()) return true;
      return !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
    } catch (_e) { return false; }
  }
  function renderPdf(v, scope, f) {
    v.body.textContent = '';
    if (isPhone()) {
      var p = element('p', 'rm-status', 'PDFs open in a new tab on a phone.'); v.body.appendChild(p);
      var a = element('a', 'cx-btn', 'Open ' + f.name); a.href = url(scope, f.id, 'inline'); a.target = '_blank'; a.rel = 'noopener'; v.body.appendChild(a);
      return;
    }
    // Same origin, so the browser's own PDF viewer draws it; the server sends it as application/pdf, nosniff.
    var frame = element('iframe', 'pv-frame'); frame.title = f.name; frame.src = url(scope, f.id, 'inline');
    v.body.appendChild(frame);
  }

  function renderImage(v, scope, f) {
    status(v, 'Loading image…');
    var gif = !NORMALIZED.test(f.name);
    v.request(url(scope, f.id, gif ? 'raw' : 'inline'), true, 'blob').then(function (blob) {
      if (!v.alive()) return;
      if (!blob || !blob.size) throw new Error('No image');
      var typed = new Blob([blob], { type: gif ? 'image/gif' : 'image/jpeg' });
      v.setUrl(URL.createObjectURL(typed));
      v.body.textContent = ''; var img = element('img'); img.alt = f.name; img.src = v.url(); v.body.appendChild(img);
    }).catch(fail(v));
  }

  function renderOther(v, scope, f) {
    v.body.textContent = '';
    var box = element('div', 'pv-other');
    if (parts(f).indexOf('thumb') >= 0) {
      var t = element('span', 'pv-thumb', badge(f)); box.appendChild(t);
      v.request(url(scope, f.id, 'thumb'), true, 'blob').then(function (blob) {
        if (!v.alive() || !blob || !blob.size) return;
        v.setUrl(URL.createObjectURL(new Blob([blob], { type: 'image/png' })));
        t.textContent = ''; var img = element('img'); img.alt = ''; img.src = v.url(); t.appendChild(img);
      }, function () { t.textContent = 'No preview image'; });
    }
    box.appendChild(element('p', 'rm-status', f.type + (f.size != null ? ' · ' + bytesWords(f.size) : '') + '. Download it, or open it on your Mac.'));
    v.body.appendChild(box);
  }

  function render(v, scope, dto) {
    var f = clean(dto); if (!f) return status(v, OFF);
    v.body.className += ' pv-body';
    if (f.state !== 'available') return status(v, REASONS[f.reason] || OFF);
    if (f.kind === 'markdown') return renderMarkdown(v, scope, f);
    if (f.kind === 'text' || f.kind === 'code') return renderCode(v, scope, f);
    if (f.kind === 'table') return renderTable(v, scope, f);
    if (f.kind === 'html') return renderHtml(v, scope, f);
    if (f.kind === 'pdf') return renderPdf(v, scope, f);
    if (f.kind === 'image') return renderImage(v, scope, f);
    return renderOther(v, scope, f);
  }

  W.preview = { chip: chip, render: render, clean: clean, parts: parts, kindOf: kindOf, url: url, failWords: failWords, reasons: REASONS, isPhone: isPhone };
  W.registerPane('preview', W.preview);
})();
