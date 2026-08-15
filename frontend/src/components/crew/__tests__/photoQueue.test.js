/**
 * The photo queue must be a courtesy, never a gate: in any environment where
 * IndexedDB or the Network Information API is missing (iOS Safari, jsdom,
 * private windows), every function fails soft so callers fall back to plain
 * direct uploads. jsdom has neither API, which makes it exactly the hostile
 * environment worth pinning.
 */
import { describe, it, expect } from 'vitest'
import {
  onCellular, enqueuePhoto, flushPhotoQueue, pendingCount, subscribeQueue,
} from '../photoQueue'

describe('photoQueue without IndexedDB / connection info (fail-soft)', () => {
  it('reports not-cellular when the platform cannot say', () => {
    expect(onCellular()).toBe(false)
  })

  it('refuses to enqueue (caller then uploads directly)', async () => {
    const ok = await enqueuePhoto({
      url: '/api/crew/jobs/1/photos',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      filename: 'photo.jpg',
      fields: { kind: 'before' },
    })
    expect(ok).toBe(false)
  })

  it('counts zero pending and flushes zero without throwing', async () => {
    expect(await pendingCount()).toBe(0)
    expect(await flushPhotoQueue()).toBe(0)
    expect(await flushPhotoQueue({ force: true })).toBe(0)
  })

  it('subscribe fires with the current (zero) count and unsubscribes cleanly', async () => {
    const seen = []
    const unsub = subscribeQueue(n => seen.push(n))
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toEqual([0])
    unsub()
  })
})
