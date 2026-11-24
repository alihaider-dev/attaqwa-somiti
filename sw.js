// Saved copy first (opens at once, even on weak signal); a fresh copy is fetched in the background.
// Data never goes through here: API calls are POSTs to another origin.
const CACHE = 'ats-shell';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' }))))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
let told = 0;
function tellClients() {
  if (Date.now() - told < 60000) return; told = Date.now();
  // Wait a moment so every changed file is saved before the user reloads.
  setTimeout(() => self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage('update'))), 2500);
}
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const old = hit ? hit.clone() : null;
    const net = fetch(e.request, { cache: 'no-cache' }).then(async (r) => {
      if (r && r.ok) {
        if (old) { const [a, b] = await Promise.all([old.text(), r.clone().text()]); if (a !== b) tellClients(); }
        await c.put(e.request, r.clone());
      }
      return r;
    }).catch(() => hit);
    if (hit) { e.waitUntil(net); return hit; }
    return net;
  }));
});
