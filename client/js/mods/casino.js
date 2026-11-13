/*
 * casino.js - "Rumah Judi" (dealer = Bandar). Koin permainan saja, tidak bisa ditukar uang.
 * Games: Dadu Besar/Kecil, Blackjack, Mesin slot. Talks to the engine only through window.GT.
 * QA: GT.casino = {rollDice, diceOutcome, newDeck, handValue, isBlackjack, dealerPlay, bjSettle, spinSlot,
 *                  slotPayout, slotRtp, PAYTABLE, REEL, _setRng(fn), open(kind), stats(), ...}
 */
/*
 * GT_CASINO - the Genesis Casino (the village's casino building; interior.js calls GT_CASINO.open(tile) at its tables).
 *   Ticket      act casino {op:'enter'}: coin buys a pass for a while (state.casinoPass, state.fun). No pass, no play.
 *   Chips       live on the server (state.chips {bought, won}), never in the browser. act chips {op:'buy', n}: coin -> chips
 *               (rate and daily limits in economy/config.json `chips`); act chips {op:'sell', n}: BOUGHT chips back to coin at
 *               the same rate minus a fee. Chips WON at a table cannot be sold: nothing here ever turns gambling into coin.
 *   Games       act chips {op:'play', game, stake, pick?}: luck | slot | dice | cards. The server draws every outcome (this file
 *               only animates what it is told) and takes the stake from bought chips first, then won chips; wins are paid in
 *               won chips.
 *   roulette    the Luck Table: double or nothing on a roll. Also opened without a ticket at the market: GT_CASINO.openFree().
 *   Titles and the record board are cosmetic and stay in this browser (localStorage); they pay nothing.
 * The casino building is a separate IIFE from the old play-coin "Rumah Judi" below (behind GT_FLAGS.casino).
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  var BETS = [5, 10, 25, 50, 100];
  function C() { return window.GT_CHAIN; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function sfx(n) { try { window.GT_SFX && GT_SFX.play(n); } catch (e) { /* no sound */ } }
  function rint(n) { return Math.floor(Math.random() * n); } // only for the spinning animation, never an outcome

  /* ---------------------------------------------------------------- titles, record board (this browser only, cosmetic) */
  var TITLES = [
    { id: 'first', name: function () { return $t('Pemain Baru'); }, hint: function () { return $t('Main satu putaran.'); } },
    { id: 'lucky', name: function () { return $t('Si Mujur'); }, hint: function () { return $t('Kumpulkan 300 chip.'); } },
    { id: 'king', name: function () { return $t('Raja Chip'); }, hint: function () { return $t('Kumpulkan 1000 chip.'); } },
    { id: 'seven', name: function () { return $t('Tujuh Keramat'); }, hint: function () { return $t('Tiga 7 di mesin slot.'); } },
    { id: 'cards', name: function () { return $t('Ahli Kartu'); }, hint: function () { return $t('Menangkan 5 putaran kartu.'); } },
    { id: 'dice', name: function () { return $t('Dewa Dadu'); }, hint: function () { return $t('Menangkan 5 putaran dadu.'); } },
    { id: 'luck', name: function () { return $t('Bintang Meja Untung'); }, hint: function () { return $t('Menangkan 5 lemparan di Meja Untung.'); } }
  ];
  function key() { var c = C(); return 'gt.casino.titles.' + (c && c.state.account || 'guest'); }
  function load() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(key()) || 'null'); } catch (e) { d = null; }
    if (!d || typeof d.plays !== 'number') d = { best: 0, plays: 0, wins: { cards: 0, dice: 0, luck: 0 }, titles: {}, board: [] };
    d.wins = d.wins || {}; d.wins.cards = d.wins.cards || 0; d.wins.dice = d.wins.dice || 0; d.wins.luck = d.wins.luck || 0; d.titles = d.titles || {}; d.board = d.board || [];
    return d;
  }
  function save(d) { try { localStorage.setItem(key(), JSON.stringify(d)); } catch (e) { /* storage blocked: the badges live for this visit */ } }
  // a title is earned once; returns the new ones so the window can celebrate
  function award(d, extra) {
    var got = [];
    function give(id) { if (!d.titles[id]) { d.titles[id] = Date.now(); got.push(id); } }
    if (d.plays >= 1) give('first');
    if (d.best >= 300) give('lucky');
    if (d.best >= 1000) give('king');
    if (extra === 'seven') give('seven');
    if (d.wins.cards >= 5) give('cards');
    if (d.wins.dice >= 5) give('dice');
    if (d.wins.luck >= 5) give('luck');
    return got;
  }
  // the record board: the best chip counts reached, kept in this browser (top 5)
  function record(d) {
    var today = new Date().toISOString().slice(0, 10), top = d.board.filter(function (r) { return r.day === today; })[0];
    if (top) { if (d.best > top.chips) top.chips = d.best; } else d.board.push({ day: today, chips: d.best });
    d.board.sort(function (a, b) { return b.chips - a.chips; }); d.board = d.board.slice(0, 5);
  }

  /* ---------------------------------------------------------------- server state: ticket, chips */
  function passUntil() { var c = C(), st = c && c.state.st; return st && st.casinoPass > Date.now() ? st.casinoPass : 0; }
  function fun() { var c = C(), st = c && c.state.st; return (st && st.fun) || { casino: 15, casinoPassMinutes: 30 }; }
  function coins() { var c = C(), st = c && c.state.st, b = st && st.bag && st.bag.coin; return b ? b.settled + b.today : 0; }
  function chips() {
    var c = C(), st = c && c.state.st, h = st && st.chips;
    return h || { bought: 0, won: 0, hand: null, perCoin: 10, feePct: 5, minStake: 5, maxStake: 100, cardsEdge: 0.94, buyLeftCoin: 0, sellLeftChips: 0, stakeLeft: 0 };
  }
  function act(body) { return C().act(Object.assign({ action: 'chips' }, body), true); } // the table shows the result itself; errors still toast

  var win = null;
  function open(tile) {
    var c = C();
    if (!c || !c.state.account) { GT.toast($t('Masuk dulu.')); if (c && c.login) c.login(); return; }
    var game = tile === 'roulette' ? 'luck' : tile === 'card_table' ? 'cards' : tile === 'dice_table' ? 'dice' : 'slot';
    if (passUntil()) return table(game);
    ticket(game);
  }
  // the Luck Table at the market: no ticket, no other tables
  function openFree() {
    var c = C();
    if (!c || !c.state.account) { GT.toast($t('Masuk dulu.')); if (c && c.login) c.login(); return; }
    table('luck', true);
  }
  function ticket(game) {
    var c = C(), f = fun(), body = el('div');
    body.appendChild(el('p', null, $t('Tiket masuk Genesis Casino: {0} koin, berlaku {1} menit. Di dalam kamu bisa main Meja Untung, slot, kartu dan dadu dengan chip.', [f.casino, f.casinoPassMinutes])));
    body.appendChild(el('p', 'chain-dim', $t('Chip dibeli dengan koin. Chip yang kamu beli bisa ditukar kembali jadi koin (ada biaya kecil), tapi chip hasil menang tidak bisa ditukar.')));
    body.appendChild(el('p', 'chain-dim', $t('Koinmu: {0}', [coins()])));
    GT.modal({ title: '🎰 ' + $t('Genesis Casino'), body: body, actions: [
      { label: $t('Beli tiket · {0} koin', [f.casino]), primary: true, disabled: coins() < f.casino, onClick: function (h) {
        h.close('ok');
        c.act({ action: 'casino', op: 'enter' }).then(function () { if (passUntil()) table(game); }, function () { /* the server's message is the toast */ });
        return true;
      } },
      { label: $t('Batal'), close: true }
    ] });
  }

  /* ---------------------------------------------------------------- the table window */
  function table(game, free) {
    if (win && win.h.isOpen()) win.h.close('again');
    var d = load(), body = el('div', 'gt-casino'), h = GT.modal({ title: free ? '🎲 ' + $t('Meja Untung') : '🎰 ' + $t('Genesis Casino'), wide: true, body: body, onClose: function () { win = null; clearInterval(spinT); clearTimeout(spinT); }, actions: [{ label: $t('Tutup'), close: true }] });
    win = { h: h };
    var spinT = 0, busy = false, note = '', slotSyms = null, shown = null; // shown: the balances to display while an animation runs (the server has already paid)
    var bet = BETS[1];
    var cardState = null, diceState = null, luck = { last: null };
    var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], SUITS = ['♠', '♥', '♦', '♣'];
    function cardOf(n) { return { r: n % 13 + 1, s: Math.floor(n / 13) }; }
    // an open hand on the server (page reloaded in the middle of it) is picked up again
    if (chips().hand) { var hd = chips().hand; cardState = { card: cardOf(hd.card), pot: hd.pot, step: hd.step, bet: hd.bet }; }

    function bal() { return shown || chips(); }
    function total() { var b = chips(); return b.bought + b.won; }

    function newTitles(extra) {
      d.best = Math.max(d.best, total()); record(d);
      var got = award(d, extra); save(d);
      got.forEach(function (id) { var t = TITLES.filter(function (x) { return x.id === id; })[0]; if (t) { GT.toast('🏅 ' + $t('Gelar baru: {0}', [t.name()])); sfx('quest_done'); } });
    }
    function head() {
      var wrap = el('div'), b = bal();
      var top = el('div', 'gt-casino-head');
      var bar = el('div', 'gt-chipbar');
      bar.appendChild(el('b', null, '🪙 ' + $t('Chip beli: {0}', [b.bought])));
      bar.appendChild(el('span', null, '🏆 ' + $t('Chip menang: {0}', [b.won])));
      top.appendChild(bar);
      var left = Math.max(0, Math.ceil((passUntil() - Date.now()) / 60000));
      if (free) top.appendChild(el('span', 'chain-dim', $t('Main tanpa tiket')));
      else top.appendChild(el('span', 'chain-dim', left ? $t('Tiket berlaku {0} menit lagi', [left]) : $t('Tiketmu habis')));
      wrap.appendChild(top);
      wrap.appendChild(el('p', 'chain-dim', $t('Chip beli bisa ditukar jadi koin. Chip menang tidak bisa ditukar.')));
      wrap.appendChild(exchange());
      return wrap;
    }
    // buy / exchange controls: coin <-> bought chips, server-checked (act chips buy / sell)
    function exchange() {
      var ch = chips(), box = el('div', 'gt-chipx'), per = ch.perCoin || 10, fee = ch.feePct || 0;
      box.appendChild(el('b', null, $t('Beli / tukar chip')));
      box.appendChild(el('p', 'chain-dim', $t('1 koin = {0} chip. Tukar kembali chip beli: dipotong biaya {1}%. Koinmu: {2}', [per, fee, coins()])));
      var buy = el('div', 'gt-chipx-row');
      buy.appendChild(el('span', null, $t('Beli')));
      [10, 50, 100].forEach(function (coin) {
        var n = coin * per, b = el('button', 'mbtn', $t('{0} chip · {1} koin', [n, coin])); b.type = 'button';
        b.disabled = busy || coins() < coin || ch.buyLeftCoin < coin;
        b.addEventListener('click', function () { exch({ op: 'buy', n: n }); });
        buy.appendChild(b);
      });
      box.appendChild(buy);
      var sell = el('div', 'gt-chipx-row');
      sell.appendChild(el('span', null, $t('Tukar')));
      var opts = [10, 50, 100].map(function (coin) { return coin * per; }).filter(function (n) { return n < ch.bought; });
      var all = Math.floor(Math.min(ch.bought, ch.sellLeftChips) / per) * per;
      if (all > 0 && opts.indexOf(all) < 0) opts.push(all);
      if (!opts.length) sell.appendChild(el('span', 'chain-dim', ch.bought > 0 ? $t('Batas tukar hari ini habis.') : $t('Belum ada chip beli untuk ditukar.')));
      opts.forEach(function (n) {
        var coin = Math.floor(n * (100 - fee) / (100 * per)), b = el('button', 'mbtn', $t('{0} chip → {1} koin', [n, coin])); b.type = 'button';
        b.disabled = busy || n > ch.bought || n > ch.sellLeftChips;
        b.addEventListener('click', function () { exch({ op: 'sell', n: n }); });
        sell.appendChild(b);
      });
      box.appendChild(sell);
      return box;
    }
    function exch(o) {
      if (busy) return;
      busy = true; paint();
      act(o).then(function (r) { busy = false; note = r.toast; paint(); }, function () { busy = false; paint(); });
    }
    function tabs() {
      var row = el('div', 'gt-mall-tabs'); row.setAttribute('role', 'tablist');
      if (free) return row; // the market table has only the Luck Table
      [['luck', '🎲 ' + $t('Meja Untung')], ['slot', '🎰 ' + $t('Slot')], ['cards', '🃏 ' + $t('Kartu')], ['dice', '🎲 ' + $t('Dadu')]].forEach(function (g) {
        var b = el('button', 'gt-mall-tab' + (g[0] === game ? ' on' : ''), g[1]); b.type = 'button'; b.setAttribute('role', 'tab');
        b.addEventListener('click', function () { if (busy) return; game = g[0]; note = ''; slotSyms = null; diceState = null; paint(); });
        row.appendChild(b);
      });
      return row;
    }
    function betRow() {
      var row = el('div', 'gt-luck-row'), have = bal().bought + bal().won;
      BETS.forEach(function (n) {
        var b = el('button', 'mbtn' + (n === bet ? ' primary' : ''), String(n)); b.type = 'button'; b.disabled = busy || n > have;
        b.addEventListener('click', function () { if (busy) return; bet = n; paint(); });
        row.appendChild(b);
      });
      return row;
    }
    function canBet() { return !busy && bet <= total(); }
    function badges() {
      var wrap = el('div', 'gt-casino-badges');
      wrap.appendChild(el('b', null, $t('Gelarmu')));
      var has = TITLES.filter(function (t) { return d.titles[t.id]; });
      if (!has.length) wrap.appendChild(el('span', 'chain-dim', ' ' + $t('belum ada')));
      has.forEach(function (t) { wrap.appendChild(el('span', 'gt-badge', '🏅 ' + t.name())); });
      var next = TITLES.filter(function (t) { return !d.titles[t.id]; })[0];
      if (next) wrap.appendChild(el('div', 'chain-dim', $t('Berikutnya: {0} · {1}', [next.name(), next.hint()])));
      var rb = el('div', 'gt-casino-rec');
      rb.appendChild(el('b', null, $t('Rekor chip (di perangkat ini)')));
      d.board.forEach(function (r, i) { rb.appendChild(el('div', null, '#' + (i + 1) + ' · ' + r.chips + ' chip · ' + r.day)); });
      wrap.appendChild(rb);
      return wrap;
    }
    function result(text, cls) { var r = el('div', 'gt-luck-dice ' + (cls || ''), text); return r; }
    // a play: send it, keep showing the old balances while the animation runs, then reveal
    function play(body, anim, done) {
      if (busy) return;
      shown = Object.assign({}, chips()); busy = true; note = ''; sfx('ui_click');
      act(Object.assign({ op: 'play' }, body)).then(function (r) {
        anim(r.play, function () { busy = false; shown = null; d.plays++; done(r.play); newTitles(r.play.game === 'slot' && r.play.reels[0] === 4 && r.play.reels[1] === 4 && r.play.reels[2] === 4 ? 'seven' : null); if (h.isOpen()) paint(); });
        paint();
      }, function () { busy = false; shown = null; if (h.isOpen()) paint(); });
    }

    /* ---- slot: three reels */
    var SYM = ['🍒', '🍋', '🔔', '⭐', '7️⃣'];
    function paintSlot() {
      var box = el('div', 'gt-luck');
      box.appendChild(el('p', null, $t('Tiga gulungan. Tiga yang sama membayar berlipat (7 7 7 paling besar), dua yang sama mengembalikan taruhan. Dibayar dengan chip menang.')));
      var reels = el('div', 'gt-casino-reels');
      for (var i = 0; i < 3; i++) reels.appendChild(el('span', 'gt-casino-reel', slotSyms ? SYM[slotSyms[i]] : '❔'));
      box.appendChild(reels);
      box.appendChild(betRow());
      var go = el('button', 'mbtn primary', '🎰 ' + $t('Putar · {0} chip', [bet])); go.type = 'button'; go.disabled = !canBet();
      go.addEventListener('click', function () {
        if (!canBet()) return;
        play({ game: 'slot', stake: bet }, function (p, fin) {
          var cells = reels.children, ticks = 0;
          spinT = setInterval(function () {
            ticks++;
            for (var k = 0; k < 3; k++) cells[k].textContent = ticks < 6 + k * 4 ? SYM[rint(SYM.length)] : SYM[p.reels[k]];
            if (ticks >= 14) { clearInterval(spinT); fin(); }
          }, 80);
        }, function (p) {
          slotSyms = p.reels;
          note = p.mult > 1 ? '🎉 ' + $t('Menang +{0} chip!', [p.payout - p.stake]) : p.mult === 1 ? $t('Dua sama: taruhan kembali.') : $t('Tidak beruntung. −{0} chip', [p.stake]);
          sfx(p.mult > 1 ? 'win' : p.mult === 1 ? 'ui_click' : 'lose');
        });
      });
      box.appendChild(go);
      return box;
    }

    /* ---- dice: three dice, big or small, a triple loses */
    var FACE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    function die(n) { return el('span', 'gt-casino-die', FACE[n - 1]); }
    function paintDice() {
      var box = el('div', 'gt-luck');
      box.appendChild(el('p', null, $t('Tiga dadu. Besar: jumlah 11-17. Kecil: jumlah 4-10. Kalau ketiganya sama, semua kalah. Menang membayar sama dengan taruhan, dalam chip menang.')));
      var row = el('div', 'gt-casino-reels');
      (diceState ? diceState.dice : [0, 0, 0]).forEach(function (n) { row.appendChild(n ? die(n) : el('span', 'gt-casino-die', '🎲')); });
      box.appendChild(row);
      box.appendChild(betRow());
      var acts = el('div', 'gt-luck-row');
      [['big', $t('Besar')], ['small', $t('Kecil')]].forEach(function (s) {
        var b = el('button', 'mbtn primary', s[1] + ' · ' + bet); b.type = 'button'; b.disabled = !canBet();
        b.addEventListener('click', function () {
          if (!canBet()) return;
          play({ game: 'dice', stake: bet, pick: s[0] }, function (p, fin) {
            var cells = row.children, ticks = 0;
            spinT = setInterval(function () {
              ticks++;
              for (var k = 0; k < 3; k++) cells[k].textContent = ticks < 8 ? FACE[rint(6)] : FACE[p.dice[k] - 1];
              if (ticks >= 9) { clearInterval(spinT); fin(); }
            }, 80);
          }, function (p) {
            diceState = { dice: p.dice };
            if (p.win) d.wins.dice++;
            note = p.win ? '🎉 ' + $t('Jumlah {0}: menang +{1} chip!', [p.total, p.stake]) : p.triple ? $t('Tiga sama ({0}): semua kalah. −{1} chip', [p.dice[0], p.stake]) : $t('Jumlah {0}: kalah. −{1} chip', [p.total, p.stake]);
            sfx(p.win ? 'win' : 'lose');
          });
        });
        acts.appendChild(b);
      });
      box.appendChild(acts);
      return box;
    }

    /* ---- cards: high or low, the pot grows by fair odds less a small cut; take it or push on (the hand lives on the server) */
    function cardEl(c, hidden) {
      return el('span', 'gt-casino-card' + (!hidden && (c.s === 1 || c.s === 2) ? ' red' : ''), hidden ? '🂠' : RANKS[c.r - 1] + SUITS[c.s]);
    }
    function paintCards() {
      var box = el('div', 'gt-luck'), edge = chips().cardsEdge || 0.94;
      box.appendChild(el('p', null, $t('Tebak kartu berikutnya lebih tinggi atau lebih rendah (A paling rendah, K paling tinggi, sama = kalah). Tiap tebakan benar menaikkan hadiah; ambil kapan saja. Hadiah dibayar dengan chip menang.')));
      var row = el('div', 'gt-casino-reels');
      if (!cardState) { row.appendChild(cardEl(null, true)); }
      else { row.appendChild(cardEl(cardState.card)); if (cardState.next) row.appendChild(cardEl(cardState.next)); }
      box.appendChild(row);
      if (!cardState) {
        box.appendChild(betRow());
        var st = el('button', 'mbtn primary', '🃏 ' + $t('Bagi kartu · {0} chip', [bet])); st.type = 'button'; st.disabled = !canBet();
        st.addEventListener('click', function () {
          if (!canBet()) return;
          play({ game: 'cards', stake: bet }, function (p, fin) { fin(); }, function (p) { cardState = { card: cardOf(p.card), pot: p.pot, step: 0, bet: p.bet }; });
        });
        box.appendChild(st);
        return box;
      }
      var acts = el('div', 'gt-luck-row'), r = cardState.card.r;
      function step(pick) {
        if (busy) return;
        play({ game: 'cards', pick: pick }, function (p, fin) { fin(); }, function (p) {
          if (pick === 'cash' || p.taken) { d.wins.cards++; note = '💰 ' + $t('Kamu ambil {0} chip.', [p.taken]); cardState = null; sfx('win'); return; }
          if (p.lost) {
            var nx = cardOf(p.next);
            note = (nx.r === cardState.card.r ? $t('Sama: kalah.') : $t('Salah.')) + ' −' + p.bet + ' chip'; sfx('lose');
            cardState = { card: cardState.card, next: nx, over: true };
            return;
          }
          note = '🎉 ' + $t('Benar! Hadiah jadi {0} chip.', [p.pot]); sfx('win');
          cardState = { card: cardOf(p.card), pot: p.pot, step: p.step, bet: p.bet };
        });
      }
      if (cardState.over) {
        var again = el('button', 'mbtn primary', $t('Main lagi')); again.type = 'button';
        again.addEventListener('click', function () { cardState = null; note = ''; paint(); });
        box.appendChild(again);
        return box;
      }
      box.appendChild(el('p', 'gt-casino-pot', $t('Hadiah sekarang: {0} chip', [cardState.pot])));
      var hiB = el('button', 'mbtn primary', '⬆ ' + $t('Lebih tinggi') + (r < 13 ? ' ×' + (Math.round(edge / ((13 - r) / 13) * 100) / 100) : '')); hiB.type = 'button'; hiB.disabled = busy || r >= 13;
      var loB = el('button', 'mbtn primary', '⬇ ' + $t('Lebih rendah') + (r > 1 ? ' ×' + (Math.round(edge / ((r - 1) / 13) * 100) / 100) : '')); loB.type = 'button'; loB.disabled = busy || r <= 1;
      hiB.addEventListener('click', function () { step('higher'); }); loB.addEventListener('click', function () { step('lower'); });
      acts.appendChild(hiB); acts.appendChild(loB);
      if (cardState.step > 0) { var co = el('button', 'mbtn', $t('Ambil {0}', [cardState.pot])); co.type = 'button'; co.disabled = busy; co.addEventListener('click', function () { step('cash'); }); acts.appendChild(co); }
      box.appendChild(acts);
      return box;
    }

    /* ---- the Luck Table: a roll that doubles the stake or loses it */
    function paintLuck() {
      var box = el('div', 'gt-luck'), pct = Math.round((chips().luckWin || 0.45) * 100);
      box.appendChild(el('p', null, $t('Taruh chip, lempar dadu. Menang: taruhanmu jadi dua kali lipat, dibayar dengan chip menang. Kalah: taruhannya hilang. Peluang menang {0}%.', [pct])));
      box.appendChild(el('p', 'chain-dim', $t('Chip menang tidak bisa ditukar jadi koin atau barang. Hadiahnya gelar.')));
      box.appendChild(betRow());
      var r = luck.last;
      box.appendChild(el('div', 'gt-luck-dice' + (busy ? ' rolling' : r ? (r.win ? ' win' : ' lose') : ''), busy ? '🎲 🎲' : r ? r.text : '🎲 🎲'));
      var roll = el('button', 'mbtn primary', '🎲 ' + $t('Lempar dadu · {0} chip', [bet])); roll.type = 'button'; roll.disabled = !canBet();
      roll.addEventListener('click', function () {
        if (!canBet()) return;
        play({ game: 'luck', stake: bet }, function (p, fin) { spinT = setTimeout(fin, 700); }, function (p) {
          if (p.win) d.wins.luck++;
          luck.last = { win: p.win, text: p.win ? '🎉 ' + $t('Menang! +{0} chip', [p.stake]) : '💨 ' + $t('Kalah −{0} chip', [p.stake]) };
          sfx(p.win ? 'win' : 'lose');
        });
      });
      box.appendChild(roll);
      return box;
    }

    function paint() {
      if (!h.isOpen()) return;
      body.textContent = '';
      body.appendChild(head());
      body.appendChild(tabs());
      var area = game === 'luck' ? paintLuck() : game === 'cards' ? paintCards() : game === 'dice' ? paintDice() : paintSlot();
      body.appendChild(area);
      if (note) body.appendChild(result(note, ''));
      body.appendChild(badges());
    }
    paint();
  }

  window.GT_CASINO = { open: open, openFree: openFree, _load: load };
})();

