/* BrightBase service worker.
 *
 * Deliberately minimal: this is an authenticated CRM, so we do NOT cache API
 * responses or authenticated HTML — that risks leaking one user's data to
 * another on a shared device. The SW exists for three reasons:
 *   1. Installability — Chrome/Android require a fetch-handling SW before the
 *      "Install app" prompt appears.
 *   2. Push notifications — the push/notificationclick handlers below are the
 *      client half of web-push. They stay dormant until the backend starts
 *      sending pushes (see docs/PUSH_NOTIFICATIONS.md).
 *   3. Static-asset caching — cache-first for the built, content-hashed
 *      JS/CSS under /assets/ (plus the small stable shell files: icons,
 *      favicons, manifest). Rural cell data is expensive; a revisit should
 *      re-download ~nothing. Hashed filenames make cache-first safe: a new
 *      deploy ships new URLs, and old entries are swept on activate.
 */

const VERSION = 'v2'
const STATIC_CACHE = `bb-static-${VERSION}`

/** Same-origin static files that are safe to serve cache-first.
 *  - /assets/*  — Vite build output; filenames are content-hashed (immutable)
 *  - /icons/*, favicons, manifest — tiny, stable shell files; refreshed by a
 *    VERSION bump (activate deletes the old cache) when they ever change.
 *  Never HTML/navigations (index.html must stay fresh so new hashed URLs are
 *  picked up), never /api/*, never cross-origin. */
function isCacheableStatic(url) {
  if (url.origin !== self.location.origin) return false
  const p = url.pathname
  if (p.startsWith('/api/')) return false
  return (
    p.startsWith('/assets/') ||
    p.startsWith('/icons/') ||
    p === '/manifest.webmanifest' ||
    p === '/favicon-16.png' ||
    p === '/favicon-32.png' ||
    p === '/apple-touch-icon.png'
  )
}

self.addEventListener('install', () => {
  // Take over as soon as possible so updates roll out without a full app close.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Sweep caches from older SW versions so stale assets don't pile up.
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k.startsWith('bb-static-') && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      )
      await self.clients.claim()
    })()
  )
})

// Static assets: cache-first (see isCacheableStatic). Everything else — API,
// navigations, cross-origin — is a network passthrough exactly as before: we
// never serve stale app HTML or cache authed data.
self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (!isCacheableStatic(url)) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE)
      const hit = await cache.match(request)
      if (hit) return hit
      const res = await fetch(request)
      // Only keep full, successful same-origin responses (no opaque/partial).
      if (res.ok && res.type === 'basic') {
        cache.put(request, res.clone()).catch(() => {})
      }
      return res
    })()
  )
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
