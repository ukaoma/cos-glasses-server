// Verbatim from server/web-control/app.js at 57a40bd (6.99.10), the lines from 'Numbers the way Control writes them'
// to the COS cost view: the narrow Usage view as it shipped. web-usage-range.test.ts renders it beside today's code
// and checks that under 860 px the page writes the same HTML, apart from the new Custom dates option.
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
  function uDayKey(tz) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (_e) { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  }
  function uAddDays(key, n) { var p = key.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); }
  function uWeekday(key) { var p = key.split('-').map(Number); return (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7; }
  function uBounds(period, tz) {
    var today = uDayKey(tz), counts = { 'Last 7 days': 7, 'Last 30 days': 30, 'Last 90 days': 90 };
    if (counts[period]) return [uAddDays(today, 1 - counts[period]), today];
    if (period === 'Last weekend') { var monday = uAddDays(today, -uWeekday(today)); return [uAddDays(monday, -2), uAddDays(monday, -1)]; }
    if (/^\d{4}-\d{2}$/.test(period)) return [period + '-01', period + '-31'];
    return null;
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
    if (periods.indexOf(SX.uPeriod) < 0) SX.uPeriod = 'Last 30 days';
    var bounds = uBounds(SX.uPeriod, tz);
    var inPeriod = bounds ? buckets.filter(function (b) { return b.day >= bounds[0] && b.day <= bounds[1]; }) : buckets;
    var tools = uGroup(buckets, function (b) { return b.provider; }).sort(function (a, b) { return b.t.all - a.t.all; }).map(function (g) { return g.key; });
    if (SX.uTool !== 'All tools' && tools.indexOf(SX.uTool) < 0) SX.uTool = 'All tools';
    var forTool = buckets.filter(function (b) { return SX.uTool === 'All tools' || b.provider === SX.uTool; });
    var models = uGroup(forTool, function (b) { return b.model; }).sort(function (a, b) { return b.t.all - a.t.all; }).map(function (g) { return g.key; });
    if (SX.uModel !== 'All models' && models.indexOf(SX.uModel) < 0) SX.uModel = 'All models';
    var selected = inPeriod.filter(function (b) { return (SX.uTool === 'All tools' || b.provider === SX.uTool) && (SX.uModel === 'All models' || b.model === SX.uModel); });
    var hasFilter = SX.uTool !== 'All tools' || SX.uModel !== 'All models';
    var updated = toDate(su.updatedAt);

    var html = '<div class="sx-ufilters">' +
      uSelect('usage-period', 'Period', SX.uPeriod, periods.map(function (p) { return [p, /^\d{4}-\d{2}$/.test(p) ? U_MONTHS[Number(p.slice(5)) - 1] + ' ' + p.slice(0, 4) : p]; })) +
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

