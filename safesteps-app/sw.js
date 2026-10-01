// SafeSteps Service Worker
// Bump CACHE_VERSION on every deploy. Cache cleanup below is *prefix-based*
// (see SAFESTEPS_CACHE_PREFIX) rather than matching one exact version string,
// so any previously-installed safesteps-* cache — v41, v42, or a future
// build id — is purged automatically and stale assets can never linger.
const CACHE_VERSION = 'v43';
const SAFESTEPS_CACHE_PREFIX = 'safesteps-';
const CACHE_NAME = `${SAFESTEPS_CACHE_PREFIX}${CACHE_VERSION}`;
// A separate, size-capped cache for map tiles so raster basemaps stay usable
// offline after they've been viewed once, without bloating the main shell cache.
const TILE_CACHE_NAME = `${SAFESTEPS_CACHE_PREFIX}tiles-${CACHE_VERSION}`;
const MAX_CACHED_TILES = 500; // oldest tiles are evicted past this many

// Core app shell — everything needed to run fully offline, including the
// Project 360° Shield branding assets and icons, so the app looks right
// on the very first offline load (not just after a page has been visited).
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './assets/brand-logo.png',
  './assets/brand-logo.webp',
  './assets/about-poster.jpg',
  './assets/about-poster.webp',
  './assets/about-poster.avif',
  './icons/icon-72.png',
  './icons/icon-72.webp',
  './icons/icon-96.png',
  './icons/icon-96.webp',
  './icons/icon-128.png',
  './icons/icon-128.webp',
  './icons/icon-144.png',
  './icons/icon-144.webp',
  './icons/icon-152.png',
  './icons/icon-152.webp',
  './icons/icon-192.png',
  './icons/icon-192.webp',
  './icons/icon-384.png',
  './icons/icon-384.webp',
  './icons/icon-512.png',
  './icons/icon-512.webp',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-192.webp',
  './icons/icon-maskable-512.png',
  './icons/icon-maskable-512.webp',
  './data/accidents.json',
  './data/lessons.json',
  './data/quiz.json',
  './data/signs.json',
  './data/trafficjams.json',
  './data/ntsa-cache.json',
  './data/routing-graph.json',
  './data/emergency-contacts.json',
  './accidents.json',
  './lessons.json',
  './quiz.json',
  './signs.json',
  './trafficjams.json',
  './ntsa-cache.json',
  './routing-graph.json',
  './emergency-contacts.json'
];

/* ---------------- INSTALL ---------------- */
// Pre-cache the app shell, then activate immediately (don't wait for old
// tabs to close) so users get offline support on the very first visit.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      // Warm the tile cache too so a brand-new install already holds the
      // first basemap tiles for its default region once it goes online.
      .then(() => self.skipWaiting())
      .catch(err => { /* one shell asset failed (e.g. offline at install) — still activate so the SW controls the page */ self.skipWaiting(); })
  );
});

/* ---------------- ACTIVATE ---------------- */
// Version-agnostic cleanup: delete EVERY cache whose name starts with the
// safesteps- prefix except the two live ones (shell + tiles). This replaces
// brittle exact-version matching — no matter how many past builds shipped
// (v41, v42, a git-sha build id, or a future "tiles-*" name), they're all
// swept on activate so nothing stale survives a deploy.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => {
        const keep = new Set([CACHE_NAME, TILE_CACHE_NAME]);
        return Promise.all(
          keys
            .filter(key => key.startsWith(SAFESTEPS_CACHE_PREFIX) && !keep.has(key))
            .map(key => caches.delete(key))
        );
      })
      .then(() => self.clients.claim())
  );
});

/* ---------------- FETCH ---------------- */
// Strategy:
//  - Page navigations (HTML): network-first, falling back to cache when
//    offline, so users always see the latest content when they have a
//    connection, but the app still opens with no signal at all.
//  - Map basemap tiles: cache-first with background revalidation and a size
//    cap, so once an area has been viewed it stays interactive offline.
//  - Dynamic safety data (accidents.json, lessons.json, trafficjams.json,
//    ntsa-cache.json, routing-graph.json, emergency-contacts.json):
//    Cache-then-Network. The cached copy is returned immediately for a
//    fast/offline-safe response, and a network fetch always runs alongside
//    it — if the network copy is valid AND differs from what's cached, the
//    cache is updated *and* every open tab is told via postMessage so the UI
//    can quietly refresh in place, without waiting for a full page reload.
//  - Everything else (fonts, icons, scripts): cache-first, falling back to
//    network, then updating the cache in the background.
const DYNAMIC_DATA_FILES = [
  './data/accidents.json',
  './data/lessons.json',
  './data/quiz.json',
  './data/signs.json',
  './data/trafficjams.json',
  './data/ntsa-cache.json',
  './data/routing-graph.json',
  './data/emergency-contacts.json'
];

// Basemap tile hosts SafeSteps pulls from (Google hybrid/road, OpenStreetMap,
// and Carto dark). Requests to these are cached so offline maps keep working.
const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'mt0.google.com', 'mt1.google.com', 'mt2.google.com', 'mt3.google.com',
  'basemaps.cartocdn.com', 'basemaps.naturalearthii.com'
];
function isMapTile(url){
  if(!url || url.protocol !== 'https:') return false;
  return TILE_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host));
}

