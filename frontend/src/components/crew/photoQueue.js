/**
 * Cellular-aware upload queue for crew job photos.
 *
 * Rural-Maine data plans are the constraint: photos are already downscaled
 * client-side (utils/imageDownscale.js), but a batch of "after" shots on one
 * bar of LTE is still slow AND expensive. Where the browser can actually tell
 * us the connection is cellular (Network Information API — Android Chrome;
 * iOS never exposes it), photo uploads wait in IndexedDB and flush when the
 * connection changes or the app next opens — with a visible "waiting for
 * WiFi" line and a Send-now override, never a silent black hole.
 *
 * Fail-soft everywhere: no IndexedDB, storage full, over the size cap → the
 * caller uploads immediately, exactly as before. The queue is a courtesy,
 * never a gate. Blobs live only in IndexedDB on the cleaner's own device and
 * upload through the same authenticated endpoint as a direct send.
 */
import { upload } from '../../api'

const DB_NAME = 'bb-photo-queue'
const STORE = 'photos'
// Caps: a queue this size means something is wrong (or a very long day) —
// past it we fall back to direct upload rather than hoarding storage.
export const MAX_QUEUE_ITEMS = 30
export const MAX_QUEUE_BYTES = 24 * 1024 * 1024
// Records that keep failing (job unassigned, photo rejected) get dropped
// after this many flush attempts instead of poisoning the queue forever.
const MAX_ATTEMPTS = 8
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** True only when the platform explicitly says "cellular". `effectiveType`
 *  ("4g") measures speed, not metering, so only `type` counts — where it's
 *  unsupported (iOS, most desktops) we never defer. */
export function onCellular() {
  const c = typeof navigator !== 'undefined' &&
    (navigator.connection || navigator.mozConnection || navigator.webkitConnection)
  return !!c && c.type === 'cellular'
}

// ── Tiny promise wrapper over IndexedDB ──────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no idb'))
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('idb open failed'))
    req.onblocked = () => reject(new Error('idb blocked'))
  })
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const out = run(t.objectStore(STORE))
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined)
    t.onerror = () => reject(t.error || new Error('idb tx failed'))
    t.onabort = () => reject(t.error || new Error('idb tx aborted'))
  })
}

const getAllRecords = (db) => tx(db, 'readonly', (s) => s.getAll())
const putRecord = (db, rec) => tx(db, 'readwrite', (s) => s.put(rec))
const addRecord = (db, rec) => tx(db, 'readwrite', (s) => s.add(rec))
const deleteRecord = (db, id) => tx(db, 'readwrite', (s) => s.delete(id))

// ── Change notifications (for the "N waiting" line) ──────────────────────────

const listeners = new Set()

/** Subscribe to pending-count changes. Fires immediately with the current
 *  count; returns an unsubscribe function. */
export function subscribeQueue(cb) {
  listeners.add(cb)
  pendingCount().then((n) => { if (listeners.has(cb)) cb(n) })
  return () => listeners.delete(cb)
}

async function notify() {
  const n = await pendingCount()
  listeners.forEach((cb) => { try { cb(n) } catch { /* listener's problem */ } })
}

/** Number of photos waiting. 0 when the queue is unavailable. */
export async function pendingCount() {
  try {
    const db = await openDb()
    const rows = await getAllRecords(db)
    db.close()
    return rows.length
  } catch {
    return 0
  }
}

// ── Enqueue / flush ──────────────────────────────────────────────────────────

/**
 * Queue one photo for later upload. `url` is the POST endpoint, `fields` the
 * extra FormData fields (e.g. { kind: 'before' }). Returns true when queued;
 * false when the queue is unavailable or full — the caller should upload
 * directly in that case.
 */
export async function enqueuePhoto({ url, blob, filename, fields = {} }) {
  try {
    const db = await openDb()
    const rows = await getAllRecords(db)
    const bytes = rows.reduce((n, r) => n + (r.size || 0), 0)
    if (rows.length >= MAX_QUEUE_ITEMS || bytes + blob.size > MAX_QUEUE_BYTES) {
      db.close()
      return false
    }
    await addRecord(db, {
      url, blob, filename, fields,
      size: blob.size, createdAt: Date.now(), attempts: 0,
    })
    db.close()
    notify()
    return true
  } catch {
    return false
  }
}

let flushing = false

/**
 * Upload everything waiting, oldest first. Skips silently while on cellular
 * unless `force` (the cleaner's "Send now" override). Stops at the first
 * upload failure — mid-flush failures usually mean the connection died, and
 * hammering a dead link burns battery and data. Failed records retry on the
 * next flush and are dropped after MAX_ATTEMPTS (or MAX_AGE). Returns the
 * number uploaded.
 */
export async function flushPhotoQueue({ force = false } = {}) {
  if (flushing) return 0
  if (!force && onCellular()) return 0
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0
  flushing = true
  let sent = 0
  let changed = false
  try {
    const db = await openDb()
    const rows = (await getAllRecords(db)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    for (const rec of rows) {
      // Expire poison/stale records instead of retrying forever.
      if ((rec.attempts || 0) >= MAX_ATTEMPTS ||
          Date.now() - (rec.createdAt || 0) > MAX_AGE_MS) {
        await deleteRecord(db, rec.id)
        changed = true
        continue
      }
      const form = new FormData()
      form.append('file', rec.blob, rec.filename || 'photo.jpg')
      for (const [k, v] of Object.entries(rec.fields || {})) form.append(k, v)
      try {
        await upload(rec.url, form)
        await deleteRecord(db, rec.id)
        sent++
        changed = true
      } catch {
        rec.attempts = (rec.attempts || 0) + 1
        await putRecord(db, rec).catch(() => {})
        break
      }
    }
    db.close()
  } catch {
    /* queue unavailable — nothing to flush */
  } finally {
    flushing = false
  }
  if (changed) notify()
  return sent
}
