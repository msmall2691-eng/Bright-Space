import { describe, it, expect, beforeEach } from 'vitest'
import {
  seriesDupKey,
  suggestKeeper,
  loadReviewedDupKeys,
  saveReviewedDupKeys,
} from '../recurringDuplicates'

describe('seriesDupKey', () => {
  it('matches two series with the same client, cadence, and days', () => {
    const a = { client_id: 7, frequency: 'biweekly', interval_weeks: 2, days_of_week: [4] }
    const b = { client_id: 7, frequency: 'biweekly', interval_weeks: 2, days_of_week: [4] }
    expect(seriesDupKey(a)).toBe(seriesDupKey(b))
  })
  it('is order-insensitive for multi-day schedules', () => {
    const a = { client_id: 7, frequency: 'weekly', interval_weeks: 1, days_of_week: [0, 2] }
    const b = { client_id: 7, frequency: 'weekly', interval_weeks: 1, days_of_week: [2, 0] }
    expect(seriesDupKey(a)).toBe(seriesDupKey(b))
  })
  it('separates different clients and different cadences', () => {
    const base = { client_id: 7, frequency: 'weekly', interval_weeks: 1, days_of_week: [4] }
    expect(seriesDupKey({ ...base, client_id: 8 })).not.toBe(seriesDupKey(base))
    expect(seriesDupKey({ ...base, interval_weeks: 2 })).not.toBe(seriesDupKey(base))
    expect(seriesDupKey({ ...base, days_of_week: [3] })).not.toBe(seriesDupKey(base))
  })
  it('falls back to legacy day_of_week when days_of_week is empty', () => {
    const legacy = { client_id: 7, frequency: 'weekly', interval_weeks: 1, days_of_week: [], day_of_week: 4 }
    const modern = { client_id: 7, frequency: 'weekly', interval_weeks: 1, days_of_week: [4] }
    expect(seriesDupKey(legacy)).toBe(seriesDupKey(modern))
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
    saveReviewedDupKeys(new Set(['7|weekly|1||4', '9|biweekly|2||1']))
    const loaded = loadReviewedDupKeys()
    expect(loaded.has('7|weekly|1||4')).toBe(true)
    expect(loaded.has('9|biweekly|2||1')).toBe(true)
    expect(loaded.size).toBe(2)
  })
  it('returns an empty set when nothing is stored or the value is corrupt', () => {
    expect(loadReviewedDupKeys().size).toBe(0)
    localStorage.setItem('bb_recurring_dup_reviewed', '{not json')
    expect(loadReviewedDupKeys().size).toBe(0)
  })
})
