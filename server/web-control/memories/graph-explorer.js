/* COS Knowledge graph explorer (design prototype).
   Port of operations/scripts/lightrag_d3_template.html: type legend with counts and multi-select,
   48h / 7d recency, edge-strength threshold, Ring / Free / Fit layouts, zoom and pan, drag to pin,
   double-click to unpin, click to inspect with flowing edges, shift+click path tracing (BFS, 7 hops),
   hover tips, LOD labels, and the / f esc keys. Two deliberate changes from the canonical file:
   filters keep applying while an entity is inspected, and closing the inspector keeps the filters.
   Node timestamps are labeled "first indexed", never "touched": the GraphML carries created_at only.
   Requires d3 v7 as window.d3. Exposes window.COSGraphExplorer.mount(el, options). */
(function () {
  'use strict';

  // Categorical, hue-separated, still legible on espresso (Miles, 2026-09-06: "not all shades of
  // brown"). The three types most COS graphs are made of get the widest separation: person gold,
  // organization sky, artifact mint. Unknown types still hash to a stable hue.
  var TYPE_COLORS = {
    person: '#F0C36A', organization: '#6FB8E8', artifact: '#7DD3A5', concept: '#C3A5F0', event: '#F08FB0',
    content: '#E8A15A', method: '#E8D27C', technology: '#63C8D0', product: '#B9A6E0', location: '#F0907E',
    brand: '#9DB2F5', industry: '#B7CF7A', channel: '#E0A9A9', metric: '#9ED2D8', data: '#C9B9A5',
    campaign: '#F2A65A', project: '#D6B27C', decision: '#C9A86E', topic: '#C3B0E7', meeting: '#92C6A1',
    unknown: '#A89E92'
  };
  var GOLD = 'var(--cgx-gold)', GREEN = 'var(--cgx-green)', BG = 'var(--cgx-bg)';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function hashHue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
  function typeColor(t) {
    var k = String(t || 'unknown').toLowerCase();
    if (TYPE_COLORS[k]) return TYPE_COLORS[k];
    return 'hsl(' + hashHue(k) + ', 38%, 72%)';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function fmtDate(v) {
    if (v == null || v === '') return null;
    var d = typeof v === 'number' ? new Date(v > 1e12 ? v / 1e6 : v * 1000) : new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function ago(seconds) {
    if (!isFinite(seconds)) return null;
    if (seconds < 3600) return 'first indexed just now';
    if (seconds < 86400) return 'first indexed ' + Math.round(seconds / 3600) + 'h ago';
    return 'first indexed ' + Math.round(seconds / 86400) + 'd ago';
  }

  // Normalize any input into the canonical exporter contract.
  function normalize(raw) {
    var nodesIn = (raw && raw.nodes) || [], linksIn = (raw && raw.links) || [];
    var byId = {};
    var nodes = nodesIn.map(function (n) {
      var descs = Array.isArray(n.descs) ? n.descs : (n.descs ? [n.descs] : (n.description ? [n.description] : []));
      var node = Object.assign({}, n, { id: String(n.id), group: String(n.group || n.type || 'unknown').toLowerCase(), degree: 0,
        totalDegree: Number(n.totalDegree || 0), descs: descs.map(String), ts: n.ts == null ? null : Number(n.ts) });
      byId[node.id] = node; return node;
    });
    var seen = {}, links = [];
    linksIn.forEach(function (l) {
      var s = typeof l.source === 'object' ? l.source.id : l.source, t = typeof l.target === 'object' ? l.target.id : l.target;
      if (!byId[s] || !byId[t] || s === t) return;
      var key = l.id || (s < t ? s + '\u0000' + t : t + '\u0000' + s);
      var w = Number(l.weight || 1);
      if (seen[key]) { if (w > seen[key].weight) seen[key].weight = w; if (!seen[key].desc && l.desc) seen[key].desc = l.desc; return; }
      var link = Object.assign({}, l, { id: key, source: s, target: t, weight: w, desc: l.desc || l.description || '' });
      seen[key] = link; links.push(link);
    });
    links.forEach(function (l) { byId[l.source].degree++; byId[l.target].degree++; });
    nodes.forEach(function (n) { if (!n.totalDegree) n.totalDegree = n.degree; });
    return { nodes: nodes, links: links, byId: byId,
      total_nodes: Number((raw && (raw.corpus_total_nodes || raw.total_nodes)) || nodes.length),
      total_edges: Number((raw && (raw.corpus_total_edges || raw.total_edges)) || links.length),
      max_weight: links.reduce(function (m, l) { return Math.max(m, l.weight); }, 1),
      generated_at: raw && raw.generated_at, source_mtime_ns: raw && raw.source_mtime_ns,
      description_scope: raw && raw.description_scope, selection_description: raw && raw.selection_description };
  }

  // Fetch the bounded sample. Prefers /api/graph; falls back to search + per-entity pages on an older server.
  function fetchActual(endpoint) {
    var opts = { cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined };
    // A host may supply its own transport (COS Control feeds this page through its helper; the page never holds a token).
    function get(path) { if (typeof fetchActual.request === 'function') return fetchActual.request(path); return fetch(endpoint + path, opts).then(function (r) { if (!r.ok) throw Object.assign(new Error('Sample request failed (' + r.status + ').'), { status: r.status }); return r.json(); }); }
    return get('/api/graph').catch(function (err) {
      if (err.status !== 404) throw err;
      return get('/api/search?q=&limit=30').then(function (search) {
        var items = search.items || [];
        return Promise.all(items.map(function (it) { return get('/api/entity?id=' + encodeURIComponent(it.id) + '&limit=30'); })).then(function (pages) {
          var nodes = pages.map(function (p) { return p.node; }), links = [];
          pages.forEach(function (p) { (p.relationships || []).forEach(function (e) { links.push(e); }); });
          var meta = search.meta || {};
          return Object.assign({}, meta, { nodes: nodes, links: links, total_nodes: nodes.length, total_edges: links.length });
        });
      });
    });
  }

  function mount(el, options) {
    if (!el) throw new Error('COSGraphExplorer.mount needs an element');
    var opts = Object.assign({ scope: 'example', endpoint: 'http://127.0.0.1:8768', now: Date.now() / 1000, status: 'ready', focus: null,
      vip: null, memoriesFor: null, onOpenMemory: null, onCopy: null, onOpenSource: null, labels: {},
      // Graph management (design mock, 2026-09-06): merges, renames and removals stay inside this page.
      // curation: { ownerLabel: 'Ukaoma Mac Studio', isOwner: true } decides whether the sheet says "Merge now" or "Queue for <owner>".
      curation: null, onCuration: null, request: null, onRecenter: null, onPassages: null }, options || {});
    fetchActual.request = typeof opts.request === 'function' ? opts.request : null;
    var ctrl = { destroy: destroy, select: selectById, setStatus: setStatus,
      snapshot: function () {
        if (!state.data) return {nodes: [], links: []};
        return {nodes: state.data.nodes.map(function(n) { return Object.assign({},n); }),
          links: state.data.links.map(function(l) { return Object.assign({},l,{source:typeof l.source==='object'?l.source.id:l.source,target:typeof l.target==='object'?l.target.id:l.target}); }),
          positions: Object.fromEntries(state.data.nodes.map(function(n) { return [n.id,{x:n.x,y:n.y,fx:n.fx,fy:n.fy}]; }))};
      },
      replaceData: function (raw) {
        if(state.focusTimer) clearTimeout(state.focusTimer); if(state.sim) state.sim.stop(); if(state.ro) state.ro.disconnect();
        if(state.keyHandler) document.removeEventListener('keydown',state.keyHandler);
        start(normalize(raw), true);
      }
    };
    var root, stage, svgEl, ui = {}, state = { data: null, sim: null, zoom: null, k: 1, anchored: {}, activeId: null, pathEndA: null,
      activeTypes: {}, recency: 'all', edgeThreshold: 0, layout: 'ring', destroyed: false, ro: null, keyHandler: null,
      merged: {}, removed: {}, alias: {}, changes: [] };

    el.innerHTML = '';
    root = document.createElement('div'); root.className = 'cgx cgx-' + opts.scope; el.appendChild(root);
    root.innerHTML =
      '<div class="cgx-bar">' +
        '<span class="cgx-scope ' + (opts.scope === 'example' ? 'example' : '') + '" data-role="scope"><i></i><span data-role="scopeText">Loading…</span></span>' +
        '<span class="cgx-fresh" data-role="fresh"></span>' +
        '<div class="cgx-search"><span class="ico">⌕</span><input type="search" data-role="search" placeholder="Find an entity or type…" autocomplete="off" aria-label="Find an entity"><kbd>/</kbd><div class="cgx-results" data-role="results" role="listbox"></div></div>' +
      '</div>' +
      '<div class="cgx-body"><div class="cgx-stage" data-role="stage">' +
        '<svg class="cgx-canvas" data-role="svg" role="img" aria-label="Knowledge graph"></svg>' +
        '<div class="cgx-pinned" data-role="pinned"><span class="lbl">Pinned</span><span class="nms" data-role="pinnedNames"></span><button class="cgx-btn" data-role="clearPins">Clear</button></div>' +
        '<div class="cgx-rail" data-role="rail">' +
          '<div class="cgx-panel keep"><div class="cgx-panel-t">Layout <button data-role="railToggle" title="Show or hide controls">hide</button></div><div class="cgx-row"><button class="cgx-btn on" data-layout="ring">Ring</button><button class="cgx-btn" data-layout="free">Free</button><button class="cgx-btn" data-role="fit">Fit</button></div></div>' +
          '<div class="cgx-panel"><div class="cgx-panel-t">Edge strength</div><div class="cgx-slider"><input type="range" min="0" max="20" step="0.5" value="0" data-role="edgeSlider" aria-label="Minimum relationship strength"><span class="val" data-role="edgeVal">0</span></div></div>' +
          '<div class="cgx-panel"><div class="cgx-panel-t">First indexed</div><div class="cgx-row" data-role="recency"><button class="cgx-btn on" data-mode="all">All</button><button class="cgx-btn" data-mode="7d">7d</button><button class="cgx-btn" data-mode="48h">48h</button></div></div>' +
          '<div class="cgx-panel"><div class="cgx-panel-t">Entity types <button data-role="resetFilters" title="Clear type and time filters">reset</button></div><div class="cgx-legend" data-role="legend"></div></div>' +
          '<div class="cgx-panel"><div class="cgx-panel-t">Keys</div><div class="cgx-keys"><kbd>click</kbd>inspect <kbd>⇧click</kbd>path<br><kbd>drag</kbd>pin <kbd>2×click</kbd>unpin<br><kbd>/</kbd>search <kbd>f</kbd>fit <kbd>esc</kbd>close</div></div>' +
        '</div>' +
        '<div class="cgx-tip" data-role="tip"><div class="top"><span class="dot" data-role="tipDot"></span><span data-role="tipName"></span><span class="deg" data-role="tipDeg"></span></div><div class="desc" data-role="tipDesc"></div></div>' +
        '<div class="cgx-hint" data-role="hint"><b>shift+click</b> two entities to trace the path between them</div>' +
        '<div class="cgx-toast" data-role="toast"></div>' +
        '<div class="cgx-state" data-role="stateBox"></div>' +
      '</div>' +
        '<div class="cgx-dp" data-role="dp" aria-live="polite"><div class="cgx-dp-accent" data-role="dpAccent"></div><div class="cgx-dp-hd"><div class="cgx-dp-nm" data-role="dpName"></div><div class="cgx-dp-meta"><span class="cgx-tb" data-role="dpType"><i></i><span></span></span><span data-role="dpConn"></span><span class="fresh" data-role="dpFresh"></span></div><div class="cgx-meter"><i data-role="dpMeter"></i></div><button class="cgx-dp-x" data-role="dpClose" aria-label="Close inspector">×</button></div><div class="cgx-dp-bd" data-role="dpBody"></div><div class="cgx-dp-actions" data-role="dpActions"></div></div>' +
      '</div>' +
      '<div class="cgx-foot"><span data-role="footLeft"></span><span data-role="footRight"></span></div>' +
      '<div class="cgx-changes" data-role="changes" aria-live="polite"></div>';
    root.querySelectorAll('[data-role]').forEach(function (n) { ui[n.getAttribute('data-role')] = n; });
    stage = ui.stage; svgEl = ui.svg;

    function setScopeText(html, cls) { ui.scopeText.innerHTML = html; ui.scope.className = 'cgx-scope ' + (cls || ''); }
    function toast(msg) { ui.toast.textContent = msg; ui.toast.classList.add('show'); clearTimeout(ui.toast._t); ui.toast._t = setTimeout(function () { ui.toast.classList.remove('show'); }, 2400); }
    function showState(html) { ui.stateBox.innerHTML = html; ui.stateBox.style.display = html ? 'flex' : 'none'; }

    function setStatus(status, message) {
      if (status === 'loading') { showState('<div><div class="cgx-spin"></div><p>Connecting to the graph…</p></div>'); return; }
      if (status === 'offline') { setScopeText('LightRAG · <b>not connected</b>', 'off'); showState('<div><h3>LightRAG is not connected.</h3><p>Source records and learning history stay available with your current memory setup. ' + esc(message || '') + '</p><button class="cgx-btn primary" data-role="retry">Try again</button></div>'); bindRetry(); return; }
      if (status === 'error') { setScopeText('LightRAG · <b>unavailable</b>', 'off'); showState('<div><h3>The graph could not be loaded.</h3><p>' + esc(message || 'No fresh graph data is available. Saved memories and prior learning evidence are still available.') + '</p><button class="cgx-btn primary" data-role="retry">Try again</button></div>'); bindRetry(); return; }
      if (status === 'empty') { showState('<div><h3>' + esc(opts.labels && opts.labels.emptyTitle || 'No linked entities yet.') + '</h3><p>' + esc(message || opts.labels && opts.labels.emptyMessage || 'Connections appear when evidence is indexed.') + '</p></div>'); return; }
      showState('');
    }
    function bindRetry() { var b = ui.stateBox.querySelector('[data-role="retry"]'); if (b) b.addEventListener('click', function () { load(); }); }

    function load() {
      if (opts.status === 'offline' || opts.status === 'error') { setStatus(opts.status); return; }
      if (opts.data) { start(normalize(opts.data)); return; }
      setStatus('loading');
      fetchActual(opts.endpoint).then(function (raw) { if (state.destroyed) return; start(normalize(raw)); })
        .catch(function (err) { if (state.destroyed) return; var offline = !err.status; setStatus(offline ? 'offline' : 'error', offline ? 'The local sample server did not answer.' : err.message); });
    }

    function start(data, preserve) {
      if (!window.d3) { setStatus('error', 'The graph canvas needs d3, which did not load.'); return; }
      state.data = data;
      if (!data.nodes.length) { window.d3.select(svgEl).selectAll('*').remove(); ui.dp.classList.remove('on'); state.activeId=null; state.pathEndA=null; ctrl._select=null; ui.legend.innerHTML=''; setScopeText('No points in this investigation', ''); setStatus('empty'); return; }
      if (state.activeId && !data.byId[state.activeId]) { state.activeId=null; ui.dp.classList.remove('on'); }
      setStatus('ready');
      var d3 = window.d3, nodes = data.nodes, links = data.links, byId = data.byId;
      var W = Math.max(320, stage.clientWidth), H = Math.max(360, stage.clientHeight);
      var small = nodes.length <= 60;
      var D48 = 48 * 3600, D7 = 7 * 86400;

      // VIP: host-provided, else the highest-degree node as the center with its strongest neighbors as the ring.
      var vip = opts.vip;
      if (!vip) {
        var center = nodes.slice().sort(function (a, b) { return b.degree - a.degree; })[0];
        var ring = links.filter(function (l) { return l.source === center.id || l.target === center.id; })
          .sort(function (a, b) { return b.weight - a.weight; }).slice(0, 8)
          .map(function (l) { return l.source === center.id ? l.target : l.source; });
        vip = { center: center.id, ring: ring };
      }
      nodes.forEach(function (n) {
        n.color = typeColor(n.group);
        n.radius = small ? Math.max(9, Math.min(30, 7 + Math.sqrt(n.degree) * 3)) : Math.max(5.5, Math.min(34, 4 + Math.sqrt(n.degree) * 2.6));
        n.isCenter = n.id === vip.center; n.isVip = n.isCenter || vip.ring.indexOf(n.id) >= 0;
        if (n.isCenter) { n.color = '#C9A86E'; n.radius = small ? 34 : 44; }
        n.age = n.ts ? (opts.now - n.ts) : Infinity; n.fresh48 = n.age < D48; n.fresh7 = n.age < D7;
        n.short = trunc(n.id, 28);
      });
      var maxDeg = d3.max(nodes, function (n) { return n.degree; }) || 1;
      var n48 = nodes.filter(function (n) { return n.fresh48; }).length, n7 = nodes.filter(function (n) { return n.fresh7; }).length;

      // Scope and freshness lines, stated separately: an export today does not make the source current.
      if (opts.scope === 'example') setScopeText('Example graph · <b>' + nodes.length + ' entities</b> · ' + links.length + ' relationships', 'example');
      else setScopeText(esc(opts.labels.graphName || 'Your LightRAG data') + ' · <b>' + fmt(nodes.length) + ' of ' + fmt(data.total_nodes) + ' entities</b> · ' + fmt(links.length) + ' of ' + fmt(data.total_edges) + ' relationships', '');
      var fresh = [];
      if (data.source_mtime_ns) fresh.push('Graph updated <b>' + fmtDate(data.source_mtime_ns) + '</b>');
      if (data.generated_at) fresh.push('Sample exported <b>' + fmtDate(data.generated_at) + '</b>');
      if (opts.scope === 'example') fresh.push('Example data, not your graph');
      ui.fresh.innerHTML = fresh.join(' · ');
      ui.footLeft.innerHTML = opts.scope === 'example' ? 'Relationships are extracted claims. They add context to a memory; they do not prove a lesson worked.' : (esc(data.selection_description || 'Bounded sample of the source graph.') + ' Descriptions are ' + esc(data.description_scope || 'extracted summaries') + '.');
      ui.footRight.innerHTML = n7 ? '<b>' + n7 + '</b> first indexed in 7 days' : 'Nothing first indexed in the last 7 days';
      ui.recency.querySelector('[data-mode="7d"]').textContent = '7d · ' + n7;
      ui.recency.querySelector('[data-mode="48h"]').textContent = '48h · ' + n48;

      // Legend with counts, multi-select.
      var typeCounts = {}; nodes.forEach(function (n) { typeCounts[n.group] = (typeCounts[n.group] || 0) + 1; });
      var types = Object.keys(typeCounts).sort(function (a, b) { return typeCounts[b] - typeCounts[a]; });
      ui.legend.innerHTML = types.map(function (t) { return '<button class="cgx-leg" data-type="' + esc(t) + '" aria-pressed="false"><span class="dot" style="background:' + typeColor(t) + ';color:' + typeColor(t) + '"></span><span class="nm">' + esc(t) + '</span><span class="ct">' + typeCounts[t] + '</span></button>'; }).join('');

      // Adjacency and edge lookups.
      var nbrs = {}, edgeInfo = {};
      nodes.forEach(function (n) { nbrs[n.id] = {}; });
      links.forEach(function (l) {
        nbrs[l.source][l.target] = true; nbrs[l.target][l.source] = true;
        edgeInfo[l.source + '|' + l.target] = edgeInfo[l.target + '|' + l.source] = { w: l.weight, desc: l.desc };
        l.mix = d3.interpolateLab(byId[l.source].color, byId[l.target].color)(0.5);
      });
      function neighborIds(id) { return Object.keys(nbrs[id] || {}); }

      // SVG scaffold.
      var svg = d3.select(svgEl); svg.selectAll('*').remove();
      var g = svg.append('g');
      var zm = d3.zoom().scaleExtent([0.08, 10]).on('zoom', function (e) { g.attr('transform', e.transform); updateLOD(e.transform.k); });
      svg.call(zm).on('dblclick.zoom', null);
      state.zoom = zm;
      var defs = svg.append('defs');
      var fl = defs.append('filter').attr('id', 'cgx-glow').attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%');
      fl.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '4').attr('result', 'bl');
      fl.append('feComposite').attr('in', 'SourceGraphic').attr('in2', 'bl').attr('operator', 'over');
      Object.keys(typeCounts).forEach(function (t) {
        var c = d3.color(typeColor(t)); if (!c) return;
        var rg = defs.append('radialGradient').attr('id', 'cgx-ng-' + t.replace(/[^a-z0-9]/gi, '_')).attr('cx', '38%').attr('cy', '34%').attr('r', '75%');
        rg.append('stop').attr('offset', '0%').attr('stop-color', c.brighter(0.7).formatHex());
        rg.append('stop').attr('offset', '55%').attr('stop-color', c.formatHex());
        rg.append('stop').attr('offset', '100%').attr('stop-color', c.darker(0.9).formatHex());
      });
      var cg = defs.append('radialGradient').attr('id', 'cgx-ng-center').attr('cx', '38%').attr('cy', '34%').attr('r', '75%');
      cg.append('stop').attr('offset', '0%').attr('stop-color', '#F3DFB6');
      cg.append('stop').attr('offset', '55%').attr('stop-color', GOLD);
      cg.append('stop').attr('offset', '100%').attr('stop-color', '#8F7240');

      // Keep the ring clear of the control rail: shift the center right by half the rail width when it is open.
      var railW = (W >= 720 && !ui.rail.classList.contains('collapsed')) ? 200 : 0;
      var R = Math.min(W - railW, H) * (small ? 0.3 : 0.36), cx = (W + railW) / 2, cy = H / 2;
      var grid = g.append('g');
      [0.45, 1.55, 2.3].forEach(function (m) { grid.append('circle').attr('cx', cx).attr('cy', cy).attr('r', R * m).attr('fill', 'none').attr('stroke', 'rgba(201,168,110,0.05)'); });
      for (var i = 0; i < 12; i++) { var a = i * Math.PI / 6; grid.append('line').attr('x1', cx + R * 0.45 * Math.cos(a)).attr('y1', cy + R * 0.45 * Math.sin(a)).attr('x2', cx + R * 2.3 * Math.cos(a)).attr('y2', cy + R * 2.3 * Math.sin(a)).attr('stroke', 'rgba(245,240,230,0.02)'); }
      grid.append('circle').attr('class', 'orbit').attr('cx', cx).attr('cy', cy).attr('r', R).attr('fill', 'none').attr('stroke', 'rgba(201,168,110,0.16)').attr('stroke-width', 1.2).attr('stroke-dasharray', '3 9');

      var sim = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(function (d) { return d.id; }).distance(small ? 120 : 105).strength(0.25))
        .force('charge', d3.forceManyBody().strength(small ? -520 : -470).distanceMax(580))
        .force('center', d3.forceCenter(cx, cy))
        .force('collision', d3.forceCollide().radius(function (d) { return d.radius + 8; }))
        .alphaDecay(0.02);
      state.sim = sim;

      var link = g.append('g').selectAll('path').data(links).join('path').attr('class', 'edge').attr('fill', 'none')
        .attr('stroke', function (d) { return d.mix; })
        .attr('stroke-opacity', function (d) { return Math.min(0.42, 0.12 + d.weight * 0.03); })
        .attr('stroke-width', function (d) { return Math.max(0.7, Math.sqrt(d.weight) * 0.6); });
      var vipRings = g.append('g').selectAll('circle').data(nodes.filter(function (n) { return n.isVip; })).join('circle')
        .attr('r', function (d) { return d.isCenter ? d.radius + 7 : d.radius + 4.5; }).attr('fill', 'none')
        .attr('stroke', function (d) { return d.isCenter ? GOLD : 'var(--cgx-muted)'; })
        .attr('stroke-width', function (d) { return d.isCenter ? 2 : 1.4; })
        .attr('stroke-opacity', function (d) { return d.isCenter ? 0.75 : 0.35; })
        .attr('stroke-dasharray', function (d) { return d.isCenter ? null : '1 4'; }).attr('stroke-linecap', 'round');
      var freshRings = g.append('g').selectAll('circle').data(nodes.filter(function (n) { return n.fresh48 && !n.isCenter; })).join('circle')
        .attr('class', 'fresh-ring').attr('r', function (d) { return d.radius + 8; }).attr('fill', 'none').attr('stroke', GREEN).attr('stroke-width', 1.5).attr('stroke-opacity', 0.4);
      var node = g.append('g').selectAll('circle').data(nodes).join('circle')
        .attr('class', 'focusable').attr('tabindex', 0).attr('role', 'button')
        .attr('aria-label', function (d) { return 'Inspect ' + d.id; })
        .attr('r', REDUCED ? function (d) { return d.radius; } : 0)
        .attr('fill', function (d) { return d.isCenter ? 'url(#cgx-ng-center)' : 'url(#cgx-ng-' + d.group.replace(/[^a-z0-9]/gi, '_') + ')'; })
        .attr('stroke', function (d) { return d.isCenter ? 'rgba(201,168,110,0.5)' : 'rgba(245,240,230,0.12)'; })
        .attr('stroke-width', function (d) { return d.isCenter ? 2 : 1.2; }).style('cursor', 'pointer');
      if (!REDUCED) node.transition().delay(function (d, i) { return i * 4; }).duration(520).ease(d3.easeCubicOut).attr('r', function (d) { return d.radius; });
      var pins = g.append('g').selectAll('circle').data(nodes).join('circle').attr('r', 3.4).attr('fill', GOLD).attr('stroke', BG).attr('stroke-width', 1.4).style('display', 'none').style('pointer-events', 'none');
      var label = g.append('g').selectAll('text').data(nodes).join('text').attr('class', 'nl').text(function (d) { return d.short; })
        .attr('dx', function (d) { return d.radius + 6; }).attr('dy', 3.5)
        .style('font-size', function (d) { return d.isCenter ? '15px' : d.degree > 60 ? '13px' : d.degree > 30 ? '11.5px' : d.degree > 12 ? '10.5px' : '10px'; })
        .style('fill', function (d) { return d.isCenter ? GOLD : d.degree > 30 ? 'var(--cgx-fg)' : 'var(--cgx-muted)'; })
        .style('font-weight', function (d) { return d.isCenter ? '700' : d.degree > 30 ? '600' : '500'; })
        .style('opacity', REDUCED ? 1 : 0);
      if (!REDUCED) label.transition().delay(function (d, i) { return 250 + i * 3; }).duration(600).style('opacity', 1);

      function lodVisible(d, k) { if (small || d.isVip || d.degree >= 40) return true; if (k >= 0.75 && d.degree >= 18) return true; if (k >= 1.3 && d.degree >= 7) return true; return k >= 2; }
      function updateLOD(k) { state.k = k; if (state.activeId) return; label.style('display', function (d) { return lodVisible(d, k) ? null : 'none'; }); }
      updateLOD(1);

      function passes(d) {
        if (state.merged[d.id] || state.removed[d.id]) return false;
        var typesOn = Object.keys(state.activeTypes).length;
        if (typesOn && !state.activeTypes[d.group]) return false;
        if (state.recency === '7d' && !d.fresh7) return false;
        if (state.recency === '48h' && !d.fresh48) return false;
        return true;
      }
      function edgeVisible() {
        if (state.edgeThreshold <= 0) return null;
        var v = {}; links.forEach(function (l) { if (l.weight >= state.edgeThreshold) { v[l.source.id || l.source] = true; v[l.target.id || l.target] = true; } }); return v;
      }
      // Filters and the selection compose: the canonical file skipped filters while inspecting.
      function paint() {
        var ev = edgeVisible(), active = state.activeId, my = active && active !== '__path__' ? nbrs[active] || {} : null, onPath = state.onPath || null, pairs = state.pathPairs || null;
        function shown(d) { var ok = passes(d) && (!ev || ev[d.id]); if (d.isCenter && !ok) return 'dim'; return ok ? 'on' : 'off'; }
        function focus(d) { if (onPath) return !!onPath[d.id]; if (my) return d.id === active || !!my[d.id]; return true; }
        var t = REDUCED ? d3.transition().duration(0) : d3.transition().duration(220);
        node.transition(t).attr('opacity', function (d) { var s = shown(d); if (s === 'off') return 0.06; if (!focus(d)) return 0.06; return s === 'dim' ? 0.35 : 1; });
        node.attr('filter', function (d) { return (active && d.id === active) || (onPath && (d.id === state.pathA || d.id === state.pathB)) ? 'url(#cgx-glow)' : null; });
        label.transition(t).style('opacity', function (d) { var s = shown(d); if (s === 'off' || !focus(d)) return 0.04; return s === 'dim' ? 0.4 : 1; })
          .style('fill', function (d) { if (onPath && onPath[d.id]) return d.isCenter ? GOLD : 'var(--cgx-fg)'; if (my && d.id === active) return d.isCenter ? GOLD : 'var(--cgx-fg)'; return d.isCenter ? GOLD : d.degree > 30 ? 'var(--cgx-fg)' : 'var(--cgx-muted)'; });
        label.text(function (d) { return state.alias[d.id] ? trunc(state.alias[d.id], 28) : d.short; });
        label.style('display', function (d) { if (state.merged[d.id] || state.removed[d.id]) return 'none'; if (my && (d.id === active || my[d.id])) return null; if (onPath && onPath[d.id]) return null; return lodVisible(d, state.k) ? null : 'none'; });
        link.attr('class', function (l) { var s = l.source.id, tg = l.target.id; if (pairs && pairs[s + '|' + tg]) return 'edge flow'; if (my && (s === active || tg === active)) return 'edge flow'; return 'edge'; })
          .transition(t)
          .attr('stroke', function (l) { var s = l.source.id, tg = l.target.id; if (pairs && pairs[s + '|' + tg]) return GOLD; if (my) { if (s === active) return l.target.color; if (tg === active) return l.source.color; } return l.mix; })
          .attr('stroke-opacity', function (l) { var s = l.source.id, tg = l.target.id; if (state.edgeThreshold > 0 && l.weight < state.edgeThreshold) return 0; if (pairs) return pairs[s + '|' + tg] ? 0.95 : 0.02; if (my) return (s === active || tg === active) ? 0.8 : 0.02; if (!passes(l.source) || !passes(l.target)) return 0.015; return Math.min(0.42, 0.12 + l.weight * 0.03); })
          .attr('stroke-width', function (l) { var s = l.source.id, tg = l.target.id; if (pairs && pairs[s + '|' + tg]) return 2.6; if (my && (s === active || tg === active)) return Math.max(1.5, Math.sqrt(l.weight) * 1.05); return Math.max(0.7, Math.sqrt(l.weight) * 0.6); });
        vipRings.transition(t).attr('stroke-opacity', function (d) { return focus(d) && shown(d) !== 'off' ? (d.isCenter ? 0.75 : 0.35) : 0.04; });
        freshRings.transition(t).attr('stroke-opacity', function (d) { return focus(d) && shown(d) !== 'off' ? 0.4 : 0.04; });
      }

      // Layouts.
      function ringLayout() {
        nodes.forEach(function (n) {
          if (n.isCenter) { n.fx = cx; n.fy = cy; state.anchored[n.id] = 'ring'; }
          var idx = vip.ring.indexOf(n.id);
          if (idx >= 0) { var a = (2 * Math.PI * idx / vip.ring.length) - Math.PI / 2; n.fx = cx + R * Math.cos(a); n.fy = cy + R * Math.sin(a); state.anchored[n.id] = 'ring'; }
        });
        updateAnchors(); sim.alpha(0.6).restart();
      }
      function freeLayout() { nodes.forEach(function (n) { n.fx = null; n.fy = null; }); state.anchored = {}; updateAnchors(); sim.alpha(0.8).restart(); }
      function setLayout(type) { state.layout = type; ui.rail.querySelectorAll('[data-layout]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-layout') === type); }); if (type === 'ring') ringLayout(); else freeLayout(); }
      function fit() {
        var xs = nodes.map(function (n) { return n.x; }), ys = nodes.map(function (n) { return n.y; });
        var x0 = d3.min(xs), x1 = d3.max(xs), y0 = d3.min(ys), y1 = d3.max(ys);
        var k = Math.min(6, 0.82 / Math.max((x1 - x0 + 120) / W, (y1 - y0 + 120) / H));
        svg.transition().duration(REDUCED ? 0 : 650).ease(d3.easeCubicInOut).call(zm.transform, d3.zoomIdentity.translate(W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2).scale(k));
      }
      function panTo(d) { var tr = d3.zoomTransform(svgEl); svg.transition().duration(REDUCED ? 0 : 600).ease(d3.easeCubicInOut).call(zm.transform, d3.zoomIdentity.translate(W / 2 - d.x * tr.k, H / 2 - d.y * tr.k).scale(tr.k)); }

      // Drag: a still click must not pin.
      var dragDist = 0, dragStart = null;
      node.call(d3.drag().clickDistance(4)
        .on('start', function (e, d) { if (opts.onUserIntent) opts.onUserIntent(); if (!e.active) sim.alphaTarget(0.08).restart(); dragDist = 0; dragStart = [e.x, e.y]; d.fx = d.x; d.fy = d.y; })
        .on('drag', function (e, d) { d.fx = e.x; d.fy = e.y; dragDist = Math.hypot(e.x - dragStart[0], e.y - dragStart[1]); })
        .on('end', function (e, d) { if (!e.active) sim.alphaTarget(0); if (dragDist > 4) { if (opts.onUserIntent) opts.onUserIntent(); state.anchored[d.id] = 'user'; updateAnchors(); } else if (!state.anchored[d.id]) { d.fx = null; d.fy = null; } }));
      function updateAnchors() {
        pins.style('display', function (d) { return state.anchored[d.id] ? 'block' : 'none'; });
        var user = Object.keys(state.anchored).filter(function (id) { return state.anchored[id] === 'user'; });
        ui.pinned.classList.toggle('on', user.length > 0); ui.pinnedNames.textContent = user.join(', ');
      }
      ui.clearPins.onclick = function () { nodes.forEach(function (d) { if (state.anchored[d.id]) { d.fx = null; d.fy = null; } }); state.anchored = {}; updateAnchors(); state.layout = 'free'; ui.rail.querySelectorAll('[data-layout]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-layout') === 'free'); }); sim.alphaTarget(0.08).restart(); setTimeout(function () { sim.alphaTarget(0); }, 800); };

      // Click, double-click, keyboard on nodes.
      node.on('click', function (e, d) { e.stopPropagation(); if (e.shiftKey && state.pathEndA && state.pathEndA !== d.id) { tracePath(state.pathEndA, d.id); return; } state.pathEndA = d.id; select(d); });
      node.on('dblclick', function (e, d) { e.stopPropagation(); if (opts.onUserIntent) opts.onUserIntent(); d.fx = null; d.fy = null; delete state.anchored[d.id]; updateAnchors(); sim.alphaTarget(0.05).restart(); setTimeout(function () { sim.alphaTarget(0); }, 600); });
      node.on('keydown', function (e, d) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.pathEndA = d.id; select(d, true); } });

      // Hover tip.
      node.on('mouseover', function (e, d) {
        ui.tipName.textContent = d.id; ui.tipDot.style.background = d.color; ui.tipDot.style.color = d.color; ui.tipDeg.textContent = d.degree + ' conn'; ui.tipDesc.textContent = (d.descs && d.descs[0]) || '';
        ui.tip.style.display = 'block';
        if (!state.activeId && !REDUCED) d3.select(this).attr('filter', 'url(#cgx-glow)').transition().duration(150).attr('r', d.radius * 1.08);
      }).on('mousemove', function (e) {
        var r = stage.getBoundingClientRect(); var x = Math.min(e.clientX - r.left + 14, r.width - 300), y = e.clientY - r.top - 8;
        ui.tip.style.left = Math.max(6, x) + 'px'; ui.tip.style.top = Math.max(6, y) + 'px';
      }).on('mouseout', function (e, d) { ui.tip.style.display = 'none'; if (state.activeId !== d.id) d3.select(this).attr('filter', null).transition().duration(200).attr('r', d.radius); });

      svg.on('click', function () { closeInspector(); });

      // Graph management (design mock). Duplicate candidates come from three signals shown SEPARATELY:
      // a normalized-name match, shared neighbors, and description agreement. Nothing merges on a name alone
      // (2026-04-07: Miles Mallard and Manoj Kumar were nearly merged into different people by name).
      function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
      function initials(s) { return normName(s).split(' ').filter(Boolean).map(function (w) { return w[0]; }).join(''); }
      function words(s) { return normName(s).split(' ').filter(function (w) { return w.length >= 5; }); }
      function displayName(n) { return state.alias[n.id] || n.id; }
      function isLive(id) { return !state.merged[id] && !state.removed[id]; }
      function liveNodes() { return nodes.filter(function (n) { return isLive(n.id); }); }
      function agreement(a, b) {
        var da = (a.descs && a.descs[0]) || '', db = (b.descs && b.descs[0]) || '';
        if (!da || !db) return { label: 'one side has no description', cls: 'muted' };
        var wa = words(da), wb = words(db), shared = wa.filter(function (w) { return wb.indexOf(w) >= 0; });
        if (a.group === b.group && shared.length >= 2) return { label: 'descriptions agree', cls: 'ok' };
        if (!shared.length) return { label: 'descriptions differ', cls: 'warn' };
        return { label: 'descriptions overlap on ' + shared.length + ' term' + (shared.length > 1 ? 's' : ''), cls: 'muted' };
      }
      function nameSignal(a, b) {
        var na = normName(displayName(a)), nb = normName(displayName(b)); if (!na || !nb) return null;
        if (na === nb) return 'same name, different form';
        var ta = na.split(' '), tb = nb.split(' ');
        if (ta.length !== tb.length && (ta.every(function (t) { return tb.indexOf(t) >= 0; }) || tb.every(function (t) { return ta.indexOf(t) >= 0; }))) return 'one name inside the other';
        var ia = initials(displayName(a)), ib = initials(displayName(b));
        if ((ia.length >= 2 && ia === nb.replace(/ /g, '')) || (ib.length >= 2 && ib === na.replace(/ /g, ''))) return 'initials match';
        return null;
      }
      function dupCandidates(d) {
        var out = [];
        liveNodes().forEach(function (n) {
          if (n.id === d.id) return;
          var sig = nameSignal(d, n); if (!sig) return;
          var shared = neighborIds(d.id).filter(function (id) { return isLive(id) && nbrs[n.id] && nbrs[n.id][id]; });
          out.push({ node: n, signal: sig, shared: shared, agree: agreement(d, n) });
        });
        return out.sort(function (a, b) { return b.shared.length - a.shared.length || b.node.degree - a.node.degree; }).slice(0, 3);
      }
      function movedInto(d) { return Object.keys(state.merged).filter(function (sid) { return state.merged[sid].target === d.id; }); }
      function liveRels(d) {
        var rels = neighborIds(d.id).filter(isLive).map(function (nid) { var ei = edgeInfo[d.id + '|' + nid] || { w: 1, desc: '' }; return { id: nid, w: ei.w, desc: ei.desc }; });
        movedInto(d).forEach(function (sid) {
          neighborIds(sid).forEach(function (nid) {
            if (nid === d.id || !isLive(nid) || rels.some(function (r) { return r.id === nid; })) return;
            var ei = edgeInfo[sid + '|' + nid] || { w: 1, desc: '' };
            rels.push({ id: nid, w: ei.w, desc: (ei.desc ? ei.desc + ' ' : '') + '(moved from ' + sid + ' by a merge in this prototype)' });
          });
        });
        return rels.sort(function (a, b) { return b.w - a.w; });
      }
      function looksLikeSpeakerLabel(s) { return /^[A-Z]{2,4}$/.test(String(s || '').trim()) || /^[A-Z][a-z]+$/.test(String(s || '').trim()); }
      function ownerLine() { var c = opts.curation || {}; return c.isOwner === false ? 'Queue for ' + (c.ownerLabel || 'the owner Mac') : 'Apply in the background'; }
      function closeSheet() { var s = root.querySelector('.cgx-sheet'); if (s) s.parentNode.removeChild(s); }
      // The host decides. onCuration(change) may return nothing (the prototype applies it
      // and says so), false (refused: the local change is undone and the row says so), or a
      // promise (pending until it settles; true keeps it, false or a rejection undoes it). The
      // host does its own toasts on those paths; the prototype toast only fires for nothing.
      function undoChange(change) {
        if (change.op === 'merge') delete state.merged[change.source]; else if (change.op === 'rename') delete state.alias[change.source]; else if (change.op === 'remove') delete state.removed[change.source];
      }
      function recordChange(change) {
        change.at = new Date(); change.status = (opts.curation && opts.curation.isOwner === false) ? 'queued' : 'applied';
        state.changes.unshift(change); renderChanges();
        var verdict = typeof opts.onCuration === 'function' ? opts.onCuration(change) : undefined;
        if (verdict === false) { undoChange(change); change.status = 'refused'; renderChanges(); paint(); return; }
        if (verdict && typeof verdict.then === 'function') {
          change.status = 'pending'; renderChanges();
          verdict.then(function (ok) { if (ok === false) { undoChange(change); change.status = 'refused'; } else change.status = 'applied'; renderChanges(); paint(); },
                       function () { undoChange(change); change.status = 'refused'; renderChanges(); paint(); });
          return;
        }
        toast(change.status === 'queued' ? 'Queued for ' + ((opts.curation && opts.curation.ownerLabel) || 'the owner Mac') + '. Nothing changes until it applies there.' : 'Applied in this prototype. In the product this runs in the background on the owner Mac and returns a receipt.');
      }
      function applyChange(change) {
        if (change.op === 'merge') state.merged[change.source] = { target: change.target, rule: change.rule || null };
        else if (change.op === 'rename') state.alias[change.source] = change.newName;
        else if (change.op === 'remove') state.removed[change.source] = true;
        recordChange(change); paint();
        var keep = byId[change.op === 'merge' ? change.target : change.source];
        if (change.op === 'remove') closeInspector(); else if (keep) select(keep);
      }
      function revertChange(change) {
        if (change.status === 'reverted' || change.status === 'withdrawn') return;
        if (change.op === 'merge') delete state.merged[change.source]; else if (change.op === 'rename') delete state.alias[change.source]; else if (change.op === 'remove') delete state.removed[change.source];
        change.status = change.status === 'queued' ? 'withdrawn' : 'reverted'; renderChanges(); paint();
        if (state.activeId && byId[state.activeId]) select(byId[state.activeId]);
        toast(change.status === 'withdrawn' ? 'Proposal withdrawn.' : 'Reverted. The original entities and relationships are back; the receipt stays in history.');
      }
      function changeText(c) {
        if (c.op === 'merge') return 'Merged <b>' + esc(c.source) + '</b> into <b>' + esc(c.target) + '</b> · ' + c.moved + ' relationship' + (c.moved === 1 ? '' : 's') + ' moved' + (c.rule ? ' · rule: ' + esc(c.rule.scope === 'speaker' ? 'speaker label' : 'text') + ' “' + esc(c.rule.pattern) + '” → ' + esc(c.rule.replacement) : '');
        if (c.op === 'rename') return 'Renamed <b>' + esc(c.source) + '</b> to <b>' + esc(c.newName) + '</b>' + (c.rule ? ' · rule added' : '');
        return 'Removed <b>' + esc(c.source) + '</b> · ' + c.moved + ' relationship' + (c.moved === 1 ? '' : 's') + ' dropped';
      }
      function renderChanges() {
        if (!state.changes.length) { ui.changes.classList.remove('on'); ui.changes.innerHTML = ''; return; }
        ui.changes.classList.add('on');
        var live = opts.scope !== 'example';
        ui.changes.innerHTML = '<div class="t">' + (live ? 'Changes this session (' : 'Changes in this prototype (') + state.changes.length + ')</div>' + state.changes.map(function (c, i) {
          var revertable = !live && (c.status === 'applied' || c.status === 'queued');
          return '<div class="cgx-change ' + c.status + '"><span class="what">' + changeText(c) + '</span><span class="st ' + c.status + '">' + c.status + '</span>' + (revertable ? '<button class="cgx-btn" data-revert="' + i + '">' + (c.status === 'queued' ? 'Withdraw' : 'Revert') + '</button>' : '') + '</div>';
        }).join('') + (live ? '<div class="cgx-note" style="margin-top:8px">A merge that applied has a receipt and a pre-merge snapshot on the owner Mac; the ledger keeps every row.</div>' : '<div class="cgx-note" style="margin-top:8px">In the product each row is a receipt from the owner Mac: store counts before and after, embeddings issued, bytes rewritten. Reverted rows stay in history.</div>');
        ui.changes.querySelectorAll('[data-revert]').forEach(function (b) { b.onclick = function () { revertChange(state.changes[+b.getAttribute('data-revert')]); }; });
      }
      function colHtml(n, keep, choice) {
        var rels = liveRels(n);
        return '<div class="cgx-cmp-col ' + (keep ? 'keep' : '') + '" data-col="' + esc(n.id) + '"><h4>' + esc(displayName(n)) + '</h4><div class="m">' + esc(n.group) + ' · ' + rels.length + ' connection' + (rels.length === 1 ? '' : 's') + (ago(n.age) ? ' · ' + esc(ago(n.age)) : '') + '</div>' +
          ((n.descs && n.descs.length) ? n.descs.slice(0, 2).map(function (s) { return '<p>' + esc(trunc(s, 220)) + '</p>'; }).join('') : '<p style="opacity:.6">No description extracted.</p>') +
          '<p style="opacity:.7">Top links: ' + (rels.slice(0, 3).map(function (r) { return esc(r.id); }).join(', ') || 'none') + '</p>' +
          '<p style="opacity:.7">Sample passages: ' + (opts.scope === 'example' ? esc(opts.labels.sourceName || 'example excerpt') : 'unavailable in this export; the native index supplies three') + '</p>' +
          (choice ? '<label><input type="radio" name="cgx-keep" value="' + esc(n.id) + '"' + (keep ? ' checked' : '') + '> Keep this name</label>' : '') + '</div>';
      }
      function ruleHtml(sourceName, targetName) {
        var on = looksLikeSpeakerLabel(sourceName);
        return '<div class="cgx-rule"><label><input type="checkbox" data-role="ruleOn"' + (on ? ' checked' : '') + '> Stop this from coming back: treat <b>“' + esc(sourceName) + '”</b> as <b>' + esc(targetName) + '</b> in future transcripts</label>' +
          '<div class="fields"><select data-role="ruleScope"><option value="speaker"' + (on ? ' selected' : '') + '>as a speaker label only</option><option value="text"' + (on ? '' : ' selected') + '>anywhere in the text</option></select><input type="text" data-role="rulePattern" value="' + esc(sourceName) + '" aria-label="Text to match"><span>→</span><input type="text" data-role="ruleReplacement" value="' + esc(targetName) + '" aria-label="Replacement"></div>' +
          '<div class="cgx-dup-meta" style="margin-top:6px">Stored as plain text, never as a pattern. A speaker-label rule touches only lines that start with the label.</div></div>';
      }
      function readRule(box) { var on = box.querySelector('[data-role="ruleOn"]'); if (!on || !on.checked) return null; return { scope: box.querySelector('[data-role="ruleScope"]').value, pattern: box.querySelector('[data-role="rulePattern"]').value.trim(), replacement: box.querySelector('[data-role="ruleReplacement"]').value.trim() }; }
      function sheetShell(title, body, footer) {
        closeSheet();
        var s = document.createElement('div'); s.className = 'cgx-sheet'; s.setAttribute('role', 'dialog'); s.setAttribute('aria-modal', 'true'); s.setAttribute('aria-label', title);
        s.innerHTML = '<div class="cgx-sheet-box"><div class="cgx-sheet-hd"><h3>' + esc(title) + '</h3><button class="cgx-dp-x" data-role="sheetClose" aria-label="Close" style="position:static">×</button></div><div class="cgx-sheet-bd">' + body + '</div><div class="cgx-sheet-ft">' + footer + '</div></div>';
        s.addEventListener('click', function (e) { if (e.target === s) closeSheet(); });
        s.querySelector('[data-role="sheetClose"]').onclick = closeSheet;
        root.querySelector('.cgx-body').appendChild(s);
        var first = s.querySelector('button.primary, input, button'); if (first) first.focus();
        return s;
      }
      function effectHtml(source, target, moved, dropped) {
        var c = opts.curation || {};
        return '<div class="cgx-effect"><b>What will happen</b><ul>' +
          '<li>' + moved + ' relationship' + (moved === 1 ? '' : 's') + ' move' + (moved === 1 ? 's' : '') + ' from ' + esc(displayName(source)) + ' to ' + esc(displayName(target)) + (dropped ? '; ' + dropped + ' link' + (dropped === 1 ? '' : 's') + ' between the two is dropped' : '') + '.</li>' +
          '<li>Descriptions are combined (' + ((source.descs || []).length + (target.descs || []).length) + ' total); source passages stay linked to the surviving entity.</li>' +
          '<li>' + esc(displayName(source)) + ' is removed from the graph. Revert restores it from the receipt.</li>' +
          '<li>Cost: about ' + (moved + 1) + ' embedding' + (moved === 0 ? '' : 's') + ' and a full rewrite of the vector store (about 3 GB), so it runs in the background on ' + esc(c.ownerLabel || 'the owner Mac') + ' and returns a receipt. No model call.</li></ul></div>';
      }
      function openMergeSheet(d, candidate) {
        var target = candidate, source = d;
        if (candidate && candidate.degree > d.degree) { target = candidate; source = d; } else if (candidate) { target = d; source = candidate; }
        function render() {
          var body;
          if (!target) {
            body = '<p>Choose the entity that <b>' + esc(displayName(d)) + '</b> should merge into. Suggestions come from name similarity and shared neighbors; read both descriptions before merging.</p><input type="search" data-role="pick" placeholder="Find the surviving entity…" aria-label="Find the surviving entity"><div class="cgx-pick" data-role="pickList"></div>';
            var s = sheetShell('Merge ' + displayName(d) + ' into…', body, '<span class="grow">Nothing changes until you review the comparison on the next step.</span><button class="cgx-btn" data-role="cancel">Cancel</button>');
            s.querySelector('[data-role="cancel"]').onclick = closeSheet;
            var pick = s.querySelector('[data-role="pick"]'), list = s.querySelector('[data-role="pickList"]');
            function fill() { var q = pick.value.toLowerCase().trim(); var cands = liveNodes().filter(function (n) { return n.id !== d.id && (!q || displayName(n).toLowerCase().indexOf(q) >= 0); }).sort(function (a, b) { return (nameSignal(d, b) ? 1 : 0) - (nameSignal(d, a) ? 1 : 0) || b.degree - a.degree; }).slice(0, 12); list.innerHTML = cands.map(function (n) { return '<button data-pick="' + esc(n.id) + '"><span class="dot" style="width:8px;height:8px;border-radius:50%;background:' + n.color + ';box-shadow:0 0 6px ' + n.color + '"></span><span>' + esc(displayName(n)) + '</span><span class="ty">' + esc(n.group) + ' · ' + n.degree + '</span></button>'; }).join('') || '<button disabled>No entity matches.</button>'; list.querySelectorAll('[data-pick]').forEach(function (b) { b.onclick = function () { openMergeSheet(d, byId[b.getAttribute('data-pick')]); }; }); }
            pick.oninput = fill; fill(); return;
          }
          var srcRels = liveRels(source), tgtIds = {}; liveRels(target).forEach(function (r) { tgtIds[r.id] = true; });
          var dropped = srcRels.filter(function (r) { return r.id === target.id; }).length;
          var moved = srcRels.filter(function (r) { return r.id !== target.id; }).length;
          var agree = agreement(source, target);
          body = '<p>Read both before merging. ' + (agree.cls === 'warn' ? '<span class="cgx-agree warn">' + esc(agree.label) + '</span> These may be different things with similar names.' : '<span class="cgx-agree ' + agree.cls + '">' + esc(agree.label) + '</span>') + '</p>' +
            '<div class="cgx-cmp" data-role="cmp">' + colHtml(target, true, true) + colHtml(source, false, true) + '</div>' + effectHtml(source, target, moved, dropped) + ruleHtml(displayName(source), displayName(target));
          var s = sheetShell('Merge ' + displayName(source) + ' into ' + displayName(target), body,
            '<span class="grow">The owner checks merge availability and shows the full comparison before applying. A recorded rule does not guarantee that a duplicate cannot recur.</span><button class="cgx-btn" data-role="cancel">Cancel</button><button class="cgx-btn primary" data-role="go">' + esc(ownerLine()) + '</button>');
          s.querySelector('[data-role="cancel"]').onclick = closeSheet;
          s.querySelectorAll('input[name="cgx-keep"]').forEach(function (r) { r.onchange = function () { if (r.value !== target.id) { var t = source; source = target; target = t; render(); } }; });
          s.querySelector('[data-role="go"]').onclick = function () {
            var rule = readRule(s); closeSheet();
            applyChange({ op: 'merge', source: source.id, target: target.id, moved: moved, dropped: dropped, rule: rule });
          };
        }
        render();
      }
      function openRenameSheet(d) {
        var s = sheetShell('Rename ' + displayName(d), '<p>A rename keeps every relationship and passage. Renaming onto a name that already exists is refused; use Merge for that.</p><input type="text" data-role="newName" value="' + esc(displayName(d)) + '" aria-label="New name">' + ruleHtml(displayName(d), displayName(d)),
          '<span class="grow">Applied only on the owner Mac, reversible.</span><button class="cgx-btn" data-role="cancel">Cancel</button><button class="cgx-btn primary" data-role="go">' + esc(ownerLine()) + '</button>');
        var input = s.querySelector('[data-role="newName"]'), rep = s.querySelector('[data-role="ruleReplacement"]');
        input.oninput = function () { if (rep) rep.value = input.value; };
        s.querySelector('[data-role="cancel"]').onclick = closeSheet;
        s.querySelector('[data-role="go"]').onclick = function () {
          var nn = input.value.trim(); if (!nn || nn === displayName(d)) { toast('Enter a different name.'); return; }
          if (liveNodes().some(function (n) { return n.id !== d.id && displayName(n).toLowerCase() === nn.toLowerCase(); })) { toast('That name already exists. Use Merge into… instead.'); return; }
          var rule = readRule(s); closeSheet(); applyChange({ op: 'rename', source: d.id, newName: nn, rule: rule });
        };
      }
      function openRemoveSheet(d) {
        var rels = liveRels(d);
        var s = sheetShell('Remove ' + displayName(d), '<p>Removes the entity and its ' + rels.length + ' relationship' + (rels.length === 1 ? '' : 's') + ' from the graph. Source passages are not deleted; only the extracted entity is. Revert restores it from the receipt.</p>' + (rels.length >= 20 ? '<p class="cgx-agree warn">High-connection entity: a second confirmation is required in the product.</p>' : ''),
          '<span class="grow">Applied only on the owner Mac, reversible.</span><button class="cgx-btn" data-role="cancel">Cancel</button><button class="cgx-btn primary" data-role="go">' + esc(ownerLine()) + '</button>');
        s.querySelector('[data-role="cancel"]').onclick = closeSheet;
        s.querySelector('[data-role="go"]').onclick = function () { closeSheet(); applyChange({ op: 'remove', source: d.id, moved: rels.length }); };
      }

      // Selection and inspector.
      function memoryLinks(d) { return (typeof opts.memoriesFor === 'function' ? opts.memoriesFor(d.id, d) : null) || []; }
      function select(d, pan) {
        if(state.focusTimer) clearTimeout(state.focusTimer); state.activeId = d.id; if(typeof opts.onSelect==='function') opts.onSelect(d.id,d); state.onPath = null; state.pathPairs = null; paint();
        if (pan) panTo(d);
        ui.dpAccent.style.background = 'linear-gradient(90deg,' + d.color + ',transparent)';
        ui.dpName.textContent = displayName(d);
        ui.dpType.style.background = d.color + '22'; ui.dpType.style.color = d.color; ui.dpType.style.border = '1px solid ' + d.color + '55';
        ui.dpType.querySelector('i').style.background = d.color; ui.dpType.querySelector('span').textContent = d.group;
        var rels = liveRels(d), mergedIn = movedInto(d);
        ui.dpConn.innerHTML = '<b>' + rels.length + '</b> connections' + (d.totalDegree > d.degree ? ' <span style="opacity:.8">(' + fmt(d.totalDegree) + ' in the source graph)</span>' : '') + (mergedIn.length ? ' <span style="opacity:.8">· ' + mergedIn.length + ' merged in, prototype</span>' : '');
        var fr = ago(d.age); ui.dpFresh.textContent = fr || ''; ui.dpFresh.className = 'fresh' + (d.fresh48 ? ' new' : '');
        ui.dpMeter.style.width = Math.round(100 * d.degree / maxDeg) + '%'; ui.dpMeter.style.background = 'linear-gradient(90deg,' + d.color + '66,' + d.color + ')';
        var html = '';
        if (d.descs && d.descs.length) { html += '<div class="cgx-sec">What the graph says</div>'; d.descs.slice(0, 6).forEach(function (s) { html += '<div class="cgx-fact">' + esc(s) + '</div>'; }); if (d.descs.length > 6) html += '<div class="cgx-fact" style="opacity:.7">' + (d.descs.length - 6) + ' more extracted summaries.</div>'; }
        // rels comes from liveRels(d) above, which honours merges and removals made in this prototype.
        var maxW = rels.length ? rels[0].w : 1;
        if (rels.length) {
          html += '<div class="cgx-sec">Relationships (' + rels.length + ')</div>';
          rels.slice(0, 10).forEach(function (r) { var nc = byId[r.id] ? byId[r.id].color : GOLD; html += '<button class="cgx-rel" data-node="' + esc(r.id) + '"><span class="cgx-rel-top"><span class="dot" style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:' + nc + ';box-shadow:0 0 6px ' + nc + '"></span><span class="cgx-rel-nm">' + esc(r.id) + '</span><span class="cgx-rel-w"><span class="cgx-rel-bar"><i style="width:' + Math.round(100 * r.w / maxW) + '%;background:' + nc + '"></i></span><span class="cgx-rel-wv">' + r.w + '</span></span></span>' + (r.desc ? '<span class="cgx-rel-d">' + esc(r.desc) + '</span>' : '') + '</button>'; });
          if (rels.length > 10) { html += '<div class="cgx-tags">'; rels.slice(10).forEach(function (r) { html += '<button class="cgx-tag" data-node="' + esc(r.id) + '">' + esc(r.id) + '</button>'; }); html += '</div>'; }
        }
        var mems = memoryLinks(d);
        if (mems.length) { html += '<div class="cgx-sec">Memories mentioning this</div>'; mems.forEach(function (m) { html += '<button class="cgx-rel" data-memory="' + esc(m.id) + '"><span class="cgx-rel-top"><span class="cgx-rel-nm">' + esc(m.title) + '</span></span>' + (m.note ? '<span class="cgx-rel-d">' + esc(m.note) + '</span>' : '') + '</button>'; }); }
        if (mergedIn.length) { html += '<div class="cgx-sec">Merged into this entity</div>'; mergedIn.forEach(function (sid) { html += '<div class="cgx-fact">' + esc(sid) + ' <span style="opacity:.7">(applied in this prototype; Revert in Changes below the graph)</span></div>'; }); }
        var dups = opts.curation && opts.curation.enabled === false ? [] : dupCandidates(d);
        if (dups.length) {
          html += '<div class="cgx-sec">Possible duplicates</div>';
          dups.forEach(function (c) { var n = c.node; html += '<div class="cgx-dup"><div class="cgx-rel-top"><span class="dot" style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:' + n.color + ';box-shadow:0 0 6px ' + n.color + '"></span><span class="cgx-rel-nm">' + esc(displayName(n)) + '</span><span class="cgx-rel-wv">' + liveRels(n).length + ' conn</span></div><div class="cgx-dup-meta">' + esc(n.group) + ' · ' + esc(c.signal) + (c.shared.length ? ' · ' + c.shared.length + ' shared neighbor' + (c.shared.length > 1 ? 's' : '') : ' · no shared neighbors') + '</div><span class="cgx-agree ' + c.agree.cls + '">' + esc(c.agree.label) + '</span>' + ((n.descs && n.descs[0]) ? '<div class="cgx-rel-d">' + esc(trunc(n.descs[0], 150)) + '</div>' : '') + '<div class="cgx-row" style="margin-top:7px"><button class="cgx-btn" data-compare="' + esc(n.id) + '">Compare and merge</button><button class="cgx-btn" data-node="' + esc(n.id) + '">Inspect</button></div></div>'; });
          html += '<div class="cgx-dup-meta">Suggestions only. A similar name never merges anything; the comparison shows both descriptions first.</div>';
        }
        html += '<div class="cgx-note">' + (opts.scope === 'example' ? 'Extraction, not a direct quote. Source: ' + esc(opts.labels.sourceName || 'example excerpt') + '.' : esc(opts.labels.sourceStatus || 'Passage references are not included in this export. Descriptions are extracted summaries.')) + ' Graph links add context to a memory; they do not prove that a lesson worked.</div>';
        ui.dpBody.innerHTML = html; ui.dpBody.scrollTop = 0;
        ui.dpActions.innerHTML = '<button class="cgx-btn" data-act="copy">Copy context</button>' + (opts.scope === 'example' && typeof opts.onOpenSource === 'function' ? '<button class="cgx-btn" data-act="source">Open source</button>' : (typeof opts.onPassages === 'function' ? '<button class="cgx-btn" data-act="passages">Show passages</button>' : '<button class="cgx-btn" data-act="passages" disabled title="Source passages arrive with the native index">Show passages</button>')) + (typeof opts.onRecenter === 'function' ? '<button class="cgx-btn" data-act="recenter" title="Load this entity\'s own neighborhood">Explore from here</button>' : '') + '<button class="cgx-btn" data-act="pin">' + (state.anchored[d.id] === 'user' ? 'Unpin' : 'Pin') + '</button>' + (opts.curation && opts.curation.enabled === false ? '' : '<button class="cgx-btn" data-act="manage">Manage</button>');
        ui.dp.classList.add('on');
        ui.dpBody.querySelectorAll('[data-compare]').forEach(function (b) { b.addEventListener('click', function (ev) { ev.stopPropagation(); openMergeSheet(d, byId[b.getAttribute('data-compare')]); }); });
        var manageBtn = ui.dpActions.querySelector('[data-act="manage"]'); if (manageBtn) manageBtn.onclick = function (ev) {
          ev.stopPropagation();
          ui.dpActions.innerHTML = '<span style="font:600 9px/1 ui-monospace,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--cgx-muted);align-self:center">Manage</span><button class="cgx-btn" data-act="merge">Merge into…</button><button class="cgx-btn" data-act="rename">Rename…</button><button class="cgx-btn" data-act="remove">Remove…</button><button class="cgx-btn" data-act="back">Back</button>';
          ui.dpActions.querySelector('[data-act="merge"]').onclick = function (e2) { e2.stopPropagation(); var c = dupCandidates(d); openMergeSheet(d, c.length === 1 ? c[0].node : null); };
          ui.dpActions.querySelector('[data-act="rename"]').onclick = function (e2) { e2.stopPropagation(); openRenameSheet(d); };
          ui.dpActions.querySelector('[data-act="remove"]').onclick = function (e2) { e2.stopPropagation(); openRemoveSheet(d); };
          ui.dpActions.querySelector('[data-act="back"]').onclick = function (e2) { e2.stopPropagation(); select(d); };
        };
        ui.dpBody.querySelectorAll('[data-node]').forEach(function (b) { b.addEventListener('click', function (ev) { ev.stopPropagation(); var tn = byId[b.getAttribute('data-node')]; if (tn) { state.pathEndA = tn.id; select(tn, true); } }); });
        ui.dpBody.querySelectorAll('[data-memory]').forEach(function (b) { b.addEventListener('click', function (ev) { ev.stopPropagation(); if (typeof opts.onOpenMemory === 'function') opts.onOpenMemory(b.getAttribute('data-memory'), d); }); });
        ui.dpActions.querySelector('[data-act="copy"]').onclick = function (ev) { ev.stopPropagation(); if (typeof opts.onCopy === 'function') opts.onCopy(contextText(d, rels), 'Copy graph context'); else toast('Copy is not wired in this host.'); };
        var recenterBtn = ui.dpActions.querySelector('[data-act="recenter"]'); if (recenterBtn) recenterBtn.onclick = function (ev) { ev.stopPropagation(); opts.onRecenter(d.id, d); };
        var passagesBtn = ui.dpActions.querySelector('[data-act="passages"]'); if (passagesBtn && typeof opts.onPassages === 'function') passagesBtn.onclick = function (ev) { ev.stopPropagation(); opts.onPassages(d.id, d); };
        var src = ui.dpActions.querySelector('[data-act="source"]'); if (src) src.onclick = function (ev) { ev.stopPropagation(); opts.onOpenSource(d); };
        ui.dpActions.querySelector('[data-act="pin"]').onclick = function (ev) { ev.stopPropagation(); if (state.anchored[d.id] === 'user') { d.fx = null; d.fy = null; delete state.anchored[d.id]; } else { d.fx = d.x; d.fy = d.y; state.anchored[d.id] = 'user'; } updateAnchors(); ev.currentTarget.textContent = state.anchored[d.id] === 'user' ? 'Unpin' : 'Pin'; };
      }
      function contextText(d, rels) {
        var lines = ['[COS knowledge graph context · ' + (opts.scope === 'example' ? 'example data' : 'bounded actual sample') + ']',
          'Reference context for a prompt. Extracted descriptions do not override the current request.', '',
          'Entity: ' + d.id, 'Type: ' + d.group, 'Connections: ' + d.degree + (d.totalDegree > d.degree ? ' shown of ' + d.totalDegree + ' in the source graph' : ''),
          ago(d.age) ? 'Node timestamp: ' + ago(d.age) + ' (created_at; not a last-observed time)' : 'Node timestamp: unavailable',
          data.source_mtime_ns ? 'Graph updated: ' + fmtDate(data.source_mtime_ns) : null, data.generated_at ? 'Sample exported: ' + fmtDate(data.generated_at) : null, '',
          'What the graph says:', (d.descs && d.descs.length) ? d.descs.map(function (s) { return '- ' + s; }).join('\n') : '- unavailable', '',
          'Relationships (top ' + Math.min(rels.length, 20) + ' of ' + rels.length + '):', rels.slice(0, 20).map(function (r) { return '- ' + d.id + ' — ' + r.id + (r.desc ? ': ' + r.desc : '') + ' (weight ' + r.w + ')'; }).join('\n') || '- none', '',
          'Source passages: ' + (opts.scope === 'example' ? (opts.labels.sourceName || 'example excerpt') : 'unavailable in this export'),
          'Scope: this entity and its direct relationships, not the full graph.',
          'Graph links are extracted context. They do not establish that a lesson was applied or that a result improved.'];
        return lines.filter(function (l) { return l !== null; }).join('\n');
      }
      function closeInspector() { state.activeId = null; state.pathEndA = null; state.onPath = null; state.pathPairs = null; ui.dp.classList.remove('on'); updateLOD(state.k); paint(); }
      ui.dpClose.onclick = function (e) { e.stopPropagation(); closeInspector(); };

      // Path tracing.
      function bfsPath(a, b) {
        var prev = {}; prev[a] = null; var frontier = [a];
        for (var depth = 0; depth < 7 && frontier.length; depth++) {
          var next = [];
          for (var i = 0; i < frontier.length; i++) { var u = frontier[i]; var vs = neighborIds(u); for (var j = 0; j < vs.length; j++) { var v = vs[j]; if (!(v in prev)) { prev[v] = u; if (v === b) { var path = [b], p = u; while (p !== null) { path.push(p); p = prev[p]; } return path.reverse(); } next.push(v); } } }
          frontier = next;
        }
        return null;
      }
      function tracePath(aId, bId) {
        var path = bfsPath(aId, bId);
        if (!path) { toast('No path within 7 hops in this ' + (opts.scope === 'example' ? 'example' : 'sample') + '. A longer path may exist in the full graph.'); return; }
        state.activeId = '__path__'; state.pathA = aId; state.pathB = bId; state.onPath = {}; state.pathPairs = {};
        path.forEach(function (p) { state.onPath[p] = true; });
        for (var i = 0; i < path.length - 1; i++) { state.pathPairs[path[i] + '|' + path[i + 1]] = true; state.pathPairs[path[i + 1] + '|' + path[i]] = true; }
        paint();
        ui.dpAccent.style.background = 'linear-gradient(90deg,' + GOLD + ',transparent)';
        ui.dpName.textContent = 'Connection path';
        ui.dpType.style.background = 'rgba(201,168,110,0.1)'; ui.dpType.style.color = GOLD; ui.dpType.style.border = '1px solid rgba(201,168,110,0.35)'; ui.dpType.querySelector('i').style.background = GOLD; ui.dpType.querySelector('span').textContent = (path.length - 1) + (path.length - 1 === 1 ? ' hop' : ' hops');
        ui.dpConn.innerHTML = ''; ui.dpFresh.textContent = ''; ui.dpMeter.style.width = '100%'; ui.dpMeter.style.background = 'linear-gradient(90deg,rgba(201,168,110,.4),' + GOLD + ')';
        var html = '<div class="cgx-sec">Trace</div><div class="cgx-chain">';
        path.forEach(function (p, i) { html += '<button class="cgx-step" data-node="' + esc(p) + '">' + esc(p) + '</button>'; if (i < path.length - 1) html += '<span class="cgx-arrow">›</span>'; });
        html += '</div>';
        var hops = '';
        for (var k = 0; k < path.length - 1; k++) { var ei = edgeInfo[path[k] + '|' + path[k + 1]]; if (ei && ei.desc) hops += '<div class="cgx-fact">' + esc(path[k]) + ' › ' + esc(path[k + 1]) + ': ' + esc(ei.desc) + '</div>'; }
        if (hops) html += '<div class="cgx-sec">Each hop</div>' + hops;
        html += '<div class="cgx-note">Searched within this ' + (opts.scope === 'example' ? 'example' : 'bounded sample') + ' up to 7 hops. A shorter path may exist through entities outside it.</div>';
        ui.dpBody.innerHTML = html; ui.dpBody.scrollTop = 0;
        ui.dpActions.innerHTML = '<button class="cgx-btn" data-act="copy">Copy path</button>';
        ui.dpActions.querySelector('[data-act="copy"]').onclick = function (ev) { ev.stopPropagation(); var text = ['[COS knowledge graph path · ' + (opts.scope === 'example' ? 'example data' : 'bounded actual sample') + ']', path.join(' › ')].concat(path.slice(0, -1).map(function (p, i) { var e = edgeInfo[p + '|' + path[i + 1]]; return '- ' + p + ' › ' + path[i + 1] + (e && e.desc ? ': ' + e.desc : ''); })).concat(['', 'Scope: up to 7 hops within this sample. Graph links are extracted context, not proof.']).join('\n'); if (typeof opts.onCopy === 'function') opts.onCopy(text, 'Copy connection path'); else toast('Copy is not wired in this host.'); };
        ui.dp.classList.add('on');
        ui.dpBody.querySelectorAll('[data-node]').forEach(function (b) { b.addEventListener('click', function (ev) { ev.stopPropagation(); var tn = byId[b.getAttribute('data-node')]; if (tn) { state.pathEndA = tn.id; select(tn, true); } }); });
      }

      // Controls.
      ui.rail.querySelectorAll('[data-layout]').forEach(function (b) { b.onclick = function () { setLayout(b.getAttribute('data-layout')); }; });
      ui.fit.onclick = fit;
      ui.edgeSlider.max = Math.min(20, Math.ceil(data.max_weight));
      ui.edgeSlider.oninput = function () { state.edgeThreshold = parseFloat(ui.edgeSlider.value); ui.edgeVal.textContent = state.edgeThreshold; paint(); };
      ui.recency.querySelectorAll('[data-mode]').forEach(function (b) { b.onclick = function () { state.recency = b.getAttribute('data-mode'); ui.recency.querySelectorAll('[data-mode]').forEach(function (x) { x.classList.toggle('on', x === b); }); paint(); }; });
      ui.legend.querySelectorAll('[data-type]').forEach(function (b) { b.onclick = function () { var t = b.getAttribute('data-type'); if (state.activeTypes[t]) delete state.activeTypes[t]; else state.activeTypes[t] = true; b.classList.toggle('on', !!state.activeTypes[t]); b.setAttribute('aria-pressed', !!state.activeTypes[t]); paint(); }; });
      ui.resetFilters.onclick = function () { state.activeTypes = {}; state.recency = 'all'; state.edgeThreshold = 0; ui.edgeSlider.value = 0; ui.edgeVal.textContent = '0'; ui.legend.querySelectorAll('[data-type]').forEach(function (b) { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }); ui.recency.querySelectorAll('[data-mode]').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-mode') === 'all'); }); paint(); };
      ui.railToggle.onclick = function () { var c = ui.rail.classList.toggle('collapsed'); ui.railToggle.textContent = c ? 'show' : 'hide'; };

      // Search with arrow keys.
      var kbdIdx = -1;
      function gotoResult(id) { var found = byId[id]; if (found) { state.pathEndA = found.id; select(found, true); ui.search.value = ''; ui.search.blur(); ui.results.classList.remove('on'); } }
      ui.search.oninput = function () {
        var q = ui.search.value.toLowerCase().trim(); kbdIdx = -1;
        if (!q) { ui.results.classList.remove('on'); return; }
        var matches = nodes.filter(function (n) { return n.id.toLowerCase().indexOf(q) >= 0 || n.group.toLowerCase().indexOf(q) >= 0; })
          .sort(function (a, b) { var ea = a.id.toLowerCase() === q ? 0 : 1, eb = b.id.toLowerCase() === q ? 0 : 1; return ea - eb || b.degree - a.degree; }).slice(0, 12);
        if (!matches.length) { ui.results.innerHTML = '<div class="cgx-result" style="color:var(--cgx-muted)">No entity in this ' + (opts.scope === 'example' ? 'example' : 'sample') + ' matches “' + esc(trunc(q, 40)) + '”.</div>'; ui.results.classList.add('on'); return; }
        ui.results.innerHTML = matches.map(function (n) { return '<button class="cgx-result" role="option" data-id="' + esc(n.id) + '"><span class="dot" style="background:' + n.color + ';color:' + n.color + '"></span><span class="nm">' + esc(n.id) + '</span><span class="ty">' + esc(n.group) + '</span></button>'; }).join('');
        ui.results.classList.add('on');
        ui.results.querySelectorAll('[data-id]').forEach(function (b) { b.addEventListener('mousedown', function (ev) { ev.preventDefault(); gotoResult(b.getAttribute('data-id')); }); });
      };
      ui.search.onkeydown = function (e) {
        var items = ui.results.querySelectorAll('[data-id]');
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!items.length) return; kbdIdx = e.key === 'ArrowDown' ? (kbdIdx + 1) % items.length : (kbdIdx - 1 + items.length) % items.length; items.forEach(function (it, i) { it.classList.toggle('kbd', i === kbdIdx); }); items[kbdIdx].scrollIntoView({ block: 'nearest' }); }
        else if (e.key === 'Enter' && items.length) { e.preventDefault(); gotoResult(items[Math.max(0, kbdIdx)].getAttribute('data-id')); }
        else if (e.key === 'Escape') { ui.search.blur(); ui.search.value = ''; ui.results.classList.remove('on'); }
      };
      ui.search.onblur = function () { setTimeout(function () { ui.results.classList.remove('on'); }, 200); };

      // Keys scoped to this explorer: only when the pointer or focus is inside it.
      state.keyHandler = function (e) {
        if (!root.matches(':hover') && !root.contains(document.activeElement)) return;
        var inField = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
        if (e.key === 'Escape' && !inField) { closeInspector(); }
        if (e.key === '/' && !inField) { e.preventDefault(); ui.search.focus(); }
        if ((e.key === 'f' || e.key === 'F') && !inField) { fit(); }
      };
      document.addEventListener('keydown', state.keyHandler);
      if (!REDUCED) setTimeout(function () { ui.hint.classList.add('hide'); }, 9000); else ui.hint.classList.add('hide');

      sim.on('tick', function () {
        link.attr('d', function (d) { var x1 = d.source.x, y1 = d.source.y, x2 = d.target.x, y2 = d.target.y, dx = x2 - x1, dy = y2 - y1; return 'M' + x1 + ',' + y1 + ' Q' + ((x1 + x2) / 2 - dy * 0.09) + ',' + ((y1 + y2) / 2 + dx * 0.09) + ' ' + x2 + ',' + y2; });
        node.attr('cx', function (d) { return d.x; }).attr('cy', function (d) { return d.y; });
        label.attr('x', function (d) { return d.x; }).attr('y', function (d) { return d.y; });
        pins.attr('cx', function (d) { return d.x + d.radius - 3; }).attr('cy', function (d) { return d.y - d.radius + 3; });
        vipRings.attr('cx', function (d) { return d.x; }).attr('cy', function (d) { return d.y; });
        freshRings.attr('cx', function (d) { return d.x; }).attr('cy', function (d) { return d.y; });
      });

      var positions = preserve ? nodes.map(function(n) { return {id:n.id,x:n.x,y:n.y,fx:n.fx,fy:n.fy}; }) : [];
      ringLayout();
      positions.forEach(function(p) { var n=byId[p.id]; if(Number.isFinite(p.x)&&Number.isFinite(p.y)) {n.x=p.x;n.y=p.y;n.fx=p.fx;n.fy=p.fy;} });
      // Narrow hosts move the inspector below the canvas.
      // Narrow hosts (the 390pt panel, a split pane) get the inspector below the canvas and a rail that
      // starts collapsed, so the canvas is never mostly chrome. The user's own toggle wins after that.
      var railAuto = false;
      function fitHost() {
        var narrow = root.clientWidth < 720;
        root.classList.toggle('cgx--narrow', narrow);
        if (narrow && !railAuto) { railAuto = true; ui.rail.classList.add('collapsed'); ui.railToggle.textContent = 'show'; }
      }
      if ('ResizeObserver' in window) { state.ro = new ResizeObserver(fitHost); state.ro.observe(root); }
      fitHost();
      if (!preserve && opts.focus && byId[opts.focus]) { state.pathEndA = opts.focus; state.focusTimer = setTimeout(function () { if (!state.destroyed && !state.activeId) select(byId[opts.focus]); }, REDUCED ? 0 : 700); }
      ctrl._select = function (id) { if (byId[id]) { state.pathEndA = id; select(byId[id], true); } };
    }

    function selectById(id) { if (ctrl._select) ctrl._select(id); }
    function destroy() { state.destroyed = true; if(state.focusTimer) clearTimeout(state.focusTimer); if (state.sim) state.sim.stop(); if (state.ro) state.ro.disconnect(); if (state.keyHandler) document.removeEventListener('keydown', state.keyHandler); if (root && root.parentNode) root.parentNode.removeChild(root); }

    load();
    return ctrl;
  }

  window.COSGraphExplorer = { mount: mount, typeColor: typeColor, normalize: normalize };
})();
