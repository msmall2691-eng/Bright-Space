import { describe, it, expect } from 'vitest'
import {
  weekRange,
  monthGridRange,
  rangeForView,
  rangeContains,
} from '../dateRange'

describe('weekRange', () => {
  it('spans Sunday through Saturday', () => {
    // Tuesday 2026-07-07 → Sun 2026-07-05 to Sat 2026-07-11.
    const r = weekRange(new Date(2026, 6, 7))
    expect(r.start).toBe('2026-07-05')
    expect(r.end).toBe('2026-07-11')
  })
  it('starts on Sunday itself when given a Sunday', () => {
    const r = weekRange(new Date(2026, 6, 5))
    expect(r.start).toBe('2026-07-05')
  })
})

describe('monthGridRange', () => {
  it("covers the full month-grid window (first Sunday on-or-before, last Saturday on-or-after)", () => {
    // July 2026 begins on Wed 2026-07-01, ends on Fri 2026-07-31.
    // First Sunday of the grid is 2026-06-28; last Saturday is 2026-08-01.
    const r = monthGridRange(new Date(2026, 6, 15))
    expect(r.start).toBe('2026-06-28')
    expect(r.end).toBe('2026-08-01')
  })
  it("aligns to Sunday when the 1st IS a Sunday", () => {
    // February 2026 begins on Sun 2026-02-01.
    const r = monthGridRange(new Date(2026, 1, 12))
    expect(r.start).toBe('2026-02-01')
  })
})

describe('rangeForView', () => {
  it('agenda + week both use the current week', () => {
    const d = new Date(2026, 6, 7)
    expect(rangeForView(d, 'agenda')).toEqual(weekRange(d))
    expect(rangeForView(d, 'week')).toEqual(weekRange(d))
  })
  it("month uses the wider grid range", () => {
    const d = new Date(2026, 6, 7)
    expect(rangeForView(d, 'month')).toEqual(monthGridRange(d))
  })
  it('falls back to week for an unknown view mode', () => {
    const d = new Date(2026, 6, 7)
    expect(rangeForView(d, 'google')).toEqual(weekRange(d))
  })
})

describe('rangeContains', () => {
  it('returns true when the outer range covers the inner one', () => {
    expect(rangeContains(
      { start: '2026-06-28', end: '2026-08-01' },
      { start: '2026-07-05', end: '2026-07-11' },
    )).toBe(true)
  })
  it('returns false when the inner extends past the outer', () => {
    expect(rangeContains(
      { start: '2026-07-05', end: '2026-07-11' },
      { start: '2026-06-28', end: '2026-08-01' },
    )).toBe(false)
  })
  it('returns false when either arg is missing', () => {
    expect(rangeContains(null, { start: 'x', end: 'y' })).toBe(false)
    expect(rangeContains({ start: 'x', end: 'y' }, null)).toBe(false)
  })
})
