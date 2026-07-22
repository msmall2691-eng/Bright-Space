/**
 * Two bugs a Codex review caught on the initial version of this module
 * (PR #546):
 *
 * 1. "future"/"all" always anchored split_date on originalDate. When a visit
 *    moves to an EARLIER date (e.g. dragged from Wednesday to that same
 *    week's Monday), the new schedule's floor (series_start_date =
 *    split_date) would then be AFTER the target Monday, so that occurrence
 *    could never be generated — it silently vanishes for a full cycle.
 *    split_date must be whichever of the two dates is earlier.
 *
 * 2. Only days_of_week/day_of_week were ever sent, but a MONTHLY schedule's
 *    generator (modules/recurring/router.py generate_dates) reads
 *    day_of_month instead and ignores days_of_week entirely — so moving a
 *    monthly visit to a new day never actually updated the monthly pattern.
 *    Both fields must be sent; the backend uses whichever matches the
 *    schedule's actual frequency and ignores the other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api', () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }))

import { get, post, patch } from '../../api'
import { rescheduleRecurringVisit, isoDateToBackendDow, shiftSeriesWeekday } from '../recurringReschedule'

beforeEach(() => {
  vi.clearAllMocks()
  post.mockResolvedValue({})
  patch.mockResolvedValue({})
  // Default: series with no recorded day set → single-day fallback, matching
  // the pre-existing assertions. Multi-day tests override this per case.
  get.mockResolvedValue({})
})

describe('isoDateToBackendDow', () => {
  it('maps Monday to 0 and Sunday to 6 (backend convention)', () => {
    expect(isoDateToBackendDow('2026-01-05')).toBe(0) // Monday
    expect(isoDateToBackendDow('2026-01-11')).toBe(6) // Sunday
  })
})

describe('rescheduleRecurringVisit — "this"', () => {
  it('posts a reschedule exception for just the one occurrence', async () => {
    await rescheduleRecurringVisit('this', {
      schedId: 42, originalDate: '2026-01-07', newDate: '2026-01-08',
      newStart: '09:00', newEnd: '11:00', cleanerIds: ['a'],
    })
    expect(post).toHaveBeenCalledWith('/api/recurring/42/reschedule', expect.objectContaining({
      exception_date: '2026-01-07', rescheduled_date: '2026-01-08',
    }))
  })
})

describe('rescheduleRecurringVisit — "future" split_date anchoring', () => {
  it('uses newDate as split_date when the visit moves to an EARLIER date', async () => {
    // Wednesday (2026-01-07) dragged back to the same week's Monday (2026-01-05).
    await rescheduleRecurringVisit('future', {
      schedId: 42, originalDate: '2026-01-07', newDate: '2026-01-05',
      newStart: '09:00', newEnd: '11:00', cleanerIds: ['a'],
    })
    expect(post).toHaveBeenCalledWith('/api/recurring/42/split', expect.objectContaining({
      split_date: '2026-01-05',
    }))
  })

  it('uses originalDate as split_date when the visit moves to a LATER date', async () => {
    await rescheduleRecurringVisit('future', {
      schedId: 42, originalDate: '2026-01-05', newDate: '2026-01-07',
      newStart: '09:00', newEnd: '11:00', cleanerIds: ['a'],
    })
    expect(post).toHaveBeenCalledWith('/api/recurring/42/split', expect.objectContaining({
      split_date: '2026-01-05',
    }))
  })

  it('sends day_of_month alongside days_of_week so monthly schedules update too', async () => {
    await rescheduleRecurringVisit('future', {
      schedId: 42, originalDate: '2026-01-15', newDate: '2026-01-20',
      newStart: '09:00', newEnd: '11:00', cleanerIds: ['a'],
    })
    expect(post).toHaveBeenCalledWith('/api/recurring/42/split', expect.objectContaining({
      day_of_month: 20,
      days_of_week: [isoDateToBackendDow('2026-01-20')],
    }))
  })

  it('omits day fields entirely when only the time changed (same date)', async () => {
    await rescheduleRecurringVisit('future', {
      schedId: 42, originalDate: '2026-01-07', newDate: '2026-01-07',
      newStart: '14:00', newEnd: '16:00', cleanerIds: ['a'],
    })
    const payload = post.mock.calls[0][1]
    expect(payload.day_of_month).toBeUndefined()
    expect(payload.days_of_week).toBeUndefined()
  })
})

describe('shiftSeriesWeekday — keep the other days of a multi-day series', () => {
  it('replaces only the dragged weekday, preserving the rest', () => {
    // Mon/Wed/Fri (0,2,4): move the Wed (2) leg to Thu (3) → Mon/Thu/Fri.
    expect(shiftSeriesWeekday([0, 2, 4], 2, 3)).toEqual([0, 3, 4])
  })
  it('collapses to the target for a single-day series', () => {
    expect(shiftSeriesWeekday([2], 2, 3)).toEqual([3])
  })
  it('falls back to the target when the series has no day filter', () => {
    expect(shiftSeriesWeekday([], 2, 3)).toEqual([3])
    expect(shiftSeriesWeekday(null, 2, 3)).toEqual([3])
  })
  it('merges when dragged onto a day the series already has', () => {
    // Mon/Wed (0,2): move Wed (2) onto Mon (0) → just Mon.
    expect(shiftSeriesWeekday([0, 2], 2, 0)).toEqual([0])
  })
})

describe('rescheduleRecurringVisit — multi-day series is not collapsed', () => {
  it('shifts only the dragged weekday and keeps the others on a "future" split', async () => {
    get.mockResolvedValue({ days_of_week: [0, 2, 4] }) // Mon/Wed/Fri
    // Drag the Wednesday (2026-01-07) leg to Thursday (2026-01-08).
    await rescheduleRecurringVisit('future', {
      schedId: 42, originalDate: '2026-01-07', newDate: '2026-01-08',
      newStart: '09:00', newEnd: '11:00', cleanerIds: ['a'],
    })
    expect(get).toHaveBeenCalledWith('/api/recurring/42')
    expect(post).toHaveBeenCalledWith('/api/recurring/42/split', expect.objectContaining({
      days_of_week: [0, 3, 4], // Mon/Thu/Fri — Wed replaced by Thu, others kept
    }))
  })

  it('shifts only the dragged weekday on an "all" resync', async () => {
    get.mockResolvedValue({ days_of_week: [0, 2, 4] })
    await rescheduleRecurringVisit('all', {
      schedId: 42, originalDate: '2026-01-07', newDate: '2026-01-08',
      newStart: '09:00', newEnd: '11:00', cleanerIds: ['a'],
    })
    expect(patch).toHaveBeenCalledWith('/api/recurring/42', expect.objectContaining({
      days_of_week: [0, 3, 4], resync: true,
    }))
  })
})

describe('rescheduleRecurringVisit — "all" mirrors the same split_date + day fields', () => {
  it('sends day_of_month for a monthly move', async () => {
    await rescheduleRecurringVisit('all', {
      schedId: 42, originalDate: '2026-01-15', newDate: '2026-01-03',
      newStart: '09:00', newEnd: '11:00', cleanerIds: ['a'],
    })
    expect(patch).toHaveBeenCalledWith('/api/recurring/42', expect.objectContaining({
      day_of_month: 3,
      resync: true,
    }))
  })
})
