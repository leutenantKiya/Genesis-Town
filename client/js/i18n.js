/* i18n.js - tiny translation layer for Genesis Town (loaded first, before every other script).
 *
 * Scheme: the game's source text is Bahasa Indonesia, and that text is the KEY. $t('Tas') returns 'Bag' in English
 * (the default) and 'Tas' in Indonesian. English entries live in js/lang/en.js (GT_I18N.add). Placeholders are {0}, {1}
 * (array) or {name} (object): $t('Koin: {0}', [5]) -> 'Coins: 5'. A key with no English entry falls back to the
 * Indonesian text (and warns once on localhost, so gaps are easy to find).
 *
 * Language: window.GT_LANG = 'en' | 'id'. Saved in localStorage 'gt.lang'; ?lang=id|en overrides it for one visit.
 * GT_I18N.setLang('id') switches LIVE, with no reload: it saves the choice, updates <html lang>, re-translates the
 * fixed text that is on screen (every text node, aria-label, title and placeholder whose whole text is a known phrase,
 * in either direction) and then calls the GT_I18N.onChange(fn) listeners so mods can re-render what they built from
 * $t() with values (open windows, banners, the hotbar). Things computed once at start (villager names, building
 * names of the generated village) keep the old language until the next visit.
 * Static HTML text (index.html) is translated by GT_I18N.dom() at start. Keep this file free of game logic.
 */
(function () {
  'use strict';
  var lang = 'en';
  try { var saved = localStorage.getItem('gt.lang'); if (saved === 'id' || saved === 'en') lang = saved; } catch (e) { /* storage blocked: default */ }
  try { var q = new URLSearchParams(location.search).get('lang'); if (q === 'id' || q === 'en') lang = q; } catch (e) { /* ignore */ }
  var dict = {};
  var rev = null; // English text -> Indonesian key, built when first needed
  var warned = {};
  var listeners = [];
  var devHost = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/.test(location.hostname);

  function fmt(s, vars) {
    if (vars == null) return s;
    return s.replace(/\{(\w+)\}/g, function (m, k) { var v = vars[k]; return v == null ? m : String(v); });
  }
  function tr(key, vars) {
    var s = key;
    if (lang === 'en') {
      var e = dict[key];
      if (e !== undefined) s = e;
      else if (devHost && !warned[key] && /[A-Za-z]{3}/.test(key)) { warned[key] = 1; try { console.warn('[i18n] no English for: ' + key); } catch (x) { /* ignore */ } }
    }
    return vars == null ? s : fmt(s, vars);
  }
  function add(map) { for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) dict[k] = map[k]; rev = null; }
  function reverse() {
    if (rev) return rev;
    rev = {};
    for (var k in dict) if (Object.prototype.hasOwnProperty.call(dict, k) && !Object.prototype.hasOwnProperty.call(rev, dict[k])) rev[dict[k]] = k;
    return rev;
  }
  /** Display name of a config entry ({name, nameId}). */
  function nm(o) { return !o ? '' : (lang === 'id' && o.nameId ? o.nameId : (o.name || '')); }

  // the phrase this exact text becomes in the current language, or undefined
  function convert(text) {
    if (lang === 'en') return dict[text];
    return reverse()[text];
  }
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, CANVAS: 1 };
  function skipped(el) {
    for (; el && el.nodeType === 1; el = el.parentNode) {
      if (SKIP_TAGS[el.nodeName]) return true;
      var c = el.className; if (typeof c === 'string' && c.indexOf('chat') !== -1) return true; // what players typed
    }
    return false;
  }
  function sweep(root) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = w.nextNode())) nodes.push(n);
    nodes.forEach(function (tn) {
      var raw = tn.nodeValue, trimmed = raw.trim();
      if (!trimmed || skipped(tn.parentNode)) return;
      var e = convert(trimmed);
      if (e !== undefined) tn.nodeValue = raw.replace(trimmed, e);
    });
    root.querySelectorAll('[aria-label],[title],[placeholder]').forEach(function (el) {
      ['aria-label', 'title', 'placeholder'].forEach(function (a) {
        var v = el.getAttribute(a); if (!v) return;
        var e = convert(v); if (e !== undefined) el.setAttribute(a, e);
      });
    });
  }
  function dom(root) { try { if (lang === 'en') sweep(root || document.body); } catch (e) { /* never break the page */ } }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function setLang(l) {
    if ((l !== 'en' && l !== 'id') || l === lang) return;
    lang = l;
    window.GT_LANG = l; if (window.GT_I18N) window.GT_I18N.lang = l;
    try { localStorage.setItem('gt.lang', l); } catch (e) { /* ignore */ }
    try { document.documentElement.lang = l; } catch (e) { /* ignore */ }
    listeners.forEach(function (fn) { try { fn(l); } catch (e) { try { console.error(e); } catch (x) { /* ignore */ } } });
    try { sweep(document.body); } catch (e) { /* never break the page */ } // after the listeners: catches text they left in the old language
    try { window.dispatchEvent(new CustomEvent('gt:lang', { detail: l })); } catch (e) { /* ignore */ }
  }

  window.GT_LANG = lang;
  window.GT_I18N = { lang: lang, t: tr, add: add, setLang: setLang, onChange: onChange, nm: nm, dom: dom, dict: dict };
  window.$t = tr;
  try { document.documentElement.lang = lang; } catch (e) { /* ignore */ }
})();