(function(){
if (!window.GT_FLAGS || !window.GT_FLAGS.casino) return; // feature flag: off in the submission build (js/flags.js)
'use strict';
var GT = window.GT;
if (!GT) return;

var MIN_BET = 10, BETS = [10, 25, 50, 100];
var RESP_LINE = 'Koin permainan saja, tidak bisa ditukar uang.';
var rng = Math.random;                       // game outcomes use this (never the world rng)
function r01(){ var v = +rng(); return v >= 0 && v < 1 ? v : 0; }
function rint(n){ return Math.floor(r01() * n); }

/* ---------------------------------------------------------------- dadu */
function rollDice(){ return [1 + rint(6), 1 + rint(6), 1 + rint(6)]; }
// side: 'besar' | 'kecil'. payout = coins returned to the player (0 on loss, 2*bet on win => pays 1:1).
function diceOutcome(dice, side, bet){
  var total = dice[0] + dice[1] + dice[2];
  var triple = dice[0] === dice[1] && dice[1] === dice[2];
  var big = total >= 11 && total <= 17, small = total >= 4 && total <= 10;
  var win = !triple && ((side === 'besar' && big) || (side === 'kecil' && small));
  return { total: total, triple: triple, win: win, payout: win ? bet * 2 : 0 };
}

/* ---------------------------------------------------------------- blackjack */
var SUITS = ['♠', '♥', '♦', '♣'];           // spade heart diamond club
var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function newDeck(){
  var d = [], s, r;
  for (s = 0; s < 4; s++) for (r = 1; r <= 13; r++) d.push({ r: r, s: s });
  for (var i = d.length - 1; i > 0; i--){ var j = rint(i + 1), t = d[i]; d[i] = d[j]; d[j] = t; }
  return d;
}
function handValue(cards){
  var t = 0, aces = 0;
  cards.forEach(function(c){ if (c.r === 1){ aces++; t += 11; } else t += Math.min(c.r, 10); });
  while (t > 21 && aces > 0){ t -= 10; aces--; }
  return { total: t, soft: aces > 0 };
}
function isBlackjack(cards){ return cards.length === 2 && handValue(cards).total === 21; }
function dealerPlay(dealer, deck){            // dealer hits below 17, stands on every 17 (also soft 17)
  while (handValue(dealer).total < 17) dealer.push(deck.pop());
  return dealer;
}
// dealer hand must be finished. result: blackjack | win | lose | push ; payout = coins returned.
function bjSettle(player, dealer, bet){
  var pv = handValue(player).total, dv = handValue(dealer).total;
  var pbj = isBlackjack(player), dbj = isBlackjack(dealer);
  if (pv > 21) return { result: 'lose', bust: true, payout: 0 };
  if (pbj && dbj) return { result: 'push', payout: bet };
  if (pbj) return { result: 'blackjack', payout: bet + Math.floor(bet * 3 / 2) };
  if (dbj) return { result: 'lose', payout: 0 };
  if (dv > 21) return { result: 'win', payout: bet * 2 };
  if (pv > dv) return { result: 'win', payout: bet * 2 };
  if (pv < dv) return { result: 'lose', payout: 0 };
  return { result: 'push', payout: bet };
}

/* ---------------------------------------------------------------- slot */
// Same strip on all three reels (16 stops). Symbols are item icons from the sprite sheet.
var SYMBOLS = ['apel', 'permen', 'bunga', 'koin', 'dadu'];
var SYMNAME = { apel: 'Apel', permen: 'Permen', bunga: 'Bunga', koin: 'Koin', dadu: 'Dadu' };
var REEL = { apel: 6, permen: 4, bunga: 3, koin: 2, dadu: 1 };
var STRIP = []; SYMBOLS.forEach(function(s){ for (var i = 0; i < REEL[s]; i++) STRIP.push(s); });
// multiplier = coins returned per coin bet (stake included)
var PAYTABLE = { dadu: 100, koin: 40, bunga: 20, permen: 8, apel: 6 };
var TWO_APEL = 1;                              // exactly two apel anywhere: stake back
function spinSlot(){ return [STRIP[rint(STRIP.length)], STRIP[rint(STRIP.length)], STRIP[rint(STRIP.length)]]; }
function slotMult(s){
  if (s[0] === s[1] && s[1] === s[2]) return PAYTABLE[s[0]] || 0;
  var ap = s.filter(function(x){ return x === 'apel'; }).length;
  return ap === 2 ? TWO_APEL : 0;
}
function slotPayout(s, bet){ return slotMult(s) * bet; }
function slotRtp(){                            // exact enumeration of all 16^3 stop combinations
  var n = STRIP.length, sum = 0;
  for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) for (var c = 0; c < n; c++) sum += slotMult([STRIP[a], STRIP[b], STRIP[c]]);
  return sum / (n * n * n);
}

/* ---------------------------------------------------------------- bookkeeping */
var stats = { games: 0, loseStreak: 0, won: 0, lost: 0 };
var BANDAR_WIN = ['Hoki juga kamu hari ini.', 'Selamat! Jangan lupa istirahat.', 'Wah, kali ini kamu yang menang.'];
var BANDAR_LOSE = ['Belum rezekimu. Coba lagi kalau mau.', 'Kali ini aku yang beruntung.', 'Tenang, ini cuma permainan.'];
function pick(a){ return a[rint(a.length)]; }
function dealerNpc(){ try { return GT.findNpc('casino:dealer'); } catch(e){ return null; } }
function say(text){ var d = dealerNpc(); if (d) { try { GT.npcSay(d, text); } catch(e){} } }
// bet = stake, payout = coins returned. Returns 'win' | 'push' | 'lose' plus an optional streak note.
function record(bet, payout){
  var cat = payout > bet ? 'win' : payout === bet ? 'push' : 'lose', note = '';
  try { if (window.GT_SFX) GT_SFX.play(cat === 'win' ? 'win' : cat === 'lose' ? 'lose' : 'ui_click'); } catch(e){}
  stats.games++;
  try { GT.addAffinity(dealerNpc(), 1); } catch(e){}
  if (cat === 'win'){ stats.loseStreak = 0; stats.won += payout - bet; say(pick(BANDAR_WIN)); }
  else if (cat === 'lose'){
    stats.loseStreak++; stats.lost += bet; say(pick(BANDAR_LOSE));
    if (stats.loseStreak === 3 || (stats.loseStreak > 3 && stats.loseStreak % 2 === 1)){
      note = stats.loseStreak >= 5 ? 'Kalah ' + stats.loseStreak + ' kali beruntun. Istirahat dulu, ya. Ini cuma permainan.'
        : 'Kalah 3 kali beruntun. Tarik napas dulu, jangan dikejar.';
      say(note);
    }
  }
  return { cat: cat, note: note };
}
function stake(bet){
  bet = Math.floor(+bet);
  if (!isFinite(bet) || bet < MIN_BET || bet > GT.state.coins) return false;
  return GT.spendCoins(bet) === true;
}
function pay(n){ if (n > 0) GT.addCoins(n); }
function reduced(){ try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch(e){ return false; } }

/* ---------------------------------------------------------------- UI helpers */
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
var styled = false;
function ensureStyle(){
  if (styled) return; styled = true;
  var s = document.createElement('style');
  s.textContent = [
    '.cz-felt{background:#1f6b38;border:3px solid #123d20;border-radius:6px;padding:10px 6px;margin:0 0 8px;color:#f4f1dc;text-align:center;box-shadow:inset 0 0 0 2px rgba(255,255,255,.08)}',
    '.cz-felt h3{margin:0 0 6px;font-size:8px;font-weight:400;color:#cfe8c0}',
    '.cz-row{display:flex;justify-content:center;gap:5px;flex-wrap:wrap;min-height:58px;align-items:center;margin-bottom:6px}',
    '.cz-sum{font-size:9px;margin:2px 0 8px;min-height:14px}',
    '.cz-die{width:46px;height:46px;background:#fafafe;border:2px solid #1b1d33;border-radius:8px;display:grid;grid-template:repeat(3,1fr)/repeat(3,1fr);padding:5px;box-shadow:inset 0 -3px 0 #c0c8e0}',
    '.cz-pip{width:8px;height:8px;border-radius:50%;place-self:center;background:transparent}',
    '.cz-pip.on{background:#1b1d33}',
    '.cz-die.roll{animation:czshake .18s linear infinite}',
    '@keyframes czshake{0%{transform:rotate(-8deg) translateY(0)}50%{transform:rotate(8deg) translateY(-3px)}100%{transform:rotate(-8deg) translateY(0)}}',
    '.cz-card{position:relative;width:42px;height:58px;background:#fafafe;color:#1b1d33;border:2px solid #1b1d33;border-radius:5px;box-shadow:inset 0 -3px 0 #c0c8e0;font-size:9px;line-height:1;text-align:left;flex:none}',
    '.cz-card.red{color:#c0392b}',
    '.cz-card .tl{position:absolute;left:3px;top:4px;line-height:1.1}',
    '.cz-card .ct{position:absolute;left:0;right:0;bottom:6px;text-align:center;font-size:18px;font-family:system-ui,sans-serif}',
    '.cz-card.down{background:repeating-linear-gradient(45deg,#9c2f55 0 4px,#7d2433 4px 8px);border-color:#f4f1dc}',
    '.cz-card.down .tl,.cz-card.down .ct{display:none}',
    '.cz-reels{display:flex;justify-content:center;gap:8px;margin-bottom:6px}',
    '.cz-reel{width:58px;height:58px;background:#fafafe;border:3px solid #1b1d33;border-radius:6px;display:flex;align-items:center;justify-content:center;box-shadow:inset 0 3px 0 #c0c8e0}',
    '.cz-reel canvas{width:40px;height:40px;image-rendering:pixelated}',
    '.cz-reel.spin{background:#e4e8f4}',
    '.cz-bets{display:flex;gap:6px;margin:0 0 8px}',
    '.cz-bets .mbtn{flex:1 1 0;min-width:0;padding:7px 2px;text-align:center}',
    '.cz-bets .mbtn.sel{background:var(--btn,#9c2f55);color:#fff;outline:3px solid var(--gold,#f2c94c);outline-offset:-3px}',
    '.cz-msg{min-height:28px;margin:0 0 6px;padding:6px 8px;border-radius:4px;background:#e7e3cc;border:2px dotted var(--paper-edge,#b9b393)}',
    '.cz-msg.win{background:#d7ecd0;color:#1d4a26}.cz-msg.lose{background:#f1d5d8;color:#6e1f2a}.cz-msg.push{background:#e4e8f4}',
    '.cz-rule{margin:0 0 8px;color:#4a4d75}',
    '.cz-pay .mrow{padding:3px 0;gap:6px}.cz-pay .mrow canvas{width:16px;height:16px}',
    '.cz-pay .tri{display:flex;gap:1px;flex:1}.cz-pay .num{color:#1b1d33}',
    '.cz-legal{margin:8px 0 0;font-size:8px;color:#4a4d75}',
    '@media (max-width:380px){.cz-die{width:42px;height:42px;padding:4px}.cz-card{width:38px;height:54px}.cz-reel{width:54px;height:54px}.cz-felt{padding:8px 4px}}',
    '@media (prefers-reduced-motion:reduce){.cz-die.roll{animation:none}}'
  ].join('\n');
  document.head.appendChild(s);
}
function icon(id, size){ try { return GT.iconEl(id, size); } catch(e){ return el('span', null, id); } }

function dieEl(v, rolling){
  var d = el('div', 'cz-die' + (rolling ? ' roll' : '')), pats = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  d.setAttribute('role', 'img'); d.setAttribute('aria-label', 'Dadu ' + v);
  var on = pats[v] || [];
  for (var i = 0; i < 9; i++) d.appendChild(el('span', 'cz-pip' + (on.indexOf(i) >= 0 ? ' on' : '')));
  return d;
}
function cardEl(c, down){
  var e = el('div', 'cz-card' + (down ? ' down' : '') + (!down && (c.s === 1 || c.s === 2) ? ' red' : ''));
  if (down){ e.setAttribute('aria-label', 'Kartu tertutup'); return e; }
  var name = RANKS[c.r - 1] + SUITS[c.s];
  e.setAttribute('role', 'img'); e.setAttribute('aria-label', 'Kartu ' + name);
  e.appendChild(el('div', 'tl', RANKS[c.r - 1])); e.appendChild(el('div', 'ct', SUITS[c.s]));
  return e;
}

/* shell shared by the three games: money line, felt, message, bet chips, footer actions */
function makeShell(title, onClose){
  ensureStyle();
  var sh = { timers: [], intervals: [], bet: MIN_BET, locked: false, closed: false };
  var body = el('div'), money = el('div', 'mmoney'), felt = el('div', 'cz-felt'), msg = el('p', 'cz-msg'), bets = el('div', 'cz-bets');
  msg.setAttribute('aria-live', 'polite');
  sh.money = money; sh.felt = felt; sh.msg = msg; sh.betsEl = bets; sh.chips = [];
  BETS.forEach(function(b){
    var x = el('button', 'mbtn', String(b)); x.type = 'button'; x.setAttribute('data-bet', b);
    x.addEventListener('click', function(){ if (!x.disabled && !sh.locked){ sh.bet = b; sh.refresh(); } });
    bets.appendChild(x); sh.chips.push(x);
  });
  body.appendChild(money); body.appendChild(felt); body.appendChild(msg);
  var lbl = el('p', 'mnote', 'Taruhan (koin permainan):'); lbl.style.margin = '0 0 4px'; sh.betLabel = lbl;
  body.appendChild(lbl); body.appendChild(bets);
  sh.body = body;
  sh.refresh = function(){
    var c = GT.state.coins;
    if (sh.bet > c || sh.bet < MIN_BET){
      sh.bet = 0; BETS.forEach(function(b){ if (b <= c && (sh.bet === 0 || b > sh.bet)) sh.bet = b; });
      if (sh.bet === 0) sh.bet = 0;
    }
    money.textContent = '';
    money.appendChild(icon('koin', 16)); money.firstChild.style.verticalAlign = 'middle';
    money.appendChild(document.createTextNode(' Koin: ' + c));
    sh.chips.forEach(function(x){
      var b = +x.getAttribute('data-bet');
      x.disabled = sh.locked || b > c;
      x.classList.toggle('sel', b === sh.bet);
      x.setAttribute('aria-pressed', b === sh.bet ? 'true' : 'false');
    });
    if (sh.onRefresh) sh.onRefresh();
  };
  sh.canPlay = function(){ return !sh.locked && sh.bet >= MIN_BET && sh.bet <= GT.state.coins; };
  sh.say = function(text, cls){ msg.textContent = text; msg.className = 'cz-msg' + (cls ? ' ' + cls : ''); };
  sh.later = function(fn, ms){ var t = setTimeout(function(){ if (!sh.closed) fn(); }, ms); sh.timers.push(t); return t; };
  sh.tick = function(fn, ms){ var t = setInterval(function(){ if (!sh.closed) fn(); }, ms); sh.intervals.push(t); return t; };
  sh.clear = function(){ sh.timers.forEach(clearTimeout); sh.intervals.forEach(clearInterval); sh.timers = []; sh.intervals = []; };
  sh.acts = function(list){
    sh.h.setActions(list);
    var p = sh.h.foot.querySelector('.primary:not([disabled])') || sh.h.foot.querySelector('button:not([disabled])');
    if (p){ try { p.focus({ preventScroll: true }); } catch(e){} }
  };
  sh.click = function(id){ var b = sh.h.btn(id); if (b && !b.disabled){ b.click(); return true; } return false; };
  sh.h = GT.modal({
    title: title, body: body, actions: [],
    onKey: function(e){
      if (e.ctrlKey || e.metaKey || e.altKey || !sh.keys) return false;
      var id = sh.keys[String(e.key).toLowerCase()];
      return id ? sh.click(id) : false;
    },
    onClose: function(reason){ sh.closed = true; sh.clear(); if (onClose) onClose(reason); }
  });
  return sh;
}
function resultText(cat, bet, payout, extra){
  if (cat === 'win') return (extra || 'Menang!') + ' +' + (payout - bet) + ' koin.';
  if (cat === 'push') return (extra || 'Seri.') + ' Taruhan kembali.';
  return (extra || 'Kalah.') + ' -' + bet + ' koin.';
}

/* ---------------------------------------------------------------- Dadu */
function openDice(){
  var sh = makeShell('Dadu Besar / Kecil', null), dice = [1, 1, 1];
  var rule = el('p', 'cz-rule', 'Tiga dadu. Besar = jumlah 11-17, Kecil = 4-10. Triple (tiga dadu kembar) = Bandar menang. Bayaran 1:1.');
  sh.body.insertBefore(rule, sh.body.firstChild);
  var row = el('div', 'cz-row'), sum = el('div', 'cz-sum');
  var h3 = el('h3', null, 'DADU'); sh.felt.appendChild(h3); sh.felt.appendChild(row); sh.felt.appendChild(sum);
  sh.keys = { b: 'besar', k: 'kecil', m: 'lagi' };
  function drawDice(vals, rolling){ row.textContent = ''; vals.forEach(function(v){ row.appendChild(dieEl(v, rolling)); }); }
  function betPhase(first){
    sh.locked = false; sh.refresh();
    if (!first) sum.textContent = '';
    sh.say(sh.canPlay() ? 'Pilih taruhan, lalu Besar atau Kecil.' : 'Koinmu kurang dari ' + MIN_BET + '. Tidak bisa bertaruh.', '');
    sh.acts([
      { id: 'besar', label: 'Besar (11-17)', primary: true, disabled: !sh.canPlay(), onClick: function(){ play('besar'); } },
      { id: 'kecil', label: 'Kecil (4-10)', primary: true, disabled: !sh.canPlay(), onClick: function(){ play('kecil'); } },
      { id: 'tutup', label: 'Selesai' }
    ]);
  }
  sh.onRefresh = function(){
    ['besar', 'kecil'].forEach(function(id){ var b = sh.h.btn(id); if (b) b.disabled = !sh.canPlay(); });
  };
  function play(side){
    if (!sh.canPlay()) return;
    var bet = sh.bet;
    if (!stake(bet)) { sh.refresh(); return; }
    var vals = rollDice(), o = diceOutcome(vals, side, bet);
    pay(o.payout);                                    // settle first; the animation below is cosmetic
    var rec = record(bet, o.payout);
    sh.locked = true; sh.refresh();
    sh.acts([{ id: 'tutup', label: 'Selesai' }]);
    var label = side === 'besar' ? 'Besar' : 'Kecil';
    var txt = (o.triple ? 'Triple! Bandar menang. ' : 'Jumlah ' + o.total + ' (' + (o.total >= 11 ? 'Besar' : 'Kecil') + '). ') + resultText(rec.cat, bet, o.payout, o.win ? 'Kamu menang (' + label + ').' : 'Kamu kalah (' + label + ').');
    if (rec.note) txt += ' ' + rec.note;
    function reveal(){
      drawDice(vals, false); sum.textContent = 'Jumlah: ' + o.total + (o.triple ? ' - TRIPLE' : '');
      sh.say(txt, rec.cat);
      sh.locked = false; sh.refresh();
      sh.acts([{ id: 'lagi', label: 'Main lagi (M)', primary: true, disabled: !sh.canPlay(), onClick: function(){ betPhase(false); } }, { id: 'tutup', label: 'Selesai' }]);
      if (sh.closed) toast2(txt);
    }
    if (reduced()){ reveal(); return; }
    sum.textContent = ''; sh.say('Dadu berputar...', '');
    var n = 0;
    drawDice([1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)], true);
    sh.tick(function(){
      n++; drawDice([1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)], true);
      if (n >= 8){ sh.clear(); reveal(); }
    }, 90);
  }
  drawDice(dice, false);
  betPhase(true);
  return sh;
}
function toast2(t){ try { GT.toast(t); } catch(e){} }

