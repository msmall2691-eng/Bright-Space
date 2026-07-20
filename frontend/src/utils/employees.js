/** Resolve a Connecteam employee to an { id, name } pair, defensively.
 *  The roster comes back in mixed shapes: sometimes { id, name }, but the raw
 *  Connecteam user shape is { userId, firstName, lastName, displayName } with
 *  NO `id`. Using `String(e.id)` blindly turns those into the literal string
 *  'undefined' — colliding buttons and a saved cleaner_ids of ['undefined'].
 *  Every flow that assigns cleaners must normalize through this. */
export function normalizeEmployee(e) {
  const id = String(e?.id ?? e?.userId ?? '')
  const composed = [e?.firstName, e?.lastName].filter(Boolean).join(' ').trim()
  const name = e?.name || e?.displayName || composed || `Cleaner ${id}`
  return { id, name }
}
