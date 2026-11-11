/*
 * concert.js - the night concert on the public square's stage (village v2, layout.fun.stage). Every night from 19:00 to
 * 01:00 (game time) the band plays the town's own tune: a short chiptune loop made here with the Web Audio API (bass,
 * a lead in a pentatonic scale, a counter-melody and a soft beat; no audio files). It is heard in the public area only,
 * loudest in front of the stage and fading out about 24 tiles away. The 2.5D view shows the band and the lights
 * (three/fun.js); in the 2D view the stage tiles stay as they are.
 * Pengaturan > "Musik konser" turns it off (localStorage 'gt.music' = 'off'). Browsers start audio only after the
 * player has pressed or clicked something, so it waits for that.
 *   window.GT_CONCERT = { on(), setOn(bool), playing() }
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;
  var LS = 'gt.music', ac = null, master = null, timer = null, step = 0, nextT = 0, unlocked = false;
  var BPM = 112, SPB = 60 / BPM / 2; // eighth notes
  // C major pentatonic, two octaves (Hz)
  var N = { C3: 130.81, D3: 146.83, E3: 164.81, G3: 196.0, A3: 220.0, C4: 261.63, D4: 293.66, E4: 329.63, G4: 392.0, A4: 440.0, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99 };
  // 4 bars of 8 eighths: lead, counter-melody (a third lower, sparse), bass (on beats), drums (k kick, h hat, s snare)
  var LEAD = ['E5', '', 'G5', 'E5', 'D5', '', 'C5', '', 'D5', '', 'E5', 'D5', 'C5', '', 'A4', '', 'C5', '', 'D5', 'E5', 'G5', '', 'E5', '', 'D5', 'C5', 'D5', '', 'C5', '', '', ''];
  var COUNTER = ['C4', '', '', '', 'G3', '', '', '', 'A3', '', '', '', 'E3', '', '', '', 'C4', '', '', '', 'G3', '', '', '', 'D4', '', '', '', 'C4', '', '', ''];
  var BASS = ['C3', '', 'C3', '', 'G3', '', 'G3', '', 'A3', '', 'A3', '', 'E3', '', 'E3', '', 'C3', '', 'C3', '', 'G3', '', 'G3', '', 'D3', '', 'G3', '', 'C3', '', 'C3', ''];
  var DRUM = ['k', 'h', 's', 'h', 'k', 'h', 's', 'h', 'k', 'h', 's', 'h', 'k', 'k', 's', 'h', 'k', 'h', 's', 'h', 'k', 'h', 's', 'h', 'k', 'h', 's', 'h', 'k', 's', 's', 's'];

  function on() { try { return localStorage.getItem(LS) !== 'off'; } catch (e) { return true; } }
  function setOn(v) { try { localStorage.setItem(LS, v ? 'on' : 'off'); } catch (e) { /* storage blocked */ } if (!v) stop(); }

  function tone(type, f, t, dur, vol) {
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  var noiseBuf = null;
  function drum(kind, t) {
    if (kind === 'k') { var o = ac.createOscillator(), g = ac.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.18); return; }
    if (!noiseBuf) { noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.2, ac.sampleRate); var d = noiseBuf.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    var s = ac.createBufferSource(), f = ac.createBiquadFilter(), gg = ac.createGain();
    s.buffer = noiseBuf; f.type = kind === 'h' ? 'highpass' : 'bandpass'; f.frequency.value = kind === 'h' ? 7000 : 1800;
    var len = kind === 'h' ? 0.04 : 0.12;
    gg.gain.setValueAtTime(kind === 'h' ? 0.12 : 0.25, t); gg.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(f); f.connect(gg); gg.connect(master); s.start(t); s.stop(t + len + 0.02);
  }
  function schedule() {
    while (nextT < ac.currentTime + 0.25) {
      var i = step % 32;
      if (LEAD[i]) tone('square', N[LEAD[i]], nextT, SPB * 1.6, 0.07);
      if (COUNTER[i]) tone('triangle', N[COUNTER[i]], nextT, SPB * 3.5, 0.08);
      if (BASS[i]) tone('triangle', N[BASS[i]] / 2, nextT, SPB * 1.4, 0.16);
      if (DRUM[i]) drum(DRUM[i], nextT);
      nextT += SPB; step++;
    }
  }
  function start() {
    if (!ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ac = new AC(); master = ac.createGain(); master.gain.value = 0; master.connect(ac.destination);
    }
    if (ac.state === 'suspended') ac.resume();
    if (timer) return;
    nextT = ac.currentTime + 0.05;
    timer = setInterval(schedule, 100);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (master) master.gain.setTargetAtTime(0, ac.currentTime, 0.2);
  }

  function concertNow() {
    var L = GT.world && GT.world.layout, st = L && L.fun && L.fun.stage, sc = GT.scene;
    if (!st || !sc || sc.kind !== 'out' || (GT.worldId && GT.worldId() !== 'public')) return null;
    var h = GT.time.hour;
    if (!(h >= 19 || h < 1)) return null;
    var p = GT.player, cx = (st.x0 + st.x1) / 2, cy = st.y0 + 2;
    return Math.hypot(p.x - cx, p.y - cy);
  }
  function onFrame() {
    var d = unlocked && on() ? concertNow() : null;
    if (d == null || d > 26) { if (timer) stop(); return; }
    start();
    if (!master) return;
    var vol = d <= 4 ? 1 : Math.max(0, 1 - (d - 4) / 22);
    master.gain.setTargetAtTime(0.55 * vol * vol, ac.currentTime, 0.3);
  }
  // audio may only start after a key press or a click
  ['keydown', 'pointerdown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, function () { unlocked = true; if (ac && ac.state === 'suspended') ac.resume(); }, { passive: true }); });

  window.GT_CONCERT = { on: on, setOn: setOn, playing: function () { return !!timer; } };
  GT.register({ id: 'concert', onFrame: onFrame });
})();
