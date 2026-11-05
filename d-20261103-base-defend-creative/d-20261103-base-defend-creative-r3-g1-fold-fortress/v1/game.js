(function () {
  "use strict";

  var W = 390, H = 844;
  var STEP = 1 / 120;
  var RUN_TIME = 80;
  var START_FOLDS = 10;
  var MAX_SOLDIERS = 40, MAX_SPARKS = 64;
  var EDGE_NONE = 0, EDGE_TOP = 1, EDGE_RIGHT = 2, EDGE_BOTTOM = 3, EDGE_LEFT = 4;
  var GUIDE_DASH = [7, 5];
  var NO_DASH = [];
  var FRACTIONS = [0.10, 0.18, 0.26, 0.34]; /* 4 snapped crease lines per edge */

  var shell = document.getElementById("game-shell");
  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d", { alpha: false });
  var scoreNode = document.getElementById("score");
  var foldsNode = document.getElementById("folds");
  var comboNode = document.getElementById("combo");
  var comboStrong = comboNode.querySelector("strong");
  var healthNode = document.getElementById("health-text");
  var healthFill = document.getElementById("health-fill");
  var gameOverScreen = document.getElementById("game-over");
  var finalScoreNode = document.getElementById("final-score");
  var overTitle = document.getElementById("over-title");
  var overKicker = document.getElementById("over-kicker");
  var toastNode = document.getElementById("toast");

  var paperImage = new Image(), castleImage = new Image(), soldierImage = new Image();
  var flatImage = new Image(), sparkImage = new Image(), creaseImage = new Image();
  paperImage.src = "assets/art/paper.png";
  castleImage.src = "assets/art/castle.png";
  soldierImage.src = "assets/art/soldier.png";
  flatImage.src = "assets/art/soldier-flat.png";
  sparkImage.src = "assets/art/spark.png";
  creaseImage.src = "assets/art/crease-glow.png";

  var soldiers = new Array(MAX_SOLDIERS);
  var sparks = new Array(MAX_SPARKS);
  var i;
  for (i = 0; i < MAX_SOLDIERS; i += 1) {
    soldiers[i] = { active: false, flat: false, x: 0, y: 0, vy: 0, wobble: 0, timer: 0 };
  }
  for (i = 0; i < MAX_SPARKS; i += 1) {
    sparks[i] = { active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, spin: 0 };
  }

  var COMBO_WINDOW = 6; // seconds to land another 3+ catch before the multiplier resets

  var game = {
    state: "playing", score: 0, folds: START_FOLDS, combo: 1, health: 3, maxHealth: 3,
    left: 14, right: 376, top: 96, bottom: 746,
    spawnClock: 0, spawnBeat: 0, elapsed: 0, seed: 3917,
    shake: 0, bumpClock: 0, noFoldsShown: false, comboClock: 0
  };
  var pointer = { down: false, edge: EDGE_NONE, startX: 0, startY: 0, x: 0, y: 0, depth: 0, snapDepth: 0 };
  var fold = { active: false, edge: EDGE_NONE, crease: 0, depth: 0, progress: 0 };
  var castleX = 147, castleY = 650, castleTX = 147, castleTY = 650;
  var lastTime = 0, accumulator = 0;
  var dpr = 1;
  var timeText = "1:20", timeShown = 80;

  /* ---------- audio (created only after first tap, fully guarded) ---------- */
  var audio = { ctx: null, noise: null, ok: true };

  function audioInit() {
    var AC, len, data, n;
    if (!audio.ok) { return; }
    try {
      if (!audio.ctx) {
        AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { audio.ok = false; return; }
        audio.ctx = new AC();
        len = (audio.ctx.sampleRate * 0.25) | 0;
        audio.noise = audio.ctx.createBuffer(1, len, audio.ctx.sampleRate);
        data = audio.noise.getChannelData(0);
        for (n = 0; n < len; n += 1) { data[n] = (Math.random() * 2 - 1) * (1 - n / len); }
      }
      if (audio.ctx.state === "suspended") { audio.ctx.resume(); }
    } catch (e) { audio.ok = false; }
  }

  function tone(freq, dur, type, vol, slide) {
    var t, o, g;
    if (!audio.ok || !audio.ctx) { return; }
    try {
      t = audio.ctx.currentTime;
      o = audio.ctx.createOscillator();
      g = audio.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audio.ctx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { audio.ok = false; }
  }

  function swish(vol, rate) {
    var t, s, g;
    if (!audio.ok || !audio.ctx || !audio.noise) { return; }
    try {
      t = audio.ctx.currentTime;
      s = audio.ctx.createBufferSource();
      g = audio.ctx.createGain();
      s.buffer = audio.noise;
      s.playbackRate.value = rate;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      s.connect(g); g.connect(audio.ctx.destination);
      s.start(t);
    } catch (e) { audio.ok = false; }
  }

  /* ---------- helpers ---------- */
  function random() {
    game.seed = (game.seed * 1664525 + 1013904223) >>> 0;
    return game.seed / 4294967296;
  }

  function formatScore(value) {
    var s = String(value);
    while (s.length < 4) { s = "0" + s; }
    return s;
  }

  function updateHud() {
    scoreNode.textContent = formatScore(game.score);
    foldsNode.textContent = String(game.folds);
    comboStrong.textContent = "x" + String(game.combo);
    healthNode.textContent = String(game.health) + " / " + String(game.maxHealth);
    healthFill.style.width = String((game.health / game.maxHealth) * 100) + "%";
    healthFill.style.background = game.health === 1 ? "#d56f52" : "#6e8b75";
  }

  function showToast(text) {
    toastNode.textContent = text;
    toastNode.classList.remove("show");
    void toastNode.offsetWidth;
    toastNode.classList.add("show");
  }

  function bumpCombo() {
    comboNode.classList.remove("bump");
    void comboNode.offsetWidth;
    comboNode.classList.add("bump");
    game.bumpClock = 0.19;
  }

  function resize() {
    var vw = window.innerWidth || 390, vh = window.innerHeight || 844;
    var s = Math.min(vw / W, vh / H);
    var k = Math.min(3, Math.max(1, s * (window.devicePixelRatio || 1)));
    shell.style.width = W + "px";
    shell.style.height = H + "px";
    shell.style.position = "absolute";
    shell.style.left = "50%";
    shell.style.top = "50%";
    shell.style.aspectRatio = "auto";
    shell.style.transform = "translate(-50%,-50%) scale(" + s + ")";
    dpr = k;
    canvas.width = Math.round(W * k);
    canvas.height = Math.round(H * k);
  }

  function clearPools() {
    var n;
    for (n = 0; n < MAX_SOLDIERS; n += 1) { soldiers[n].active = false; }
    for (n = 0; n < MAX_SPARKS; n += 1) { sparks[n].active = false; }
  }

  function resetGame() {
    clearPools();
    game.state = "playing";
    game.score = 0; game.folds = START_FOLDS; game.combo = 1; game.health = 3;
    game.left = 14; game.right = 376; game.top = 96; game.bottom = 746;
    game.spawnClock = 0; game.spawnBeat = 0; game.elapsed = 0; game.seed = 3917;
    game.shake = 0; game.bumpClock = 0; game.noFoldsShown = false; game.comboClock = 0;
    pointer.down = false; pointer.edge = EDGE_NONE;
    fold.active = false;
    castleTX = (game.left + game.right) * 0.5 - 48;
    castleTY = game.bottom - 96;
    castleX = castleTX; castleY = castleTY;
    timeShown = -1;
    comboNode.classList.remove("bump");
    gameOverScreen.classList.remove("active");
    updateHud();
  }

  function beginGame() {
    audioInit();
    resetGame();
    spawnCluster();
    showToast("SWIPE IN FROM AN EDGE");
  }

  function gameOver(win, reason) {
    game.state = "over";
    pointer.down = false;
    finalScoreNode.textContent = formatScore(game.score);
    overTitle.textContent = reason;
    overKicker.textContent = win ? "THE LINE HELD" : "THE MAP IS LOST";
    gameOverScreen.classList.add("active");
    if (win) { tone(520, 0.3, "triangle", 0.15, 1.6); } else { tone(180, 0.5, "sawtooth", 0.12, 0.4); }
  }

  /* ---------- spawning ---------- */
  function spawnSoldier(x, y, speed) {
    var s, n;
    for (n = 0; n < MAX_SOLDIERS; n += 1) {
      s = soldiers[n];
      if (!s.active) {
        s.active = true; s.flat = false; s.x = x; s.y = y; s.vy = speed;
        s.wobble = random() * 6.283; s.timer = 0;
        return;
      }
    }
  }

  function spawnCluster() {
    var usable = game.right - game.left - 76;
    var center = game.left + 38 + random() * usable;
    var amount = game.spawnBeat % 3 === 2 ? 4 : 3;
    var n, x;
    for (n = 0; n < amount; n += 1) {
      x = center + (n - (amount - 1) * 0.5) * 25;
      if (x < game.left + 18) { x = game.left + 18; }
      if (x > game.right - 18) { x = game.right - 18; }
      spawnSoldier(x, game.top + 12 - (n % 2) * 11, 26 + random() * 8 + game.elapsed * 0.2);
    }
    game.spawnBeat += 1;
  }

  function emitSparks(x, y, amount) {
    var p, angle, speed, made = 0, n;
    for (n = 0; n < MAX_SPARKS && made < amount; n += 1) {
      p = sparks[n];
      if (!p.active) {
        angle = -2.8 + made * (5.6 / Math.max(1, amount - 1));
        speed = 38 + (made % 3) * 13;
        p.active = true; p.x = x; p.y = y;
        p.vx = Math.cos(angle) * speed;
        p.vy = Math.sin(angle) * speed - 24;
        p.life = 0.62 + (made % 2) * 0.16;
        p.spin = made * 0.7;
        made += 1;
      }
    }
  }

  /* ---------- folding ---------- */
  function castleInFlap(edge, crease) {
    if (edge === EDGE_BOTTOM) { return castleTY + 82 > crease; }
    if (edge === EDGE_LEFT) { return castleTX < crease; }
    if (edge === EDGE_RIGHT) { return castleTX + 96 > crease; }
    return false;
  }

  function soldierInFlap(s, edge, crease) {
    if (edge === EDGE_TOP) { return s.y < crease; }
    if (edge === EDGE_RIGHT) { return s.x > crease; }
    if (edge === EDGE_BOTTOM) { return s.y > crease; }
    return s.x < crease;
  }

  function reflectSoldier(s, edge, crease) {
    if (edge === EDGE_TOP) { s.y = crease + (crease - s.y); }
    else if (edge === EDGE_RIGHT) { s.x = crease - (s.x - crease); }
    else if (edge === EDGE_BOTTOM) { s.y = crease - (s.y - crease); }
    else { s.x = crease + (crease - s.x); }
  }

  function commitFold(edge, depth) {
    var crease, caught = 0, s, hitCastle, n;
    if (game.folds <= 0 || fold.active || game.state !== "playing") { return; }
    if (edge === EDGE_TOP) { crease = game.top + depth; }
    else if (edge === EDGE_RIGHT) { crease = game.right - depth; }
    else if (edge === EDGE_BOTTOM) { crease = game.bottom - depth; }
    else { crease = game.left + depth; }
    hitCastle = castleInFlap(edge, crease);

    for (n = 0; n < MAX_SOLDIERS; n += 1) {
      s = soldiers[n];
      if (s.active && !s.flat && soldierInFlap(s, edge, crease)) {
        reflectSoldier(s, edge, crease);
        s.flat = true; s.timer = 1.2; s.vy = 0;
        caught += 1;
        emitSparks(s.x, s.y, 3);
      }
    }

    if (edge === EDGE_TOP) { game.top = crease; }
    else if (edge === EDGE_RIGHT) { game.right = crease; }
    else if (edge === EDGE_BOTTOM) { game.bottom = crease; }
    else { game.left = crease; }

    game.folds -= 1;
    fold.active = true; fold.edge = edge; fold.crease = crease; fold.depth = depth; fold.progress = 0;
    swish(0.3, 0.9 + random() * 0.3);

    if (hitCastle) {
      game.combo = 1; game.health -= 1; game.shake = 0.3;
      showToast("MISFOLD x1");
      tone(150, 0.35, "sawtooth", 0.12, 0.5);
    } else if (caught === 0) {
      game.combo = 1;
      showToast("EMPTY FOLD x1");
      tone(220, 0.2, "square", 0.06, 0.6);
    } else {
      if (caught >= 3 && game.combo < 5) { game.combo += 1; bumpCombo(); }
      else if (caught >= 3) { bumpCombo(); }
      if (caught >= 3) { game.comboClock = COMBO_WINDOW; }
      game.score += caught * 100 * game.combo;
      showToast("x" + String(game.combo) + " CREASE");
      tone(330 + game.combo * 70, 0.18, "triangle", 0.14, 1.5);
    }
    castleTX = (game.left + game.right) * 0.5 - 48;
    castleTY = game.bottom - 96;
    updateHud();

    if (game.health <= 0) { gameOver(false, "CASTLE CRUSHED"); }
    else if (game.right - game.left < 184 || game.bottom - game.top < 300) { gameOver(false, "OUT OF PAPER"); }
    else if (game.folds <= 0 && !game.noFoldsShown) { game.noFoldsShown = true; }
  }

  /* ---------- input ---------- */
  function pickEdge(x, y) {
    var topD = Math.abs(y - game.top), rightD = Math.abs(x - game.right);
    var bottomD = Math.abs(y - game.bottom), leftD = Math.abs(x - game.left);
    var best = topD, edge = EDGE_TOP;
    if (rightD < best) { best = rightD; edge = EDGE_RIGHT; }
    if (bottomD < best) { best = bottomD; edge = EDGE_BOTTOM; }
    if (leftD < best) { best = leftD; edge = EDGE_LEFT; }
    return best <= 48 ? edge : EDGE_NONE;
  }

  function pointerPosition(event) {
    var rect = canvas.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) * (W / rect.width);
    pointer.y = (event.clientY - rect.top) * (H / rect.height);
  }

  function calculateDepth() {
    var raw, size, n, best = 0, bd = 1e9, d;
    if (pointer.edge === EDGE_TOP) { raw = pointer.y - pointer.startY; size = game.bottom - game.top; }
    else if (pointer.edge === EDGE_RIGHT) { raw = pointer.startX - pointer.x; size = game.right - game.left; }
    else if (pointer.edge === EDGE_BOTTOM) { raw = pointer.startY - pointer.y; size = game.bottom - game.top; }
    else { raw = pointer.x - pointer.startX; size = game.right - game.left; }
    pointer.depth = Math.max(0, raw);
    for (n = 0; n < 4; n += 1) {
      d = Math.abs(size * FRACTIONS[n] - pointer.depth);
      if (d < bd) { bd = d; best = n; }
    }
    pointer.snapDepth = size * FRACTIONS[best];
  }

  function onPointerDown(event) {
    audioInit();
    if (game.state !== "playing" || fold.active) { return; }
    pointerPosition(event);
    pointer.edge = pickEdge(pointer.x, pointer.y);
    if (pointer.edge === EDGE_NONE) { return; }
    pointer.down = true;
    pointer.startX = pointer.x; pointer.startY = pointer.y;
    pointer.depth = 0; pointer.snapDepth = 0;
    try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!pointer.down) { return; }
    pointerPosition(event);
    calculateDepth();
    event.preventDefault();
  }

  function onPointerCancel(event) {
    if (!pointer.down) { return; }
    pointer.down = false; pointer.depth = 0; pointer.snapDepth = 0;
    pointer.edge = EDGE_NONE;
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (!pointer.down) { return; }
    pointerPosition(event);
    calculateDepth();
    pointer.down = false;
    if (pointer.depth >= 38) { commitFold(pointer.edge, pointer.snapDepth); }
    pointer.edge = EDGE_NONE;
    event.preventDefault();
  }

  /* ---------- simulation (fixed 120 Hz) ---------- */
  function updateSoldiers(dt) {
    var s, n, targetX = (game.left + game.right) * 0.5;
    for (n = 0; n < MAX_SOLDIERS; n += 1) {
      s = soldiers[n];
      if (!s.active) { continue; }
      if (s.flat) {
        s.timer -= dt;
        if (s.timer <= 0) { s.active = false; }
        continue;
      }
      s.wobble += dt * 6;
      s.x += (targetX - s.x) * dt * 0.025;
      s.y += s.vy * dt;
      if (s.y >= castleY + 20) {
        s.active = false;
        if (s.x < castleX - 8 || s.x > castleX + 96 + 8) { continue; }
        game.health -= 1; game.combo = 1; game.shake = 0.3;
        emitSparks(targetX, castleY + 38, 8);
        showToast("BREACH x1");
        tone(140, 0.35, "sawtooth", 0.12, 0.5);
        updateHud();
        if (game.health <= 0) { gameOver(false, "CASTLE CRUSHED"); return; }
      }
    }
  }

  function updateSparks(dt) {
    var p, n;
    for (n = 0; n < MAX_SPARKS; n += 1) {
      p = sparks[n];
      if (!p.active) { continue; }
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 85 * dt; p.spin += dt * 7;
    }
  }

  function update(dt) {
    var interval;
    if (game.state !== "playing") { return; }
    game.elapsed += dt;
    game.spawnClock += dt;
    interval = 2.4 - game.elapsed * 0.01;
    if (game.spawnClock >= interval) { game.spawnClock -= interval; spawnCluster(); }
    updateSoldiers(dt);
    if (game.state !== "playing") { return; }
    updateSparks(dt);
    castleX += (castleTX - castleX) * Math.min(1, dt * 8);
    castleY += (castleTY - castleY) * Math.min(1, dt * 8);
    if (fold.active) {
      fold.progress += dt * 3.2;
      if (fold.progress >= 1) { fold.progress = 1; fold.active = false; }
    }
    if (game.combo > 1) {
      game.comboClock -= dt;
      if (game.comboClock <= 0) { game.combo = 1; showToast("COMBO LOST x1"); updateHud(); }
    }
    if (game.shake > 0) { game.shake -= dt; }
    if (game.bumpClock > 0) {
      game.bumpClock -= dt;
      if (game.bumpClock <= 0) { comboNode.classList.remove("bump"); }
    }
    if (game.elapsed >= RUN_TIME) { gameOver(true, "FORTRESS HELD"); }
  }

  /* ---------- rendering ---------- */
  function drawPaper() {
    var l = game.left, r = game.right, t = game.top, b = game.bottom;
    ctx.fillStyle = "#f4e6c8";
    ctx.fillRect(0, 0, W, H);
    if (paperImage.complete) { ctx.drawImage(paperImage, 0, 0, W, H); }
    /* dim the table outside the folded sheet */
    ctx.fillStyle = "rgba(47,55,57,.62)";
    ctx.fillRect(0, 0, W, t);
    ctx.fillRect(0, b, W, H - b);
    ctx.fillRect(0, t, l, b - t);
    ctx.fillRect(r, t, W - r, b - t);
    ctx.strokeStyle = "rgba(70,81,88,.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(l + 0.5, t + 0.5, r - l - 1, b - t - 1);
  }

  function drawEdgeTicks() {
    var n, t, x, y;
    ctx.fillStyle = "rgba(213,111,82,.72)";
    for (n = 1; n <= 4; n += 1) {
      t = n / 5;
      x = game.left + (game.right - game.left) * t;
      y = game.top + (game.bottom - game.top) * t;
      ctx.beginPath(); ctx.moveTo(x - 6, game.top); ctx.lineTo(x + 6, game.top); ctx.lineTo(x, game.top + 7); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(game.left, y - 6); ctx.lineTo(game.left, y + 6); ctx.lineTo(game.left + 7, y); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(game.right, y - 6); ctx.lineTo(game.right, y + 6); ctx.lineTo(game.right - 7, y); ctx.closePath(); ctx.fill();
    }
  }

  function drawSoldiers() {
    var s, n, bob;
    for (n = 0; n < MAX_SOLDIERS; n += 1) {
      s = soldiers[n];
      if (!s.active) { continue; }
      if (s.flat) {
        if (fold.active && fold.progress < 0.5) { continue; }
        ctx.globalAlpha = Math.min(1, s.timer * 2.5);
        if (flatImage.complete) { ctx.drawImage(flatImage, s.x - 16, s.y - 8, 32, 16); }
        ctx.globalAlpha = 1;
      } else {
        bob = Math.sin(s.wobble) * 1.5;
        if (soldierImage.complete) { ctx.drawImage(soldierImage, s.x - 16, s.y - 20 + bob, 32, 40); }
      }
    }
  }

  function drawCastle() {
    if (castleImage.complete) { ctx.drawImage(castleImage, castleX, castleY, 96, 96); }
  }

  function drawSparks() {
    var p, n;
    for (n = 0; n < MAX_SPARKS; n += 1) {
      p = sparks[n];
      if (!p.active) { continue; }
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      if (sparkImage.complete) { ctx.drawImage(sparkImage, -6, -6, 12, 12); }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawGuide() {
    var crease, d;
    if (!pointer.down || pointer.depth < 5) { return; }
    d = pointer.snapDepth;
    ctx.save();
    ctx.strokeStyle = "rgba(213,111,82,.9)";
    ctx.lineWidth = 2;
    ctx.setLineDash(GUIDE_DASH);
    ctx.fillStyle = "rgba(213,111,82,.13)";
    if (pointer.edge === EDGE_TOP) {
      crease = game.top + d;
      ctx.fillRect(game.left, game.top, game.right - game.left, d);
      ctx.beginPath(); ctx.moveTo(game.left, crease); ctx.lineTo(game.right, crease); ctx.stroke();
    } else if (pointer.edge === EDGE_RIGHT) {
      crease = game.right - d;
      ctx.fillRect(crease, game.top, d, game.bottom - game.top);
      ctx.beginPath(); ctx.moveTo(crease, game.top); ctx.lineTo(crease, game.bottom); ctx.stroke();
    } else if (pointer.edge === EDGE_BOTTOM) {
      crease = game.bottom - d;
      ctx.fillRect(game.left, crease, game.right - game.left, d);
      ctx.beginPath(); ctx.moveTo(game.left, crease); ctx.lineTo(game.right, crease); ctx.stroke();
    } else {
      crease = game.left + d;
      ctx.fillRect(game.left, game.top, d, game.bottom - game.top);
      ctx.beginPath(); ctx.moveTo(crease, game.top); ctx.lineTo(crease, game.bottom); ctx.stroke();
    }
    ctx.setLineDash(NO_DASH);
    ctx.restore();
  }

  /* The flap is a rectangle polygon reflected about the crease:
     its free edge sweeps from the original side (reach = -depth) to the mirrored side (+depth). */
  function drawFoldAnimation() {
    var reach, far, c = fold.crease, sh;
    if (!fold.active) { return; }
    reach = -Math.cos(fold.progress * Math.PI) * fold.depth;
    far = c - reach; /* only used for top/left sign handling below */
    sh = Math.sin(fold.progress * Math.PI);
    ctx.save();
    ctx.shadowColor = "rgba(30,30,30,.4)";
    ctx.shadowBlur = 10;
    ctx.fillStyle = "#fff4d6";
    if (fold.edge === EDGE_TOP) {
      far = c + reach;
      ctx.fillRect(game.left, Math.min(c, far), game.right - game.left, Math.abs(far - c));
    } else if (fold.edge === EDGE_BOTTOM) {
      far = c - reach;
      ctx.fillRect(game.left, Math.min(c, far), game.right - game.left, Math.abs(far - c));
    } else if (fold.edge === EDGE_LEFT) {
      far = c + reach;
      ctx.fillRect(Math.min(c, far), game.top, Math.abs(far - c), game.bottom - game.top);
    } else {
      far = c - reach;
      ctx.fillRect(Math.min(c, far), game.top, Math.abs(far - c), game.bottom - game.top);
    }
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#596b73";
    ctx.globalAlpha = 0.12 + sh * 0.22;
    if (fold.edge === EDGE_TOP || fold.edge === EDGE_BOTTOM) {
      ctx.fillRect(game.left, Math.min(c, far), game.right - game.left, Math.abs(far - c));
    } else {
      ctx.fillRect(Math.min(c, far), game.top, Math.abs(far - c), game.bottom - game.top);
    }
    ctx.globalAlpha = 1;
    if (creaseImage.complete) {
      if (fold.edge === EDGE_TOP || fold.edge === EDGE_BOTTOM) {
        ctx.drawImage(creaseImage, 0, c - 8, W, 16);
      } else {
        ctx.translate(c, 0); ctx.rotate(Math.PI * 0.5); ctx.drawImage(creaseImage, 0, -8, H, 16);
      }
    }
    ctx.restore();
  }

  function drawTimer() {
    var left = Math.max(0, Math.ceil(RUN_TIME - game.elapsed));
    var m;
    if (left !== timeShown) {
      timeShown = left;
      m = (left / 60) | 0;
      timeText = String(m) + ":" + (left % 60 < 10 ? "0" : "") + String(left % 60);
    }
    ctx.fillStyle = "rgba(70,81,88,.7)";
    ctx.font = "800 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(timeText, W * 0.5, game.top - 6 > 90 ? game.top - 6 : 90);
  }

  function render() {
    var shakeX = 0, shakeY = 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (game.shake > 0) {
      shakeX = Math.sin(game.shake * 90) * 4;
      shakeY = Math.cos(game.shake * 70) * 2;
    }
    ctx.save();
    ctx.translate(shakeX, shakeY);
    drawPaper();
    ctx.save();
    ctx.beginPath();
    ctx.rect(game.left, game.top, game.right - game.left, game.bottom - game.top);
    ctx.clip();
    drawSoldiers();
    drawCastle();
    drawSparks();
    ctx.restore();
    drawEdgeTicks();
    drawGuide();
    drawFoldAnimation();
    drawTimer();
    ctx.restore();
  }

  function loop(time) {
    var delta;
    if (!lastTime) { lastTime = time; }
    delta = Math.min(0.1, (time - lastTime) / 1000);
    lastTime = time;
    accumulator += delta;
    while (accumulator >= STEP) {
      update(STEP);
      accumulator -= STEP;
    }
    render();
    window.requestAnimationFrame(loop);
  }

  canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
  canvas.addEventListener("pointermove", onPointerMove, { passive: false });
  canvas.addEventListener("pointerup", onPointerUp, { passive: false });
  canvas.addEventListener("pointercancel", onPointerCancel, { passive: false });
  document.getElementById("restart-button").addEventListener("click", beginGame);
  window.addEventListener("resize", resize);
  resize();
  resetGame();
  spawnCluster();
  showToast("SWIPE IN FROM AN EDGE");
  window.requestAnimationFrame(loop);
}());
