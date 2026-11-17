/* 7.0.55: live glass on Today's Running rows (A1; Miles 11/17 08:47 "more expressive similar to the gotcos.com homepage",
   09:04 "more glass morphisim / amber like the desktop ... reduce the size", 09:30 "get this built out"; the lead's 09:32
   ruling). Reference mock: wk47_2026/gotcos_material/control_web_qa/working-mark-mock.html.

   Each working row's mark is the COS molecule in the desktop mark's amber glass (export_app_mark.py MAT dark, the strips'
   own material), drawn live by ONE WebGL context on ONE canvas laid over the Running panel. The motion only ever says
   something true:
     progress  the atoms gather and the three bonds fuse at real thirds, ONLY from a real done and total (a session's
               subagent_activity). With no real count the molecule holds one mid pose and no bond fuses. Never invented.
     activity  a bead drops into a node and the node swells, ONLY when the row's own activity time moves forward (a frame
               on the live stream), at most one a second per row. No stream, no beads. Never a timer.
     done      the last bonds fuse into the full mark, every node swells once, then it rests.
     waiting   it stops where it is.
   Limits (the lead, 09:32): one context for every row; at most 3 rows drawn live, the rest still; nothing drawn while the
   page is hidden or the panel is off screen; Reduce Motion draws one still pose and stops; about 30 frames a second.
   No WebGL, a shader that fails, or a lost context: mount() returns false or onFail fires, and the caller keeps the
   7.0.54 strip mark. The slot never changes row height: it is 36 x 20 in the badge line and the glass overhangs it.

   API (window.CosRunGlass):
     mount(panel, {onFail})   lay the canvas over panel; false when the glass cannot draw here
     sync(rows)               rows in display order: {key, state: 'work'|'wait'|'done', done, total, activityAt}
     wake()                   look again (scroll, resize, visibility, the reduce setting): the caller may call it freely
     animating()              true while a live glass row moves on screen (the rail and top-bar marks then rest)
     unmount()                take the canvas off; the context is kept for the next mount
   The slots are '.rg-slot[data-rg-key="<key>"]' inside the panel; a key with no slot on the page is not drawn. */
