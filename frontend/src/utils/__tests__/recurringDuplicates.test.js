import { describe, it, expect, beforeEach } from 'vitest'
import {
  seriesDupKey,
  isLiveSeries,
  groupDuplicateSeries,
  parseSimilarSeriesConflict,
  suggestKeeper,
  loadReviewedDupKeys,
  saveReviewedDupKeys,
  seriesState,
  SERIES_STATE_LABEL,
} from '../recurringDuplicates'

// Local YYYY-MM-DD offsets for isLiveSeries boundaries.
const ymd = (offsetDays) => {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const base = {
  client_id: 7, property_id: 12, frequency: 'biweekly', interval_weeks: 2,
  days_of_week: [1], start_time: '09:00:00', active: true,
}

describe('seriesDupKey', () => {
  it('matches two series with the same client, property, cadence, time, and days', () => {
    expect(seriesDupKey({ ...base })).toBe(seriesDupKey({ ...base }))
  })
  it('is order-insensitive for multi-day schedules', () => {
    expect(seriesDupKey({ ...base, days_of_week: [0, 2] }))
      .toBe(seriesDupKey({ ...base, days_of_week: [2, 0] }))
  })
  it('separates different clients, cadences, properties, and times', () => {
    expect(seriesDupKey({ ...base, client_id: 8 })).not.toBe(seriesDupKey(base))
    expect(seriesDupKey({ ...base, interval_weeks: 1 })).not.toBe(seriesDupKey(base))
    expect(seriesDupKey({ ...base, property_id: 99 })).not.toBe(seriesDupKey(base))
    expect(seriesDupKey({ ...base, property_id: null })).not.toBe(seriesDupKey(base))
    expect(seriesDupKey({ ...base, start_time: '13:00:00' })).not.toBe(seriesDupKey(base))
  })
  it('normalizes HH:MM:SS and HH:MM start times to the same key', () => {
    expect(seriesDupKey({ ...base, start_time: '09:00' }))
      .toBe(seriesDupKey({ ...base, start_time: '09:00:00' }))
  })
  it('falls back to legacy day_of_week when days_of_week is empty', () => {
    expect(seriesDupKey({ ...base, days_of_week: [], day_of_week: 4 }))
      .toBe(seriesDupKey({ ...base, days_of_week: [4] }))
  })
})

describe('isLiveSeries', () => {
  it('is live when active with no end date', () => {
    expect(isLiveSeries({ ...base })).toBe(true)
  })
  it('is not live when paused', () => {
    expect(isLiveSeries({ ...base, active: false })).toBe(false)
  })
  it('is live while the (exclusive) end date is still in the future', () => {
    expect(isLiveSeries({ ...base, series_end_date: ymd(30) })).toBe(true)
  })
  it('is ended once the end date is today or past (how split retires a predecessor)', () => {
    expect(isLiveSeries({ ...base, series_end_date: ymd(0) })).toBe(false)
    expect(isLiveSeries({ ...base, series_end_date: ymd(-10) })).toBe(false)
  })
})

describe('groupDuplicateSeries', () => {
  it('groups two identical live series', () => {
    const groups = groupDuplicateSeries([{ ...base, id: 1 }, { ...base, id: 2 }])
    expect(groups).toHaveLength(1)
    expect(groups[0].members.map(s => s.id).sort()).toEqual([1, 2])
  })
  it('matches on day OVERLAP: a new Wednesday series joins an existing Mon/Wed/Fri one', () => {
    const groups = groupDuplicateSeries([
      { ...base, id: 1, days_of_week: [0, 2, 4] },
      { ...base, id: 2, days_of_week: [2] },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].members.map(s => s.id).sort()).toEqual([1, 2])
  })
  it('does not group series with disjoint day sets', () => {
    expect(groupDuplicateSeries([
      { ...base, id: 1, days_of_week: [0] },
      { ...base, id: 2, days_of_week: [4] },
    ])).toHaveLength(0)
  })
  it('does not group different property / time / cadence', () => {
    expect(groupDuplicateSeries([{ ...base, id: 1 }, { ...base, id: 2, property_id: 99 }])).toHaveLength(0)
    expect(groupDuplicateSeries([{ ...base, id: 1 }, { ...base, id: 2, start_time: '13:00:00' }])).toHaveLength(0)
    expect(groupDuplicateSeries([{ ...base, id: 1 }, { ...base, id: 2, interval_weeks: 1, frequency: 'weekly' }])).toHaveLength(0)
  })
  it('excludes ended series — a retired split predecessor is not a live duplicate', () => {
    expect(groupDuplicateSeries([
      { ...base, id: 1 },
      { ...base, id: 2, series_end_date: ymd(-1) },
    ])).toHaveLength(0)
    // …but an end date still in the future stays live and still groups.
    expect(groupDuplicateSeries([
      { ...base, id: 1 },
      { ...base, id: 2, series_end_date: ymd(30) },
    ])).toHaveLength(1)
  })
  it('excludes paused series', () => {
    expect(groupDuplicateSeries([
      { ...base, id: 1 },
      { ...base, id: 2, active: false },
    ])).toHaveLength(0)
  })
  it('chains overlapping day sets into one group (union semantics)', () => {
    const groups = groupDuplicateSeries([
      { ...base, id: 1, days_of_week: [0, 2] },
      { ...base, id: 2, days_of_week: [2, 4] },
      { ...base, id: 3, days_of_week: [4] },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].members.map(s => s.id).sort()).toEqual([1, 2, 3])
  })
  it('produces a stable key for the same membership', () => {
    const list = [{ ...base, id: 1 }, { ...base, id: 2 }]
    expect(groupDuplicateSeries(list)[0].key).toBe(groupDuplicateSeries([...list].reverse())[0].key)
  })
  it('groups same-bucket monthly series even with mismatched (cosmetic) day_of_week, matching the backend audit', () => {
    // Monthly cadence has no real day-of-week; day_of_month is what matters
    // and is already part of the bucket key. Two monthly series in the same
    // bucket must group regardless of their unused days_of_week/day_of_week.
    const monthly = { client_id: 7, property_id: 12, frequency: 'monthly',
                       interval_weeks: 1, day_of_month: 15, start_time: '09:00:00', active: true }
    const groups = groupDuplicateSeries([
      { ...monthly, id: 1, days_of_week: [0], day_of_week: 0 },
      { ...monthly, id: 2, days_of_week: [4], day_of_week: 4 },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].members.map(s => s.id).sort()).toEqual([1, 2])
  })
})

describe('parseSimilarSeriesConflict', () => {
  it('extracts matches from the stringified 409 detail api.js produces', () => {
    const err = new Error('similar')
    err.status = 409
    err.detail = JSON.stringify({ detail: 'similar_series_exists', matches: [{ id: 5, cadence: 'Biweekly Tue 9:00' }] })
    const matches = parseSimilarSeriesConflict(err)
    expect(matches).toHaveLength(1)
    expect(matches[0].id).toBe(5)
  })
  it('returns null for other 409s and non-409 errors', () => {
    const other = new Error('Scheduling conflict: cleaner busy')
    other.status = 409
    other.detail = 'Scheduling conflict: cleaner busy'
    expect(parseSimilarSeriesConflict(other)).toBeNull()
    const notFound = new Error('nope')
    notFound.status = 404
    notFound.detail = JSON.stringify({ detail: 'similar_series_exists', matches: [] })
    expect(parseSimilarSeriesConflict(notFound)).toBeNull()
    expect(parseSimilarSeriesConflict(null)).toBeNull()
    expect(parseSimilarSeriesConflict(new Error('plain'))).toBeNull()
  })
})

describe('suggestKeeper', () => {
  it('prefers the series with the most upcoming visits, and says why', () => {
    const sug = suggestKeeper([
      { id: 1, upcoming_job_count: 2, created_at: '2026-01-01T00:00:00' },
      { id: 2, upcoming_job_count: 6, created_at: '2026-06-01T00:00:00' },
    ])
    expect(sug.id).toBe(2)
    expect(sug.reason).toBe('most upcoming visits (6)')
  })
  it('tiebreaks on oldest created_at when upcoming counts match', () => {
    const sug = suggestKeeper([
      { id: 1, upcoming_job_count: 4, created_at: '2026-06-01T00:00:00' },
      { id: 2, upcoming_job_count: 4, created_at: '2026-01-01T00:00:00' },
    ])
    expect(sug.id).toBe(2)
    expect(sug.reason).toBe('tied on upcoming visits — oldest series')
  })
  it('treats a missing created_at as newest, not oldest', () => {
    const sug = suggestKeeper([
      { id: 1, upcoming_job_count: 4, created_at: null },
      { id: 2, upcoming_job_count: 4, created_at: '2026-01-01T00:00:00' },
    ])
    expect(sug.id).toBe(2)
  })
  it('returns null for an empty group', () => {
    expect(suggestKeeper([])).toBeNull()
  })
})

describe('reviewed-group persistence', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a set of skipped group keys', () => {
    saveReviewedDupKeys(new Set(['7|12|weekly|1||09:00|4', '9||biweekly|2||10:00|1']))
    const loaded = loadReviewedDupKeys()
    expect(loaded.has('7|12|weekly|1||09:00|4')).toBe(true)
    expect(loaded.has('9||biweekly|2||10:00|1')).toBe(true)
    expect(loaded.size).toBe(2)
  })
  it('returns an empty set when nothing is stored or the value is corrupt', () => {
    expect(loadReviewedDupKeys().size).toBe(0)
    localStorage.setItem('bb_recurring_dup_reviewed', '{not json')
    expect(loadReviewedDupKeys().size).toBe(0)
  })
})

