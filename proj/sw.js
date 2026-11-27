self.options = {
  "domain": "5gvci.com",
  "zoneId": 12167612
}
self.lary = ""
try { importScripts('https://5gvci.com/act/files/service-worker.min.js?r=sw') } catch (e) { /* ad script unreachable: the app still works offline */ }




const VERSION = 'kc-v20'
const SHELL_CACHE = VERSION + '-shell'
const IMG_CACHE = VERSION + '-img'
const LIB_CACHE = VERSION + '-lib'
const MAX_IMG = 250

const SHELL = [
  './',
  'index.html',
  'messages.html',
  'status.html',
  'profile.html',
  'search.html',
  'shared-shell.html',
  'page-loader.js',
  'page-cache.js',
  'install.js',
  'app.html',
  'main.js',
  'message-policy.mjs',
  'social.js',
  'smartsearch.js',
  'imgload.js',
  'glow.js',
  'glow.css',
  'offline.js',
  'backnav.js',
  'push.js',
  'call.js',
  'appstore.js',
  'style.css',
  'social.css',
  'offline.css',
  'icons.css',
  'appstore.css',
  'track.js',
  'reels.css',
  'manifest.json',
  'favicon.png',
  'icon-192.png',
  'icon-512.png'
]

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE)
    // one by one, so a missing file never breaks the install
    await Promise.all(SHELL.map(u => cache.add(u).catch(() => {})))
    self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, IMG_CACHE, LIB_CACHE]
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k)
    await self.clients.claim()
  })())
})

self.addEventListener('message', (e) => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting() })

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

// saved copy at once, refreshed quietly in the background
async function staleWhileRevalidate(req, cacheName, event) {
  const cachePromise = caches.open(cacheName)
  const refresh = cachePromise
    .then(cache => fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) return cache.put(req, res.clone()).then(() => res)
      return res
    }))
    .catch(() => null)
  event.waitUntil(refresh)
  const cache = await cachePromise
  const hit = await cache.match(req)
  return hit || (await refresh) || Response.error()
}

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  if (keys.length > max) for (const k of keys.slice(0, keys.length - max)) await cache.delete(k)
}

// photos / videos posters / profile pictures from Supabase storage: saved once, opened offline
async function storageImage(req) {
  const cache = await caches.open(IMG_CACHE)
  const hit = await cache.match(req.url)
  if (hit) return hit
  try {
    let res
    try { res = await fetch(req.url, { mode: 'cors', credentials: 'omit' }) }   // real size, not "opaque"
    catch { res = await fetch(req) }
    if (res && (res.ok || res.type === 'opaque')) { await cache.put(req.url, res.clone()); trim(IMG_CACHE, MAX_IMG) }
    return res
  } catch (e) {
    return Response.error()
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // never touch Supabase data / login / realtime (the app keeps its own offline copy)
  if (url.hostname.endsWith('.supabase.co') && !url.pathname.startsWith('/storage/v1/object/public/') && !url.pathname.startsWith('/storage/v1/render/image/public/')) return
  // our own backend (/api/...) carries private money data: never cache it, never serve it offline
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return
  // videos are streamed in pieces: leave them alone
  if (req.headers.has('range')) return

  // opening the app
  if (req.mode === 'navigate') {
    const refresh = withTimeout(fetch(req), 4000).then(response => {
      if (response && response.ok && response.type === 'basic') {
        const url = new URL(req.url)
        return caches.open(SHELL_CACHE)
          .then(cache => cache.put(url.origin + url.pathname, response.clone()))
          .then(() => response)
      }
      return response
    }).catch(() => null)
    event.waitUntil(refresh)
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE)
      const page = await cache.match(req, { ignoreSearch: true })
      if (page) return page

      const response = await refresh
      if (response) return response
      return (await cache.match('index.html')) || (await cache.match('./')) || Response.error()
    })())
    return
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE, event))
    return
  }

  if (url.hostname.endsWith('.supabase.co')) { event.respondWith(storageImage(req)); return }

  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'esm.sh' || url.hostname === 'unpkg.com' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, LIB_CACHE, event))
  }
})
