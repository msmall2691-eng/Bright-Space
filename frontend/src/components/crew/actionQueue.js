/**
 * Offline queue for the two crew actions that must not be lost: marking a job
 * done, and answering an assignment.
 *
 * WHY. My Day already survives a dead zone for READING — `bb_myday_cache` in
 * MyDay.jsx keeps today's work on screen with no signal — and photos survive
 * for WRITING, via photoQueue.js. Everything in between just failed. A cleaner
 * finishing a house with no bars tapped "Mark done", got "Could not mark the
 * job done", drove away, and forgot; the office saw an open job and chased
 * them. The most important action in the whole crew app was the one with no
 * safety net.
 *
 * NOT A SECOND SOURCE OF TRUTH. This is a client-side retry buffer, nothing
 * more: it replays the SAME authenticated POST to the SAME canonical endpoint
 * the button already called. BrightBase's Job stays the single owner of
 * schedule state (scheduling-invariants Rule 0) — the phone never decides
 * anything, it just finishes sending. No new tick and no polling either
 * (R1 / economy rule 2): the flush rides the `online` and connection-change
 * listeners MyDay.jsx already registers for photos.
 *
 * REPLAY IS SAFE, which is what makes this honest rather than hopeful:
 *   - POST /jobs/{id}/complete is idempotent by contract — "re-marking an
 *     already-completed job just refreshes the note; no duplicate activity or
 *     invoice";
 *   - POST /jobs/{id}/respond keeps one row per (job, cleaner), updated in
 *     place, with a unique constraint backstopping races.
 * So a double flush cannot double-complete or double-answer. We still dedupe
 * by (kind, jobId) below, because a replayed decline re-pings the office and
 * nobody needs to be told twice.
 *
 * NO WIFI DEFERRAL, deliberately — this is where it differs from photoQueue.
 * Photos wait for WiFi because a batch of them is genuinely expensive on a
 * rural plan. These bodies are a job id and maybe a sentence. Holding one back
 * to save ~100 bytes would leave the office believing a house is uncleaned, so
 * actions go the moment there is any connection at all.
 *
 * FAIL-SOFT, like the photo queue: no IndexedDB, storage blocked, queue full →
 * `enqueueAction` returns false and the caller shows its normal error. The
 * queue is a courtesy, never a gate.
 */

import { post } from '../../api'

const DB_NAME = 'bb-action-queue'
const STORE = 'actions'

// Bodies here are tiny (an id, a short note), so there's no byte cap — only a
// count, and a generous one. Past it something is wrong rather than busy.
export const MAX_QUEUE_ITEMS = 50
// A record that keeps failing on something retryable gets dropped rather than
// retried forever.
const MAX_ATTEMPTS = 8
// A day's work is the horizon. An action older than this is no longer
// something the office can act on, and replaying it would be confusing.
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * HTTP statuses where replaying will never succeed, so the record is dropped
 * instead of retried: the job was cancelled (400), isn't theirs or is gone
 * (403/404), the body is rejected (409/422). api.js attaches `status` to the
 * error it throws, which is what makes this distinguishable from "no signal".
 *
 * 408 and 429 are deliberately NOT here — a timeout or a rate limit is exactly
 * the case worth retrying, and so is every 5xx.
 */
const PERMANENT_STATUSES = new Set([400, 403, 404, 409, 422])

// ── Tiny promise wrapper over IndexedDB (same shape as photoQueue.js) ────────

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

// ── Change notifications (for the "waiting to send" line) ────────────────────

const listeners = new Set()

/** Subscribe to pending-count changes. Fires immediately with the current
 *  count; returns an unsubscribe function. */
export function subscribeActions(cb) {
  listeners.add(cb)
  pendingActionCount().then((n) => { if (listeners.has(cb)) cb(n) })
  return () => listeners.delete(cb)
}

async function notify() {
  const n = await pendingActionCount()
  listeners.forEach((cb) => { try { cb(n) } catch { /* listener's problem */ } })
}

/** Number of actions waiting. 0 when the queue is unavailable. */
export async function pendingActionCount() {
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
 * Queue one action for later. `kind` is what the cleaner did ('complete' |
 * 'respond'), used with `jobId` to dedupe: tapping done twice with no signal,
 * or changing an answer from accepted to declined, REPLACES the pending record
 * rather than stacking a second one. The last thing they did is what gets
 * sent.
 *
 * Returns true when queued, false when the queue is unavailable or full — in
 * which case the caller should surface its normal error, because nothing was
 * saved.
 */
export async function enqueueAction({ url, body = {}, kind, jobId }) {
  if (!url || !kind) return false
  try {
    const db = await openDb()
    const rows = await getAllRecords(db)

    // Dedupe first, so replacing an existing record never trips the cap.
    const supersedes = rows.filter((r) => r.kind === kind && r.jobId === jobId)
    for (const dup of supersedes) await deleteRecord(db, dup.id).catch(() => {})

    if (rows.length - supersedes.length >= MAX_QUEUE_ITEMS) {
      db.close()
      return false
    }
    await addRecord(db, {
      url, body, kind, jobId,
      createdAt: Date.now(), attempts: 0,
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
 * Send everything waiting, oldest first. Unlike the photo queue there is no
 * cellular check — see the file header. Stops at the first RETRYABLE failure,
 * since that usually means the connection died again and hammering a dead link
 * burns battery; a permanent failure (see PERMANENT_STATUSES) drops just that
 * record and keeps going, because one cancelled job must not block a
 * completion behind it.
 *
 * Returns { sent, dropped } so the caller can tell "your work went through"
 * from "one of these could not be sent".
 */
export async function flushActionQueue() {
  if (flushing) return { sent: 0, dropped: 0 }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { sent: 0, dropped: 0 }
  }
  flushing = true
  let sent = 0
  let dropped = 0
  let changed = false
  try {
    const db = await openDb()
    const rows = (await getAllRecords(db))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    for (const rec of rows) {
      // Expire poison/stale records instead of retrying forever.
      if ((rec.attempts || 0) >= MAX_ATTEMPTS ||
          Date.now() - (rec.createdAt || 0) > MAX_AGE_MS) {
        await deleteRecord(db, rec.id)
        dropped++
        changed = true
        continue
      }
      try {
        await post(rec.url, rec.body || {})
        await deleteRecord(db, rec.id)
        sent++
        changed = true
      } catch (e) {
        if (PERMANENT_STATUSES.has(e?.status)) {
          // Will never succeed — drop this one and carry on with the rest.
          await deleteRecord(db, rec.id).catch(() => {})
          dropped++
          changed = true
          continue
        }
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
  return { sent, dropped }
}

/**
 * True when a failure looks like "no signal" rather than "the server said no".
 * Only these get queued: a 400 "this job was cancelled" is a real answer the
 * cleaner needs to see, not something to hide behind a retry.
 *
 * api.js throws a TypeError for a network/DNS failure and sets `isTimeout` on
 * a timeout; a 5xx carries a status. Anything with a permanent 4xx status, or
 * no recognizable shape at all, is surfaced to the cleaner as before.
 */
export function looksOffline(e) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  if (e?.isTimeout) return true
  if (e instanceof TypeError) return true          // fetch could not reach the host
  const s = e?.status
  if (typeof s === 'number') return s >= 500 || s === 408
  return false
}