(function () {
  'use strict';
  var VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
  var FS = [
    'precision highp float;',
    'uniform vec2 uC;uniform float uPx;uniform mat3 uRT;',
    'uniform vec3 uN[7];uniform float uR[7];uniform vec3 uNk;uniform vec4 uD[4];',
    'float smin(float a,float b,float k){float h=clamp(.5+.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.-h);}',
    'float cap(vec3 p,vec3 a,vec3 b,float r){vec3 pa=p-a,ba=b-a;float h=clamp(dot(pa,ba)/dot(ba,ba),0.,1.);return length(pa-ba*h)-r;}',
    // the blend scales with the join, so a thin join opens instead of popping (F1's note on the exporter)
    'float pr(vec3 p,vec3 a,float ra,vec3 b,float rb,float nk){float d=min(length(p-a)-ra,length(p-b)-rb);if(nk>.01)d=smin(d,cap(p,a,b,nk),.55*clamp(nk/.34,.25,1.));return d;}',
    'float map(vec3 p){',
    '  float d=length(p-uN[0])-uR[0];',
    '  d=min(d,pr(p,uN[1],uR[1],uN[2],uR[2],uNk.x));',
    '  d=min(d,pr(p,uN[3],uR[3],uN[4],uR[4],uNk.y));',
    '  d=min(d,pr(p,uN[5],uR[5],uN[6],uR[6],uNk.z));',
    '  for(int i=0;i<4;i++){if(uD[i].w>.001)d=smin(d,length(p-uD[i].xyz)-uD[i].w,.6);}',
    '  return d;}',
    'vec3 nrm(vec3 p){vec2 e=vec2(.012,-.012);return normalize(e.xyy*map(p+e.xyy)+e.yyx*map(p+e.yyx)+e.yxy*map(p+e.yxy)+e.xxx*map(p+e.xxx));}',
    // the desktop mark's material, MAT['dark']: env (1,.70,.34), ab (.08,1.20,4.50), gain .68, carry .26, hi .32
    'vec3 env(vec3 d){vec3 c=vec3(1.,.70,.34)*mix(.55,1.5,smoothstep(-.9,.9,d.y));float w=smoothstep(.15,.80,d.y)*smoothstep(.95,.10,abs(d.x+.35));return c+vec3(1.,.92,.80)*w*w*.64;}',
    'void main(){',
    '  vec2 q=(gl_FragCoord.xy-uC)/uPx;',
    '  vec3 ro=uRT*vec3(q,6.5),rd=uRT*vec3(0.,0.,-1.);',
    '  float t=0.,dmin=1e3,tmin=0.;bool hit=false;',
    '  for(int i=0;i<56;i++){float d=map(ro+rd*t);if(d<dmin){dmin=d;tmin=t;}if(d<.002){hit=true;break;}t+=d;if(t>13.)break;}',
    '  float a=hit?1.:1.-smoothstep(0.,1.3/uPx,dmin);',
    '  if(a<.003){gl_FragColor=vec4(0.);return;}',
    '  vec3 p=ro+rd*(hit?t:tmin);vec3 n=nrm(p);vec3 nv=n*uRT;float ndv=clamp(nv.z,0.,1.);',
    '  vec3 rin=refract(rd,n,1./1.46);vec3 pi=p-n*.04;float L=0.;',
    '  for(int i=0;i<26;i++){float d=-map(pi);if(d<.004)break;float st=max(d,.035);pi+=rin*st;L+=st;}',
    '  vec3 n2=-nrm(pi);vec3 rout=refract(rin,n2,1.46);if(dot(rout,rout)<.01)rout=reflect(rin,n2);',
    '  vec3 T=exp(-vec3(.08,1.20,4.50)*L);',
    '  vec3 g=env(rout*uRT)*T*.68;g+=vec3(.95,.42,.07)*(1.-exp(-L*.6))*.26;',
    // the surface mirrors the room, faded at the very silhouette so a 36 px mark has no pale ring
    '  float F=.04+.96*pow(1.-ndv,5.);vec3 r=reflect(vec3(0.,0.,-1.),nv);g=mix(g,env(r),F*.85*smoothstep(.03,.30,ndv));',
    '  float box=smoothstep(.10,.62,r.y)*smoothstep(1.,.62,r.y)*smoothstep(.70,.10,abs(r.x+.30));g+=vec3(1.,.95,.86)*box*box*.32;',
    '  g=g/(1.+.28*g);g=pow(g,vec3(1./2.2));',
    '  if(!hit)g=mix(g,vec3(.60,.26,.09),.85);',
    '  float al=a*(1.-.22*dot(T,vec3(.34,.33,.33)));',          // thin glass lets the panel show through
    '  gl_FragColor=vec4(g*al,al);}'
  ].join('\n');

  // The logo's geometry (logo-mark.svg, node radius 100) in units, with the hero's small depth so it turns like a molecule.
  var DEPTH = [0.5, -0.45, 0.3, 0.45, -0.5, -0.3, 0.55];
  var NODE = [[348, 100], [100, 240], [100, 520], [593, 240], [348, 380], [593, 520], [348, 660]].map(function (p, i) { return [(p[0] - 346.5) / 100, (380 - p[1]) / 100, DEPTH[i]]; });
  var LOOSE = NODE.map(function (p, i) { var d = Math.hypot(p[0], p[1]) || 1; return [p[0] + p[0] / d * 0.95, p[1] + p[1] / d * 0.95, i % 2 ? 0.9 : -0.9]; });
  var NECK = 0.34, UNITS = 9.0, SIZE = 36, LIVE_MAX = 3, FRAME_MS = 33, BEAD_MS = 900, BEAD_GAP_MS = 1000, MID = 0.6;
  var C = {
    gl: null, cv: null, prog: null, U: {}, failed: '', panel: null, onFail: null,
    rows: {}, order: [], raf: 0, last: 0, clock: 0, onScreen: true, io: null, wired: false, stillSig: '', frames: 0
  };
  var nArr = new Float32Array(21), rArr = new Float32Array(7), dArr = new Float32Array(16);
  var ease = function (x) { return 1 - Math.pow(1 - x, 3); };
  var inOut = function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  function reduced() { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_e) { return false; } }
  function hidden() { return !!(typeof document !== 'undefined' && document.hidden); }

  function fail(why) {
    C.failed = why;
    var cb = C.onFail;
    unmount();
    if (typeof cb === 'function') { try { cb(why); } catch (_e) {} }
  }

  /** One context for the page's life: made on the first mount, kept across unmounts. */
  function init() {
    if (C.gl) return true;
    if (C.failed) return false;
    var cv = document.createElement('canvas');
    cv.className = 'rg-canvas'; cv.setAttribute('aria-hidden', 'true');
    var gl = null;
    try { gl = cv.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, powerPreference: 'low-power' }); } catch (_e) { gl = null; }
    if (!gl) { C.failed = 'no-webgl'; return false; }
    try {
      var sh = function (type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('compile'); return s; };
      var prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
      gl.useProgram(prog);
      var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      ['uC', 'uPx', 'uRT', 'uN', 'uR', 'uNk', 'uD'].forEach(function (n) { C.U[n] = gl.getUniformLocation(prog, n); });
      gl.enable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0);
      C.prog = prog;
    } catch (e) { C.failed = 'shader:' + (e && e.message || 'error'); return false; }
    cv.addEventListener('webglcontextlost', function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); C.gl = null; fail('context-lost'); });
    C.gl = gl; C.cv = cv;
    return true;
  }

  function wire() {
    if (C.wired) return;
    C.wired = true;
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('resize', wake);
    try {
      var mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq && mq.addEventListener) mq.addEventListener('change', wake); else if (mq && mq.addListener) mq.addListener(wake);
    } catch (_e) {}
  }

  function mount(panel, opts) {
    if (!panel) return false;
    C.onFail = opts && typeof opts.onFail === 'function' ? opts.onFail : null;
    if (!init()) return false;
    wire();
    if (C.panel !== panel) {
      if (C.io) { C.io.disconnect(); C.io = null; }
      C.panel = panel;
      panel.appendChild(C.cv);
      C.onScreen = true;
      if (window.IntersectionObserver) {
        C.io = new IntersectionObserver(function (es) { C.onScreen = !!(es[0] && es[0].isIntersecting); wake(); }, { threshold: [0] });
        C.io.observe(panel);
      }
    } else if (C.cv.parentNode !== panel) panel.appendChild(C.cv);
    C.stillSig = '';
    wake();
    return true;
  }

  function unmount() {
    if (C.raf) { cancelAnimationFrame(C.raf); C.raf = 0; }
    if (C.io) { C.io.disconnect(); C.io = null; }
    if (C.cv && C.cv.parentNode) C.cv.parentNode.removeChild(C.cv);
    C.panel = null; C.last = 0; C.stillSig = '';
  }

  function model(key) {
    var m = C.rows[key];
    if (!m) {
      m = C.rows[key] = { key: key, seed: (Object.keys(C.rows).length * 1.37) % 5, state: 'work', done: null, total: null,
        e: -1, nk: [0, 0, 0], pulse: [0, 0, 0, 0, 0, 0, 0], drops: [], activityAt: null, bead: false, lastBead: -1e9, finished: false };
    }
    return m;
  }

  /** The real progress, or null: never invented. */
  function progress(m) {
    if (m.state === 'done') return 1;
    if (typeof m.total === 'number' && m.total > 0 && typeof m.done === 'number' && m.done >= 0) return Math.min(1, m.done / m.total);
    return null;
  }
  function targetE(m) { var p = progress(m); return p == null ? MID : 0.28 + 0.62 * p; }
  function targetNeck(m, k) {
    var p = progress(m);
    if (p == null) return 0;                                  // no real count: no bond fuses
    return NECK * Math.min(1, Math.max(0, (p - k / 3) * 3));
  }

  function sync(rows) {
    var seen = {}, order = [];
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r || typeof r.key !== 'string' || !r.key || seen[r.key]) return;
      seen[r.key] = true; order.push(r.key);
      var m = model(r.key), st = r.state === 'wait' || r.state === 'done' ? r.state : 'work';
      if (st === 'done' && m.state !== 'done') { for (var j = 0; j < 7; j++) m.pulse[j] = 0.22; }
      m.state = st;
      m.done = typeof r.done === 'number' && isFinite(r.done) ? r.done : null;
      m.total = typeof r.total === 'number' && isFinite(r.total) ? r.total : null;
      // Activity: only a later time than the one already seen. The first sight of a row sets the mark, no bead.
      var at = typeof r.activityAt === 'number' && isFinite(r.activityAt) ? r.activityAt : null;
      if (at != null && m.activityAt != null && at > m.activityAt && st === 'work') m.bead = true;
      if (at != null && (m.activityAt == null || at > m.activityAt)) m.activityAt = at;
      if (m.e < 0) { m.e = targetE(m); for (var k = 0; k < 3; k++) m.nk[k] = targetNeck(m, k); }
    });
    Object.keys(C.rows).forEach(function (k) { if (!seen[k]) delete C.rows[k]; });
    C.order = order;
    wake();                                                   // a still is redrawn only when its signature changes

  }

  /** The rows that may move: working, in display order, the first LIVE_MAX of them. */
  function liveKeys() {
    var out = [];
    for (var i = 0; i < C.order.length && out.length < LIVE_MAX; i++) { var m = C.rows[C.order[i]]; if (m && (m.state === 'work' || (m.state === 'done' && settling(m)))) out.push(m.key); }
    return out;
  }
  function settling(m) {
    if (Math.abs(targetE(m) - m.e) > 0.004) return true;
    for (var k = 0; k < 3; k++) if (Math.abs(targetNeck(m, k) - m.nk[k]) > 0.004) return true;
    for (var j = 0; j < 7; j++) if (m.pulse[j] > 0.004) return true;
    return m.drops.length > 0;
  }
  function motionAllowed() { return !!(C.panel && C.gl && !hidden() && C.onScreen && !reduced()); }
  function slotFor(key) {
    if (!C.panel || !C.panel.querySelector) return null;
    var k = String(key), q = window.CSS && typeof CSS.escape === 'function' ? CSS.escape(k) : k.replace(/["\\]/g, '\\$&');
    var s = C.panel.querySelector('.rg-slot[data-rg-key="' + q + '"]');
    return s && s.isConnected !== false ? s : null;
  }
  function animating() {
    if (!motionAllowed()) return false;
    var keys = liveKeys();
    for (var i = 0; i < keys.length; i++) if (C.rows[keys[i]].state === 'work' && slotFor(keys[i])) return true;
    return false;
  }

  function wake() {
    if (!C.panel || !C.gl) return;
    if (motionAllowed() && liveKeys().length) { if (!C.raf) { C.last = 0; C.raf = requestAnimationFrame(loop); } return; }
    if (C.raf) { cancelAnimationFrame(C.raf); C.raf = 0; }
    if (!hidden() && C.onScreen) drawStill();
  }

  function loop(t) {
    C.raf = 0;
    if (!motionAllowed()) { wake(); return; }
    var keys = liveKeys();
    if (!keys.length) { wake(); return; }
    C.raf = requestAnimationFrame(loop);
    if (C.last && t - C.last < FRAME_MS) return;              // about 30 frames a second: slow motion needs no more
    var dt = C.last ? Math.min(t - C.last, 60) : FRAME_MS;
    C.last = t; C.clock += dt;
    step(dt, keys);
    draw(keys);
  }

  function step(dt, keys) {
    var ke = 1 - Math.pow(0.04, dt / 1000);                   // eases toward its target in about a second
    keys.forEach(function (key) {
      var m = C.rows[key], j;
      if (m.bead && C.clock - m.lastBead >= BEAD_GAP_MS && m.state === 'work') {
        m.bead = false; m.lastBead = C.clock;
        var node = Math.floor((m.activityAt || C.clock) / 7) % 7, ang = (m.seed + C.clock * 0.001) * 2.1;
        m.drops.push({ t0: C.clock, node: node, from: [Math.cos(ang) * 4.2, -3.6 + Math.sin(ang) * 0.6, 1.6] });
      }
      m.e += (targetE(m) - m.e) * ke;
      for (j = 0; j < 3; j++) m.nk[j] += (targetNeck(m, j) - m.nk[j]) * ke;
      for (j = 0; j < 7; j++) m.pulse[j] *= Math.pow(0.94, dt / 16);
    });
  }

  function rot(ry, rx) { var cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx); return [cy, sy * sx, sy * cx, 0, cx, -sx, -sy, cy * sx, cy * cx]; }

  /** A still frame: the pose for each row's real progress, no drift, no turn. Drawn again only when something changed. */
  function drawStill() {
    var keys = C.order.filter(function (k) { return !!slotFor(k); });
    var sig = keys.map(function (k) { var m = C.rows[k]; return k + ':' + m.state + ':' + m.done + '/' + m.total; }).join('|') + '@' + (C.panel ? C.panel.clientWidth + 'x' + C.panel.clientHeight : '') + ':' + (window.devicePixelRatio || 1);
    if (sig === C.stillSig) return;
    C.stillSig = sig;
    keys.forEach(function (k) { var m = C.rows[k], j; m.e = targetE(m); for (j = 0; j < 3; j++) m.nk[j] = targetNeck(m, j); for (j = 0; j < 7; j++) m.pulse[j] = 0; m.drops.length = 0; m.bead = false; });
    draw([], true);
  }

  function draw(liveList, still) {
    var gl = C.gl, panel = C.panel;
    if (!gl || !panel) return;
    var dpr = window.devicePixelRatio || 1, W = panel.clientWidth, H = panel.clientHeight;
    var bw = Math.max(1, Math.round(W * dpr)), bh = Math.max(1, Math.round(H * dpr));
    if (C.cv.width !== bw || C.cv.height !== bh) { C.cv.width = bw; C.cv.height = bh; }
    gl.viewport(0, 0, bw, bh); gl.scissor(0, 0, bw, bh); gl.clear(gl.COLOR_BUFFER_BIT);
    var pr = panel.getBoundingClientRect(), live = {};
    (liveList || []).forEach(function (k) { live[k] = true; });
    var ts = C.clock * 0.001;
    C.order.forEach(function (key) {
      var m = C.rows[key], slot = slotFor(key);
      if (!m || !slot) return;
      var sr = slot.getBoundingClientRect();
      var cx = sr.left - pr.left - (panel.clientLeft || 0) + sr.width / 2, cy = sr.top - pr.top - (panel.clientTop || 0) + sr.height / 2;
      var moving = !still && live[key] && m.state === 'work', i;
      var e = ease(Math.min(1, Math.max(0, m.e)));
      var R = moving ? rot(Math.sin(ts * 0.35 + m.seed * 1.7) * 0.32 + (1 - e) * 0.7, 0.05 + Math.sin(ts * 0.23 + m.seed) * 0.08) : rot((1 - e) * 0.35, 0.05);
      for (i = 0; i < 7; i++) {
        var a = LOOSE[i], b = NODE[i], w = moving ? (1 - e) * 0.32 + 0.03 : 0;   // loose atoms drift; gathered ones barely breathe
        nArr[i * 3] = a[0] + (b[0] - a[0]) * e + Math.sin(ts * 0.9 + i * 1.3 + m.seed) * w;
        nArr[i * 3 + 1] = a[1] + (b[1] - a[1]) * e + Math.cos(ts * 0.7 + i * 2.1 + m.seed) * w;
        nArr[i * 3 + 2] = a[2] + (b[2] - a[2]) * e;
        rArr[i] = (0.74 + 0.26 * e) * (1 + m.pulse[i]);
      }
      dArr.fill(0);
      var dn = 0;
      for (i = m.drops.length - 1; i >= 0; i--) {
        var d = m.drops[i], u = (C.clock - d.t0) / BEAD_MS;
        if (u >= 1) { m.pulse[d.node] = Math.max(m.pulse[d.node], 0.16); m.drops.splice(i, 1); continue; }
        if (dn >= 4) continue;
        var q = inOut(u), tx = nArr[d.node * 3], ty = nArr[d.node * 3 + 1], tz = nArr[d.node * 3 + 2];
        var rad = 0.42 * Math.min(u / 0.2, 1) * (u > 0.8 ? (1 - u) / 0.2 : 1);
        dArr[dn * 4] = d.from[0] + (tx - d.from[0]) * q; dArr[dn * 4 + 1] = d.from[1] + (ty - d.from[1]) * q; dArr[dn * 4 + 2] = d.from[2] + (tz - d.from[2]) * q; dArr[dn * 4 + 3] = rad; dn++;
      }
      var pxu = SIZE * dpr / UNITS, bs = Math.ceil(SIZE * dpr);
      gl.scissor(Math.round((cx - SIZE / 2) * dpr), Math.round((H - cy - SIZE / 2) * dpr), bs, bs);
      gl.uniform2f(C.U.uC, cx * dpr, (H - cy) * dpr); gl.uniform1f(C.U.uPx, pxu);
      gl.uniformMatrix3fv(C.U.uRT, false, new Float32Array(R));
      gl.uniform3fv(C.U.uN, nArr); gl.uniform1fv(C.U.uR, rArr); gl.uniform3f(C.U.uNk, m.nk[0], m.nk[1], m.nk[2]); gl.uniform4fv(C.U.uD, dArr);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });
    C.frames++;
  }

  window.CosRunGlass = {
    mount: mount, unmount: unmount, sync: sync, wake: wake, animating: animating,
    supported: function () { return init(); },
    /** For tests and diagnostics: what the module decided, never the pixels. */
    state: function () {
      var rows = {};
      Object.keys(C.rows).forEach(function (k) { var m = C.rows[k]; rows[k] = { state: m.state, e: m.e, nk: m.nk.slice(), target: targetE(m), necks: [0, 1, 2].map(function (j) { return targetNeck(m, j); }), bead: m.bead, drops: m.drops.length, beadsAt: m.lastBead }; });
      return { mounted: !!C.panel, failed: C.failed, frames: C.frames, running: !!C.raf, live: liveKeys(), rows: rows };
    },
    LIMITS: { LIVE_MAX: LIVE_MAX, FRAME_MS: FRAME_MS, BEAD_GAP_MS: BEAD_GAP_MS, SIZE: SIZE, MID: MID, NECK: NECK }
  };
})();
