// Web Push client helpers — the browser half of the notification flow.
//
// Flow: the service worker (public/sw.js) is already registered by main.jsx.
// Here we (1) ask the backend for the VAPID public key, (2) subscribe the
// browser's PushManager with it, and (3) POST the subscription to the backend
// so it can send. Unsubscribe reverses it. Everything degrades gracefully when
// the browser doesn't support push or the server has no VAPID keys.

import { get, post, api } from '../api'

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** Is this tab running as an installed PWA (Home Screen / desktop install)?
 *  iOS Safari only exposes the Push API to installed apps — a regular Safari
 *  tab reports pushSupported()=false with no further explanation, so callers
 *  need this + isMobilePlatform() to tell "won't ever work here" apart from
 *  "will work once installed." */
export function isAppInstalled() {
  try {
    return (
      (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)')?.matches) ||
      (typeof navigator !== 'undefined' && navigator.standalone === true)
    )
  } catch { return false }
}

/** 'ios' | 'android' | 'other' — drives the platform-specific "Add to Home
 *  Screen" copy shared by the crew setup card and the office Settings page. */
export function mobilePlatform() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'other'
}

/** Re-run a support/state check whenever the tab regains focus, not just
 *  once at mount. Owner report: adding the app to the Home Screen, then
 *  switching back to the still-open Safari TAB (not the new icon), read as
 *  "it still won't set up notifications" — pushSupported()/isAppInstalled()
 *  only flip true once you're actually running from the installed icon, and
 *  a one-shot mount check never notices the switch. `pageshow` also covers
 *  iOS's bfcache restore (returning to a backgrounded tab without a real
 *  reload) and the documented iOS quirk where a freshly-installed icon's
 *  FIRST launch sometimes needs one full close+reopen before PushManager
 *  appears — both read as "focus changed," which this catches without
 *  asking the user to manually refresh. Returns an unsubscribe. */
export function onAppForeground(fn) {
  const handler = () => { if (document.visibilityState === 'visible') fn() }
  document.addEventListener('visibilitychange', handler)
  window.addEventListener('pageshow', handler)
  return () => {
    document.removeEventListener('visibilitychange', handler)
    window.removeEventListener('pageshow', handler)
  }
}

// VAPID public keys are URL-safe base64; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function readyRegistration() {
  if (!pushSupported()) return null
  try {
    return await navigator.serviceWorker.ready
  } catch {
    return null
  }
}

/** Current push state for rendering the Settings toggle. */
export async function getPushState() {
  if (!pushSupported()) {
    return { supported: false, enabledOnServer: false, permission: 'denied', subscribed: false }
  }
  let enabledOnServer = false
  try {
    // BB-CODE-06: must go through the authenticated client — /api/push/* sits
    // behind APIKeyMiddleware (not in the public-prefix list), so a bare
    // fetch() carries no JWT, 401s, and made this permanently report
    // "not configured" even with VAPID keys set.
    enabledOnServer = !!(await get('/api/push/vapid-public-key'))?.enabled
  } catch { /* offline / not logged in */ }

  const reg = await readyRegistration()
  let subscribed = false
  if (reg) {
    try {
      subscribed = !!(await reg.pushManager.getSubscription())
    } catch { /* noop */ }
  }
  return {
    supported: true,
    enabledOnServer,
    permission: Notification.permission,
    subscribed,
  }
}

/** Ask permission, subscribe, and register with the backend. Returns the new
 *  state. Throws with a friendly message the caller can surface. */
export async function enablePush() {
  if (!pushSupported()) throw new Error('This browser doesn’t support push notifications.')

  // BB-CODE-06: authenticated client, not a bare fetch — see getPushState.
  const { enabled, publicKey } = await get('/api/push/vapid-public-key').catch(() => ({}))
  if (!enabled || !publicKey) {
    throw new Error('Push isn’t configured on the server yet (missing VAPID keys).')
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notifications were blocked. Enable them in your browser/site settings.')
  }

  const reg = await readyRegistration()
  if (!reg) throw new Error('Service worker isn’t ready yet — reload and try again.')

  // Reuse an existing subscription if present; otherwise create one.
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
  }

  const json = sub.toJSON()
  await post('/api/push/subscriptions', {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  })
  return getPushState()
}

/** Unsubscribe this device and tell the backend to forget it. */
export async function disablePush() {
  const reg = await readyRegistration()
  if (!reg) return getPushState()
  try {
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      const endpoint = sub.endpoint
      await sub.unsubscribe().catch(() => {})
      await api('/api/push/subscriptions', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint }),
      }).catch(() => {})
    }
  } catch { /* best-effort */ }
  return getPushState()
}

/** Fire a server-side test push to confirm the round-trip. */
export async function sendTestPush() {
  return post('/api/push/test', {})
}
