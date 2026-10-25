/* Freeze Fountain - prototype v1
 * Water leaps from the fountain; tap to freeze it mid-splash and match the ghost silhouette.
 *
 * Architecture
 *  - SIM (pure, DOM-free, deterministic): silhouette definitions, parametric emitters,
 *    grid-overlap scoring. Exported for node so thresholds can be calibrated offline.
 *  - GAME (browser only): fixed 120 Hz step, state machine, rendering on one canvas, WebAudio.
 *
 * Emitter model: every stream of water flows along a curve whose shape at sim time t is
 *   lerp(wildArc(s, t), targetStroke(s), m(t))
 * wildArc  = ballistic arc from the nozzle with animated angle + power (a dancing fountain),
 * target   = the silhouette stroke, m(t) = periodic match envelope (sharpness k, period P).
 * So the water shape is known for every frame and the Perfect window is tunable per silhouette.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- constants
  var W = 390, H = 844;
  var NOZ = { x: 195, y: 598 };       // nozzle in logical px
  var STEP = 1 / 120;                 // fixed sim step
  var GRAV = 900;                     // px/s^2 for the wild arcs
  var TS = 128;                       // samples per target stroke
  var DROPS = 56;                     // droplets per stream
  var CELL = 12, GX0 = -186, GY0 = -384, COLS = 31, ROWS = 36; // scoring grid (relative to nozzle)
  var MASK_R = 15, WATER_R = 12;

  function mirror(pts) { return pts.map(function (p) { return [-p[0], p[1]]; }); }

  // ---------------------------------------------------------------- silhouettes (easy -> hard)
  // strokes: control points relative to the nozzle (y up is negative).
  // period: seconds between matches, k: envelope sharpness (higher = briefer match),
  // first: time of first match after the sculpture starts, offs: per-stream peak offsets (messiness),
  // jit: droplet wobble px, mist: stray droplets per stream that never match, flow: spray speed.
  // perfect/good: IoU thresholds (calibrated with calibrate(); see report).
  var HEART_R = [[0, 0], [62, -78], [114, -166], [122, -232], [94, -284], [44, -294], [6, -258], [0, -244]];
  var TULIP_R = [[0, 0], [8, -120], [44, -186], [92, -232], [104, -296], [74, -338]];
  var BFLY_UP = [[0, 0], [14, -120], [60, -240], [128, -300], [158, -268], [136, -206], [40, -170]];
  var BFLY_LO = [[0, 0], [48, -40], [112, -66], [130, -112], [100, -150], [36, -150]];

  var DEFS = [
    { name: 'Heart', dwell: 0.55, period: 2.6, k: 1.6, first: 1.7, jit: 2.5, mist: 0, flow: 0.55,
      perfect: 0.72, good: 0.40,
      strokes: [HEART_R, mirror(HEART_R)] },
    { name: 'Tulip', dwell: 0.4, period: 2.5, k: 2.6, first: 1.8, jit: 3, mist: 0, flow: 0.6,
      perfect: 0.74, good: 0.45,
      strokes: [[[0, 0], [0, -110], [0, -220], [0, -330]], TULIP_R, mirror(TULIP_R)] },
    { name: 'Dolphin', dwell: 0.28, period: 2.4, k: 4, first: 1.8, jit: 3.5, mist: 4, flow: 0.65,
      perfect: 0.66, good: 0.40,
      strokes: [
        [[0, 0], [44, -110], [40, -210], [6, -272], [-14, -286], [-6, -332], [-44, -302], [-100, -300], [-150, -272], [-178, -250]],
        [[0, 0], [14, -110], [-2, -200], [-40, -246], [-100, -260], [-178, -250]],
        [[0, 0], [44, 6], [86, -12]],
        [[0, 0], [-38, 12], [-74, 2]]] },
    { name: 'Snail', dwell: 0.2, period: 2.3, k: 6, first: 1.9, jit: 4, mist: 6, flow: 0.7,
      perfect: 0.58, good: 0.36,
      strokes: [
        [[0, 0], [-56, -80], [-104, -186], [-70, -282], [24, -306], [92, -238], [64, -166], [-2, -170], [-14, -224], [26, -240]],
        [[0, 0], [76, -14], [140, -34], [162, -84], [150, -120]]] },
    { name: 'Butterfly', dwell: 0.15, period: 2.2, k: 8, first: 1.9, jit: 4.5, mist: 6, flow: 0.75,
      perfect: 0.60, good: 0.38,
      strokes: [BFLY_UP, mirror(BFLY_UP), BFLY_LO, mirror(BFLY_LO)] },
    { name: 'Swan', dwell: 0.07, period: 2.1, k: 11, first: 2.0, jit: 5, mist: 9, flow: 0.8,
      perfect: 0.52, good: 0.34,
      strokes: [
        [[0, 0], [-60, -50], [-62, -120], [-34, -190], [-40, -250], [-74, -284], [-108, -280], [-138, -256]],
        [[0, 0], [60, -34], [120, -56], [158, -100], [150, -130]],
        [[0, 0], [34, -52], [86, -82], [136, -86]]] }
  ];

  // ---------------------------------------------------------------- geometry helpers
  function catmull(p0, p1, p2, p3, u) {
    var u2 = u * u, u3 = u2 * u;
    return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
  }
  // dense Catmull-Rom polyline, then resample to n points evenly by arc length
  function sampleStroke(pts, n) {
    var dense = [], i, j;
    for (i = 0; i < pts.length - 1; i++) {
      var a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[i + 1], d = pts[Math.min(pts.length - 1, i + 2)];
      for (j = 0; j < 24; j++) {
        var u = j / 24;
        dense.push([catmull(a[0], b[0], c[0], d[0], u), catmull(a[1], b[1], c[1], d[1], u)]);
      }
    }
    dense.push(pts[pts.length - 1].slice());
    var cum = [0];
    for (i = 1; i < dense.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
    }
    var total = cum[cum.length - 1], xs = new Float32Array(n), ys = new Float32Array(n), k = 0;
    for (i = 0; i < n; i++) {
      var target = total * i / (n - 1);
      while (k < cum.length - 2 && cum[k + 1] < target) k++;
      var seg = cum[k + 1] - cum[k] || 1, f = (target - cum[k]) / seg;
      xs[i] = dense[k][0] + (dense[k + 1][0] - dense[k][0]) * f;
      ys[i] = dense[k][1] + (dense[k + 1][1] - dense[k][1]) * f;
    }
    return { x: xs, y: ys, len: total };
  }

  function buildSil(def) {
    var sil = { def: def, name: def.name, streams: [], perfect: def.perfect, good: def.good };
    var minY = 0, maxY = 0, minX = 0, maxX = 0;
    def.strokes.forEach(function (pts, i) {
      var smp = sampleStroke(pts, TS);
      var mid = Math.floor(TS * 0.55), hmax = 0, q;
      for (q = 0; q < TS; q++) {
        hmax = Math.max(hmax, -smp.y[q]);
        minY = Math.min(minY, smp.y[q]); maxY = Math.max(maxY, smp.y[q]);
        minX = Math.min(minX, smp.x[q]); maxX = Math.max(maxX, smp.x[q]);
      }
      // wild arc points the same general way as the stroke
      var a0 = Math.atan2(-smp.y[mid], smp.x[mid]);
      a0 = Math.max(0.35, Math.min(Math.PI - 0.35, a0));
      var h = Math.max(60, hmax);
      var p0 = Math.sqrt(2 * GRAV * h) / Math.sin(a0);
      p0 = Math.min(p0, 1400);
      sil.streams.push({
        tx: smp.x, ty: smp.y, len: smp.len,
        a0: a0, p0: p0, tf: 1.7 * p0 * Math.sin(a0) / GRAV,
        ph: 1.3 + i * 2.17,
        off: (def.offs && def.offs[i]) || 0
      });
    });
    sil.bounds = { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
    // mask on the coarse grid
    var mask = new Uint8Array(COLS * ROWS), count = 0;
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var cx = GX0 + (c + 0.5) * CELL, cy = GY0 + (r + 0.5) * CELL, hit = 0;
        for (var s = 0; s < sil.streams.length && !hit; s++) {
          var st = sil.streams[s];
          for (var q2 = 0; q2 < TS; q2++) {
            var dx = st.tx[q2] - cx, dy = st.ty[q2] - cy;
            if (dx * dx + dy * dy <= MASK_R * MASK_R) { hit = 1; break; }
          }
        }
        mask[r * COLS + c] = hit; count += hit;
      }
    }
    sil.mask = mask; sil.maskCount = count;
    return sil;
  }

  // match envelope for stream i at envelope time te
  function envelope(sil, i, te) {
    var d = sil.def, st = sil.streams[i];
    // signed distance to the nearest match moment, with a flat "dwell" where the water holds the shape
    var x = te - d.first - st.off, P = d.period;
    x = x - Math.round(x / P) * P;
    var hold = (d.dwell || 0) / 2;
    x = x > hold ? x - hold : x < -hold ? x + hold : 0;
    var c = 0.5 + 0.5 * Math.cos(2 * Math.PI * x / P);
    return Math.pow(c, d.k);
  }

  // position of a point at arc parameter s (0..1) on stream i
  function streamPos(sil, i, s, t, m, out) {
    var st = sil.streams[i];
    var f = s * (TS - 1), j = Math.min(TS - 2, f | 0), u = f - j;
    var tx = st.tx[j] + (st.tx[j + 1] - st.tx[j]) * u;
    var ty = st.ty[j] + (st.ty[j + 1] - st.ty[j]) * u;
    var a = st.a0 + 0.42 * Math.sin(1.7 * t + st.ph);
    var p = st.p0 * (1 + 0.17 * Math.sin(2.3 * t + st.ph * 1.3));
    var tau = s * st.tf;
    var wx = p * Math.cos(a) * tau, wy = -p * Math.sin(a) * tau + 0.5 * GRAV * tau * tau;
    out.x = wx + (tx - wx) * m;
    out.y = wy + (ty - wy) * m;
  }

  function frac(x) { return x - Math.floor(x); }

  // A frame = every droplet position (relative to nozzle) + the IoU score.
  function makeFrame() {
    var cap = 4 * (DROPS + 12);
    return { px: new Float32Array(cap), py: new Float32Array(cap), ps: new Float32Array(cap),
      pk: new Uint8Array(cap), pst: new Uint8Array(cap), n: 0, iou: 0, m: [] };
  }
  var _stamp = new Int32Array(COLS * ROWS), _gen = 1, _tmp = { x: 0, y: 0 };

  // t: sculpture time, te: envelope time (t scaled for later nights), reach: 0..1 spray growth
  function computeFrame(sil, t, te, reach, fr) {
    var n = 0, i, k;
    fr.m.length = sil.streams.length;
    for (i = 0; i < sil.streams.length; i++) {
      var m = envelope(sil, i, te);
      fr.m[i] = m;
      var d = sil.def;
      for (k = 0; k < DROPS; k++) {
        var s = frac(k / DROPS + t * d.flow);
        if (s > reach) continue;
        streamPos(sil, i, s, t, m, _tmp);
        fr.px[n] = _tmp.x + d.jit * Math.sin(t * 6.1 + k * 2.39 + i * 1.1);
        fr.py[n] = _tmp.y + d.jit * Math.cos(t * 5.3 + k * 1.71 + i * 2.3);
        fr.ps[n] = s; fr.pk[n] = 0; fr.pst[n] = i; n++;
      }
      for (k = 0; k < d.mist; k++) {           // stray spray: follows the wild arc only
        var s2 = frac(k / d.mist + t * d.flow * 1.13 + 0.37);
        if (s2 > reach) continue;
        streamPos(sil, i, s2, t * 1.07 + 0.9, 0, _tmp);
        fr.px[n] = _tmp.x + 22 * Math.sin(t * 3.1 + k * 4.1 + i);
        fr.py[n] = _tmp.y + 22 * Math.cos(t * 2.7 + k * 3.3 + i * 0.7);
        fr.ps[n] = s2; fr.pk[n] = 1; fr.pst[n] = i; n++;
      }
    }
    fr.n = n;
    fr.iou = scoreFrame(sil, fr);
    return fr;
  }

  // IoU of water cells vs silhouette cells on the coarse grid
  function scoreFrame(sil, fr) {
    _gen++;
    var water = 0, inter = 0, mask = sil.mask, R2 = WATER_R * WATER_R;
    for (var q = 0; q < fr.n; q++) {
      var x = fr.px[q], y = fr.py[q];
      var c0 = Math.floor((x - WATER_R - GX0) / CELL), c1 = Math.floor((x + WATER_R - GX0) / CELL);
      var r0 = Math.floor((y - WATER_R - GY0) / CELL), r1 = Math.floor((y + WATER_R - GY0) / CELL);
      if (c1 < 0 || c0 >= COLS || r1 < 0 || r0 >= ROWS) { water++; continue; } // off-grid spray still counts
      for (var r = Math.max(0, r0); r <= Math.min(ROWS - 1, r1); r++) {
        var cy = GY0 + (r + 0.5) * CELL - y;
        for (var c = Math.max(0, c0); c <= Math.min(COLS - 1, c1); c++) {
          var cx = GX0 + (c + 0.5) * CELL - x, idx = r * COLS + c;
          if (cx * cx + cy * cy <= R2 && _stamp[idx] !== _gen) {
            _stamp[idx] = _gen; water++;
            if (mask[idx]) inter++;
          }
        }
      }
    }
    var uni = water + sil.maskCount - inter;
    return uni > 0 ? inter / uni : 0;
  }

  // Offline tuning helper: IoU curve over two periods, max and window lengths.
  function calibrate(sil, timeScale) {
    timeScale = timeScale || 1;
    var fr = makeFrame(), d = sil.def, maxI = 0, perf = 0, good = 0, steps = 0;
    var t0 = d.first + d.period * 2, t1 = t0 + d.period * 2;
    var firstGood = -1, firstPerf = -1;
    for (var t = 0; t < t1; t += STEP) {
      computeFrame(sil, t, t * timeScale, Math.min(1, t / 0.6), fr);
      if (firstGood < 0 && fr.iou >= sil.good) firstGood = t;
      if (firstPerf < 0 && fr.iou >= sil.perfect) firstPerf = t;
      if (t < t0) continue;
      steps++;
      maxI = Math.max(maxI, fr.iou);
      if (fr.iou >= sil.perfect) perf++;
      if (fr.iou >= sil.good) good++;
    }
    var cycles = 2 / timeScale > 0 ? (t1 - t0) * timeScale / d.period : 1;
    return { name: sil.name, max: +maxI.toFixed(3), perfectWin: +(perf * STEP / cycles).toFixed(3),
      goodWin: +(good * STEP / cycles).toFixed(3), firstGood: +firstGood.toFixed(2), firstPerfect: +firstPerf.toFixed(2) };
  }

  var SIM = { W: W, H: H, NOZ: NOZ, STEP: STEP, DEFS: DEFS, TS: TS, MASK_R: MASK_R,
    buildSil: buildSil, computeFrame: computeFrame, makeFrame: makeFrame, envelope: envelope,
    streamPos: streamPos, calibrate: calibrate };

  if (typeof module !== 'undefined' && module.exports) module.exports = SIM;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ===================================================================== GAME (browser)
  var SILS = DEFS.map(buildSil);
  var TIMEOUT = 15;          // seconds per sculpture before the water splashes away (= Slush)
  var GRACE = 0.12;          // tap forgiveness: freeze at the best frame of the last 120 ms
  var HIST = Math.ceil(GRACE / STEP) + 1;

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var view = { s: 1, ox: 0, oy: 0, dpr: 1, cw: 0, ch: 0 };

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var cw = window.innerWidth, ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    var s = Math.min(cw / W, ch / H);
    view = { s: s, ox: (cw - W * s) / 2, oy: (ch - H * s) / 2, dpr: dpr, cw: cw, ch: ch };
  }
  window.addEventListener('resize', resize);
  resize();

  // ------------------------------------------------------------ audio (created on first tap)
  var AudioFX = {
    ctx: null, noise: null, master: null,
    init: function () {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!this.ctx) {
          this.ctx = new AC();
          this.master = this.ctx.createGain(); this.master.gain.value = 0.7;
          this.master.connect(this.ctx.destination);
          var len = this.ctx.sampleRate, buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate), d = buf.getChannelData(0);
          for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
          this.noise = buf;
          this.startAmbient();
        }
        if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
      } catch (e) { this.ctx = null; }
    },
    startAmbient: function () {
      try {
        var c = this.ctx, src = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
        src.buffer = this.noise; src.loop = true;
        bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
        g.gain.value = 0.035;
        src.connect(bp); bp.connect(g); g.connect(this.master); src.start();
        this.amb = g;
      } catch (e) { /* ignore */ }
    },
    burst: function (when, dur, type, freq, q, vol) {
      var c = this.ctx, src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      src.buffer = this.noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
      g.gain.setValueAtTime(vol, when); g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(when, Math.random() * 0.5, dur + 0.05);
    },
    tone: function (when, freq, dur, vol, type, slideTo) {
      var c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, when);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, when + dur);
      g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(vol, when + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      o.connect(g); g.connect(this.master); o.start(when); o.stop(when + dur + 0.05);
    },
    crackle: function () {
      if (!this.ctx) return;
      try {
        var t = this.ctx.currentTime;
        for (var i = 0; i < 9; i++) this.burst(t + i * 0.022 + Math.random() * 0.015, 0.03 + Math.random() * 0.03, 'highpass', 2500 + Math.random() * 4000, 1, 0.5);
        this.tone(t, 2600, 0.25, 0.08, 'triangle', 1800);
      } catch (e) { /* ignore */ }
    },
    result: function (grade, mult) {
      if (!this.ctx) return;
      try {
        var t = this.ctx.currentTime + 0.12, i;
        if (grade === 'perfect') {
          var base = 523.25 * Math.pow(2, Math.min(mult - 2, 7) / 12);
          [1, 1.25, 1.5, 2].forEach(function (r, j) { AudioFX.tone(t + j * 0.07, base * r, 0.5, 0.16, 'sine'); });
          this.tone(t + 0.28, base * 4, 0.6, 0.05, 'triangle');
        } else if (grade === 'good') {
          this.tone(t, 523.25, 0.35, 0.14); this.tone(t + 0.09, 659.25, 0.4, 0.12);
        } else {
          this.burst(t - 0.05, 0.5, 'lowpass', 700, 0.8, 0.6);
          for (i = 0; i < 6; i++) this.burst(t + 0.05 + i * 0.05, 0.08, 'bandpass', 1500 + Math.random() * 2500, 2, 0.35);
          this.tone(t, 330, 0.5, 0.1, 'triangle', 140);
        }
      } catch (e) { /* ignore */ }
    },
    melt: function () {
      if (!this.ctx) return;
      try { var t = this.ctx.currentTime; this.tone(t, 392, 1.2, 0.12, 'sine', 98); this.burst(t, 1.2, 'lowpass', 500, 0.7, 0.4); } catch (e) { /* ignore */ }
    }
  };

  // ------------------------------------------------------------ game state
  var best = 0;
  try { best = +(window.localStorage.getItem('freezeFountainBest') || 0); } catch (e) { best = 0; }

  var G = {};
  var frame = makeFrame(), freezeFrame = makeFrame();
  var stars = [];
  (function () { var seed = 7; function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var i = 0; i < 60; i++) stars.push({ x: rnd() * W, y: rnd() * 520, r: 0.4 + rnd() * 1.3, p: rnd() * 6.28 }); })();

  function newRun() {
    G = { state: 'spray', stateT: 0, T: G.T || 0, silIdx: 0, night: 0, t: 0, score: 0, mult: 1, perfects: 0,
      slush: 0, garden: [], hist: [], cue: 0, ice: null, shards: [], fx: [], result: null,
      tutorial: !G.everSucceeded, everSucceeded: G.everSucceeded || false, banner: null, newBest: false };
    startSculpture();
  }

  function cur() { return SILS[G.silIdx]; }
  function timeScale() { return 1 + 0.15 * G.night; }
  function thr(kind) { return Math.min(0.9, cur()[kind] + 0.02 * G.night); }

  function startSculpture() {
    G.state = 'spray'; G.stateT = 0; G.t = 0; G.hist.length = 0; G.cue = 0; G.ice = null; G.result = null;
  }

  function freeze(timedOut) {
    var sil = cur(), tf = G.t, bestI = -1;
    if (!timedOut) {
      for (var i = 0; i < G.hist.length; i++) if (G.hist[i].iou > bestI) { bestI = G.hist[i].iou; tf = G.hist[i].t; }
    }
    computeFrame(sil, tf, tf * timeScale(), Math.min(1, tf / 0.6), freezeFrame);
    var iou = timedOut ? 0 : freezeFrame.iou;
    var grade = iou >= thr('perfect') ? 'perfect' : iou >= thr('good') ? 'good' : 'slush';
    var pts = 0;
    if (grade === 'perfect') { G.mult += 1; G.perfects++; pts = 100 * G.mult; }
    else if (grade === 'good') { pts = 50 * G.mult; }
    else { G.mult = 1; G.slush++; }
    G.score += pts;
    if (grade !== 'slush') { G.everSucceeded = true; G.tutorial = false; }
    G.ice = snapshotIce(sil, tf, freezeFrame, grade);
    G.result = { grade: grade, iou: iou, pts: pts, mult: G.mult, timedOut: !!timedOut };
    G.state = 'frozen'; G.stateT = 0;
    spawnFreezeFx(freezeFrame);
    AudioFX.crackle();
    AudioFX.result(grade, G.mult);
    if (navigator.vibrate) { try { navigator.vibrate(grade === 'slush' ? [30, 40, 30] : 18); } catch (e) { /* ignore */ } }
  }

  function snapshotIce(sil, tf, fr, grade) {
    var bodies = [], i, q, o = { x: 0, y: 0 }, reach = Math.min(1, tf / 0.6);
    for (i = 0; i < sil.streams.length; i++) {
      var m = envelope(sil, i, tf * timeScale()), line = [];
      for (q = 0; q <= 28; q++) { var s = q / 28 * reach; streamPos(sil, i, s, tf, m, o); line.push(o.x, o.y); }
      bodies.push(line);
    }
    var drops = [];
    for (q = 0; q < fr.n; q++) drops.push(fr.px[q], fr.py[q], fr.pk[q]);
    return { bodies: bodies, drops: drops, grade: grade, x: NOZ.x, y: NOZ.y, sc: 1 };
  }

  function spawnFreezeFx(fr) {
    for (var q = 0; q < fr.n; q += 3) {
      G.fx.push({ x: NOZ.x + fr.px[q], y: NOZ.y + fr.py[q], vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 60 - 20,
        life: 0.5 + Math.random() * 0.4, age: 0, kind: 'spark' });
    }
    G.fx.push({ kind: 'ring', x: NOZ.x, y: NOZ.y - 160, age: 0, life: 0.5 });
  }

  function shatter() {
    var ice = G.ice; if (!ice) return;
    for (var q = 0; q < ice.drops.length; q += 3) {
      G.shards.push({ x: NOZ.x + ice.drops[q], y: NOZ.y + ice.drops[q + 1], vx: (Math.random() - 0.5) * 220, vy: -Math.random() * 180,
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12, sz: 3 + Math.random() * 5, age: 0, life: 1.1 + Math.random() * 0.4 });
    }
    G.ice = null;
  }

  function gardenSlot(i) { return { x: 33 + (i % 6) * 64.8, y: 812 }; }

  function advance() {
    G.silIdx++;
    if (G.silIdx >= SILS.length) {
      G.silIdx = 0; G.night++;
      G.banner = { text: 'Night ' + (G.night + 1), sub: 'The fountain dances faster', age: 0 };
    }
    startSculpture();
  }

  function gameOver() {
    G.state = 'over'; G.stateT = 0;
    if (G.score > best) { best = G.score; G.newBest = true; try { window.localStorage.setItem('freezeFountainBest', String(best)); } catch (e) { /* ignore */ } }
    AudioFX.melt();
  }

  // ------------------------------------------------------------ update (fixed step)
  function update(dt) {
    G.T += dt; G.stateT += dt;
    var sil = cur();
    if (G.state === 'spray') {
      G.t += dt;
      computeFrame(sil, G.t, G.t * timeScale(), Math.min(1, G.t / 0.6), frame);
      G.hist.push({ t: G.t, iou: frame.iou });
      if (G.hist.length > HIST) G.hist.shift();
      // Perfect frames = full glow (the cue). Below that a faint ramp lets players anticipate the moment.
      var pT = thr('perfect'), gT = thr('good');
      var ramp = Math.max(0, Math.min(1, (frame.iou - 0.2) / (gT - 0.2)));
      var target = frame.iou >= pT ? 1 : frame.iou >= gT ? 0.5 : 0.3 * ramp * ramp;
      G.cue += (target - G.cue) * Math.min(1, dt * (target > G.cue ? 30 : 10));
      if (G.t >= TIMEOUT) freeze(true);
    } else if (G.state === 'frozen') {
      var r = G.result;
      if (r.grade === 'slush') {
        if (G.ice && G.stateT > 0.35) shatter();
        if (G.stateT > 1.4) { if (G.slush >= 3) gameOver(); else startSculpture(); }
      } else if (G.stateT > 1.0) {
        G.state = 'fly'; G.stateT = 0;
        G.garden.push({ bodies: G.ice.bodies, drops: G.ice.drops, grade: G.ice.grade, name: sil.name, born: G.T });
      }
    } else if (G.state === 'fly') {
      if (G.stateT > 0.7) { G.ice = null; advance(); }
    }
    var i;
    for (i = G.fx.length - 1; i >= 0; i--) {
      var f = G.fx[i]; f.age += dt;
      if (f.kind === 'spark') { f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 40 * dt; }
      if (f.age >= f.life) G.fx.splice(i, 1);
    }
    for (i = G.shards.length - 1; i >= 0; i--) {
      var s = G.shards[i]; s.age += dt; s.vy += 700 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.vr * dt;
      if (s.y > NOZ.y + 40) { s.y = NOZ.y + 40; s.vy *= -0.25; s.vx *= 0.6; }
      if (s.age >= s.life) G.shards.splice(i, 1);
    }
    if (G.banner) { G.banner.age += dt; if (G.banner.age > 2.4) G.banner = null; }
  }

  // ------------------------------------------------------------ input
  function onPointer(e) {
    if (e && e.preventDefault) e.preventDefault();
    AudioFX.init();
    if (G.state === 'spray') { if (G.t > 0.3) freeze(false); }
    else if (G.state === 'over') { if (G.stateT > 0.8) newRun(); }
  }
  canvas.addEventListener('pointerdown', onPointer, { passive: false });
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // ------------------------------------------------------------ rendering
  function strokeLine(arr, ox, oy, sc) {
    ctx.beginPath();
    ctx.moveTo(ox + arr[0] * sc, oy + arr[1] * sc);
    for (var q = 2; q < arr.length; q += 2) ctx.lineTo(ox + arr[q] * sc, oy + arr[q + 1] * sc);
    ctx.stroke();
  }

  function drawBackground() {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#060b24'); g.addColorStop(0.55, '#0d2148'); g.addColorStop(1, '#0a1630');
    ctx.fillStyle = g; ctx.fillRect(-W, -H, W * 3, H * 3);
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i]; ctx.globalAlpha = 0.35 + 0.35 * Math.sin(G.T * 1.3 + s.p);
      ctx.fillStyle = '#cfe6ff'; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // moon
    ctx.fillStyle = 'rgba(220,235,255,0.9)'; ctx.beginPath(); ctx.arc(352, 236, 16, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#0a1a3c'; ctx.beginPath(); ctx.arc(359, 231, 14, 0, 6.283); ctx.fill();
  }

  function drawFountain() {
    var x = NOZ.x;
    // pool glow
    var pg = ctx.createRadialGradient(x, 650, 10, x, 650, 170);
    pg.addColorStop(0, 'rgba(80,160,255,0.25)'); pg.addColorStop(1, 'rgba(80,160,255,0)');
    ctx.fillStyle = pg; ctx.fillRect(x - 180, 560, 360, 160);
    // pedestal
    ctx.fillStyle = '#3d4f74'; ctx.fillRect(x - 11, NOZ.y + 6, 22, 40);
    ctx.fillStyle = '#5b6f99'; ctx.beginPath(); ctx.ellipse(x, NOZ.y + 6, 20, 6, 0, 0, 6.283); ctx.fill();
    // basin
    ctx.fillStyle = '#2c3a5c'; ctx.beginPath(); ctx.ellipse(x, 662, 132, 26, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#4a5d88'; ctx.beginPath(); ctx.ellipse(x, 652, 132, 24, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#1d4f8c'; ctx.beginPath(); ctx.ellipse(x, 650, 118, 18, 0, 0, 6.283); ctx.fill();
    ctx.strokeStyle = 'rgba(160,210,255,0.35)'; ctx.lineWidth = 1.5;
    for (var i = 0; i < 3; i++) {
      var rr = ((G.T * 0.6 + i / 3) % 1);
      ctx.globalAlpha = 1 - rr; ctx.beginPath(); ctx.ellipse(x, 648, 20 + rr * 90, 4 + rr * 12, 0, 0, 6.283); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#4a5d88'; ctx.fillRect(x - 11, 640, 22, 10);
    ctx.fillStyle = '#7e93c2'; ctx.beginPath(); ctx.ellipse(x, NOZ.y, 7, 3, 0, 0, 6.283); ctx.fill();
  }

  function drawGhost(sil, cue) {
    var ox = NOZ.x, oy = NOZ.y;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    var a = 0.13 + 0.42 * cue;
    if (cue > 0.6) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(150,230,255,' + (0.18 * cue).toFixed(3) + ')'; ctx.lineWidth = MASK_R * 2 + 22;
      sil.streams.forEach(function (st) { strokeArr(st, ox, oy); });
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.strokeStyle = 'rgba(' + Math.round(150 + 90 * cue) + ',' + Math.round(200 + 50 * cue) + ',255,' + a.toFixed(3) + ')';
    ctx.lineWidth = MASK_R * 2;
    sil.streams.forEach(function (st) { strokeArr(st, ox, oy); });
    ctx.setLineDash([4, 7]); ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(220,240,255,' + (0.25 + 0.5 * cue).toFixed(3) + ')';
    sil.streams.forEach(function (st) { strokeArr(st, ox, oy); });
    ctx.setLineDash([]);
  }
  function strokeArr(st, ox, oy) {
    ctx.beginPath(); ctx.moveTo(ox + st.tx[0], oy + st.ty[0]);
    for (var q = 4; q < TS; q += 4) ctx.lineTo(ox + st.tx[q], oy + st.ty[q]);
    ctx.lineTo(ox + st.tx[TS - 1], oy + st.ty[TS - 1]);
    ctx.stroke();
  }

  var _o = { x: 0, y: 0 };
  function drawWater(sil) {
    var ox = NOZ.x, oy = NOZ.y, reach = Math.min(1, G.t / 0.6), i, q;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < sil.streams.length; i++) {
      var m = frame.m[i] || 0;
      ctx.strokeStyle = 'rgba(60,140,255,0.28)'; ctx.lineWidth = 9;
      ctx.beginPath();
      for (q = 0; q <= 32; q++) {
        streamPos(sil, i, q / 32 * reach, G.t, m, _o);
        if (q === 0) ctx.moveTo(ox + _o.x, oy + _o.y); else ctx.lineTo(ox + _o.x, oy + _o.y);
      }
      ctx.stroke();
      // falling splash off the end of the jet
      if (reach >= 1) {
        streamPos(sil, i, 1, G.t, m, _o);
        for (q = 0; q < 6; q++) {
          var age = frac(G.t * 1.6 + q / 6), dx = (q % 2 ? 1 : -1) * (12 + q * 5) * age;
          ctx.fillStyle = 'rgba(90,170,255,' + (0.5 * (1 - age)).toFixed(3) + ')';
          ctx.beginPath(); ctx.arc(ox + _o.x + dx, oy + _o.y + 260 * age * age + 20 * age, 2.5, 0, 6.283); ctx.fill();
        }
      }
    }
    for (q = 0; q < frame.n; q++) {
      var x = ox + frame.px[q], y = oy + frame.py[q];
      ctx.fillStyle = frame.pk[q] ? 'rgba(70,150,255,0.35)' : 'rgba(80,170,255,0.55)';
      ctx.beginPath(); ctx.arc(x, y, frame.pk[q] ? 3 : 4.5, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(200,235,255,0.5)';
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 6.283); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawIce(ice, ox, oy, sc, glow, alpha) {
    alpha = alpha == null ? 1 : alpha;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    var perfect = ice.grade === 'perfect';
    if (glow > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = (perfect ? 'rgba(140,240,255,' : 'rgba(120,190,255,') + (0.22 * glow * alpha).toFixed(3) + ')';
      ctx.lineWidth = Math.max(2, 22 * sc);
      ice.bodies.forEach(function (b) { strokeLine(b, ox, oy, sc); });
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.strokeStyle = 'rgba(205,238,255,' + (0.85 * alpha).toFixed(3) + ')'; ctx.lineWidth = Math.max(1.2, 10 * sc);
    ice.bodies.forEach(function (b) { strokeLine(b, ox, oy, sc); });
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.9 * alpha).toFixed(3) + ')'; ctx.lineWidth = Math.max(0.6, 3 * sc);
    ice.bodies.forEach(function (b) { strokeLine(b, ox, oy, sc); });
    if (sc > 0.5) {
      for (var q = 0; q < ice.drops.length; q += 3) {
        ctx.fillStyle = ice.drops[q + 2] ? 'rgba(190,225,250,' + (0.6 * alpha).toFixed(3) + ')' : 'rgba(235,248,255,' + alpha.toFixed(3) + ')';
        var x = ox + ice.drops[q] * sc, y = oy + ice.drops[q + 1] * sc, r = 4 * sc;
        ctx.beginPath(); ctx.moveTo(x, y - r * 1.3); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r * 1.3); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill();
      }
    }
  }

  function drawGarden() {
    var top = 700;
    var g = ctx.createLinearGradient(0, top, 0, H);
    g.addColorStop(0, '#13284f'); g.addColorStop(1, '#0b1733');
    ctx.fillStyle = g; ctx.fillRect(0, top, W, H - top);
    ctx.fillStyle = 'rgba(210,235,255,0.12)'; ctx.fillRect(0, top, W, 2);
    ctx.fillStyle = 'rgba(200,230,255,0.5)'; ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'left'; ctx.fillText('ICE GARDEN  ' + G.garden.length, 12, top + 18);
    // snowy ground
    ctx.fillStyle = 'rgba(200,230,255,0.10)';
    ctx.beginPath(); ctx.ellipse(W / 2, 826, 220, 14, 0, 0, 6.283); ctx.fill();
    var start = Math.max(0, G.garden.length - 6);
    for (var i = start; i < G.garden.length; i++) {
      var slot = gardenSlot(i - start), sc = 0.17, item = G.garden[i];
      var glow = 0.6 + 0.4 * Math.sin(G.T * 2 + i * 1.3);
      var fresh = Math.max(0, 1 - (G.T - item.born - 0.7) / 0.8);
      // little glow pool under each sculpture
      var pg = ctx.createRadialGradient(slot.x, slot.y, 1, slot.x, slot.y, 30);
      pg.addColorStop(0, item.grade === 'perfect' ? 'rgba(130,240,255,' + (0.35 * glow + 0.4 * fresh).toFixed(3) + ')' : 'rgba(110,170,255,' + (0.22 * glow).toFixed(3) + ')');
      pg.addColorStop(1, 'rgba(110,170,255,0)');
      ctx.fillStyle = pg; ctx.fillRect(slot.x - 32, slot.y - 60, 64, 72);
      drawIce(item, slot.x, slot.y, sc, glow, 1);
    }
    if (start > 0) {
      ctx.fillStyle = 'rgba(200,230,255,0.6)'; ctx.textAlign = 'right';
      ctx.fillText('+' + start + ' more', W - 12, top + 18);
    }
  }

  function drawHUD(sil) {
    ctx.textAlign = 'left'; ctx.fillStyle = '#eaf6ff';
    ctx.font = '800 34px system-ui, -apple-system, sans-serif';
    ctx.fillText(String(G.score), 18, 52);
    ctx.font = '600 12px system-ui, -apple-system, sans-serif'; ctx.fillStyle = 'rgba(200,225,255,0.65)';
    ctx.fillText('BEST ' + Math.max(best, G.score), 20, 72);
    // slush lives (3 ice drops; cracked when lost)
    for (var i = 0; i < 3; i++) {
      var x = W - 26 - i * 26, y = 40, lost = i < G.slush;
      ctx.fillStyle = lost ? 'rgba(120,135,160,0.45)' : '#9fdcff';
      ctx.beginPath(); ctx.moveTo(x, y - 12); ctx.quadraticCurveTo(x + 10, y + 2, x, y + 9); ctx.quadraticCurveTo(x - 10, y + 2, x, y - 12); ctx.fill();
      if (lost) { ctx.strokeStyle = '#0d2148'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x - 3, y - 6); ctx.lineTo(x + 2, y); ctx.lineTo(x - 2, y + 4); ctx.stroke(); }
    }
    ctx.textAlign = 'right'; ctx.font = '600 11px system-ui, -apple-system, sans-serif'; ctx.fillStyle = 'rgba(200,225,255,0.6)';
    ctx.fillText('SLUSH LEFT', W - 14, 68);
    // Frost meter
    var m = G.mult, pulse = G.result && G.result.grade === 'perfect' && G.stateT < 0.5 ? 1 + 0.25 * (1 - G.stateT / 0.5) : 1;
    ctx.save(); ctx.translate(W / 2, 98); ctx.scale(pulse, pulse);
    ctx.textAlign = 'center';
    ctx.font = '800 22px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = m > 1 ? '#bff4ff' : 'rgba(190,215,240,0.55)';
    ctx.fillText('FROST ×' + m, 0, 0);
    ctx.restore();
    for (i = 0; i < 5; i++) {
      var on = ((m - 1) % 5) > i || (m > 1 && (m - 1) % 5 === 0);
      ctx.fillStyle = on ? '#9feeff' : 'rgba(150,180,220,0.22)';
      ctx.fillRect(W / 2 - 62 + i * 25, 108, 21, 5);
    }
    // silhouette name + timer
    ctx.textAlign = 'center'; ctx.font = '600 14px system-ui, -apple-system, sans-serif'; ctx.fillStyle = 'rgba(220,238,255,0.85)';
    ctx.fillText(sil.name + '  ·  ' + (G.silIdx + 1) + '/' + SILS.length + (G.night ? '  ·  Night ' + (G.night + 1) : ''), W / 2, 138);
    if (G.state === 'spray') {
      var left = Math.max(0, 1 - G.t / TIMEOUT);
      ctx.fillStyle = 'rgba(150,180,220,0.18)'; ctx.fillRect(W / 2 - 60, 146, 120, 3);
      ctx.fillStyle = left < 0.25 ? '#ff9e9e' : 'rgba(160,220,255,0.7)'; ctx.fillRect(W / 2 - 60, 146, 120 * left, 3);
    }
  }

  function drawResult() {
    var r = G.result; if (!r || G.state === 'over') return;
    var a = Math.min(1, G.stateT * 6), sc = 1 + 0.3 * Math.max(0, 1 - G.stateT * 5);
    ctx.save(); ctx.globalAlpha = G.state === 'fly' ? Math.max(0, 1 - G.stateT * 2) : a;
    ctx.translate(W / 2, 196); ctx.scale(sc, sc); ctx.textAlign = 'center';
    var txt = r.grade === 'perfect' ? 'PERFECT' : r.grade === 'good' ? 'GOOD' : (r.timedOut ? 'SPLASHED AWAY' : 'SLUSH');
    ctx.font = '900 ' + (r.timedOut ? 28 : 40) + 'px system-ui, -apple-system, sans-serif';
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(5,12,35,0.7)'; ctx.strokeText(txt, 0, 0);
    ctx.fillStyle = r.grade === 'perfect' ? '#d9fbff' : r.grade === 'good' ? '#9fd0ff' : '#ffb3b3';
    ctx.fillText(txt, 0, 0);
    ctx.font = '700 17px system-ui, -apple-system, sans-serif';
    var sub = r.grade === 'perfect' ? '+' + r.pts + '   Frost ×' + r.mult : r.grade === 'good' ? '+' + r.pts + '   (Perfect builds Frost)' : 'Frost reset  ·  ' + (3 - G.slush) + ' slush left';
    ctx.lineWidth = 4; ctx.strokeText(sub, 0, 28); ctx.fillStyle = 'rgba(225,240,255,0.92)'; ctx.fillText(sub, 0, 28);
    ctx.font = '600 12px system-ui, -apple-system, sans-serif'; ctx.fillStyle = 'rgba(200,225,255,0.6)';
    ctx.fillText('match ' + Math.round(r.iou * 100) + '%', 0, 48);
    ctx.restore();
  }

  function drawTutorial() {
    if (!G.tutorial || G.state !== 'spray') return;
    ctx.textAlign = 'center';
    ctx.font = '700 16px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(230,245,255,' + (0.7 + 0.3 * Math.sin(G.T * 4)).toFixed(3) + ')';
    ctx.fillText('Tap anywhere when the ' + cur().name.toLowerCase() + ' glows', W / 2, 186);
    if (G.cue > 0.6) {
      var s = 1 + 0.12 * Math.sin(G.T * 18);
      ctx.save(); ctx.translate(W / 2, 240); ctx.scale(s, s);
      ctx.font = '900 34px system-ui, -apple-system, sans-serif';
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(5,12,35,0.6)'; ctx.strokeText('TAP!', 0, 0);
      ctx.fillStyle = '#e8fdff'; ctx.fillText('TAP!', 0, 0);
      ctx.restore();
    }
  }

  function drawOver() {
    if (G.state !== 'over') return;
    var a = Math.min(1, G.stateT * 2);
    ctx.fillStyle = 'rgba(4,8,24,' + (0.72 * a).toFixed(3) + ')'; ctx.fillRect(0, 0, W, 700);
    ctx.globalAlpha = a; ctx.textAlign = 'center';
    ctx.fillStyle = '#d6efff'; ctx.font = '900 32px system-ui, -apple-system, sans-serif';
    ctx.fillText('The fountain melted', W / 2, 260);
    ctx.font = '800 54px system-ui, -apple-system, sans-serif'; ctx.fillStyle = '#ffffff';
    ctx.fillText(String(G.score), W / 2, 340);
    ctx.font = '600 16px system-ui, -apple-system, sans-serif'; ctx.fillStyle = 'rgba(200,225,255,0.8)';
    ctx.fillText(G.newBest ? 'New best!' : 'Best ' + best, W / 2, 372);
    ctx.fillText(G.garden.length + (G.garden.length === 1 ? ' sculpture  ' : ' sculptures  ') + '·  ' + G.perfects + ' perfect', W / 2, 400);
    if (G.stateT > 0.8) {
      ctx.globalAlpha = a * (0.65 + 0.35 * Math.sin(G.T * 4));
      ctx.font = '700 20px system-ui, -apple-system, sans-serif'; ctx.fillStyle = '#e8fdff';
      ctx.fillText('Tap to play again', W / 2, 480);
    }
    ctx.globalAlpha = 1;
  }

  function drawBanner() {
    var b = G.banner; if (!b) return;
    var a = Math.min(1, b.age * 4, (2.4 - b.age) * 3);
    ctx.globalAlpha = Math.max(0, a); ctx.textAlign = 'center';
    ctx.fillStyle = '#e8fdff'; ctx.font = '900 30px system-ui, -apple-system, sans-serif'; ctx.fillText(b.text, W / 2, 300);
    ctx.font = '600 15px system-ui, -apple-system, sans-serif'; ctx.fillStyle = 'rgba(200,225,255,0.8)'; ctx.fillText(b.sub, W / 2, 326);
    ctx.globalAlpha = 1;
  }

  function render() {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.fillStyle = '#060b24'; ctx.fillRect(0, 0, view.cw, view.ch);
    ctx.setTransform(view.dpr * view.s, 0, 0, view.dpr * view.s, view.dpr * view.ox, view.dpr * view.oy);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    var sil = cur();
    drawBackground();
    drawFountain();
    if (G.state === 'spray') { drawGhost(sil, G.cue); drawWater(sil); }
    else if (G.state === 'frozen') {
      drawGhost(sil, G.result.grade === 'slush' ? 0 : 0.5);
      if (G.ice) {
        var crack = G.result.grade === 'slush' ? 0 : 1;
        var shake = G.result.grade === 'slush' ? Math.sin(G.stateT * 90) * 2.5 : 0;
        drawIce(G.ice, NOZ.x + shake, NOZ.y, 1, crack * (0.7 + 0.3 * Math.sin(G.T * 5)), 1);
      }
    } else if (G.state === 'fly' && G.ice) {
      var k = Math.min(1, G.stateT / 0.7), e = k * k * (3 - 2 * k);
      var slot = gardenSlot(Math.min(5, G.garden.length - 1));
      drawIce(G.ice, NOZ.x + (slot.x - NOZ.x) * e, NOZ.y + (slot.y - NOZ.y) * e, 1 + (0.17 - 1) * e, 1, 1);
    }
    // fx
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < G.fx.length; i++) {
      var f = G.fx[i], t = f.age / f.life;
      if (f.kind === 'spark') {
        ctx.fillStyle = 'rgba(220,250,255,' + (1 - t).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(f.x, f.y, 2.2 * (1 - t) + 0.5, 0, 6.283); ctx.fill();
      } else if (f.kind === 'ring') {
        ctx.strokeStyle = 'rgba(190,240,255,' + (0.6 * (1 - t)).toFixed(3) + ')'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(f.x, f.y, 40 + t * 220, 0, 6.283); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    for (i = 0; i < G.shards.length; i++) {
      var s = G.shards[i], fa = Math.max(0, 1 - s.age / s.life);
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.rot); ctx.fillStyle = 'rgba(205,235,255,' + fa.toFixed(3) + ')';
      ctx.beginPath(); ctx.moveTo(0, -s.sz); ctx.lineTo(s.sz * 0.6, s.sz * 0.4); ctx.lineTo(-s.sz * 0.5, s.sz * 0.6); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    drawGarden();
    drawHUD(sil);
    drawResult();
    drawTutorial();
    drawBanner();
    drawOver();
    ctx.restore();
  }

  // ------------------------------------------------------------ main loop (fixed 120 Hz accumulator)
  var acc = 0, last = performance.now();
  function loop(now) {
    var dt = (now - last) / 1000; last = now;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.25) dt = 0.25;
    acc += dt;
    while (acc >= STEP) { update(STEP); acc -= STEP; }
    render();
    window.requestAnimationFrame(loop);
  }
  document.addEventListener('visibilitychange', function () { last = performance.now(); acc = 0; });

  newRun();
  window.requestAnimationFrame(loop);
  root.FreezeFountain = { G: function () { return G; }, SIM: SIM };
})(typeof window !== 'undefined' ? window : this);
