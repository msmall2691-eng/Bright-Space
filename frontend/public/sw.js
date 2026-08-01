/* BrightBase service worker.
 *
 * Deliberately minimal: this is an authenticated CRM, so we do NOT cache API
 * responses or authenticated HTML — that risks leaking one user's data to
 * another on a shared device. The SW exists for two reasons:
 *   1. Installability — Chrome/Android require a fetch-handling SW before the
 *      "Install app" prompt appears.
 *   2. Push notifications — the push/notificationclick handlers below are the
 *      client half of web-push. They stay dormant until the backend starts
 *      sending pushes (see docs/PUSH_NOTIFICATIONS.md).
 */

const VERSION = 'v1'

self.addEventListener('install', () => {
  // Take over as soon as possible so updates roll out without a full app close.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// Network-first passthrough. We don't serve stale content; we only need a
// fetch handler to exist for installability. Non-GET and cross-origin requests
// are left entirely alone.
self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  // Let the browser handle it normally — no offline caching of authed data.
})

// ── Push notifications (client half) ─────────────────────────────────────────
// Fires when the backend sends a web-push message to this device's subscription.
self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { title: 'BrightBase', body: event.data ? event.data.text() : '' }
  }
  const title = payload.title || 'BrightBase'
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag,               // collapse duplicates (e.g. one per job)
    data: { url: payload.url || '/' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

// Focus an existing tab (or open one) when a notification is tapped.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(target)
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    })
  )
})
