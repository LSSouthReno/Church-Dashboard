// LS Dashboard service worker — makes the site installable and usable on weak Wi-Fi.
// NETWORK FIRST for everything on this site: every visit still gets the newest page and
// data; the saved copy is used only when the network fails (offline / dropped Wi-Fi).
// Other origins (Apps Script web apps, CDNs, fonts) are never touched.
const CACHE = 'lssr-app-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './team-checklists.js',
  './assets/ls-logo-white.png', './assets/ls-lockup-white.png', './assets/app/icon-192.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/build.txt') || url.pathname.endsWith('/sw.js')) return;   // update check always live
  // One cache entry per path (the page adds ?v=<time> to data fetches; don't store each one).
  // Section paths (/sunday …) are the dashboard page; real folders (e.g. /journey/) are their own page.
  const nav = req.mode === 'navigate', own = /^\/journey(\/|$)/.test(url.pathname);
  const key = url.origin + (nav ? (own ? '/journey/' : '/') : url.pathname);
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(key).then(hit => hit ||
      (req.mode === 'navigate' ? caches.match(url.origin + '/') : Response.error())))
  );
});