/* ---------------------------------------------------------------- Blackjack */
function openBlackjack(){
  var phase = 'bet', deck = [], player = [], dealer = [], bet = 0;
  var sh = makeShell('Blackjack', function(){ if (phase === 'play') finishHand(true); });
  var rule = el('p', 'cz-rule', 'Dekati 21 tanpa lewat. Bandar menarik kartu sampai 17. Blackjack bayar 3:2, seri = taruhan kembali.');
  sh.body.insertBefore(rule, sh.body.firstChild);
  var dTitle = el('h3', null, 'BANDAR'), dRow = el('div', 'cz-row'), dSum = el('div', 'cz-sum');
  var pTitle = el('h3', null, 'KAMU'), pRow = el('div', 'cz-row'), pSum = el('div', 'cz-sum');
  [dTitle, dRow, dSum, pTitle, pRow, pSum].forEach(function(n){ sh.felt.appendChild(n); });
  sh.keys = { h: 'hit', s: 'stand', m: 'lagi', d: 'deal' };
  function draw(){ if (!deck.length) deck = newDeck(); return deck.pop(); }
  function render(hideHole){
    dRow.textContent = ''; pRow.textContent = '';
    dealer.forEach(function(c, i){ dRow.appendChild(cardEl(c, hideHole && i === 1)); });
    player.forEach(function(c){ pRow.appendChild(cardEl(c, false)); });
    if (!dealer.length){ dSum.textContent = ''; pSum.textContent = ''; return; }
    dSum.textContent = hideHole ? 'Terlihat: ' + handValue([dealer[0]]).total : 'Total: ' + handValue(dealer).total;
    pSum.textContent = 'Total: ' + handValue(player).total;
  }
  function betPhase(){
    phase = 'bet'; sh.locked = false; sh.refresh();
    sh.say(sh.canPlay() ? 'Pilih taruhan lalu bagi kartu.' : 'Koinmu kurang dari ' + MIN_BET + '. Tidak bisa bertaruh.', '');
    sh.acts([
      { id: 'deal', label: 'Bagi kartu (D)', primary: true, disabled: !sh.canPlay(), onClick: deal },
      { id: 'tutup', label: 'Selesai' }
    ]);
  }
  sh.onRefresh = function(){ var b = sh.h.btn('deal'); if (b && phase === 'bet') b.disabled = !sh.canPlay(); };
  function deal(){
    if (phase !== 'bet' || !sh.canPlay()) return;
    bet = sh.bet;
    if (!stake(bet)){ sh.refresh(); return; }
    deck = newDeck(); player = []; dealer = [];
    player.push(draw()); dealer.push(draw()); player.push(draw()); dealer.push(draw());
    phase = 'play'; sh.locked = true; sh.refresh();
    if (isBlackjack(player) || isBlackjack(dealer)){ finishHand(false); return; }
    render(true);
    sh.say('Giliranmu: Tambah atau Cukup?', '');
    sh.acts([
      { id: 'hit', label: 'Tambah (H)', primary: true, onClick: hit },
      { id: 'stand', label: 'Cukup (S)', onClick: function(){ finishHand(false); } }
    ]);
  }
  function hit(){
    if (phase !== 'play') return;
    player.push(draw());
    var v = handValue(player).total;
    if (v >= 21){ finishHand(false); return; }
    render(true);
  }
  function finishHand(silent){
    if (phase !== 'play') return;
    phase = 'done';
    var pv = handValue(player).total;
    if (pv <= 21 && !isBlackjack(player) && !isBlackjack(dealer)) dealerPlay(dealer, deck);
    var o = bjSettle(player, dealer, bet);
    pay(o.payout);
    var rec = record(bet, o.payout);
    var extra = o.result === 'blackjack' ? 'BLACKJACK!' : o.bust ? 'Lewat 21 (bust).' : o.result === 'win' ? (handValue(dealer).total > 21 ? 'Bandar lewat 21.' : 'Kamu menang.') :
      o.result === 'push' ? (isBlackjack(dealer) && isBlackjack(player) ? 'Sama-sama blackjack.' : 'Seri.') : (isBlackjack(dealer) ? 'Bandar blackjack.' : 'Bandar menang.');
    var txt = resultText(rec.cat, bet, o.payout, extra);
    if (rec.note) txt += ' ' + rec.note;
    if (silent || sh.closed){ toast2('Blackjack: ' + txt); return; }
    render(false);
    sh.locked = false; sh.refresh();
    sh.say(txt, rec.cat);
    sh.acts([{ id: 'lagi', label: 'Main lagi (M)', primary: true, disabled: !sh.canPlay(), onClick: betPhase }, { id: 'tutup', label: 'Selesai' }]);
  }
  betPhase();
  return sh;
}

