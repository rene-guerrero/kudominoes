/* Kudominoes service worker — hand-written, no dependencies.
 * - Navigations (index.html): network-first, falling back to the cached shell when offline,
 *   so a new deploy is picked up on the next online launch.
 * - Everything else same-origin (hashed JS/CSS, icons, manifest): cache-first, filled on demand.
 * - On install and after every online navigation, the hashed assets of the current index.html
 *   (boot chunk + CSS) and the chunks it loads lazily (game, renderer, three.js) are precached in the
 *   background, and older deploys' assets are dropped: repeat visits are instant and work offline.
 * Registered only in production web builds (never inside the Capacitor app).
 */
const CACHE = 'kudominoes-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-maskable.svg'];

/**
 * Hashed asset URLs referenced by `text`: "assets/x.js" paths (index.html) resolve against the scope,
 * sibling "./x.js" paths (Vite's lazy-chunk map inside a JS chunk) against that chunk's own URL.
 */
function assetRefs(text, scope, self_ = scope) {
  const out = new Set();
  let m;
  const inAssets = /(?:\.\/|\/)?assets\/[\w.-]+\.(?:js|css)/g;
  while ((m = inAssets.exec(text))) out.add(new URL(m[0].replace(/^\.?\/?(?=assets)/, './'), scope).href);
  if (self_ !== scope) {
    const sibling = /["'`](\.\/[\w.-]+-[\w-]{8}\.(?:js|css))["'`]/g; // hashed names only
    while ((m = sibling.exec(text))) out.add(new URL(m[1], self_).href);
  }
  return out;
}

/** text of a same-origin asset, from the cache if present, else the network (and cache it) */
async function assetText(cache, u) {
  let r = await cache.match(u);
  if (!r) {
    r = await fetch(u);
    if (!r.ok) throw new Error(`${u}: ${r.status}`);
    await cache.put(u, r.clone());
  }
  return r.text();
}

/**
 * Precache every hashed asset this deploy's index.html needs: its own <script>/<link> files plus
 * the chunks they load lazily (Vite lists them in the boot chunk's preload map), then drop cached
 * assets of older deploys. Best effort; anything missed is still cached on demand.
 */
async function precacheDeploy(cache, html) {
  const scope = self.registration.scope;
  const want = assetRefs(html, scope);
  const queue = [...want];
  let complete = true;
  while (queue.length) {
    const u = queue.shift();
    const text = await assetText(cache, u).catch(() => ((complete = false), ''));
    if (!u.endsWith('.js')) continue;
    for (const v of assetRefs(text, scope, u)) if (!want.has(v)) (want.add(v), queue.push(v));
  }
  if (!complete) return;
  for (const req of await cache.keys()) if (req.url.includes('/assets/') && !want.has(req.url)) await cache.delete(req);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (c) => {
        await c.addAll(SHELL);
        // best effort: a failure here must not block the install (assets are also cached on demand)
        const html = await (await c.match('./index.html'))?.text();
        if (html) await precacheDeploy(c, html).catch(() => {});
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('.apk')) return; // never cache the Android download

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            const forPrecache = res.clone();
            // keep the offline shell current, and fetch this deploy's chunks (incl. three.js) in the background
            event.waitUntil(
              caches.open(CACHE).then(async (c) => {
                await c.put('./index.html', copy);
                await precacheDeploy(c, await forPrecache.text()).catch(() => {});
              }),
            );
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