/**
 * What a series is CALLED.
 *
 * Cancel and pause write identical rows — both clear `active`, and only the
 * button copy differed — so a series the owner cancelled came back reading
 * "Paused" and stayed in the list. Her words: "when I try to cancel or delete
 * them they dont go away". `cancelled_at` is what tells them apart, and this
 * pins that one series can't be called two things on two screens.
 */
describe('seriesState', () => {
  const live = { active: true }
  const paused = { active: false }
  const cancelled = { active: false, cancelled_at: '2026-08-23T12:00:00' }
  const ended = { active: true, series_end_date: '2020-01-01' }

  it('separates cancelled from paused', () => {
    expect(seriesState(paused)).toBe('paused')
    expect(seriesState(cancelled)).toBe('cancelled')
  })

  it('still calls a running series active and a retired one ended', () => {
    expect(seriesState(live)).toBe('active')
    // How a split retires its predecessor: active stays true, end date passes.
    expect(seriesState(ended)).toBe('ended')
  })

  it('reads a row written before the column existed as paused, not cancelled', () => {
    // Every pre-migration row has cancelled_at NULL. If those flipped to
    // "Cancelled" on deploy day, half the list would relabel itself overnight.
    expect(seriesState({ active: false, cancelled_at: null })).toBe('paused')
    expect(seriesState({ active: false })).toBe('paused')
  })

  it('prefers active over cancelled if a row somehow has both', () => {
    // Belt and braces: resuming clears the stamp server-side, but a row that
    // is generating visits must never be labelled Cancelled.
    expect(seriesState({ active: true, cancelled_at: '2026-08-23T12:00:00' }))
      .toBe('active')
  })

  it('has a label for every state it can return', () => {
    for (const s of [live, paused, cancelled, ended]) {
      expect(SERIES_STATE_LABEL[seriesState(s)]).toBeTruthy()
    }
  })

  it('survives a missing series without throwing', () => {
    expect(seriesState(undefined)).toBe('paused')
  })
})