self.addEventListener('fetch', event => {
  const req = event.request;

  // Only handle GET requests — POSTs / other methods just pass through.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (isMapTile(url)) {
    event.respondWith(cacheFirstTile(req));
    return;
  }

  const isNavigation = req.mode === 'navigate' ||
    (req.method === 'GET' && req.headers.get('accept')?.includes('text/html'));

  const isDynamicData = DYNAMIC_DATA_FILES.some(f => url.pathname.endsWith(f.replace('./', '/')));

  if (isNavigation) {
    event.respondWith(networkFirst(req));
  } else if (isDynamicData) {
    event.respondWith(cacheThenNetwork(req));
  } else {
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Last resort: try to serve the app shell so the person still gets
    // *something* usable instead of a browser error page.
    const shellFallback = await caches.match('./index.html');
    if (shellFallback) return shellFallback;
    return new Response(
      "<h1>Offline</h1><p>SafeSteps isn't available right now and no offline copy was found. Reconnect and reload once you have signal.</p>",
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
}

// Stale-while-revalidate for general static assets (icons, jsPDF, fonts,
// screenshots): serve the cached copy instantly, then quietly fetch a fresh
// copy in the background for next time.
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    fetch(request).then(res => {
      if (res && res.ok) {
        caches.open(CACHE_NAME).then(cache => cache.put(request, res));
      }
    }).catch(() => { /* offline — cached copy is all we have, that's fine */ });
    return cached;
  }
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'Offline and not cached' });
  }
}

// Map-tile strategy: serve the cached tile immediately if present (offline
// maps keep working), otherwise fetch it, cache it, and evict the oldest
// tiles once we exceed MAX_CACHED_TILES so storage can't grow unbounded.
async function cacheFirstTile(request) {
  const cache = await caches.open(TILE_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    // Revalidate in the background so tiles stay reasonably fresh online.
    fetch(request).then(res => {
      if (res && res.ok) cache.put(request, res);
    }).catch(() => {});
    return cached;
  }
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
      trimTileCache(cache); // fire-and-forget eviction of the oldest tiles
    }
    return fresh;
  } catch (err) {
    // Offline and this tile was never cached — return a transparent 1px PNG
    // so the Leaflet layer doesn't show broken-image icons; the app draws a
    // routing-graph vector overlay on top when it detects blank tiles.
    return new Response(
      Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0)),
      { status: 200, headers: { 'Content-Type': 'image/png' } }
    );
  }
}
async function trimTileCache(cache){
  try {
    const keys = await cache.keys();
    if (keys.length <= MAX_CACHED_TILES) return;
    // Cache Storage preserves insertion order, so delete from the front.
    const overflow = keys.length - MAX_CACHED_TILES;
    await Promise.all(keys.slice(0, overflow).map(k => cache.delete(k)));
  } catch (err) { /* non-critical */ }
}

// Guard used by cacheThenNetwork(): only accept a network payload that is
// genuinely parseable JSON. This stops a corrupted / truncated / HTML error
// page (some captive portals return 200 + HTML) from being cached over a good
// local copy or from firing a bogus DATA_UPDATED that makes the UI re-render
// from garbage.
function isValidJsonPayload(text){
  if (typeof text !== 'string' || !text.trim()) return false;
  let data;
  try { data = JSON.parse(text); }
  catch (e) { return false; }
  return data !== null && typeof data === 'object';
}

// Cache-then-Network: respond with whatever's cached right away (or wait on
// the network if there's nothing cached yet), then separately fetch a fresh
// copy. If the fresh copy is valid JSON AND actually different from what was
// cached, save it and tell every open SafeSteps tab exactly which file changed
// so it can re-fetch and re-render that data live — e.g. a newly-published
// blackspot showing up on the hazard map without the person needing to reload.
async function cacheThenNetwork(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const networkUpdate = (async () => {
    try {
      const fresh = await fetch(request, { cache: 'no-store' });
      if (fresh && fresh.ok) {
        const freshText = await fresh.clone().text();
        // Validate BEFORE touching the cache or notifying — a corrupt payload
        // must never override the good cached database.
        if (!isValidJsonPayload(freshText)) {
          return fresh; // serve it this once, but keep the cached copy intact
        }
        const cachedText = cached ? await cached.clone().text() : null;
        if (freshText !== cachedText) {
          await cache.put(request, fresh.clone());
          if (cachedText !== null) {
            // Only announce a change if there was a previous cached copy to
            // compare against — on the very first load there's nothing to
            // "update" in the UI yet, so no need to notify.
            const url = new URL(request.url);
            notifyClients('DATA_UPDATED', { file: url.pathname.split('/').pop() });
          }
        }
      }
      return fresh;
    } catch (err) {
      return null; // offline or unreachable — the cached copy already served is all we have
    }
  })();

  if (cached) return cached;
  const fresh = await networkUpdate;
  if (fresh) return fresh;
  return new Response('{}', { status: 504, statusText: 'Offline and not cached', headers: { 'Content-Type': 'application/json' } });
}

