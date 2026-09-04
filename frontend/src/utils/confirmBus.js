// Global confirm bus — a Promise-based replacement for window.confirm().
//
// window.confirm() blocks the JS thread and renders unstyled browser chrome
// that can't be themed (breaks dark mode) or driven in Testing Library the
// way the rest of the app's UI can. This bus works like utils/toastBus.js: a
// tiny module-level pub/sub so any code — component, hook, or plain util —
// can request a confirmation without holding a hook, and
// <GlobalConfirmDialog/> (mounted once in main.jsx) renders the active
// request and resolves the caller's promise.
//
// Only one confirm is ever visible at a time (mirrors window.confirm's
// blocking nature) — a second request made while one is open queues behind it.

let _id = 0
const _subscribers = new Set()
const _queue = []
let _active = null

/** Subscribe to the active request (null when none is open). Returns an unsubscribe function. */
export function subscribe(fn) {
  _subscribers.add(fn)
  return () => _subscribers.delete(fn)
}

function _advance() {
  if (!_active && _queue.length) {
    _active = _queue.shift()
  }
  _subscribers.forEach(fn => {
    try { fn(_active) } catch { /* a bad subscriber must not break the bus */ }
  })
}

/** Ask the user to confirm. Resolves true/false, mirroring window.confirm().
 *  opts: { title, confirmLabel, cancelLabel, danger, altLabel }
 *
 *  `altLabel` adds a THIRD answer and resolves the string 'alt'. It exists for
 *  the case where "no" and "not like that" are different answers — cancelling
 *  a recurring series can mean "and clear its booked visits" or "but leave
 *  them on the calendar", and forcing that into yes/no is what made the old
 *  cancel feel like it did nothing. Callers that don't pass it are unchanged;
 *  note that 'alt' is truthy, so only a caller that asked for the third
 *  button ever needs to distinguish it. */
export function confirmDialog(message, opts = {}) {
  return new Promise((resolve) => {
    _queue.push({ id: ++_id, message: String(message), ...opts, resolve })
    _advance()
  })
}

/** Called by <GlobalConfirmDialog/> once the user picks an answer. */
export function resolveConfirm(id, answer) {
  if (_active?.id !== id) return
  const { resolve } = _active
  _active = null
  resolve(answer)
  _advance()
}
