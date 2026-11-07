/* pwa.js - registers the service worker and exposes install state as window.GT_PWA. Add ?nosw to skip the worker. */
(function () {
  'use strict';
  var deferred = null;
  var standaloneQuery = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : null;
  var fullscreenQuery = window.matchMedia ? window.matchMedia('(display-mode: fullscreen)') : null;

  if ('serviceWorker' in navigator && !/[?&]nosw\b/.test(location.search)) {
    window.addEventListener('load', function () {
      // check for a newer worker on every load; when a new one takes over, reload once so the page runs the new code
      navigator.serviceWorker.register('/sw.js').then(function (reg) { reg.update().catch(function () {}); }).catch(function () { /* no worker: the game still runs */ });
    });
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloaded) { hadController = true; return; }
      reloaded = true; location.reload();
    });
  }

  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; });
  window.addEventListener('appinstalled', function () { deferred = null; });

  window.GT_PWA = {
    canInstall: function () { return !!deferred; },
    install: function () {
      if (!deferred) return Promise.resolve(false);
      var d = deferred; deferred = null;
      d.prompt();
      return d.userChoice.then(function (c) { return c && c.outcome === 'accepted'; }, function () { return false; });
    },
    standalone: function () {
      return !!((standaloneQuery && standaloneQuery.matches) || (fullscreenQuery && fullscreenQuery.matches) || navigator.standalone);
    },
    iphone: function () { return /iPhone|iPod/.test(navigator.userAgent) && !document.fullscreenEnabled; }
  };
})();
