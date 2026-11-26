// KIREZI CANJE - notifications (push) service worker.
// It lives in its own folder on purpose, so it never clashes with the main sw.js (offline + ads).
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let d = null
  try { d = event.data ? event.data.json() : null } catch { d = null }
  if (!d || !d.kc) return                       // not a KIREZI CANJE notification
  event.waitUntil((async () => {
    // the app is open and visible: the app shows its own little popup, no phone notification
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (all.some(c => c.visibilityState === 'visible')) return
    await self.registration.showNotification(d.title || 'KIREZI CANJE', {
      body: d.body || '',
      icon: d.icon || '/icon-192.png',
      badge: '/icon-192.png',
      tag: d.tag || 'kc',
      renotify: true,
      requireInteraction: !!d.requireInteraction,                          // a call stays on the screen until you tap it
      vibrate: Array.isArray(d.vibrate) ? d.vibrate : [200, 100, 200],
      data: { url: d.url || '/' },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of all) {
      if (c.url.startsWith(self.location.origin) && 'focus' in c) {
        await c.focus()
        c.postMessage({ type: 'kc-open', url })     // the open app goes to the chat / profile
        return
      }
    }
    await self.clients.openWindow(url)
  })())
})