/* ---------------------------------------------------------------- Slot */
function openSlot(){
  var sh = makeShell('Mesin Slot', null), cells = [], cur = ['apel', 'permen', 'bunga'];
  var rule = el('p', 'cz-rule', 'Tiga gulungan. Cocokkan 3 simbol untuk menang.');
  sh.body.insertBefore(rule, sh.body.firstChild);
  var reels = el('div', 'cz-reels');
  for (var i = 0; i < 3; i++){ var c = el('div', 'cz-reel'); cells.push(c); reels.appendChild(c); }
  sh.felt.appendChild(reels);
  var pay2 = el('div', 'cz-pay');
  SYMBOLS.slice().reverse().forEach(function(s){
    var r = el('div', 'mrow'), tri = el('span', 'tri');
    for (var k = 0; k < 3; k++) tri.appendChild(icon(s, 16));
    r.appendChild(tri); r.appendChild(el('span', 'grow', SYMNAME[s]));
    r.appendChild(el('span', 'num', 'x' + PAYTABLE[s])); pay2.appendChild(r);
  });
  var r2 = el('div', 'mrow'), tri2 = el('span', 'tri');
  tri2.appendChild(icon('apel', 16)); tri2.appendChild(icon('apel', 16));
  r2.appendChild(tri2); r2.appendChild(el('span', 'grow', '2 apel (di mana saja)')); r2.appendChild(el('span', 'num', 'x' + TWO_APEL)); pay2.appendChild(r2);
  var rtp = el('p', 'cz-legal', 'Total bayaran x taruhan (modal ikut kembali). Peluang kembali jangka panjang sekitar ' + (slotRtp() * 100).toFixed(1).replace('.', ',') + '%, jadi rumah menang dalam jangka panjang.');
  sh.body.appendChild(el('p', 'mnote', 'Tabel bayaran')); sh.body.appendChild(pay2); sh.body.appendChild(rtp);
  sh.keys = { p: 'putar', m: 'putar' };
  function show(i, id, spin){ cells[i].textContent = ''; cells[i].appendChild(icon(id, 32)); cells[i].classList.toggle('spin', !!spin); cells[i].setAttribute('aria-label', SYMNAME[id]); }
  function showAll(syms){ for (var i = 0; i < 3; i++) show(i, syms[i], false); }
  function idle(first){
    sh.locked = false; sh.refresh();
    if (!first || true) sh.say(sh.canPlay() ? 'Pilih taruhan lalu putar.' : 'Koinmu kurang dari ' + MIN_BET + '. Tidak bisa bertaruh.', '');
    sh.acts([{ id: 'putar', label: 'Putar (P)', primary: true, disabled: !sh.canPlay(), onClick: spin }, { id: 'tutup', label: 'Selesai' }]);
  }
  sh.onRefresh = function(){ var b = sh.h.btn('putar'); if (b && !sh.locked) b.disabled = !sh.canPlay(); };
  function spin(){
    if (!sh.canPlay()) return;
    var bet = sh.bet;
    if (!stake(bet)){ sh.refresh(); return; }
    var res = spinSlot(), mult = slotMult(res), payout = mult * bet;
    pay(payout);                                     // settled up front; animation is cosmetic
    var rec = record(bet, payout);
    sh.locked = true; sh.refresh(); sh.acts([{ id: 'tutup', label: 'Selesai' }]);
    var combo = res.map(function(s){ return SYMNAME[s]; }).join(' - ');
    var txt = combo + '. ' + (mult === 0 ? resultText('lose', bet, payout) : payout === bet ? resultText('push', bet, payout, '2 apel.') : resultText('win', bet, payout, 'Kena x' + mult + '!'));
    if (rec.note) txt += ' ' + rec.note;
    function done(){
      showAll(res); sh.locked = false; sh.refresh(); sh.say(txt, rec.cat);
      sh.acts([{ id: 'putar', label: 'Putar lagi (P)', primary: true, disabled: !sh.canPlay(), onClick: spin }, { id: 'tutup', label: 'Selesai' }]);
      if (sh.closed) toast2(txt);
    }
    if (reduced()){ done(); return; }
    sh.say('Berputar...', '');
    var stopped = [false, false, false];
    function tickReels(){ for (var i = 0; i < 3; i++) if (!stopped[i]) show(i, SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)], true); }
    tickReels(); sh.tick(tickReels, 70);
    [0, 1, 2].forEach(function(i){
      sh.later(function(){
        stopped[i] = true; show(i, res[i], false);
        if (i === 2){ sh.clear(); done(); }
      }, 500 + i * 350);
    });
  }
  showAll(cur);
  idle(true);
  return sh;
}

