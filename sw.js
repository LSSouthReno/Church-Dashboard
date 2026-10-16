// LS Dashboard service worker — makes the site installable, fast, and usable on weak Wi-Fi.
// · Pages, scripts, images, fonts: STALE-WHILE-REVALIDATE — shown instantly from this device,
//   refreshed in the background (the dashboard's build.txt check offers "A newer version is ready").
// · Data files (*.json): the network gets a short head start; if it's slow the saved copy is shown
//   right away and the fresh one is saved for next time.
// · Apps Script (script.google.com) and everything else is never touched.
const CACHE = 'lssr-app-v6';
const SHELL = ['./', './index.html', './manifest.webmanifest', './team-checklists.js', './conferences.js', './engagement.js', './theme.js',
  './assets/ls-logo-white.png', './assets/ls-lockup-white.png', './assets/app/icon-192.png', './assets/belong-topo.svg',
  './journey/', './journey/manifest.webmanifest'];   // the member app (Me) opens instantly / offline too
const DATA_ORIGINS = [self.location.origin, 'https://lssouthreno.com'];          // the beta reads the live data files
const STATIC_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const DATA_HEAD_START = 900;   // ms the network gets before the saved copy is used

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function save(key, res) {
  if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {}); }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.endsWith('/build.txt') || url.pathname.endsWith('/sw.js')) return;   // update check always live
  const isData = /\.json$/.test(url.pathname) && !/manifest/.test(url.pathname) && DATA_ORIGINS.indexOf(url.origin) >= 0;
  const isStatic = STATIC_HOSTS.indexOf(url.hostname) >= 0;
  if (url.origin !== self.location.origin && !isData && !isStatic) return;

  // One cache entry per path (pages add ?v=<time> to data fetches; don't store each one).
  // Section paths (/sunday …) are the dashboard page; real folders are their own page.
  const nav = req.mode === 'navigate', folder = (/^\/(journey|fit|links)(\/|$)/.exec(url.pathname) || [])[1];
  const key = isStatic ? req.url : url.origin + (nav ? (folder ? '/' + folder + '/' : '/') : url.pathname);

  if (isData) {
    e.respondWith(caches.match(key).then(hit => {
      const net = fetch(req).then(res => save(key, res));
      if (!hit) return net;
      const timer = new Promise(r => setTimeout(() => r(hit), DATA_HEAD_START));
      e.waitUntil(net.catch(() => {}));
      return Promise.race([net.catch(() => hit), timer]);
    }));
    return;
  }
  // 404 bounce pages (/church, /give …) must stay live: they're tiny and route by address.
  if (nav && !folder && url.pathname !== '/' && url.pathname !== '/index.html') return;
  e.respondWith(caches.match(key).then(hit => {
    const net = fetch(req).then(res => save(key, res));
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(() => nav ? caches.match(self.location.origin + (folder === 'journey' ? '/journey/' : '/')) : Response.error());
  }));
});
