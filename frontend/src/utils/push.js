// Web Push client helpers — the browser half of the notification flow.
//
// Flow: the service worker (public/sw.js) is already registered by main.jsx.
// Here we (1) ask the backend for the VAPID public key, (2) subscribe the
// browser's PushManager with it, and (3) POST the subscription to the backend
// so it can send. Unsubscribe reverses it. Everything degrades gracefully when
// the browser doesn't support push or the server has no VAPID keys.

import { post, api } from '../api'

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
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
    const res = await fetch('/api/push/vapid-public-key')
    if (res.ok) enabledOnServer = !!(await res.json())?.enabled
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

  const keyRes = await fetch('/api/push/vapid-public-key')
  const { enabled, publicKey } = keyRes.ok ? await keyRes.json() : {}
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