/* ---------------------------------------------------------------- menu / interaction */
var openGame = null;
function open(kind){
  if (openGame && openGame.h && openGame.h.isOpen()) return openGame;
  if (kind === 'dadu') openGame = openDice();
  else if (kind === 'blackjack') openGame = openBlackjack();
  else if (kind === 'slot') openGame = openSlot();
  else openGame = null;
  return openGame;
}
function openMenu(){
  GT.menu('Rumah Judi', [
    { label: 'Dadu Besar/Kecil', onPick: function(){ open('dadu'); } },
    { label: 'Blackjack', onPick: function(){ open('blackjack'); } },
    { label: 'Mesin slot', onPick: function(){ open('slot'); } },
    { label: 'Tidak jadi' }
  ]);
}
var TABLES = { card_table: 1, dice_table: 1, slot: 1 };
function onInteract(ctx){
  if (!ctx || !ctx.scene || ctx.scene.kind !== 'casino') return false;
  if (ctx.mode === 'bump') return false;
  var isDealer = !!(ctx.npc && ctx.npc.key === 'casino:dealer');
  if (!isDealer && !TABLES[ctx.tileType]) return false;
  if (isDealer && ctx.mode === 'message' && GT.soul && typeof GT.soul.hasSoul === 'function' && GT.soul.hasSoul('casino:dealer')) return false;
  if (isDealer && ctx.mode === 'talk'){
    GT.dialog(['Selamat datang di Rumah Judi! Aku Bandar.', RESP_LINE + ' Main secukupnya, ya.'], 'Bandar', ctx.npc, openMenu);
    return true;
  }
  openMenu();
  return true;
}
function onSceneEnter(sc){
  if (sc && sc.kind === 'casino') toast2(RESP_LINE);
}

GT.casino = {
  MIN_BET: MIN_BET, BETS: BETS.slice(), PAYTABLE: PAYTABLE, TWO_APEL: TWO_APEL, REEL: REEL, SYMBOLS: SYMBOLS.slice(), STRIP: STRIP.slice(),
  rollDice: rollDice, diceOutcome: diceOutcome,
  newDeck: newDeck, handValue: handValue, isBlackjack: isBlackjack, dealerPlay: dealerPlay, bjSettle: bjSettle,
  spinSlot: spinSlot, slotMult: slotMult, slotPayout: slotPayout, slotRtp: slotRtp,
  open: open, openMenu: openMenu, stats: function(){ return { games: stats.games, loseStreak: stats.loseStreak, won: stats.won, lost: stats.lost }; },
  current: function(){ return openGame; },
  _setRng: function(fn){ rng = typeof fn === 'function' ? fn : Math.random; },
  _resetStats: function(){ stats.games = 0; stats.loseStreak = 0; stats.won = 0; stats.lost = 0; }
};
GT.register({ id: 'casino', onInteract: onInteract, onSceneEnter: onSceneEnter });
})();

