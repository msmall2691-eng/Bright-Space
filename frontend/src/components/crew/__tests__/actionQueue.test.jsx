/**
 * The crew offline action queue (components/crew/actionQueue.js).
 *
 * What is pinned here, and why each one matters:
 *
 *   * a tap made with NO SIGNAL is kept, and a tap the SERVER REFUSED is not.
 *     That distinction is the whole feature. Queue a 400 "this job was
 *     cancelled" and the cleaner never learns the job was cancelled; surface a
 *     network blip as an error and they drive away believing the office knows
 *     a house is clean when it does not;
 *   * re-tapping replaces rather than stacks. Replay is safe server-side
 *     (complete is idempotent, respond is one row per (job, cleaner)), but a
 *     replayed decline re-pings the office and nobody needs telling twice;
 *   * a permanently-failing record is dropped WITHOUT blocking the queue, so
 *     one cancelled job can't hold a completion hostage behind it;
 *   * it degrades to "not queued" wherever IndexedDB isn't usable, because the
 *     caller then shows its normal error -- a queue that silently swallows a
 *     tap it did not store would be worse than no queue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// A real IndexedDB implementation, so these tests exercise the queue's actual
// storage path rather than a hand-rolled stub of it. jsdom ships no IndexedDB;
// photoQueue.test.js only covers the no-IndexedDB fail-soft path for exactly
// that reason, which left its real logic untested.
import { IDBFactory } from 'fake-indexeddb'

// The queue posts through the shared api client; that is the seam.
vi.mock('../../../api', () => ({ post: vi.fn() }))
import { post } from '../../../api'

import {
  enqueueAction, flushActionQueue, pendingActionCount,
  subscribeActions, looksOffline, MAX_QUEUE_ITEMS,
} from '../actionQueue'

const COMPLETE = { url: '/api/crew/jobs/7/complete', body: {}, kind: 'complete', jobId: 7 }

beforeEach(() => {
  // A brand-new factory per test, so one test's queue never leaks into the next.
  global.indexedDB = new IDBFactory()
  post.mockReset()
  // Default: the browser believes it is online, so flush is allowed to try.
  Object.defineProperty(global.navigator, 'onLine', { value: true, configurable: true })
})

afterEach(() => { delete global.indexedDB })

describe('looksOffline — what gets queued at all', () => {
  it('treats a failed fetch, a timeout and a 5xx as "no signal"', () => {
    expect(looksOffline(new TypeError('Failed to fetch'))).toBe(true)
    expect(looksOffline(Object.assign(new Error('slow'), { isTimeout: true }))).toBe(true)
    expect(looksOffline(Object.assign(new Error('boom'), { status: 503 }))).toBe(true)
    expect(looksOffline(Object.assign(new Error('gw'), { status: 408 }))).toBe(true)
  })

  it('does NOT hide a real answer from the server', () => {
    // THE load-bearing case. 400 is "this job was cancelled -- check with the
    // office before cleaning". Queueing that silently loses the message.
    expect(looksOffline(Object.assign(new Error('cancelled'), { status: 400 }))).toBe(false)
    expect(looksOffline(Object.assign(new Error('not yours'), { status: 404 }))).toBe(false)
    expect(looksOffline(Object.assign(new Error('bad'), { status: 422 }))).toBe(false)
  })

  it('trusts navigator.onLine === false even for an odd error shape', () => {
    Object.defineProperty(global.navigator, 'onLine', { value: false, configurable: true })
    expect(looksOffline({})).toBe(true)
  })
})

describe('enqueue + flush', () => {
  it('queues a tap and sends it to the same endpoint on flush', async () => {
    expect(await enqueueAction(COMPLETE)).toBe(true)
    expect(await pendingActionCount()).toBe(1)

    post.mockResolvedValue({})
    const { sent, dropped } = await flushActionQueue()
    expect({ sent, dropped }).toEqual({ sent: 1, dropped: 0 })
    expect(post).toHaveBeenCalledWith('/api/crew/jobs/7/complete', {})
    expect(await pendingActionCount()).toBe(0)
  })

  it('replaces rather than stacks when the same job is tapped twice', async () => {
    await enqueueAction({ ...COMPLETE, body: { note: 'first' } })
    await enqueueAction({ ...COMPLETE, body: { note: 'second' } })
    expect(await pendingActionCount()).toBe(1)

    post.mockResolvedValue({})
    await flushActionQueue()
    // The LAST thing the cleaner did is what the office gets.
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/api/crew/jobs/7/complete', { note: 'second' })
  })

  it('keeps a changed answer for the same job as one record', async () => {
    const base = { url: '/api/crew/jobs/9/respond', kind: 'respond', jobId: 9 }
    await enqueueAction({ ...base, body: { response: 'accepted' } })
    await enqueueAction({ ...base, body: { response: 'declined', reason: 'sick' } })
    expect(await pendingActionCount()).toBe(1)

    post.mockResolvedValue({})
    await flushActionQueue()
    expect(post).toHaveBeenCalledWith('/api/crew/jobs/9/respond',
      { response: 'declined', reason: 'sick' })
  })

  it('keeps different jobs separate', async () => {
    await enqueueAction(COMPLETE)
    await enqueueAction({ ...COMPLETE, url: '/api/crew/jobs/8/complete', jobId: 8 })
    expect(await pendingActionCount()).toBe(2)
  })

  it('does nothing while the browser reports itself offline', async () => {
    await enqueueAction(COMPLETE)
    Object.defineProperty(global.navigator, 'onLine', { value: false, configurable: true })
    const { sent } = await flushActionQueue()
    expect(sent).toBe(0)
    expect(post).not.toHaveBeenCalled()
    // Still waiting, not lost.
    expect(await pendingActionCount()).toBe(1)
  })
})

describe('flush failure handling', () => {
  it('keeps a retryable failure queued and stops, rather than hammering a dead link', async () => {
    await enqueueAction(COMPLETE)
    await enqueueAction({ ...COMPLETE, url: '/api/crew/jobs/8/complete', jobId: 8 })

    post.mockRejectedValue(new TypeError('Failed to fetch'))
    const { sent, dropped } = await flushActionQueue()
    expect({ sent, dropped }).toEqual({ sent: 0, dropped: 0 })
    // Stopped after the first failure: one attempt, not two.
    expect(post).toHaveBeenCalledTimes(1)
    expect(await pendingActionCount()).toBe(2)
  })

  it('drops a permanently-refused record and still sends the one behind it', async () => {
    // The case that makes "stop at the first failure" alone wrong: a cancelled
    // job must not block a completed one forever.
    await enqueueAction(COMPLETE)
    await enqueueAction({ ...COMPLETE, url: '/api/crew/jobs/8/complete', jobId: 8 })

    post.mockImplementation((url) => url.includes('/7/')
      ? Promise.reject(Object.assign(new Error('cancelled'), { status: 400 }))
      : Promise.resolve({}))

    const { sent, dropped } = await flushActionQueue()
    expect({ sent, dropped }).toEqual({ sent: 1, dropped: 1 })
    expect(await pendingActionCount()).toBe(0)
  })
})

describe('degrading safely', () => {
  it('reports "not queued" with no IndexedDB, so the caller shows its error', async () => {
    delete global.indexedDB
    expect(await enqueueAction(COMPLETE)).toBe(false)
    expect(await pendingActionCount()).toBe(0)
  })

  it('refuses an action with no url or kind instead of storing a dud', async () => {
    expect(await enqueueAction({ jobId: 1 })).toBe(false)
    expect(await enqueueAction({ url: '/x', jobId: 1 })).toBe(false)
  })

  it('notifies subscribers of the pending count', async () => {
    const seen = []
    const unsub = subscribeActions((n) => seen.push(n))
    await enqueueAction(COMPLETE)
    await new Promise((r) => setTimeout(r, 5))
    expect(seen.at(-1)).toBe(1)
    unsub()
  })

  it('caps the queue so a broken connection cannot fill storage', async () => {
    for (let i = 0; i < MAX_QUEUE_ITEMS; i++) {
      await enqueueAction({ ...COMPLETE, url: `/api/crew/jobs/${i}/complete`, jobId: i })
    }
    expect(await pendingActionCount()).toBe(MAX_QUEUE_ITEMS)
    // Past the cap it declines, so the caller errors rather than believing a
    // tap was saved when it wasn't.
    expect(await enqueueAction({ ...COMPLETE, url: '/api/crew/jobs/999/complete', jobId: 999 }))
      .toBe(false)
  })
})
