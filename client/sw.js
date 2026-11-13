/* Service worker: makes the game installable and keeps the app shell available offline.
 * Network-first for everything, so game code is never stale while online. /api/* is never touched. */
var CACHE = 'gt-shell-v56';
var SHELL = [
  '/', '/manifest.json',
  '/css/theme.css', '/css/game.css', '/css/chain.css', '/css/settings.css', '/css/sim.css', '/css/mods.css', '/css/phone.css',
  '/js/i18n.js', '/js/lang/en.js', '/js/pwa.js', '/js/flags.js', '/js/theme.js', '/js/sprites.js', '/js/art.js', '/js/buildings.js', '/js/world/village.js', '/js/world/homeland.js', '/js/engine.js',
  '/js/mods/casino.js', '/js/mods/thief.js', '/js/mods/police.js', '/js/mods/combat.js', '/js/mods/curfew.js',
  '/js/mods/gossip.js', '/js/mods/agent.js', '/js/mods/social.js', '/js/mods/ferry.js', '/js/mods/ride.js', '/js/mods/interior.js', '/js/mods/settings.js',
  '/vendor/env.js', '/vendor/near.js', '/js/mods/chain.js', '/js/mods/homeland.js', '/js/mods/fishing.js', '/js/mods/actfx.js', '/js/mods/players.js', '/js/mods/party.js', '/js/mods/admin.js', '/js/mods/trade.js', '/js/mods/hotbar.js', '/js/mods/mouse.js', '/js/mods/sim.js', '/js/mods/view3d.js', '/js/mods/concert.js', '/js/mods/sfx.js', '/js/mods/music.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  // add one by one so a single missing file does not block the install
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(new Request(u, { cache: 'reload' })).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf('/api/') === 0) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('/') : Response.error());
      });
    })
  );
});
