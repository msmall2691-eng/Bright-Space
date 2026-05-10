// Thin wrapper around the browser Notifications API. No-ops cleanly when
// the API is unavailable, the user hasn't granted permission, or the tab
// is already focused (in which case the in-app toast/badge is enough).

const STORAGE_KEY = 'brightbase_notif_dismissed'

export function isSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function getPermission() {
  return isSupported() ? Notification.permission : 'denied'
}

export function isDismissed() {
  try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
}

export function dismiss() {
  try { localStorage.setItem(STORAGE_KEY, '1') } catch {}
}

export async function requestPermission() {
  if (!isSupported()) return 'denied'
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission
  }
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

/**
 * Fire a desktop notification. Skipped when:
 *  - the API is unsupported
 *  - permission is not granted
 *  - the tab is currently visible (the in-app badge + chime is enough — a
 *    desktop notification would be redundant and feel intrusive)
 *
 * onClick: optional callback invoked when the user clicks the notification.
 * The wrapper also focuses the window for you.
 */
export function notify(title, { body, tag, onClick } = {}) {
  if (!isSupported()) return
  if (Notification.permission !== 'granted') return
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return

  try {
    const n = new Notification(title, { body, tag, silent: true })
    n.onclick = () => {
      try { window.focus() } catch {}
      onClick?.()
      n.close()
    }
  } catch {
    // Some browsers throw if a notification is fired in an unsupported context
    // (e.g. inside a non-secure iframe). Swallow rather than crash the chime path.
  }
}
