/* i18n.js - tiny translation layer for Genesis Town (loaded first, before every other script).
 *
 * Scheme: the game's source text is Bahasa Indonesia, and that text is the KEY. $t('Tas') returns 'Bag' in English
 * (the default) and 'Tas' in Indonesian. English entries live in js/lang/en.js (GT_I18N.add). Placeholders are {0}, {1}
 * (array) or {name} (object): $t('Koin: {0}', [5]) -> 'Coins: 5'. A key with no English entry falls back to the
 * Indonesian text (and warns once on localhost, so gaps are easy to find).
 *
 * Language: window.GT_LANG = 'en' | 'id'. Saved in localStorage 'gt.lang'; ?lang=id|en overrides it for one visit.
 * GT_I18N.setLang('id') saves the choice and reloads the page (the settings menu uses it).
 * Names that come from the economy config / server have an Indonesian twin: GT_I18N.nm(obj) picks obj.nameId in 'id'.
 * Static HTML text (index.html) is translated by GT_I18N.dom(): every text node and aria-label/title/placeholder is
 * looked up by its trimmed Indonesian text. Keep this file free of game logic.
 */
(function () {
  'use strict';
  var lang = 'en';
  try { var saved = localStorage.getItem('gt.lang'); if (saved === 'id' || saved === 'en') lang = saved; } catch (e) { /* storage blocked: default */ }
  try { var q = new URLSearchParams(location.search).get('lang'); if (q === 'id' || q === 'en') lang = q; } catch (e) { /* ignore */ }
  var dict = {};
  var warned = {};
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
  function add(map) { for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) dict[k] = map[k]; }
  function setLang(l) {
    if (l !== 'en' && l !== 'id') return;
    try { localStorage.setItem('gt.lang', l); } catch (e) { /* ignore */ }
    var u = new URL(location.href); u.searchParams.delete('lang');
    location.href = u.toString();
  }
  /** Display name of a config entry ({name, nameId}). */
  function nm(o) { return !o ? '' : (lang === 'id' && o.nameId ? o.nameId : (o.name || '')); }

  function domText(root) {
    if (lang !== 'en') return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = w.nextNode())) nodes.push(n);
    nodes.forEach(function (tn) {
      var p = tn.parentNode;
      if (p && (p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE')) return;
      var raw = tn.nodeValue, trimmed = raw.trim();
      if (!trimmed) return;
      var e = dict[trimmed];
      if (e !== undefined) tn.nodeValue = raw.replace(trimmed, e);
    });
    root.querySelectorAll('[aria-label],[title],[placeholder]').forEach(function (el) {
      ['aria-label', 'title', 'placeholder'].forEach(function (a) {
        var v = el.getAttribute(a); if (v && dict[v] !== undefined) el.setAttribute(a, dict[v]);
      });
    });
  }
  function dom(root) { try { domText(root || document.body); } catch (e) { /* never break the page */ } }

  window.GT_LANG = lang;
  window.GT_I18N = { lang: lang, t: tr, add: add, setLang: setLang, nm: nm, dom: dom, dict: dict };
  window.$t = tr;
  try { document.documentElement.lang = lang; } catch (e) { /* ignore */ }
})();
