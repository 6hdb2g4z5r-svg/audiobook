/*
 * sw.js — offline app shell.
 *
 * Audio never passes through here: it lives in IndexedDB, which is why a
 * converted book plays with no connection at all.
 *
 * Caching strategy, deliberately split:
 *   - app code (HTML/CSS/JS)  → network-first, cache as fallback.
 *     A deploy must be able to reach an already-installed app. Cache-first
 *     would pin whatever was cached the first time and never let go.
 *   - vendor + icons          → cache-first. Pinned library builds and icons
 *     never change, so there is nothing to revalidate.
 *
 * Bump VERSION on every release: it is what makes the browser install this
 * worker again and drop the previous cache.
 */

const VERSION = 'lisan-v3';

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/db.js',
  'js/text.js',
  'js/epub.js',
  'js/pdfbook.js',
  'js/tts.js',
  'js/player.js',
  'vendor/jszip.min.js',
  'vendor/pdf.min.mjs',
  'vendor/pdf.worker.min.mjs',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png',
];

/** Files that change with every deploy and must never be pinned. */
const isAppCode = (path) =>
  path.endsWith('/') ||
  path.endsWith('.html') ||
  path.endsWith('.css') ||
  path.endsWith('.webmanifest') ||
  /\/js\//.test(path);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Lets the page force an update check without waiting for a reload. */
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    // `cache: 'no-cache'` forces a revalidation against the server. Without it
    // the browser's own HTTP cache can hand back the previous build and the
    // deploy still never lands.
    const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
    }
    return Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google and friends go straight out

  if (req.mode === 'navigate' || isAppCode(url.pathname)) {
    e.respondWith(networkFirst(req));
    return;
  }
  e.respondWith(cacheFirst(req));
});
