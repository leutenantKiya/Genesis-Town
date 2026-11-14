/*
 * music.js - the game's own music, all made with the Web Audio API (no audio files, no network).
 *  1. Background music: a calm generative village tune (warm pad chords, a kalimba-like melody in a pentatonic scale,
 *     soft bass, a little reverb and echo). Daytime is brighter, night is slower and minor-ish. It changes key and
 *     chord progression every few minutes, and sounds muffled indoors.
 *  2. Ducking: it fades to about 15% while the night concert plays (GT_CONCERT.playing()) and out while riding the
 *     carousel.
 *  3. Sleep music: GT_MUSIC.sleep(true/false), a slow music-box lullaby (6/8) while the player naps; the background
 *     fades out and comes back when waking.
 *  4. Carousel music: GT_MUSIC.ride(true/false), a fairground waltz (oom-pah-pah, organ lead, glockenspiel sparkles).
 * Everything goes through a compressor/limiter so it is clearly audible on small speakers at 100%.
 * Settings: localStorage 'gt.bgm' ('on'/'off', default on; 'gt.music' belongs to the concert switch) and
 * 'gt.musicVol' (0..1, default 0.7). Audio starts after the first key press, click or touch (browsers need that).
 *   window.GT_MUSIC = { on(), setOn(bool), vol(), setVol(0..1), ride(bool), sleep(bool), playing() }
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;
  var ac = null, unlocked = false, started = false, paused = false, timer = null, tick = null;
  var master = null, comp = null, bgIn = null, lp = null, bgDuck = null, rideBus = null, rideGain = null, dlyIn = null;
  var noiseBuf = null;
  var sleepBus = null, sleepGain = null, sleepWant = false, sleepEndT = 0, sleepT = 0, sleepStep = 0;
  var rideWant = false, rideEndT = 0, rideT = 0, rideStep = 0;
  var duckNow = -1, lpNow = -1, volNow = -1;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function on() { return lsGet('gt.bgm') !== 'off'; }
  function setOn(v) { lsSet('gt.bgm', v ? 'on' : 'off'); }
  function vol() { var v = parseFloat(lsGet('gt.musicVol')); return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7; }
  function setVol(v) { lsSet('gt.musicVol', String(Math.max(0, Math.min(1, +v || 0)))); }
  function rnd(n) { return Math.floor(Math.random() * n); }
  function pick(a) { return a[rnd(a.length)]; }

  // ---------- audio graph
  function impulse(sec, decay) {
    var n = Math.floor(ac.sampleRate * sec), b = ac.createBuffer(2, n, ac.sampleRate);
    for (var c = 0; c < 2; c++) {
      var d = b.getChannelData(c);
      for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return b;
  }
  function ensure() {
    if (ac) return true;
    try {
      ac = (window.GT_SFX && GT_SFX.ctx && GT_SFX.ctx()) || null;
      if (!ac) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        ac = new AC();
      }
      // music master -> limiter -> out
      comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 12; comp.attack.value = 0.004; comp.release.value = 0.2;
      var out = ac.createGain(); out.gain.value = 1.0;
      master = ac.createGain(); master.gain.value = 0;
      master.connect(comp); comp.connect(out); out.connect(ac.destination);
      // background bus: notes -> lowpass -> duck gain -> master, plus reverb and echo
      bgIn = ac.createGain(); lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000; lp.Q.value = 0.5;
      bgDuck = ac.createGain(); bgDuck.gain.value = 1;
      bgIn.connect(lp); lp.connect(bgDuck); bgDuck.connect(master);
      var conv = ac.createConvolver(); conv.buffer = impulse(2.6, 2.6);
      var rev = ac.createGain(); rev.gain.value = 0.5;
      lp.connect(conv); conv.connect(rev); rev.connect(bgDuck);
      dlyIn = ac.createGain(); dlyIn.gain.value = 1;
      var dl = ac.createDelay(1.0), fb = ac.createGain(), dlp = ac.createBiquadFilter(), dout = ac.createGain();
      dl.delayTime.value = 0.43; fb.gain.value = 0.32; dlp.type = 'lowpass'; dlp.frequency.value = 2200; dout.gain.value = 0.35;
      dlyIn.connect(dl); dl.connect(dlp); dlp.connect(fb); fb.connect(dl); dlp.connect(dout); dout.connect(bgIn);
      // carousel bus
      rideBus = ac.createGain(); rideBus.gain.value = 1;
      rideGain = ac.createGain(); rideGain.gain.value = 0;
      rideBus.connect(rideGain); rideGain.connect(master);
      // lullaby bus: a soft echo of its own (the background's reverb is ducked away while sleeping)
      sleepBus = ac.createGain(); sleepGain = ac.createGain(); sleepGain.gain.value = 0;
      var sd2 = ac.createDelay(1.0), sfb = ac.createGain(), sdl = ac.createBiquadFilter();
      sd2.delayTime.value = 0.68; sfb.gain.value = 0.38; sdl.type = 'lowpass'; sdl.frequency.value = 2400;
      sleepBus.connect(sleepGain); sleepBus.connect(sd2); sd2.connect(sdl); sdl.connect(sfb); sfb.connect(sd2); sdl.connect(sleepGain);
      sleepGain.connect(master);
      return true;
    } catch (e) { ac = null; return false; }
  }

  // ---------- note makers (all take a start time t)
  function env(g, t, a, dur, peak) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function osc(type, f, t, a, dur, peak, dest, detune) {
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.value = f; if (detune) o.detune.value = detune;
    env(g, t, a, dur, peak);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.05);
  }
  function pad(f, t, dur, peak) { // slow swell, two soft oscillators a few cents apart
    var g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + Math.min(1.4, dur * 0.4));
    g.gain.setValueAtTime(peak, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.9);
    g.connect(bgIn);
    [['sine', -5], ['triangle', 6]].forEach(function (p) {
      var o = ac.createOscillator(); o.type = p[0]; o.frequency.value = f; o.detune.value = p[1];
      o.connect(g); o.start(t); o.stop(t + dur + 1);
    });
  }
  function kalimba(f, t, peak, soft) { // a plucked tine: fundamental plus a short bright partial
    var g = ac.createGain(); env(g, t, 0.006, soft ? 1.1 : 1.5, peak);
    g.connect(bgIn); g.connect(dlyIn);
    var o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + 1.6);
    osc('sine', f * 5.4, t, 0.003, 0.14, peak * 0.22, g);
  }
  function noise(t, dur, hp, peak, dest) {
    if (!noiseBuf) { noiseBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.6), ac.sampleRate); var d = noiseBuf.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    var s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuf; f.type = 'highpass'; f.frequency.value = hp;
    env(g, t, 0.004, dur, peak);
    s.connect(f); f.connect(g); g.connect(dest); s.start(t); s.stop(t + dur + 0.02);
  }

  // ---------- background music
  var MAJ = { I: [0, [4, 7]], ii: [2, [5, 9]], iii: [4, [7, 11]], IV: [5, [9, 12]], V: [7, [11, 14]], vi: [9, [12, 16]] };
  var MIN = { i: [0, [3, 7]], III: [3, [7, 10]], iv: [5, [8, 12]], v: [7, [10, 14]], VI: [8, [12, 15]], VII: [10, [14, 17]] };
  var PROG_MAJ = [['I', 'vi', 'IV', 'V'], ['I', 'IV', 'vi', 'V'], ['ii', 'V', 'I', 'I'], ['I', 'V', 'vi', 'IV'], ['vi', 'IV', 'I', 'V']];
  var PROG_MIN = [['i', 'VI', 'III', 'VII'], ['i', 'iv', 'VI', 'v'], ['VI', 'VII', 'i', 'i'], ['i', 'VII', 'VI', 'VII']];
  var PENT_MAJ = [0, 2, 4, 7, 9], PENT_MIN = [0, 3, 5, 7, 10];
  var KEYS = [0, 7, 5, 2, -3, -5, 4, -2];
  var RHY_DAY = [[1, 0, 0, 1, 0, 1, 0, 0], [1, 0, 1, 0, 0, 1, 0, 0], [1, 0, 0, 0, 1, 0, 1, 0], [0, 0, 1, 0, 1, 0, 0, 0], [1, 0, 0, 1, 0, 0, 1, 0]];
  var RHY_NIGHT = [[1, 0, 0, 0, 0, 1, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0], [0, 0, 1, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0]];
  var bg = { key: 0, night: false, prog: null, phrase: null, i: 0, plays: 0, keyAt: 0, t: 0, started: false };

  function isNight() {
    try { var h = GT.time && GT.time.hour; return typeof h === 'number' && (h >= 20 || h < 5); } catch (e) { return false; }
  }
  function degSemi(d, pent) { return pent[((d % 5) + 5) % 5] + 12 * Math.floor(d / 5); }
  function newPhrase() { // A B A C: the third bar repeats the first, the last bar comes home to a chord tone
    var night = bg.night, pent = night ? PENT_MIN : PENT_MAJ, rh = night ? RHY_NIGHT : RHY_DAY;
    var rA = pick(rh), rB = pick(rh), rC = pick(rh), d = pick([2, 3, 4, 5]), out = [];
    function bar(r, endHome, repeat) {
      var notes = [];
      for (var s = 0; s < 8; s++) {
        if (!r[s]) { notes.push(null); continue; }
        d = Math.max(0, Math.min(8, d + pick([-2, -1, -1, 0, 1, 1, 2])));
        notes.push(d);
      }
      if (endHome) { for (var k = 7; k >= 0; k--) if (notes[k] != null) { notes[k] = pick([0, 5]); break; } }
      return notes;
    }
    var a = bar(rA, false), b = bar(rB, false), c = bar(rC, true);
    out = a.concat(b, a, c);
    bg.phrase = out.map(function (x) { return x == null ? null : degSemi(x, pent); });
  }
  function newProgression(keyChange) {
    bg.night = isNight();
    var set = bg.night ? MIN : MAJ;
    if (keyChange || !bg.prog) {
      var k; do { k = pick(KEYS); } while (k === bg.key && KEYS.length > 1);
      bg.key = k; bg.keyAt = ac.currentTime;
    }
    bg.prog = pick(bg.night ? PROG_MIN : PROG_MAJ).map(function (n) { return set[n]; });
    newPhrase(); bg.plays = 0;
  }
  function bgSchedule() {
    var night = bg.night, sd = 60 / (night ? 62 : 74) / 2, tonic = 261.63 * Math.pow(2, bg.key / 12);
    var nPad = night ? 0.05 : 0.06, nMel = night ? 0.2 : 0.26, nBass = night ? 0.2 : 0.24;
    function fq(semi, oct) { return tonic * Math.pow(2, semi / 12) * (oct || 1); }
    function fold(s) { return ((s + 5) % 12 + 12) % 12 - 5; }
    var t = bg.t, i = bg.i, bar = i >> 3, s = i & 7, ch = bg.prog[bar];
    if (s === 0) {
      var tones = [ch[0]].concat(ch[1]);
      tones.forEach(function (x, n) { pad(fq(fold(x)), t, sd * 8, nPad * (n === 0 ? 0.8 : 1)); });
      pad(fq(fold(ch[0]), 2), t, sd * 8, nPad * 0.35);
      osc('triangle', fq(fold(ch[0]), 0.5), t, 0.03, sd * 3.6, nBass, bgIn);
      osc('sine', fq(fold(ch[0]), 1), t, 0.03, sd * 3, nBass * 0.45, bgIn);
    } else if (s === 4) {
      osc('triangle', fq(fold(ch[0] + 7), 0.5), t, 0.03, sd * 3, nBass * 0.65, bgIn);
    }
    var m = bg.phrase[i];
    if (m != null) kalimba(fq(m, 2), t, nMel * (s === 0 ? 1 : 0.8), night);
    // a light high tinkle on the first beat of the last bar of a play (day only)
    if (!night && bar === 3 && s === 6 && Math.random() < 0.6) kalimba(fq(ch[1][1], 4), t, 0.06, true);
    bg.t += sd; bg.i++;
    if (bg.i >= 32) {
      bg.i = 0; bg.plays++;
      var flip = isNight() !== bg.night, longKey = ac.currentTime - bg.keyAt > 150;
      if (bg.plays === 1) { // second play of the same chords: a new ending
        var c = bg.phrase.slice(24), pent = bg.night ? PENT_MIN : PENT_MAJ;
        for (var j = 0; j < 8; j++) if (c[j] != null) c[j] = degSemi(pick([0, 1, 2, 4, 5]), pent);
        for (var q = 7; q >= 0; q--) if (c[q] != null) { c[q] = 0; break; }
        bg.phrase = bg.phrase.slice(0, 24).concat(c);
      } else newProgression(flip || longKey);
    }
  }

  // ---------- carousel waltz (3/4, 150 BPM, 8-bar theme). Semitones relative to C5; bass roots relative to C.
  var R_MEL = [[12, null, 7, 12, null, 16], [14, 12, 11, 12, null, null], [17, null, 12, 17, null, 21], [19, 17, 16, 14, null, 11],
    [12, null, 7, 12, null, 16], [14, 12, 9, 12, null, 16], [14, null, 11, 14, null, 17], [16, 14, 12, null, null, null]];
  var R_ROOT = [0, 0, 5, 7, 0, 9, 7, 0];
  var R_PAH = [[4, 7, 12], [4, 7, 12], [9, 12, 17], [11, 14, 17], [4, 7, 12], [12, 16, 21], [11, 14, 17], [4, 7, 12]];
  function rf(semi, tr) { return 523.25 * Math.pow(2, (semi + tr) / 12); }
  function organ(f, t, dur, peak) {
    var g = ac.createGain(), fl = ac.createBiquadFilter();
    fl.type = 'lowpass'; fl.frequency.value = 4200;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + 0.012);
    g.gain.setValueAtTime(peak * 0.8, t + dur * 0.7); g.gain.linearRampToValueAtTime(0.0001, t + dur);
    fl.connect(g); g.connect(rideBus);
    [['square', 0], ['square', 7], ['sawtooth', -6]].forEach(function (p) {
      var o = ac.createOscillator(); o.type = p[0]; o.frequency.value = f; o.detune.value = p[1];
      var og = ac.createGain(); og.gain.value = p[0] === 'sawtooth' ? 0.35 : 0.5;
      o.connect(og); og.connect(fl); o.start(t); o.stop(t + dur + 0.02);
    });
  }
  function rideSchedule() {
    var sd = 60 / 150 / 2, t = rideT, i = rideStep, bar = Math.floor(i / 6) % 8, s = i % 6, loop = Math.floor(i / 48);
    var tr = [0, 0, 2, 2, 4, 4, 2, 0][loop % 8]; // the tune climbs a step every two loops
    if (s === 0) { // oom
      osc('triangle', rf(R_ROOT[bar] - 24, tr) * 1.0, t, 0.01, sd * 1.8, 0.34, rideBus);
      osc('square', rf(R_ROOT[bar] - 24, tr), t, 0.01, sd * 0.9, 0.07, rideBus);
      if (bar % 4 === 0) { noise(t, 0.7, 5500, 0.16, rideBus); osc('sine', 120, t, 0.005, 0.2, 0.3, rideBus); }
    } else if (s === 2 || s === 4) { // pah, pah
      R_PAH[bar].forEach(function (x) { osc('square', rf(x - 12, tr), t, 0.006, sd * 1.4, 0.075, rideBus); });
    }
    var m = R_MEL[bar][s];
    if (m != null) {
      var nx = R_MEL[bar][s + 1], len = (nx === null || s === 5) ? sd * 1.9 : sd * 0.95;
      if (s === 5 && bar < 7 && R_MEL[bar + 1][0] != null) len = sd * 0.9;
      organ(rf(m, tr), t, len, 0.19);
      if (s === 0 || s === 3) osc('sine', rf(m + 24, tr), t, 0.004, 0.5, 0.09, rideBus); // glockenspiel
    }
    if (s === 4 && (bar === 3 || bar === 7)) osc('sine', rf(R_MEL[bar][0] + 31, tr), t, 0.004, 0.45, 0.06, rideBus);
    rideT += sd; rideStep++;
  }

  // ---------- lullaby (6/8, eighth notes of 0.36 s, 8 bars: a rocking melody over I I IV V I IV V I). Semitones from C5.
  var S_MEL = [[7, null, 4, null, 7, null], [9, null, 7, null, 4, null], [5, null, 9, null, 12, null], [11, null, 7, null, null, null],
    [7, null, 4, null, 7, null], [9, null, 12, null, 9, null], [11, null, 9, null, 5, null], [4, null, null, null, 0, null]];
  var S_ROOT = [0, 0, 5, 7, 0, 5, 7, 0], S_CH = { 0: [0, 4, 7], 5: [5, 9, 12], 7: [7, 11, 14] };
  function boxNote(f, t, dur, peak) { // a music-box tine: a soft sine and a quick high partial
    osc('sine', f, t, 0.01, dur, peak, sleepBus);
    osc('sine', f * 4, t, 0.004, 0.18, peak * 0.14, sleepBus);
  }
  function sleepSchedule() {
    var sd = 0.36, t = sleepT, i = sleepStep, bar = Math.floor(i / 6) % 8, s = i % 6, root = S_ROOT[bar], ch = S_CH[root];
    if (s === 0) {
      osc('sine', rf(root - 24, 0), t, 0.05, sd * 5.6, 0.2, sleepBus);
      pad2(ch, t, sd * 6);
    }
    if (s === 2 || s === 4) boxNote(rf(ch[s === 2 ? 1 : 2] - 12, 0), t, 1.0, 0.045); // a gentle rocking arpeggio underneath
    var m = S_MEL[bar][s];
    if (m != null) boxNote(rf(m, 0), t, s === 0 || s === 4 ? 1.5 : 1.1, 0.16);
    sleepT += sd; sleepStep++;
  }
  function pad2(ch, t, dur) { // a very soft sustained chord for the lullaby bus
    var g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.035, t + 1.2);
    g.gain.setValueAtTime(0.035, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.8);
    g.connect(sleepBus);
    ch.forEach(function (x) { var o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = rf(x - 12, 0); o.connect(g); o.start(t); o.stop(t + dur + 1); });
  }

  // ---------- scheduler and control
  function run() {
    if (!ac || paused) return;
    try {
      var now = ac.currentTime;
      if (rideWant || now < rideEndT) { while (rideT < now + 0.5) rideSchedule(); }
      if (sleepWant || now < sleepEndT) { while (sleepT < now + 0.5) sleepSchedule(); }
      if (!rideWant && !sleepWant && bgWanted()) {
        if (!bg.prog) newProgression(true);
        if (!bg.started) { bg.started = true; bg.t = now + 0.1; }
        if (bg.t < now) bg.t = now + 0.05; // fell behind (tab was busy): jump forward instead of bursting
        while (bg.t < now + 0.5) bgSchedule();
      }
    } catch (e) { /* music must never break the game */ }
  }
  function bgWanted() { return on() && vol() > 0; }
  function control() {
    try {
      if (!unlocked) return;
      if (!ensure()) return;
      var now = ac.currentTime, hid = !!document.hidden;
      if (ac.state === 'suspended') { try { ac.resume(); } catch (e) { /* ignore */ } }
      if (hid !== paused) { paused = hid; if (!hid) { bg.t = now + 0.1; rideT = now + 0.1; } }
      if (!started) { started = true; if (!timer) timer = setInterval(run, 100); }
      var v = paused || !on() ? 0 : vol();
      if (v !== volNow) { master.gain.setTargetAtTime(v, now, paused ? 0.15 : 0.25); volNow = v; }
      // ducking: concert nearby leaves 15%, the carousel ride silences the background
      var duck = 1;
      if (rideWant || sleepWant) duck = 0;
      else if (window.GT_CONCERT && GT_CONCERT.playing && GT_CONCERT.playing()) duck = 0.15;
      if (duck !== duckNow) { bgDuck.gain.setTargetAtTime(duck, now, duck === 0 ? 0.25 : 0.6); duckNow = duck; }
      // indoors the music is muffled, at night it is a bit softer on top
      var indoor = GT.scene && GT.scene.kind && GT.scene.kind !== 'out';
      var cut = indoor ? 1100 : (isNight() ? 4200 : 9000);
      if (cut !== lpNow) { lp.frequency.setTargetAtTime(cut, now, 0.4); lpNow = cut; }
    } catch (e) { /* music must never break the game */ }
  }
  function ride(v) {
    try {
      v = !!v; if (v === rideWant) return;
      rideWant = v;
      if (!ensure()) return;
      var now = ac.currentTime;
      if (v) {
        rideStep = 0; rideT = now + 0.05;
        rideGain.gain.cancelScheduledValues(now); rideGain.gain.setTargetAtTime(1, now, 0.17); // about 0.5 s in
      } else {
        rideEndT = now + 1.4;
        rideGain.gain.cancelScheduledValues(now); rideGain.gain.setTargetAtTime(0, now, 0.27); // about 0.8 s out
      }
      control();
    } catch (e) { /* ignore */ }
  }

  function sleep(v) {
    try {
      v = !!v; if (v === sleepWant) return;
      sleepWant = v;
      if (!ensure()) return;
      var now = ac.currentTime;
      sleepGain.gain.cancelScheduledValues(now);
      if (v) { sleepStep = 0; sleepT = now + 0.3; sleepGain.gain.setTargetAtTime(1, now, 0.9); } // slow fade in
      else { sleepEndT = now + 2.5; sleepGain.gain.setTargetAtTime(0, now, 0.6); }
      control();
    } catch (e) { /* ignore */ }
  }

  function unlock() { unlocked = true; if (ac && ac.state === 'suspended') { try { ac.resume(); } catch (e) { /* ignore */ } } control(); }
  ['keydown', 'pointerdown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, unlock, { passive: true, capture: true }); });
  document.addEventListener('visibilitychange', function () { if (unlocked) control(); });
  tick = setInterval(control, 250);

  window.GT_MUSIC = {
    on: on, setOn: function (v) { setOn(v); control(); }, vol: vol, setVol: function (v) { setVol(v); control(); },
    ride: ride, sleep: sleep, playing: function () { return !!(started && !paused && ac && on() && vol() > 0); }
  };
})();
