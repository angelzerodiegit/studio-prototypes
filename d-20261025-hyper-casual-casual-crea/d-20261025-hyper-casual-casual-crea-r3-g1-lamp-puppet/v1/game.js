/* Lamp Puppet \u2014 prototype v1
 * You never touch the puppet. Drag the lamp: closer = bigger shadow, sideways = shadow slides the other way.
 * Shadow's mouth eats fireflies (combo x2..x5 within 1.5 s), moths touching the shadow cost a bulb.
 *
 * Structure:
 *   CFG         tuning constants
 *   Sfx         WebAudio synth (created on first tap, every call is a no-op if unavailable)
 *   Projection  lamp position -> shadow transform (x, y, scale)
 *   Fox         silhouette paths + hit circles (local space, feet at origin, facing right)
 *   Pools       fireflies / moths / particles / popups (fixed-size, reused)
 *   G           game state; phases: 'tutorial' -> 'play' -> 'over'
 *   update/draw main loop, pointer input, window.__game debug handle
 */
(function () {
  'use strict';

  var W = 390, H = 844, TAU = Math.PI * 2;

  // ------------------------------------------------------------------ CONFIG
  var CFG = {
    runTime: 90,
    comboWindow: 1.5,
    maxMult: 5,
    invuln: 1.0,
    bulbs: 3,
    // layout
    skyBottom: 120, wallBottom: 600, tableBottom: 662,
    puppetX: 195, puppetY: 642,
    jarX: 346, jarY: 640,
    // lamp zone (lower third)
    lampMinX: 40, lampMaxX: 350, lampMinY: 690, lampMaxY: 815,
    // shadow
    sMin: 0.6, sMax: 3.4, slide: 1.5, rise: 32,
    // spawning
    flyMinY: 185, flyMaxY: 560, flyMinX: 40, flyMaxX: 350,
    maxFlies: 26,
    jarCaps: [26, 30, 34, 38, 42, 46, 50, 54, 58, 62],
    mothR: 11
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function dist2(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

  // ------------------------------------------------------------------ CANVAS
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var view = { s: 1, ox: 0, oy: 0, dpr: 1, cw: 0, ch: 0 };

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var cw = window.innerWidth || W, ch = window.innerHeight || H;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    var s = Math.min(cw / W, ch / H);
    view = { s: s, ox: (cw - W * s) / 2, oy: (ch - H * s) / 2, dpr: dpr, cw: cw, ch: ch };
  }
  window.addEventListener('resize', resize);
  resize();

  function toLogical(e) {
    return { x: (e.clientX - view.ox) / view.s, y: (e.clientY - view.oy) / view.s };
  }

  // ------------------------------------------------------------------ AUDIO
  var Sfx = {
    ctx: null, master: null,
    init: function () {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!this.ctx) {
          this.ctx = new AC();
          this.master = this.ctx.createGain();
          this.master.gain.value = 0.5;
          this.master.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
      } catch (e) { this.ctx = null; }
    },
    tone: function (f, dur, type, vol, f2, delay) {
      if (!this.ctx) return;
      try {
        var c = this.ctx, t = c.currentTime + (delay || 0);
        var o = c.createOscillator(), g = c.createGain();
        o.type = type || 'sine';
        o.frequency.setValueAtTime(f, t);
        if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol || 0.2, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(this.master);
        o.start(t); o.stop(t + dur + 0.05);
      } catch (e) { /* ignore */ }
    },
    eat: function (mult) {
      var base = 520 * Math.pow(1.122, mult - 1);
      this.tone(base, 0.12, 'sine', 0.22, base * 1.6);
      this.tone(base * 2, 0.08, 'triangle', 0.06, null, 0.03);
    },
    gulp: function () { this.tone(180, 0.12, 'sine', 0.18, 90); },
    hit: function () {
      this.tone(140, 0.35, 'sawtooth', 0.16, 60);
      this.tone(95, 0.3, 'square', 0.06, 50, 0.02);
    },
    window: function () {
      var n = [523, 659, 784, 1047];
      for (var i = 0; i < n.length; i++) this.tone(n[i], 0.5, 'triangle', 0.14, null, i * 0.09);
    },
    over: function () {
      var n = [523, 440, 392, 330];
      for (var i = 0; i < n.length; i++) this.tone(n[i], 0.4, 'triangle', 0.12, null, i * 0.14);
    }
  };

  // ------------------------------------------------------------------ PROJECTION
  // Closer lamp (higher on screen) => bigger shadow; sideways lamp => shadow slides the opposite way.
  function project(lx, ly) {
    var u = clamp((ly - CFG.lampMinY) / (CFG.lampMaxY - CFG.lampMinY), 0, 1);
    var s = CFG.sMin + (CFG.sMax - CFG.sMin) * Math.pow(1 - u, 1.5);
    var x = CFG.puppetX - (lx - CFG.puppetX) * CFG.slide;
    var y = CFG.wallBottom - (s - CFG.sMin) * CFG.rise;
    return { x: x, y: y, s: s };
  }

  // ------------------------------------------------------------------ FOX (local space, feet at 0,0, facing right)
  var MOUTH = { x: 44, y: -80, r: 22 };
  var BODY_HITS = [
    { x: 0, y: -38, r: 26 }, { x: 0, y: -12, r: 22 }, { x: 16, y: -84, r: 18 },
    { x: -44, y: -48, r: 13 }, { x: -30, y: -24, r: 12 }, { x: -56, y: -70, r: 8 },
    { x: 21, y: -108, r: 9 }, { x: 46, y: -84, r: 12 }
  ];
  var JAW_PIVOT = { x: 30, y: -79 };
  var JAW_PTS = [[0, -1], [26, 0], [24, 4], [-2, 9]];

  function polyPath(c, pts) {
    c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
  }
  // Draws each part with the current fillStyle (opaque fills so overlaps don't double up).
  function foxParts(c, jaw, mode) {
    var parts = [];
    // body
    parts.push(function () { c.beginPath(); c.ellipse(0, -38, 26, 38, 0, 0, TAU); });
    // neck
    parts.push(function () { polyPath(c, [[4, -66], [26, -76], [24, -50], [4, -48]]); });
    // head
    parts.push(function () { c.beginPath(); c.arc(16, -84, 18, 0, TAU); });
    // ears
    parts.push(function () { polyPath(c, [[5, -94], [9, -124], [21, -99]]); });
    parts.push(function () { polyPath(c, [[18, -99], [31, -122], [33, -90]]); });
    // upper jaw
    parts.push(function () { polyPath(c, [[26, -98], [60, -88], [58, -83], [30, -80]]); });
    // lower jaw (rotates open)
    parts.push(function () {
      var a = 0.08 + jaw * 0.55, ca = Math.cos(a), sa = Math.sin(a), pts = [];
      for (var i = 0; i < JAW_PTS.length; i++) {
        var px = JAW_PTS[i][0], py = JAW_PTS[i][1];
        pts.push([JAW_PIVOT.x + px * ca - py * sa, JAW_PIVOT.y + px * sa + py * ca]);
      }
      polyPath(c, pts);
    });
    // tail
    parts.push(function () {
      c.beginPath(); c.moveTo(-16, -14);
      c.bezierCurveTo(-46, -16, -72, -46, -58, -80);
      c.bezierCurveTo(-50, -58, -36, -44, -14, -40);
      c.closePath();
    });
    // front leg
    parts.push(function () { polyPath(c, [[4, -36], [20, -3], [22, 0], [4, 0]]); });
    for (var i = 0; i < parts.length; i++) {
      parts[i]();
      if (mode === 'stroke') c.stroke(); else c.fill();
    }
  }

  // ------------------------------------------------------------------ SPRITES
  function makeGlow(size, inner, outer) {
    var cv = document.createElement('canvas'); cv.width = cv.height = size;
    var c = cv.getContext('2d'), r = size / 2;
    var g = c.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, inner); g.addColorStop(0.25, outer); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, size, size);
    return cv;
  }
  var GLOW_FLY = (function () {
    var cv = document.createElement('canvas'); cv.width = cv.height = 64;
    var c = cv.getContext('2d'), g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,225,1)'); g.addColorStop(0.15, 'rgba(240,255,150,0.95)');
    g.addColorStop(0.4, 'rgba(190,255,80,0.4)'); g.addColorStop(1, 'rgba(120,200,40,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64); return cv;
  })();
  var GLOW_WARM = makeGlow(64, 'rgba(255,240,190,1)', 'rgba(255,190,80,0.4)');

  // ------------------------------------------------------------------ VILLAGE
  var HOUSES = [
    { x: 10, w: 46, top: 80, peak: 62 }, { x: 62, w: 40, top: 72, peak: 52 },
    { x: 110, w: 58, top: 84, peak: 66 }, { x: 176, w: 38, top: 64, peak: 40 },
    { x: 222, w: 54, top: 80, peak: 60 }, { x: 284, w: 42, top: 72, peak: 52 },
    { x: 334, w: 48, top: 84, peak: 66 }
  ];
  var WINDOWS = [];
  (function () {
    for (var i = 0; i < HOUSES.length; i++) {
      var h = HOUSES[i];
      if (i === 2) {
        WINDOWS.push({ x: h.x + 10, y: h.top + 12, w: 12, h: 14 });
        WINDOWS.push({ x: h.x + h.w - 22, y: h.top + 12, w: 12, h: 14 });
      } else {
        WINDOWS.push({ x: h.x + h.w / 2 - 6, y: h.top + 12, w: 12, h: 14 });
      }
    }
  })();
  var WINDOW_ORDER = [3, 0, 5, 2, 7, 1, 4, 6];
  var STARS = [];
  for (var si = 0; si < 40; si++) STARS.push({ x: Math.random() * W, y: Math.random() * 100, r: rand(0.5, 1.4), p: rand(0, TAU) });

  // ------------------------------------------------------------------ POOLS
  function makePool(n, factory) { var a = []; for (var i = 0; i < n; i++) { var o = factory(); o.active = false; a.push(o); } return a; }
  function take(pool) { for (var i = 0; i < pool.length; i++) if (!pool[i].active) { pool[i].active = true; return pool[i]; } return null; }
  function countActive(pool) { var n = 0; for (var i = 0; i < pool.length; i++) if (pool[i].active) n++; return n; }

  var flies = makePool(40, function () { return { x: 0, y: 0, hx: 0, hy: 0, vx: 0, vy: 0, p1: 0, p2: 0, amp: 0, age: 0, life: 0, tut: 0 }; });
  var moths = makePool(4, function () { return { x: 0, y: 0, vx: 0, vy: 0, ph: 0, flee: false, t: 0 }; });
  var parts = makePool(160, function () { return { x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0, size: 0, kind: 0, col: '' }; });
  var pops = makePool(16, function () { return { x: 0, y: 0, text: '', life: 0, max: 0, size: 0, col: '' }; });

  // ------------------------------------------------------------------ STATE
  var G = {};
  var best = 0;
  try { best = parseInt(localStorage.getItem('lampPuppetBest') || '0', 10) || 0; } catch (e) { best = 0; }

  function resetState(skipTutorial) {
    var i;
    for (i = 0; i < flies.length; i++) flies[i].active = false;
    for (i = 0; i < moths.length; i++) moths[i].active = false;
    for (i = 0; i < parts.length; i++) parts[i].active = false;
    for (i = 0; i < pops.length; i++) pops[i].active = false;
    G = {
      phase: skipTutorial ? 'play' : 'tutorial',
      tutStep: 0, tutT: 0, tutFly: null,
      runT: 0, playStartT: 0, score: 0, bulbs: CFG.bulbs,
      chain: 0, mult: 1, lastEat: -99, bestMult: 1,
      glow: 0, jarIdx: 0, windowsLit: 0, eaten: 0,
      invuln: 0, shake: 0, hitFlash: 0, warn: 0,
      lamp: { x: 195, y: 800 }, shadow: null,
      jaw: 0.3, chomp: 0, jarPulse: 0,
      spawnT: skipTutorial ? 0.8 : 99, mothCd: skipTutorial ? 5 : 0,
      orbs: [], winAnim: [0, 0, 0, 0, 0, 0, 0, 0],
      banner: null, overT: 0, endReason: '', dragged: 0, newBest: false
    };
    G.shadow = project(G.lamp.x, G.lamp.y);
    if (!skipTutorial) startTutStep(0);
  }

  // ------------------------------------------------------------------ SPAWNING
  function spawnFly(x, y, opts) {
    var f = take(flies); if (!f) return null;
    opts = opts || {};
    f.x = f.hx = x; f.y = f.hy = y;
    f.vx = opts.still ? 0 : rand(-12, 12); f.vy = opts.still ? 0 : rand(-8, 8);
    f.p1 = rand(0, TAU); f.p2 = rand(0, TAU);
    f.amp = opts.amp != null ? opts.amp : rand(6, 14);
    f.age = 0; f.life = opts.life || rand(9, 12); f.tut = opts.tut || 0;
    return f;
  }
  function spawnSwarm() {
    var t = G.runT / CFG.runTime;
    var n = 2 + Math.floor(Math.random() * (2 + t * 2.5));
    n = Math.min(n, 5);
    var cx = rand(CFG.flyMinX + 20, CFG.flyMaxX - 20);
    var cy = rand(CFG.flyMinY + 10, CFG.flyMaxY - 10);
    var spread = rand(14, 26);
    for (var i = 0; i < n; i++) {
      if (countActive(flies) >= CFG.maxFlies) break;
      var a = (i / n) * TAU + rand(-0.4, 0.4);
      spawnFly(clamp(cx + Math.cos(a) * spread, 20, W - 20), clamp(cy + Math.sin(a) * spread, CFG.flyMinY - 10, CFG.flyMaxY + 10));
    }
  }
  function mothTarget() {
    if (G.phase !== 'play') return 0;
    if (G.runT - G.playStartT < 2) return 0;
    if (G.runT < 35) return 1;
    if (G.runT < 60) return 2;
    return 3;
  }
  function spawnMoth() {
    var m = take(moths); if (!m) return;
    var left = Math.random() < 0.5;
    m.x = left ? -14 : W + 14; m.y = rand(210, 440);
    m.vx = (left ? 1 : -1) * rand(42, 62) * (1 + G.runT / 180);
    m.vy = rand(-20, 20); m.ph = rand(0, TAU); m.flee = false; m.t = 0;
  }

  // ------------------------------------------------------------------ TUTORIAL
  function startTutStep(step) {
    G.tutStep = step; G.tutT = 0;
    if (step === 0) {
      G.tutFly = spawnFly(300, 536, { still: true, amp: 3, life: 999, tut: 1 });
    } else if (step === 1) {
      G.tutFly = spawnFly(235, 330, { still: true, amp: 3, life: 999, tut: 2 });
    } else if (step === 2) {
      // tight swarm: one big shadow gulps all three -> "x3!"
      spawnFly(128, 282, { still: true, amp: 4, life: 14 });
      spawnFly(150, 270, { still: true, amp: 4, life: 14 });
      spawnFly(142, 296, { still: true, amp: 4, life: 14 });
      G.tutFly = null;
      G.phase = 'play'; G.playStartT = G.runT; G.spawnT = 2.2;
    }
  }
  function updateTutorial(dt) {
    G.tutT += dt;
    var fly = G.tutFly, gone = !fly || !fly.active;
    if (G.tutStep === 0 && (gone || G.tutT > 6)) {
      if (!gone) { fly.tut = 0; fly.life = fly.age + 8; }
      startTutStep(1);
    } else if (G.tutStep === 1 && (gone || G.tutT > 9)) {
      if (!gone) { fly.tut = 0; fly.life = fly.age + 8; }
      startTutStep(2);
    }
  }

  // ------------------------------------------------------------------ FX helpers
  function burst(x, y, n, col, speed, size) {
    for (var i = 0; i < n; i++) {
      var p = take(parts); if (!p) return;
      var a = rand(0, TAU), v = rand(speed * 0.3, speed);
      p.x = x; p.y = y; p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v;
      p.life = p.max = rand(0.35, 0.7); p.size = size || rand(1.5, 3); p.kind = 0; p.col = col;
    }
  }
  function streakToJar(x, y) {
    var p = take(parts); if (!p) return;
    p.x = x; p.y = y; p.vx = rand(-60, 60); p.vy = rand(-120, -40);
    p.life = p.max = 1.6; p.size = 3; p.kind = 1; p.col = '#fff4a8';
  }
  function popup(x, y, text, size, col, life) {
    var p = take(pops); if (!p) return;
    p.x = clamp(x, 44, W - 44); p.y = y; p.text = text; p.size = size; p.col = col; p.life = p.max = life || 0.9;
  }

  // ------------------------------------------------------------------ CORE RULES
  function jarCap() { return CFG.jarCaps[Math.min(G.jarIdx, CFG.jarCaps.length - 1)]; }

  function eatFly(f) {
    f.active = false;
    if (G.runT - G.lastEat <= CFG.comboWindow && G.chain > 0) G.chain++; else G.chain = 1;
    G.lastEat = G.runT;
    G.mult = Math.min(CFG.maxMult, G.chain);
    if (G.mult > G.bestMult) G.bestMult = G.mult;
    var pts = 10 * G.mult;
    G.score += pts; G.eaten++;
    G.glow += 1 + (G.mult - 1) * 0.25;
    G.chomp = 1;
    burst(f.x, f.y, 8, '#eaff9a', 110);
    streakToJar(f.x, f.y);
    popup(f.x, f.y - 10, '+' + pts, 18, '#fff7c2', 0.8);
    if (G.mult >= 2) popup(f.x + 18, f.y - 34, '\u00d7' + G.mult + '!', 26 + G.mult * 4, multColor(G.mult), 0.9);
    Sfx.eat(G.mult);
    if (G.glow >= jarCap()) fillJar();
  }

  function fillJar() {
    G.glow -= jarCap();
    var wi = WINDOW_ORDER[G.windowsLit % WINDOW_ORDER.length];
    G.windowsLit++; G.jarIdx++;
    G.orbs.push({ t: 0, dur: 1.0, x0: CFG.jarX, y0: CFG.jarY - 24, wi: wi });
    G.banner = { text: 'A window lights up!', t: 0, dur: 1.8 };
    G.jarPulse = 1;
    Sfx.window();
  }

  function mothHit(m) {
    G.bulbs--; G.chain = 0; G.mult = 1; G.lastEat = -99;
    G.invuln = CFG.invuln; G.shake = 0.35; G.hitFlash = 1;
    m.flee = true; m.vx = (m.x < 195 ? -1 : 1) * 200; m.vy = -160;
    burst(m.x, m.y, 14, '#d9cfb8', 140);
    popup(m.x, m.y - 20, 'combo lost', 18, '#ff8d8d', 0.9);
    Sfx.hit();
    G.mothCd = 2.5;
    if (G.bulbs <= 0) endRun('Lights out!');
  }

  function endRun(reason) {
    if (G.phase === 'over') return;
    G.phase = 'over'; G.overT = 0; G.endReason = reason;
    if (G.score > best) { best = G.score; G.newBest = true; try { localStorage.setItem('lampPuppetBest', String(best)); } catch (e) { /* ignore */ } }
    Sfx.over();
  }

  function multColor(m) { return ['#cfd3ff', '#cfd3ff', '#9cf0ff', '#a6ff8a', '#ffd84a', '#ff7ad9'][m] || '#fff'; }

  // ------------------------------------------------------------------ UPDATE
  function update(dt) {
    var i, f, m, p, sh = G.shadow;

    // FX always update
    for (i = 0; i < parts.length; i++) {
      p = parts[i]; if (!p.active) continue;
      p.life -= dt;
      if (p.kind === 1) {
        // glow streak homing to jar
        var dx = CFG.jarX - p.x, dy = (CFG.jarY - 18) - p.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        p.vx += dx / d * 3600 * dt; p.vy += dy / d * 3600 * dt;
        var kj = Math.pow(0.93, dt * 60); p.vx *= kj; p.vy *= kj; // time-scaled damping
        if (d < 12 || p.life <= 0) { p.active = false; G.jarPulse = Math.max(G.jarPulse, 0.4); continue; }
      } else { var kb = Math.pow(0.94, dt * 60); p.vx *= kb; p.vy *= kb; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.life <= 0) p.active = false;
    }
    for (i = 0; i < pops.length; i++) { p = pops[i]; if (!p.active) continue; p.life -= dt; p.y -= 28 * dt; if (p.life <= 0) p.active = false; }
    for (i = G.orbs.length - 1; i >= 0; i--) {
      var o = G.orbs[i]; o.t += dt;
      if (o.t >= o.dur) { G.winAnim[o.wi] = Math.max(G.winAnim[o.wi], 0.001); G.orbs.splice(i, 1); var w = WINDOWS[o.wi]; burst(w.x + w.w / 2, w.y + w.h / 2, 18, '#ffd36b', 120); }
    }
    for (i = 0; i < G.winAnim.length; i++) if (G.winAnim[i] > 0 && G.winAnim[i] < 1) G.winAnim[i] = Math.min(1, G.winAnim[i] + dt * 1.6);
    if (G.banner) { G.banner.t += dt; if (G.banner.t > G.banner.dur) G.banner = null; }
    G.shake = Math.max(0, G.shake - dt); G.hitFlash = Math.max(0, G.hitFlash - dt * 2.5);
    G.jarPulse = Math.max(0, G.jarPulse - dt * 2);

    if (G.phase === 'over') { G.overT += dt; return; }

    G.runT += dt;
    if (G.runT >= CFG.runTime) { endRun("Night's over"); return; }
    G.invuln = Math.max(0, G.invuln - dt);

    // shadow follows lamp (smoothed so it feels like light, not a cursor)
    var tgt = project(G.lamp.x, G.lamp.y), k = Math.min(1, dt * 14);
    sh.x = lerp(sh.x, tgt.x, k); sh.y = lerp(sh.y, tgt.y, k); sh.s = lerp(sh.s, tgt.s, k);

    // combo timeout (silent reset to x1)
    if (G.chain > 0 && G.runT - G.lastEat > CFG.comboWindow) { G.chain = 0; G.mult = 1; }

    if (G.phase === 'tutorial') updateTutorial(dt);

    // spawning
    if (G.phase === 'play') {
      G.spawnT -= dt;
      if (G.spawnT <= 0) { spawnSwarm(); G.spawnT = lerp(1.9, 1.05, G.runT / CFG.runTime) * rand(0.8, 1.2); }
      G.mothCd -= dt;
      var act = 0; for (i = 0; i < moths.length; i++) if (moths[i].active && !moths[i].flee) act++;
      if (act < mothTarget() && G.mothCd <= 0) { spawnMoth(); G.mothCd = 1.5; }
    }

    // mouth in world space
    var mx = sh.x + MOUTH.x * sh.s, my = sh.y + MOUTH.y * sh.s, mr = MOUTH.r * sh.s + 5;
    var nearest = 1e9;

    // fireflies
    for (i = 0; i < flies.length; i++) {
      f = flies[i]; if (!f.active) continue;
      f.age += dt;
      f.hx += f.vx * dt; f.hy += f.vy * dt;
      if (f.hx < CFG.flyMinX || f.hx > CFG.flyMaxX) f.vx = -f.vx;
      if (f.hy < CFG.flyMinY || f.hy > CFG.flyMaxY) f.vy = -f.vy;
      f.x = f.hx + Math.sin(G.runT * 1.3 + f.p1) * f.amp + Math.sin(G.runT * 2.7 + f.p2) * f.amp * 0.4;
      f.y = f.hy + Math.cos(G.runT * 1.1 + f.p2) * f.amp * 0.7;
      if (f.age > f.life) { f.active = false; continue; }
      var d2 = dist2(f.x, f.y, mx, my);
      if (d2 < mr * mr) { eatFly(f); continue; }
      if (d2 < nearest) nearest = d2;
    }

    // jaw: opens wide when a firefly is near, snaps shut on a gulp
    var near = Math.sqrt(nearest) < mr * 2.2;
    G.chomp = Math.max(0, G.chomp - dt * 5);
    var jt = G.chomp > 0 ? 0 : (near ? 1 : 0.35);
    G.jaw = lerp(G.jaw, jt, Math.min(1, dt * (G.chomp > 0 ? 30 : 10)));

    // moths
    var warn = 0;
    for (i = 0; i < moths.length; i++) {
      m = moths[i]; if (!m.active) continue;
      m.t += dt;
      if (m.flee) {
        m.x += m.vx * dt; m.y += m.vy * dt;
        if (m.x < -40 || m.x > W + 40 || m.y < CFG.skyBottom - 30) m.active = false;
        continue;
      }
      m.x += m.vx * dt;
      m.y += (m.vy + Math.sin(m.t * 3 + m.ph) * 45) * dt;
      if (m.t > 1 && (m.x < 20 && m.vx < 0 || m.x > W - 20 && m.vx > 0)) m.vx = -m.vx;
      if (m.y < 200 && m.vy < 0 || m.y > 455 && m.vy > 0) m.vy = -m.vy;
      if (Math.random() < dt * 0.4) m.vy = rand(-25, 25);
      // touch test against every shadow hit circle (bigger shadow = more area = more risk)
      for (var h = 0; h < BODY_HITS.length; h++) {
        var c = BODY_HITS[h], cx = sh.x + c.x * sh.s, cy = sh.y + c.y * sh.s, rr = c.r * sh.s + CFG.mothR;
        var dd = dist2(m.x, m.y, cx, cy);
        if (dd < rr * rr) {
          if (G.invuln <= 0) { mothHit(m); }
          break;
        }
        var gap = Math.sqrt(dd) - rr;
        if (gap < 36) warn = Math.max(warn, 1 - gap / 36);
      }
      if (G.phase === 'over') return;
    }
    G.warn = warn;
  }

  // ------------------------------------------------------------------ DRAW
  function drawSky(t) {
    var g = ctx.createLinearGradient(0, 0, 0, CFG.skyBottom);
    g.addColorStop(0, '#070722'); g.addColorStop(1, '#1b1846');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, CFG.skyBottom);
    for (var i = 0; i < STARS.length; i++) {
      var s = STARS[i];
      ctx.globalAlpha = 0.4 + 0.4 * Math.sin(t * 1.7 + s.p);
      ctx.fillStyle = '#fff'; ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx.globalAlpha = 1;
    // moon
    ctx.fillStyle = '#f4efd2'; ctx.beginPath(); ctx.arc(150, 30, 11, 0, TAU); ctx.fill();
    ctx.fillStyle = '#121236'; ctx.beginPath(); ctx.arc(155, 27, 10, 0, TAU); ctx.fill();
    // houses
    ctx.fillStyle = '#0b0b20';
    for (i = 0; i < HOUSES.length; i++) {
      var h = HOUSES[i];
      ctx.beginPath();
      ctx.moveTo(h.x - 3, h.top); ctx.lineTo(h.x + h.w / 2, h.peak); ctx.lineTo(h.x + h.w + 3, h.top);
      ctx.lineTo(h.x + h.w, h.top); ctx.lineTo(h.x + h.w, CFG.skyBottom); ctx.lineTo(h.x, CFG.skyBottom); ctx.lineTo(h.x, h.top);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillRect(0, CFG.skyBottom - 6, W, 6);
    // windows
    for (i = 0; i < WINDOWS.length; i++) {
      var w = WINDOWS[i], a = G.winAnim[i];
      ctx.fillStyle = '#22264a'; ctx.fillRect(w.x, w.y, w.w, w.h);
      if (a > 0) {
        var pulse = a < 1 ? (1 + (1 - a) * 2) : 1;
        ctx.globalCompositeOperation = 'lighter';
        var gs = 46 * pulse;
        ctx.globalAlpha = 0.55 * a;
        ctx.drawImage(GLOW_WARM, w.x + w.w / 2 - gs / 2, w.y + w.h / 2 - gs / 2, gs, gs);
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = a;
        ctx.fillStyle = '#ffd36b'; ctx.fillRect(w.x, w.y, w.w, w.h);
        ctx.fillStyle = '#0b0b20'; ctx.fillRect(w.x + w.w / 2 - 0.75, w.y, 1.5, w.h); ctx.fillRect(w.x, w.y + w.h / 2 - 0.75, w.w, 1.5);
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawWall(t) {
    var top = CFG.skyBottom, bot = CFG.wallBottom;
    ctx.fillStyle = '#1e1832'; ctx.fillRect(0, top, W, bot - top);
    // warm light pool from the lamp (centre mirrors the lamp like the shadow does)
    var cx = CFG.puppetX - (G.lamp.x - CFG.puppetX) * 0.9;
    var strength = lerp(0.62, 0.38, (G.lamp.y - CFG.lampMinY) / (CFG.lampMaxY - CFG.lampMinY));
    var g = ctx.createRadialGradient(cx, 420, 20, cx, 400, 360);
    g.addColorStop(0, 'rgba(255,214,150,' + strength + ')');
    g.addColorStop(0.55, 'rgba(214,150,110,' + (strength * 0.55) + ')');
    g.addColorStop(1, 'rgba(60,40,80,0)');
    ctx.fillStyle = g; ctx.fillRect(0, top, W, bot - top);
    // subtle wallpaper stripes
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    for (var x = 0; x < W; x += 26) ctx.fillRect(x, top, 10, bot - top);
    // top shade
    var tg = ctx.createLinearGradient(0, top, 0, top + 40);
    tg.addColorStop(0, 'rgba(10,8,25,0.6)'); tg.addColorStop(1, 'rgba(10,8,25,0)');
    ctx.fillStyle = tg; ctx.fillRect(0, top, W, 40);
  }

  function drawShadow(t) {
    var sh = G.shadow;
    if (G.invuln > 0 && Math.floor(G.invuln * 14) % 2 === 0) ctx.globalAlpha = 0.45;
    ctx.save();
    ctx.translate(sh.x, sh.y); ctx.scale(sh.s, sh.s);
    // soft penumbra
    ctx.save();
    ctx.shadowColor = 'rgba(10,5,20,0.75)';
    ctx.shadowBlur = (4 + sh.s * 4) * view.s * view.dpr;
    ctx.fillStyle = '#140d1f';
    foxParts(ctx, G.jaw, 'fill');
    ctx.restore();
    // danger rim when a moth is close
    if (G.warn > 0.05 && G.invuln <= 0) {
      ctx.strokeStyle = 'rgba(255,80,80,' + (G.warn * 0.9) + ')';
      ctx.lineWidth = 3 / sh.s; ctx.lineJoin = 'round';
      foxParts(ctx, G.jaw, 'stroke');
      ctx.fillStyle = '#140d1f';
      foxParts(ctx, G.jaw, 'fill');
    }
    // eye: light leaking through the cardboard cut-out
    ctx.fillStyle = 'rgba(255,225,170,0.95)';
    ctx.beginPath(); ctx.arc(22, -89, 2.6, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawGhostHint(t) {
    // "closer = bigger": dashed outline of the size you need
    var g = project(244.6, 715);
    ctx.save();
    ctx.translate(g.x, g.y); ctx.scale(g.s, g.s);
    ctx.globalAlpha = 0.35 + 0.25 * Math.sin(t * 4);
    ctx.strokeStyle = '#fff2c8'; ctx.lineWidth = 2 / g.s;
    ctx.setLineDash([6 / g.s, 5 / g.s]);
    foxParts(ctx, 0.9, 'stroke');
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawFlies(t) {
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < flies.length; i++) {
      var f = flies[i]; if (!f.active) continue;
      var fade = Math.min(1, f.age / 0.4) * Math.min(1, (f.life - f.age) / 0.8);
      var flick = 0.7 + 0.3 * Math.sin(t * 9 + f.p1 * 3);
      var size = f.tut ? 76 : 58;
      ctx.globalAlpha = fade * flick;
      ctx.drawImage(GLOW_FLY, f.x - size / 2, f.y - size / 2, size, size);
      ctx.drawImage(GLOW_FLY, f.x - size / 4, f.y - size / 4, size / 2, size / 2);
      ctx.globalAlpha = fade;
      ctx.fillStyle = '#fbffd8'; ctx.beginPath(); ctx.arc(f.x, f.y, 2.6, 0, TAU); ctx.fill();
      if (f.tut) {
        ctx.globalAlpha = 0.5 + 0.4 * Math.sin(t * 5);
        ctx.strokeStyle = '#eaff9a'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(f.x, f.y, 16 + 4 * Math.sin(t * 5), 0, TAU); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  function drawMoths(t) {
    for (var i = 0; i < moths.length; i++) {
      var m = moths[i]; if (!m.active) continue;
      var flap = Math.abs(Math.sin(t * 22 + m.ph));
      ctx.save(); ctx.translate(m.x, m.y);
      // halo so moths read against the dark shadow
      ctx.fillStyle = 'rgba(255,120,120,0.16)';
      ctx.beginPath(); ctx.arc(0, 0, CFG.mothR + 6, 0, TAU); ctx.fill();
      ctx.fillStyle = '#d9cfb8';
      for (var sgn = -1; sgn <= 1; sgn += 2) {
        ctx.save(); ctx.scale(sgn * (0.35 + flap * 0.65), 1);
        ctx.beginPath(); ctx.ellipse(8, -4, 9, 7, -0.4, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.ellipse(6, 5, 6, 5, 0.5, 0, TAU); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = '#6b5b45';
      ctx.beginPath(); ctx.ellipse(0, 0, 2.6, 8, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#6b5b45'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-1, -7); ctx.lineTo(-4, -12); ctx.moveTo(1, -7); ctx.lineTo(4, -12); ctx.stroke();
      // dark spots on wings
      ctx.fillStyle = 'rgba(80,60,40,0.6)';
      ctx.beginPath(); ctx.arc(-7 * (0.35 + flap * 0.65), -4, 2, 0, TAU); ctx.arc(7 * (0.35 + flap * 0.65), -4, 2, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }

  function drawParticles() {
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i]; if (!p.active) continue;
      var a = clamp(p.life / p.max, 0, 1);
      ctx.globalAlpha = p.kind === 1 ? 1 : a;
      if (p.kind === 1) ctx.drawImage(GLOW_FLY, p.x - 10, p.y - 10, 20, 20);
      ctx.fillStyle = p.col; ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    // orbs flying from the jar to a village window
    for (i = 0; i < G.orbs.length; i++) {
      var o = G.orbs[i], k = clamp(o.t / o.dur, 0, 1), w = WINDOWS[o.wi];
      var tx = w.x + w.w / 2, ty = w.y + w.h / 2;
      var e = k * k * (3 - 2 * k);
      var x = lerp(o.x0, tx, e), y = lerp(o.y0, ty, e) - Math.sin(k * Math.PI) * 80;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(GLOW_WARM, x - 30, y - 30, 60, 60);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function drawTableAndPuppet(t) {
    var top = CFG.wallBottom, bot = CFG.tableBottom;
    var g = ctx.createLinearGradient(0, top, 0, bot);
    g.addColorStop(0, '#6e4a2e'); g.addColorStop(0.25, '#5a3a22'); g.addColorStop(1, '#2e1d12');
    ctx.fillStyle = g; ctx.fillRect(0, top, W, bot - top);
    ctx.fillStyle = 'rgba(255,220,170,0.15)'; ctx.fillRect(0, top, W, 2);
    // puppet: cardboard fox on a stick (fixed; you never touch it)
    var px = CFG.puppetX, py = CFG.puppetY;
    ctx.fillStyle = '#7a5a3a'; ctx.fillRect(px - 2, py - 4, 4, 22);
    ctx.save(); ctx.translate(px, py); ctx.scale(0.36, 0.36);
    ctx.fillStyle = '#c99862'; foxParts(ctx, 0.3, 'fill');
    ctx.fillStyle = '#2a1a10'; ctx.beginPath(); ctx.arc(22, -89, 3.5, 0, TAU); ctx.fill();
    ctx.restore();
    // lamp-side highlight on the puppet
    var lit = clamp(1 - (G.lamp.y - CFG.lampMinY) / 200, 0.2, 0.8);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = lit * 0.35;
    ctx.drawImage(GLOW_WARM, px - 28, py - 52, 56, 56);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    drawJar(t);
  }

  function drawJar(t) {
    var x = CFG.jarX, y = CFG.jarY, w = 34, h = 44, pulse = 1 + G.jarPulse * 0.12;
    ctx.save(); ctx.translate(x, y); ctx.scale(pulse, pulse);
    var fill = clamp(G.glow / jarCap(), 0, 1);
    // glow
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.25 + fill * 0.6;
    ctx.drawImage(GLOW_FLY, -40, -h / 2 - 40 + 6, 80, 80);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    // body
    ctx.fillStyle = 'rgba(180,210,230,0.18)';
    roundRect(-w / 2, -h, w, h, 7); ctx.fill();
    // contents
    if (fill > 0) {
      ctx.save(); roundRect(-w / 2, -h, w, h, 7); ctx.clip();
      var lvl = -h * fill + Math.sin(t * 3) * 1.2;
      ctx.fillStyle = '#e8ff8a'; ctx.fillRect(-w / 2, lvl, w, -lvl);
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(-w / 2, lvl, w, 2);
      ctx.restore();
    }
    ctx.strokeStyle = 'rgba(220,240,255,0.75)'; ctx.lineWidth = 2;
    roundRect(-w / 2, -h, w, h, 7); ctx.stroke();
    ctx.fillStyle = '#8a6a48'; ctx.fillRect(-w / 2 - 2, -h - 7, w + 4, 7);
    ctx.restore();
    // jar count (which jar of how many windows)
    ctx.fillStyle = '#ffe9b0'; ctx.font = 'bold 11px system-ui, -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(Math.floor(fill * 100) + '%', x, y + 14);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  function drawFloorAndLamp(t) {
    var top = CFG.tableBottom;
    var g = ctx.createLinearGradient(0, top, 0, H);
    g.addColorStop(0, '#191326'); g.addColorStop(1, '#0c0916');
    ctx.fillStyle = g; ctx.fillRect(0, top, W, H - top);
    var lx = G.lamp.x, ly = G.lamp.y;
    // light cone toward the puppet and wall
    ctx.globalCompositeOperation = 'lighter';
    var cg = ctx.createLinearGradient(0, ly, 0, CFG.wallBottom - 40);
    cg.addColorStop(0, 'rgba(255,210,140,0.22)'); cg.addColorStop(1, 'rgba(255,210,140,0)');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.moveTo(lx - 8, ly - 10); ctx.lineTo(lx + 8, ly - 10);
    ctx.lineTo(CFG.puppetX + 150, CFG.wallBottom - 40); ctx.lineTo(CFG.puppetX - 150, CFG.wallBottom - 40); ctx.closePath(); ctx.fill();
    ctx.drawImage(GLOW_WARM, lx - 60, ly - 72, 120, 120);
    ctx.globalCompositeOperation = 'source-over';
    // lamp body
    ctx.fillStyle = '#3d3550'; ctx.fillRect(lx - 3, ly - 2, 6, 22);
    ctx.fillStyle = '#4c4366'; roundRect(lx - 18, ly + 18, 36, 8, 4); ctx.fill();
    ctx.fillStyle = '#fff3c4'; ctx.beginPath(); ctx.arc(lx, ly - 10, 9, 0, TAU); ctx.fill();
    ctx.fillStyle = '#5a4f78';
    ctx.beginPath(); ctx.moveTo(lx - 16, ly - 2); ctx.lineTo(lx + 16, ly - 2); ctx.lineTo(lx + 8, ly + 6); ctx.lineTo(lx - 8, ly + 6); ctx.closePath(); ctx.fill();
    // drag ring
    ctx.strokeStyle = 'rgba(255,240,200,' + (0.25 + 0.15 * Math.sin(t * 3)) + ')'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(lx, ly + 4, 34, 0, TAU); ctx.stroke();
    // zone edges: "closer" (up) / "farther" (down)
    ctx.fillStyle = 'rgba(255,240,210,0.18)'; ctx.font = 'bold 11px system-ui, -apple-system, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('\u25b2 closer', 10, CFG.lampMinY - 10);
    ctx.fillText('\u25bc farther', 10, H - 10);
  }

  function drawHand(x, y, alpha) {
    ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y);
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#2a2140'; ctx.lineWidth = 2;
    // finger
    roundRect(-7, -34, 14, 36, 7); ctx.fill(); ctx.stroke();
    // palm
    roundRect(-14, -4, 34, 30, 10); ctx.fill(); ctx.stroke();
    // touch ripple
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath(); ctx.arc(0, -34, 10 + 4 * Math.sin(Date.now() / 150), 0, TAU); ctx.stroke();
    ctx.restore();
  }

  function drawHints(t) {
    if (G.phase !== 'tutorial') return;
    ctx.textAlign = 'center'; ctx.font = 'bold 22px system-ui, -apple-system, sans-serif';
    if (G.tutStep === 0) {
      var k = (t * 0.8) % 1, e = Math.sin(k * Math.PI);
      if (G.dragged < 60) drawHand(G.lamp.x - 70 * e + 30, G.lamp.y + 40, 0.9);
      ctx.fillStyle = 'rgba(255,245,220,0.95)';
      ctx.fillText('drag the lamp', W / 2, CFG.lampMinY - 4 + 0 * e);
    } else if (G.tutStep === 1) {
      drawGhostHint(t);
      var k2 = (t * 0.7) % 1, e2 = k2 * k2 * (3 - 2 * k2);
      drawHand(lerp(G.lamp.x, 244, e2) + 20, lerp(G.lamp.y, 715, e2) + 40, 0.85 * (1 - k2 * 0.5));
      ctx.fillStyle = 'rgba(255,245,220,0.95)';
      ctx.fillText('closer = bigger', W / 2, CFG.lampMinY - 4);
    }
  }

  function drawHUD(t) {
    // time bar
    var tl = clamp(1 - G.runT / CFG.runTime, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(0, 0, W, 4);
    ctx.fillStyle = tl < 0.15 ? '#ff8d6b' : '#ffd36b'; ctx.fillRect(0, 0, W * tl, 4);
    // score
    ctx.textAlign = 'left'; ctx.fillStyle = '#fff6dc';
    ctx.font = 'bold 26px system-ui, -apple-system, sans-serif';
    ctx.fillText(String(G.score), 12, 34);
    // bulbs (lives)
    for (var i = 0; i < CFG.bulbs; i++) {
      var bx = W - 24 - i * 26, by = 22, on = i < G.bulbs;
      if (on) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5; ctx.drawImage(GLOW_WARM, bx - 16, by - 16, 32, 32); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
      ctx.fillStyle = on ? '#ffe28a' : '#3a3550';
      ctx.beginPath(); ctx.arc(bx, by, 8, 0, TAU); ctx.fill();
      ctx.fillStyle = on ? '#b89a5a' : '#2a2540'; ctx.fillRect(bx - 4, by + 7, 8, 6);
    }
    // combo meter: xN + timer bar
    var cy = CFG.skyBottom + 30;
    var m = G.mult, live = G.chain > 0;
    var rem = live ? clamp(1 - (G.runT - G.lastEat) / CFG.comboWindow, 0, 1) : 0;
    ctx.textAlign = 'center';
    var sz = live && m >= 2 ? 30 + m * 3 : 24;
    ctx.font = 'bold ' + sz + 'px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = live && m >= 2 ? multColor(m) : 'rgba(255,255,255,0.35)';
    ctx.fillText('\u00d7' + m, W / 2, cy);
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; roundRect(W / 2 - 60, cy + 8, 120, 7, 3.5); ctx.fill();
    if (rem > 0) { ctx.fillStyle = multColor(Math.max(2, m)); roundRect(W / 2 - 60, cy + 8, 120 * rem, 7, 3.5); ctx.fill(); }
  }

  function drawPopups() {
    ctx.textAlign = 'center';
    for (var i = 0; i < pops.length; i++) {
      var p = pops[i]; if (!p.active) continue;
      var a = clamp(p.life / p.max * 1.5, 0, 1), k = 1 - p.life / p.max;
      var sc = k < 0.15 ? lerp(0.6, 1.15, k / 0.15) : 1;
      ctx.globalAlpha = a;
      ctx.font = 'bold ' + Math.round(p.size * sc) + 'px system-ui, -apple-system, sans-serif';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(20,10,30,0.7)'; ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.col; ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
    if (G.banner) {
      var b = G.banner, ba = clamp(Math.min(b.t / 0.2, (b.dur - b.t) / 0.4), 0, 1);
      ctx.globalAlpha = ba;
      ctx.fillStyle = 'rgba(20,12,36,0.7)'; roundRect(W / 2 - 130, 228, 260, 52, 26); ctx.fill();
      ctx.font = 'bold 22px system-ui, -apple-system, sans-serif'; ctx.fillStyle = '#ffd36b';
      ctx.fillText(b.text, W / 2, 262);
      ctx.globalAlpha = 1;
    }
  }

  var BTN = { x: 95, y: 590, w: 200, h: 64 };
  function drawOver(t) {
    var a = clamp(G.overT / 0.5, 0, 1);
    ctx.globalAlpha = a * 0.82; ctx.fillStyle = '#0a0818'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd36b'; ctx.font = 'bold 40px system-ui, -apple-system, sans-serif';
    ctx.fillText(G.endReason, W / 2, 250);
    ctx.fillStyle = '#fff6dc'; ctx.font = 'bold 64px system-ui, -apple-system, sans-serif';
    ctx.fillText(String(G.score), W / 2, 340);
    ctx.font = '16px system-ui, -apple-system, sans-serif'; ctx.fillStyle = 'rgba(255,246,220,0.7)';
    ctx.fillText(G.newBest ? 'new best!' : 'best ' + best, W / 2, 368);
    // lit windows
    ctx.font = 'bold 18px system-ui, -apple-system, sans-serif'; ctx.fillStyle = '#fff6dc';
    ctx.fillText(G.windowsLit + (G.windowsLit === 1 ? ' window lit' : ' windows lit'), W / 2, 430);
    var n = Math.max(WINDOWS.length, G.windowsLit), per = Math.min(n, 8), size = 22, gap = 10;
    var x0 = W / 2 - (per * size + (per - 1) * gap) / 2;
    for (var i = 0; i < per; i++) {
      var lit = i < G.windowsLit, wx = x0 + i * (size + gap), wy = 450;
      if (lit) { ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(GLOW_WARM, wx - 12, wy - 12, size + 24, size + 24); ctx.globalCompositeOperation = 'source-over'; }
      ctx.fillStyle = lit ? '#ffd36b' : '#2a2c50'; ctx.fillRect(wx, wy, size, size);
    }
    ctx.font = '15px system-ui, -apple-system, sans-serif'; ctx.fillStyle = 'rgba(255,246,220,0.7)';
    ctx.fillText(G.eaten + ' fireflies \u00b7 best combo \u00d7' + G.bestMult, W / 2, 520);
    // button
    var ready = G.overT > 0.8;
    ctx.fillStyle = ready ? '#ffd36b' : 'rgba(255,211,107,0.4)';
    roundRect(BTN.x, BTN.y, BTN.w, BTN.h, 32); ctx.fill();
    ctx.fillStyle = '#2a1a10'; ctx.font = 'bold 24px system-ui, -apple-system, sans-serif';
    ctx.fillText('Play again', W / 2, BTN.y + 41);
    ctx.globalAlpha = 1;
  }

  function draw(t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0a0a1c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    var sx = 0, sy = 0;
    if (G.shake > 0) { sx = rand(-6, 6) * G.shake / 0.35; sy = rand(-6, 6) * G.shake / 0.35; }
    var d = view.dpr, s = view.s;
    ctx.setTransform(d * s, 0, 0, d * s, d * (view.ox + sx * s), d * (view.oy + sy * s));
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    drawSky(t);
    ctx.save(); ctx.beginPath(); ctx.rect(0, CFG.skyBottom, W, CFG.wallBottom - CFG.skyBottom); ctx.clip();
    drawWall(t);
    drawShadow(t);
    drawMoths(t);
    drawFlies(t);
    ctx.restore();
    drawTableAndPuppet(t);
    drawFloorAndLamp(t);
    drawParticles();
    drawHUD(t);
    drawHints(t);
    drawPopups();
    if (G.hitFlash > 0) { ctx.fillStyle = 'rgba(255,60,60,' + (G.hitFlash * 0.3) + ')'; ctx.fillRect(0, 0, W, H); }
    if (G.phase === 'over') drawOver(t);
    ctx.restore();
  }

  // ------------------------------------------------------------------ INPUT (relative drag, one finger)
  var drag = { id: null, x: 0, y: 0 };
  function onDown(e) {
    if (e.cancelable) e.preventDefault();
    Sfx.init();
    var p = toLogical(e);
    if (G.phase === 'over') {
      if (G.overT > 0.8 && p.x >= BTN.x && p.x <= BTN.x + BTN.w && p.y >= BTN.y - 10 && p.y <= BTN.y + BTN.h + 10) restart();
      return;
    }
    if (drag.id !== null) return;
    drag.id = e.pointerId; drag.x = p.x; drag.y = p.y;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }
  function onMove(e) {
    if (drag.id === null || e.pointerId !== drag.id) return;
    if (e.cancelable) e.preventDefault();
    var p = toLogical(e);
    var dx = p.x - drag.x, dy = p.y - drag.y;
    drag.x = p.x; drag.y = p.y;
    if (G.phase === 'over') return;
    setLamp(G.lamp.x + dx, G.lamp.y + dy);
    G.dragged += Math.abs(dx) + Math.abs(dy);
  }
  function onUp(e) {
    if (e.pointerId !== drag.id) return;
    drag.id = null;
  }
  function setLamp(x, y) {
    G.lamp.x = clamp(x, CFG.lampMinX, CFG.lampMaxX);
    G.lamp.y = clamp(y, CFG.lampMinY, CFG.lampMaxY);
  }
  canvas.addEventListener('pointerdown', onDown, { passive: false });
  canvas.addEventListener('pointermove', onMove, { passive: false });
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  function restart() { resetState(true); drag.id = null; }

  // ------------------------------------------------------------------ DEBUG HANDLE (for QA automation)
  window.__game = {
    get score() { return G.score; },
    get bulbs() { return G.bulbs; },
    get combo() { return G.mult; },
    get chain() { return G.chain; },
    get phase() { return G.phase; },
    get tutorialStep() { return G.tutStep; },
    get windowsLit() { return G.windowsLit; },
    get jar() { return G.glow / jarCap(); },
    get time() { return G.runT; },
    get lamp() { return { x: G.lamp.x, y: G.lamp.y }; },
    get shadow() { return { x: G.shadow.x, y: G.shadow.y, s: G.shadow.s }; },
    get mouth() { var s = G.shadow; return { x: s.x + MOUTH.x * s.s, y: s.y + MOUTH.y * s.s, r: MOUTH.r * s.s }; },
    get fireflies() { var a = []; for (var i = 0; i < flies.length; i++) if (flies[i].active) a.push({ x: flies[i].x, y: flies[i].y }); return a; },
    get moths() { var a = []; for (var i = 0; i < moths.length; i++) if (moths[i].active && !moths[i].flee) a.push({ x: moths[i].x, y: moths[i].y }); return a; },
    get state() {
      return { score: G.score, bulbs: G.bulbs, combo: G.mult, chain: G.chain, phase: G.phase, windowsLit: G.windowsLit,
        jar: G.glow / jarCap(), time: G.runT, eaten: G.eaten, invuln: G.invuln };
    },
    setLamp: function (x, y) { setLamp(x, y); },
    lampFor: function (s) { // lamp y that yields shadow scale s
      var r = clamp((s - CFG.sMin) / (CFG.sMax - CFG.sMin), 0, 1);
      return CFG.lampMinY + (1 - Math.pow(r, 1 / 1.5)) * (CFG.lampMaxY - CFG.lampMinY);
    },
    restart: function () { restart(); },
    // advance the simulation deterministically (for automated tests where rAF is throttled)
    advance: function (seconds) { var n = Math.round(seconds * 60); for (var i = 0; i < n; i++) update(1 / 60); },
    config: CFG
  };

  // ------------------------------------------------------------------ LOOP
  resetState(false);
  var last = 0;
  function frame(ts) {
    var t = ts / 1000;
    var dt = last ? Math.min(0.05, Math.max(0, t - last)) : 1 / 60;
    last = t;
    try { update(dt); draw(t); } catch (err) { if (window.console) console.warn(err); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