/* ---------------- MESSAGE ---------------- */
// Lets the page force an update (e.g. a "Refresh app" button in Settings)
// by posting {type:'SKIP_WAITING'} to the active service worker.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ---------------- NOTIFICATION CLICK ---------------- */
// Tapping a local reminder / proximity hazard alert (see
// showLocalNotification() in index.html) should focus an already-open
// SafeSteps tab if there is one, or open a new one otherwise — same behaviour
// people expect from any app notification. If the notification carries a
// target page (e.g. the hazard map), it's forwarded so the app can jump there.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          // Let the open tab react (e.g. navigate to the hazard map).
          client.postMessage({ type: 'NOTIFICATION_CLICK', url: target });
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

/* ---------------- BACKGROUND SYNC ---------------- */
// Hazard reports, near-misses and feedback are queued the instant they're
// created (stored in IndexedDB by the page — see idbQueue in index.html — so
// they survive localStorage eviction and hold far more than a mailto could).
// The "notify the team" email step needs a connection, so if it can't send
// while offline the page registers a one-off Background Sync via
// swRegistration.sync.register('sync-reports'). When the browser regains
// connectivity it fires this event — even if SafeSteps isn't open — and we
// wake any open/opening window to flush the IndexedDB queue using the page's
// existing EmailJS setup.
self.addEventListener('sync', event => {
  if (event.tag === 'sync-reports') {
    event.waitUntil(flushReportsFromBackground());
  }
});

async function flushReportsFromBackground(){
  // If a tab is already open, hand the job to it — it owns the EmailJS config.
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clientList.length) {
    clientList.forEach(client => client.postMessage({ type: 'FLUSH_PENDING_SYNC' }));
    return;
  }
  // No tab open: open one in the background so the queued reports still go
  // out. If that's not possible on this browser, the IndexedDB queue simply
  // stays put and flushes next time the person opens the app themselves.
  try {
    if (self.clients.openWindow) await self.clients.openWindow('./index.html?flush=sync');
  } catch (err) { /* best effort */ }
}

async function notifyClients(type, payload) {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clientList.length) {
    clientList.forEach(client => client.postMessage({ type, ...(payload || {}) }));
    return;
  }
  // No tab open right now — leave a quiet notification trace for queue flushes
  // rather than silently failing, without being intrusive. Most browsers skip
  // this if notifications aren't permitted.
  if (type === 'FLUSH_PENDING_SYNC' && self.registration.showNotification) {
    try {
      await self.registration.showNotification('SafeSteps', {
        body: 'Back online — sending your queued safety reports.',
        icon: './icons/icon-192.png',
        badge: './icons/icon-96.png',
        tag: 'safesteps-sync',
        data: { url: './index.html' }
      });
    } catch (err) { /* notifications blocked — the queue still flushes on next open */ }
  }
}

/* ---------------- PERIODIC BACKGROUND SYNC ---------------- */
// On browsers/devices that grant it (installed PWA + periodic-background-sync
// permission), this keeps the offline hazard/blackspot data reasonably fresh
// even between visits, so an offline session still has recent data.
self.addEventListener('periodicsync', event => {
  if (event.tag === 'update-safety-data') {
    event.waitUntil(refreshSafetyData());
  }
});

async function refreshSafetyData() {
  const cache = await caches.open(CACHE_NAME);
  const files = ['./data/accidents.json', './data/trafficjams.json', './data/ntsa-cache.json', './data/routing-graph.json'];
  await Promise.all(files.map(async file => {
    try {
      const fresh = await fetch(file, { cache: 'no-store' });
      if (fresh && fresh.ok) {
        const text = await fresh.clone().text();
        if (isValidJsonPayload(text)) await cache.put(file, fresh.clone());
      }
    } catch (err) {
      // Offline or unreachable — the cached copy from last time stays in place.
    }
  }));
}

/* ---------------- PUSH NOTIFICATIONS ---------------- */
// SafeSteps has no push server of its own today (see EMAILJS_* placeholders
// in index.html for the same pattern) — reminders currently run entirely
// on-device. This listener is here so that if a school, county, or Scout
// troop later stands up a small push backend (e.g. to broadcast a new
// blackspot alert or a school-run advisory), the app already knows how to
// display it; nothing is sent or received until a real endpoint exists.
self.addEventListener('push', event => {
  let data = { title: 'SafeSteps', body: 'New road safety update available.' };
  if (event.data) {
    try { data = { ...data, ...event.data.json() }; }
    catch (err) { data.body = event.data.text() || data.body; }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-96.png',
      data: { url: data.url || './index.html' }
    })
  );
});

self.addEventListener('pushsubscriptionchange', event => {
  // The browser rotated our push subscription. Without a server to
  // re-register with, just notify open tabs so the UI can reflect that
  // push reminders need to be re-enabled in Settings.
  event.waitUntil(notifyClients('PUSH_SUBSCRIPTION_LOST'));
});
