/* pwa/sw.js · the service worker for the installable desktop app (briefing page 22)
 *
 * Rules:
 *   · caches ONLY the app shell: scripts, styles, fonts, logos
 *   · never caches /api/, /files/, /sign/ or anything with a session: personal data never
 *     touches the cache, so a shared or stolen machine gives nothing away
 *   · fits the strict CSP (no inline script, no eval) and the SHA-256-pinned vendor files
 *   · updates cleanly on deploy: the shell list carries the build id, so a new deploy is a
 *     new cache and the old one is removed on activate
 *   · signing out when the window closes still works: the session cookie is the server's,
 *     the worker never sees or stores it
 */

const BUILD = '__BUILD_ID__'; // replaced at deploy (git sha); a new id = a new cache
const SHELL_CACHE = `nl-shell-${BUILD}`;

// Exactly what is cached. Anything not on this list is fetched from the network, always.
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/app.css',
  '/js/app/core.js',
  '/js/app/caps.js',
  '/js/vendor/jspdf.min.js',
  '/js/vendor/pdf.min.js',
  '/img/logo.svg',
  '/img/icon-192.png',
  '/img/icon-512.png',
];

// Paths that must never be cached, whatever the request looks like.
const NEVER = [/^\/api\//, /^\/files\//, /^\/sign\//, /^\/health$/];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('nl-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // saves never go near the cache
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // nothing from elsewhere
  if (NEVER.some((re) => re.test(url.pathname))) return;  // data, files, signing: network only
  if (!SHELL.includes(url.pathname)) return;              // not shell: network only

  // Shell: cache first, then network; a navigation falls back to the cached index.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('/index.html') : undefined)))
  );
});
