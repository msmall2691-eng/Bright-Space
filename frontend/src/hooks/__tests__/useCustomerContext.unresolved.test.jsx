/**
 * "Nobody closed out Thursday's visit" — derived, not fetched.
 *
 * The owner sent a screenshot of a customer writing *"no one came
 * yesterday."* The app knew: a job sat on the calendar for that day, still
 * `scheduled`. The thread had already fetched it — `useCustomerContext` pulls
 * every job for the client — and then flattened it away, because `pastJobs`
 * is "completed OR dated before today", which makes an unresolved visit
 * indistinguishable from history.
 *
 * So what is pinned here is the CLASSIFICATION, because that is the whole
 * feature. The Job vocabulary is
 * `unscheduled | scheduled | in_progress | completed | cancelled`
 * (backend/database/models.py), and each one is here deliberately:
 *
 *   completed   resolved — we went
 *   cancelled   resolved — we agreed not to go
 *   unscheduled no date to be late against
 *   scheduled   PAST-DATED: the calendar still believes in it
 *   in_progress PAST-DATED: someone started it and never closed it
 *
 * Getting `cancelled` wrong would nag the operator about work a customer
 * called off; getting `in_progress` wrong would hide a crew member's
 * unfinished job. Both are asserted rather than assumed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'

vi.mock('../../api', () => ({ get: vi.fn() }))
vi.mock('../../utils/format', async (orig) => ({
  ...(await orig()),
  // Pin "today" so the fixtures below don't drift into the past and start
  // passing for the wrong reason.
  todayYMD: () => '2026-10-10',
}))

import { get } from '../../api'
import { useCustomerContext } from '../useCustomerContext'

const job = (over) => ({
  id: 1, title: 'Clean', scheduled_date: '2026-10-09', status: 'scheduled', ...over,
})

function withJobs(jobs) {
  get.mockImplementation((url) =>
    String(url).startsWith('/api/jobs') ? Promise.resolve(jobs) : Promise.resolve([]))
  return renderHook(() => useCustomerContext(42))
}

const unresolvedIds = async (jobs) => {
  const { result } = withJobs(jobs)
  await waitFor(() => expect(result.current.loading).toBe(false))
  return result.current.unresolvedVisits.map(j => j.id)
}

beforeEach(() => { get.mockReset() })
afterEach(cleanup)

describe('what counts as a visit nobody closed out', () => {
  it('counts a past-dated scheduled visit', async () => {
    expect(await unresolvedIds([job({ id: 1 })])).toEqual([1])
  })

  it('counts a past-dated in_progress visit', async () => {
    // Started and never finished. Easy to forget, and the one most likely to
    // be a real "we were there but something went wrong".
    expect(await unresolvedIds([job({ id: 2, status: 'in_progress' })])).toEqual([2])
  })

  it('does not count a completed visit', async () => {
    expect(await unresolvedIds([job({ id: 3, status: 'completed' })])).toEqual([])
  })

  it('does not count a cancelled visit', async () => {
    // The customer called it off. Nagging about it would be worse than silence.
    expect(await unresolvedIds([job({ id: 4, status: 'cancelled' })])).toEqual([])
  })

  it('does not count a dated-nowhere job, whatever its status says', async () => {
    // `scheduled_date` is nullable (models.py), so a row can read `scheduled`
    // with no date — the kind of drift data-doctor exists to find. It must
    // not become a missed visit: the note's whole job is to NAME the day, and
    // there isn't one. Without the explicit date check, `('' < today)` is
    // true and this falls through on the status alone.
    expect(await unresolvedIds([job({ id: 6, status: 'scheduled', scheduled_date: null })])).toEqual([])
  })

  it('does not count an unscheduled job', async () => {
    // A converted quote with no date yet. It cannot be late.
    expect(await unresolvedIds([job({ id: 5, status: 'unscheduled', scheduled_date: null })])).toEqual([])
  })

  it("does not count today's visit, or a future one", async () => {
    // The day is not over. This is the boundary that decides whether the
    // operator gets nagged about work that is happening right now.
    const ids = await unresolvedIds([
      job({ id: 6, scheduled_date: '2026-10-10' }),
      job({ id: 7, scheduled_date: '2026-10-11' }),
    ])
    expect(ids).toEqual([])
  })

  it('lists the most recent first', async () => {
    const ids = await unresolvedIds([
      job({ id: 8, scheduled_date: '2026-09-01' }),
      job({ id: 9, scheduled_date: '2026-10-09' }),
      job({ id: 10, scheduled_date: '2026-10-01' }),
    ])
    expect(ids, 'the note names the first one, so order is load-bearing').toEqual([9, 10, 8])
  })

  it('is empty, not undefined, with no client', async () => {
    const { result } = renderHook(() => useCustomerContext(null))
    expect(result.current.unresolvedVisits).toEqual([])
  })
})

describe('it costs no extra request', () => {
  it('derives from the jobs the thread already fetched', async () => {
    const { result } = withJobs([job({ id: 1 })])
    await waitFor(() => expect(result.current.loading).toBe(false))

    const jobCalls = get.mock.calls.filter(c => String(c[0]).startsWith('/api/jobs'))
    expect(jobCalls, 'one client-scoped jobs read, as before').toHaveLength(1)
    expect(get, 'quotes + jobs + invoices, unchanged').toHaveBeenCalledTimes(3)
  })
})

describe('it never describes the previous customer', () => {
  it('clears everything the moment the client changes', async () => {
    // Switching threads re-runs the effect, but three requests take a moment.
    // Until they landed, this hook kept serving client A's jobs — so the
    // thread for client B showed A's unresolved-visit note, linking to A's
    // job. A blank panel for 200ms is the better wrong answer.
    let resolveB
    get.mockImplementation((url) => {
      if (!String(url).startsWith('/api/jobs')) return Promise.resolve([])
      return String(url).includes('client_id=42')
        ? Promise.resolve([job({ id: 1 })])
        : new Promise(res => { resolveB = res })  // B's jobs hang
    })

    const { result, rerender } = renderHook(({ id }) => useCustomerContext(id),
      { initialProps: { id: 42 } })
    await waitFor(() => expect(result.current.unresolvedVisits).toHaveLength(1))

    rerender({ id: 99 })
    expect(
      result.current.unresolvedVisits,
      "client B's thread is showing client A's missed visit",
    ).toEqual([])
    expect(result.current.upcomingJobs).toEqual([])
    expect(result.current.stats.visitCount).toBe(0)

    resolveB?.([])
  })
})
