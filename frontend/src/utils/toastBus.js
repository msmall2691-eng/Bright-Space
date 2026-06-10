// Global toast bus.
//
// The existing useToast() hook (components/ui/Toast.jsx) is per-component: each
// page renders its own container and shows its own toasts. That's great for
// "Saved ✓" feedback a page raises deliberately, but it can't catch an error
// that's thrown *outside* a page's own try/catch — e.g. an `onClick={async …}`
// mutation with no catch block, where the rejection currently vanishes and the
// user sees nothing.
//
// This bus is a tiny module-level pub/sub so non-React code (the global
// error handlers in App, the api() client, future call sites) can push a toast
// without holding a hook. <GlobalToasts/> subscribes and renders them once.

let _id = 0
const _subscribers = new Set()

/** Subscribe to toast pushes. Returns an unsubscribe function. */
export function subscribe(fn) {
  _subscribers.add(fn)
  return () => _subscribers.delete(fn)
}

/** Push a toast to every subscriber. variant: 'error' | 'success' | 'info'. */
export function pushToast(message, variant = 'info') {
  if (!message) return
  const t = { id: ++_id, message: String(message), variant }
  _subscribers.forEach(fn => {
    try { fn(t) } catch { /* a bad subscriber must not break the bus */ }
  })
  return t.id
}

/** Convenience matching the useToast() shape so call sites read the same. */
export const toast = {
  error: (msg) => pushToast(msg, 'error'),
  success: (msg) => pushToast(msg, 'success'),
  info: (msg) => pushToast(msg, 'info'),
}
