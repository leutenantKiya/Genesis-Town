/*
 * sfx.js - the shared sound effects. Every sound is made here with the Web Audio API (oscillators and filtered noise,
 * no audio files, no network): short, soft, cozy pixel-game blips. Other mods call them through
 *   window.GT_SFX = { play(name, {vol, pitch, x, y}), on(), setOn(bool), vol(), setVol(0..1), names, unlocked(), ctx() }
 * Always call as `window.GT_SFX && GT_SFX.play('coin')`; unknown names are ignored and play() never throws.
 * x,y (tile coords) make the volume fade with the distance from GT.player (silent beyond 14 tiles).
 * Settings: localStorage 'gt.sfx' ('on'/'off', default on) and 'gt.sfxVol' (0..1, default 0.6).
 * The AudioContext is created on the first play after a key press, click or touch (browsers need that).
 * Loudness: master = vol^2 * 2.2 into a limiter (compressor), each sound has a loudness factor in LV.
 * Also here: footsteps (a mod that watches the player's tile) and weather ambience (rain drops, snow wind).
 */
(function () {
  'use strict';
  var ac = null, master = null, unlocked = false, noiseBuf = null, voices = 0, last = {};
  var MAXV = 12, FAR = 14, MAKEUP = 2.2;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function on() { return lsGet('gt.sfx') !== 'off'; }
  function setOn(v) { lsSet('gt.sfx', v ? 'on' : 'off'); }
  function vol() { var v = parseFloat(lsGet('gt.sfxVol')); return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.6; }
  function setVol(v) { v = Math.max(0, Math.min(1, +v || 0)); lsSet('gt.sfxVol', String(v)); if (master) master.gain.value = curve(v); }
  function curve(v) { return v * v * MAKEUP; }

  function unlock() {
    unlocked = true;
    if (ac && ac.state === 'suspended') { try { ac.resume(); } catch (e) { /* ignore */ } }
  }
  ['keydown', 'pointerdown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, unlock, { passive: true, capture: true }); });

  function ctx() {
    if (!ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC(); master = ac.createGain(); master.gain.value = curve(vol());
      // a limiter after master so the louder sounds never clip
      var lim = ac.createDynamicsCompressor();
      lim.threshold.value = -10; lim.knee.value = 4; lim.ratio.value = 12; lim.attack.value = 0.002; lim.release.value = 0.12;
      master.connect(lim); lim.connect(ac.destination);
    }
    if (ac.state === 'suspended') { try { ac.resume(); } catch (e) { /* ignore */ } }
    return ac;
  }

  // ---- building blocks. t = start time, o = {pitch, vol}
  function use(dur) { voices++; setTimeout(function () { voices--; }, (dur + 0.1) * 1000); }
  // a tone with a pitch slide f0 -> f1 and a soft attack/decay envelope
  function tone(type, f0, f1, t, dur, v, o, dest) {
    var os = ac.createOscillator(), g = ac.createGain(), p = o.pitch || 1;
    os.type = type; os.frequency.setValueAtTime(f0 * p, t);
    if (f1 && f1 !== f0) os.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * p), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v * o.vol), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    os.connect(g); g.connect(dest || master); os.start(t); os.stop(t + dur + 0.03);
  }
  // filtered noise burst (ftype: lowpass/highpass/bandpass), optional cutoff sweep f0 -> f1
  function noise(ftype, f0, f1, t, dur, v, o, q) {
    if (!noiseBuf) { noiseBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.6), ac.sampleRate); var d = noiseBuf.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    var s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuf; f.type = ftype; f.Q.value = q || 0.8; f.frequency.setValueAtTime(f0 * (o.pitch || 1), t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1 * (o.pitch || 1), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v * o.vol), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master); s.start(t, Math.random() * 0.3); s.stop(t + dur + 0.03);
  }
  // a run of notes: list of [freq, delay, dur]
  function seq(type, notes, t, v, o) { notes.forEach(function (n) { tone(type, n[0], 0, t + n[1], n[2], v, o); }); }

  var S = {
    ui_click: function (t, o) { tone('square', 700, 520, t, 0.05, 0.07, o); },
    ui_open: function (t, o) { tone('triangle', 420, 640, t, 0.09, 0.12, o); },
    ui_close: function (t, o) { tone('triangle', 560, 360, t, 0.09, 0.11, o); },
    error: function (t, o) { tone('square', 190, 150, t, 0.16, 0.08, o); tone('square', 150, 120, t + 0.1, 0.18, 0.08, o); },
    notify: function (t, o) { seq('sine', [[880, 0, 0.14], [1175, 0.1, 0.2]], t, 0.12, o); },
    coin: function (t, o) { tone('square', 988, 0, t, 0.06, 0.07, o); tone('square', 1319, 0, t + 0.06, 0.2, 0.07, o); },
    buy: function (t, o) { seq('triangle', [[523, 0, 0.09], [659, 0.07, 0.09], [784, 0.14, 0.18]], t, 0.13, o); tone('square', 1319, 0, t + 0.2, 0.12, 0.04, o); },
    sell: function (t, o) { seq('triangle', [[784, 0, 0.09], [659, 0.07, 0.09], [523, 0.14, 0.16]], t, 0.13, o); tone('square', 1175, 0, t + 0.02, 0.1, 0.04, o); },
    pickup: function (t, o) { tone('square', 500, 900, t, 0.09, 0.07, o); },
    chop: function (t, o) { noise('bandpass', 900, 300, t, 0.1, 0.35, o, 1.2); tone('triangle', 180, 90, t, 0.1, 0.2, o); },
    mine: function (t, o) { noise('highpass', 3000, 5000, t, 0.06, 0.2, o); tone('square', 1500, 1100, t, 0.07, 0.06, o); tone('triangle', 220, 110, t, 0.08, 0.15, o); },
    dig: function (t, o) { noise('lowpass', 1400, 400, t, 0.16, 0.35, o); tone('sine', 110, 70, t, 0.1, 0.12, o); },
    plant: function (t, o) { tone('sine', 300, 480, t, 0.12, 0.14, o); noise('lowpass', 900, 500, t, 0.08, 0.15, o); },
    water: function (t, o) { noise('bandpass', 1600, 2600, t, 0.3, 0.2, o, 2); tone('sine', 700, 1100, t + 0.05, 0.12, 0.05, o); },
    harvest: function (t, o) { noise('bandpass', 2200, 1200, t, 0.07, 0.2, o); seq('triangle', [[523, 0.04, 0.1], [784, 0.11, 0.16]], t, 0.12, o); },
    cast: function (t, o) { noise('bandpass', 600, 2400, t, 0.22, 0.25, o, 1.5); tone('sine', 400, 900, t, 0.2, 0.05, o); },
    splash: function (t, o) { noise('lowpass', 2800, 500, t, 0.28, 0.35, o); tone('sine', 500, 220, t, 0.12, 0.08, o); },
    bite: function (t, o) { tone('square', 880, 0, t, 0.06, 0.08, o); tone('square', 880, 0, t + 0.09, 0.06, 0.08, o); },
    reel: function (t, o) { for (var i = 0; i < 4; i++) tone('square', 1100 + i * 40, 0, t + i * 0.045, 0.025, 0.04, o); },
    catch: function (t, o) { seq('triangle', [[523, 0, 0.1], [659, 0.09, 0.1], [784, 0.18, 0.1], [1047, 0.27, 0.25]], t, 0.13, o); },
    craft: function (t, o) { tone('square', 800, 0, t, 0.05, 0.06, o); noise('highpass', 4000, 0, t, 0.04, 0.15, o); tone('square', 1000, 0, t + 0.12, 0.05, 0.06, o); tone('triangle', 150, 90, t + 0.12, 0.1, 0.14, o); tone('triangle', 784, 0, t + 0.24, 0.2, 0.1, o); },
    cook: function (t, o) { noise('bandpass', 4500, 6000, t, 0.4, 0.14, o, 0.6); tone('sine', 660, 0, t + 0.3, 0.2, 0.08, o); },
    eat: function (t, o) { noise('bandpass', 1500, 900, t, 0.06, 0.3, o, 1.5); noise('bandpass', 1500, 900, t + 0.1, 0.06, 0.3, o, 1.5); tone('sine', 400, 520, t + 0.2, 0.1, 0.08, o); },
    build: function (t, o) { tone('triangle', 200, 100, t, 0.1, 0.22, o); noise('bandpass', 700, 300, t, 0.08, 0.25, o, 1.2); tone('triangle', 240, 120, t + 0.16, 0.1, 0.22, o); noise('bandpass', 700, 300, t + 0.16, 0.08, 0.25, o, 1.2); },
    hammer: function (t, o) { tone('square', 1800, 1200, t, 0.04, 0.06, o); tone('triangle', 260, 130, t, 0.09, 0.22, o); noise('bandpass', 1200, 500, t, 0.06, 0.2, o); },
    upgrade: function (t, o) { seq('triangle', [[392, 0, 0.1], [523, 0.1, 0.1], [659, 0.2, 0.1], [784, 0.3, 0.1], [1047, 0.4, 0.3]], t, 0.13, o); },
    levelup: function (t, o) { seq('square', [[523, 0, 0.1], [659, 0.1, 0.1], [784, 0.2, 0.1], [1047, 0.3, 0.28]], t, 0.07, o); seq('triangle', [[262, 0, 0.4], [392, 0.3, 0.3]], t, 0.12, o); },
    door: function (t, o) { tone('triangle', 130, 80, t, 0.14, 0.22, o); noise('lowpass', 500, 250, t, 0.1, 0.18, o); tone('sine', 520, 0, t + 0.12, 0.08, 0.05, o); },
    portal: function (t, o) { tone('sine', 300, 1200, t, 0.5, 0.12, o); tone('triangle', 450, 1800, t + 0.04, 0.45, 0.07, o); noise('bandpass', 800, 4000, t, 0.5, 0.08, o, 1.5); },
    swing: function (t, o) { noise('bandpass', 500, 2200, t, 0.16, 0.25, o, 1.2); },
    hit: function (t, o) { noise('bandpass', 1200, 400, t, 0.09, 0.35, o, 1); tone('square', 260, 100, t, 0.1, 0.1, o); },
    hurt: function (t, o) { tone('square', 340, 140, t, 0.2, 0.1, o); noise('lowpass', 900, 300, t, 0.12, 0.2, o); },
    monster_die: function (t, o) { tone('square', 420, 60, t, 0.4, 0.09, o); noise('lowpass', 1200, 200, t, 0.3, 0.25, o); },
    chat: function (t, o) { tone('sine', 1000, 1400, t, 0.06, 0.1, o); tone('sine', 1400, 0, t + 0.06, 0.08, 0.08, o); },
    trade_done: function (t, o) { seq('triangle', [[659, 0, 0.1], [880, 0.1, 0.1], [1175, 0.2, 0.25]], t, 0.13, o); tone('square', 1568, 0, t + 0.3, 0.12, 0.04, o); },
    win: function (t, o) { seq('square', [[659, 0, 0.09], [784, 0.09, 0.09], [988, 0.18, 0.09], [1319, 0.27, 0.3]], t, 0.07, o); },
    lose: function (t, o) { seq('triangle', [[392, 0, 0.15], [330, 0.15, 0.15], [262, 0.3, 0.3]], t, 0.13, o); },
    ride: function (t, o) { seq('triangle', [[523, 0, 0.1], [659, 0.08, 0.1], [523, 0.16, 0.1], [784, 0.24, 0.2]], t, 0.1, o); },
    quest_done: function (t, o) { seq('triangle', [[523, 0, 0.1], [523, 0.12, 0.08], [659, 0.2, 0.1], [784, 0.3, 0.1], [1047, 0.4, 0.3]], t, 0.13, o); },
    step: function (t, o) {
      var sf = o.surf || 'grass';
      if (sf === 'wood') { tone('triangle', 190, 110, t, 0.07, 0.14, o); noise('bandpass', 900, 400, t, 0.04, 0.12, o, 1.2); }
      else if (sf === 'hard') { noise('highpass', 2500, 4000, t, 0.03, 0.14, o); tone('square', 1300, 900, t, 0.025, 0.03, o); }
      else { noise('lowpass', 1500, 500, t, 0.07, 0.22, o); noise('bandpass', 2200, 1200, t + 0.015, 0.03, 0.06, o); }
    }
  };
  // loudness factor per sound (default 2); the small blips were the quietest so they get the most
  var LV = { ui_click: 3.4, ui_open: 2.6, ui_close: 2.6, notify: 2.6, chat: 2.8, error: 2.6, coin: 2.8, pickup: 3, bite: 2.6, reel: 3.2,
    cast: 1.7, water: 1.6, plant: 1.7, dig: 1.4, chop: 1.5, mine: 1.7, hit: 1.5, hurt: 2.2, monster_die: 2.2, win: 2.8, levelup: 2.6,
    swing: 1.7, splash: 1.5, cook: 1.8, eat: 1.6, harvest: 1.8, step: 1 };
  var DUR = { levelup: 0.7, upgrade: 0.8, quest_done: 0.8, portal: 0.6, win: 0.6, catch: 0.6 };

  function play(name, opts) {
    try {
      var fn = S[name];
      if (!fn || !unlocked || document.hidden || !on()) return;
      opts = opts || {};
      var v = opts.vol == null ? 1 : opts.vol;
      if (opts.x != null && opts.y != null) {
        var p = window.GT && window.GT.player;
        if (p) { var d = Math.hypot(opts.x - p.x, opts.y - p.y); if (d >= FAR) return; v *= 1 - d / FAR; }
      }
      v *= vol();
      if (v <= 0.01) return;
      var now = Date.now();
      if (last[name] && now - last[name] < 60) return;
      if (voices >= MAXV) return;
      if (!ctx()) return;
      last[name] = now;
      use(DUR[name] || 0.4);
      fn(ac.currentTime + 0.005, { pitch: opts.pitch || 1, surf: opts.surf, vol: Math.min(1, v / Math.max(vol(), 0.01)) * (LV[name] || 2) });
    } catch (e) { /* sounds must never break the game */ }
  }

  window.GT_SFX = { play: play, on: on, setOn: setOn, vol: vol, setVol: setVol, names: Object.keys(S),
    unlocked: function () { return unlocked; }, ctx: function () { return ac; } };

  /* ---- footsteps: one soft step each time the player lands on a new tile ---- */
  var st = { x: null, y: null, scene: null, foot: 0 };
  function stepFrame() {
    try {
      var GT = window.GT, p = GT && GT.player, sc = GT && GT.scene;
      if (!p || !sc) return;
      if (st.scene !== sc || st.x == null) { st.scene = sc; st.x = p.x; st.y = p.y; return; }
      if (p.x === st.x && p.y === st.y) return;
      st.x = p.x; st.y = p.y;
      if (window.GT_RIDE && window.GT_RIDE.on) return;
      var surf = 'grass';
      if (sc.kind !== 'out') surf = 'wood';
      else {
        var m = sc.map, tt = m && m.tiles && m.tiles[p.y * m.w + p.x];
        if (tt === 'sand' || tt === 'path') surf = 'hard';
      }
      st.foot ^= 1;
      play('step', { surf: surf, pitch: st.foot ? 1.08 : 0.92, vol: 1 });
    } catch (e) { /* never break a frame */ }
  }
  try { if (window.GT && GT.register) GT.register({ id: 'sfx_steps', onFrame: stepFrame }); } catch (e) { /* no engine */ }

  /* ---- weather ambience: rain bed + drips on 'hujan', soft wind on 'salju'. Checked every 500 ms. ---- */
  var amb = null, ambKind = null, ambBuf = null;
  function loopBuf() {
    if (!ambBuf) { ambBuf = ac.createBuffer(1, ac.sampleRate * 3, ac.sampleRate); var d = ambBuf.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    return ambBuf;
  }
  function startAmb(kind) {
    var a = { kind: kind, nodes: [] }, src = ac.createBufferSource(), g = ac.createGain(), lp = ac.createBiquadFilter();
    src.buffer = loopBuf(); src.loop = true;
    g.gain.value = 0.0001; g.connect(master);
    if (kind === 'hujan') {
      var bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.4;
      lp.type = 'lowpass'; lp.frequency.value = 6000;
      src.connect(bp); bp.connect(lp); lp.connect(g);
    } else {
      lp.type = 'lowpass'; lp.frequency.value = 500; lp.Q.value = 1.2;
      src.connect(lp); lp.connect(g);
      // slow gusts: an oscillator wobbles the filter
      var lfo = ac.createOscillator(), lg = ac.createGain();
      lfo.frequency.value = 0.18; lg.gain.value = 180; lfo.connect(lg); lg.connect(lp.frequency); lfo.start(); a.nodes.push(lfo);
    }
    src.start(0, Math.random() * 2); a.nodes.push(src);
    a.g = g; a.lp = lp;
    return a;
  }
  function stopAmb(a, fade) {
    if (!a) return;
    try { a.g.gain.setTargetAtTime(0.0001, ac.currentTime, fade / 3); } catch (e) { /* ignore */ }
    setTimeout(function () { a.nodes.forEach(function (n) { try { n.stop(); } catch (e) { /* ignore */ } }); try { a.g.disconnect(); } catch (e) { /* ignore */ } }, fade * 1000 + 100);
  }
  function ambTick() {
    try {
      var want = null, wk = null;
      if (unlocked && !document.hidden && on() && vol() > 0.01) {
        try { wk = window.GT_CHAIN && window.GT_CHAIN.weather && window.GT_CHAIN.weather(); } catch (e) { wk = null; }
        if (wk === 'hujan' || wk === 'salju') want = wk;
      }
      if (want !== ambKind) {
        if (amb) { stopAmb(amb, document.hidden ? 0.05 : 1.2); amb = null; }
        ambKind = want;
        if (want && ctx()) amb = startAmb(want);
        else ambKind = null;
      }
      if (!amb) return;
      var indoors = window.GT && GT.scene && GT.scene.kind !== 'out', now = ac.currentTime;
      if (amb.kind === 'hujan') {
        amb.g.gain.setTargetAtTime(indoors ? 0.22 : 0.45, now, 0.7);
        amb.lp.frequency.setTargetAtTime(indoors ? 900 : 6000, now, 0.4);
        // a few soft drips in the next half second
        var n = Math.floor(Math.random() * (indoors ? 2 : 4));
        for (var i = 0; i < n; i++) {
          var o = { pitch: 0.8 + Math.random() * 0.8, vol: indoors ? 0.6 : 1 };
          tone('sine', 2400, 1500, now + Math.random() * 0.5, 0.05, 0.11, o);
        }
      } else amb.g.gain.setTargetAtTime(indoors ? 0.12 : 0.3, now, 0.7);
    } catch (e) { /* ambience must never break the game */ }
  }
  setInterval(ambTick, 500);
  document.addEventListener('visibilitychange', function () { if (document.hidden) ambTick(); });
})();
