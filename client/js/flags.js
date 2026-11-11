/* flags.js - feature flags for Genesis Town.
 * The submission build focuses on the economy, so these prototype mods are OFF by default (their code is kept):
 * casino, combat, thief, police, curfew, gossip, social.
 * Turn some back on for local play with ?flags=casino,combat or the Dev panel (stored in localStorage 'gt.flags').
 * Both only work on localhost: a deployed game always runs the defaults. GT_DEV_HOST says which one this is.
 * The casino only ever used valueless play coins; it never touches on-chain balances.
 */
(function () {
  'use strict';
  var defaults = { casino: false, combat: false, thief: false, police: false, curfew: false, gossip: false, social: false };
  var flags = Object.assign({}, defaults);
  var devHost = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/.test(location.hostname);
  window.GT_DEV_HOST = devHost;
  if (!devHost) { window.GT_FLAGS = flags; return; }
  try {
    var saved = JSON.parse(localStorage.getItem('gt.flags') || '{}');
    Object.keys(defaults).forEach(function (k) { if (typeof saved[k] === 'boolean') flags[k] = saved[k]; });
  } catch (e) { /* storage unavailable: use defaults */ }
  try {
    var q = new URLSearchParams(location.search).get('flags');
    if (q) q.split(',').forEach(function (k) { k = k.trim(); if (k in defaults) flags[k] = true; });
  } catch (e) { /* ignore */ }
  window.GT_FLAGS = flags;
})();
