import { get, post } from '../api'

/**
 * One definition of "create a client, but check for duplicates first" — so
 * every "+ New client" affordance (the Clients form AND the inline mini-forms
 * in Schedule, Property and Quoting) dedups the same way instead of blindly
 * POSTing and showing a raw 409. The backend already guards (409 with the full
 * matching clients + ?force=true to override) and offers a pre-check endpoint;
 * this wires the UI to both.
 */

/** Pre-check: returns the matching clients (or []) without creating anything. */
export async function checkClientDuplicates({ name, phone, email } = {}) {
  const q = new URLSearchParams()
  if (name) q.set('name', String(name).trim())
  if (phone) q.set('phone', String(phone).trim())
  if (email) q.set('email', String(email).trim())
  if (![...q.keys()].length) return []
  const res = await get(`/api/clients/check-duplicate?${q.toString()}`).catch(() => null)
  return res?.duplicates || []
}

/**
 * api.js flattens a FastAPI error so `err.detail` is a JSON *string*, not an
 * object — so reading the duplicates array off a 409 needs a parse (the old
 * `e?.detail?.duplicates` fallback silently never matched). Returns [] for
 * anything that isn't a dedup 409.
 */
export function duplicatesFrom409(err) {
  if (err?.status !== 409) return []
  let d = err.detail
  if (typeof d === 'string') {
    try { d = JSON.parse(d) } catch { return [] }
  }
  return Array.isArray(d?.duplicates) ? d.duplicates : []
}

/**
 * Create a client with a duplicate check.
 *   - force=false: pre-checks; if matches exist, returns
 *     {status:'duplicates', duplicates} WITHOUT creating.
 *   - force=true (or no matches): POSTs (with ?force=true when forced) and
 *     returns {status:'created', client}.
 * A server-side 409 (a match the pre-check missed — a secondary phone, a race)
 * also comes back as {status:'duplicates'} so the caller shows the same prompt.
 */
export async function createClientChecked(payload, { force = false } = {}) {
  if (!force) {
    const dupes = await checkClientDuplicates(payload)
    if (dupes.length) return { status: 'duplicates', duplicates: dupes }
  }
  try {
    const client = await post(`/api/clients${force ? '?force=true' : ''}`, payload)
    return { status: 'created', client }
  } catch (err) {
    const dupes = duplicatesFrom409(err)
    if (dupes.length) return { status: 'duplicates', duplicates: dupes }
    throw err
  }
}
