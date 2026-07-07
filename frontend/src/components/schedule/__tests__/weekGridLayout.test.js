import { describe, it, expect } from 'vitest'
import {
  parseTimeToHour,
  computeHourBand,
  positionForBlock,
  layoutDayColumn,
  splitTimedUntimed,
  weekDaysContaining,
  WEEK_GRID_CONSTANTS,
} from '../weekGridLayout'

describe('parseTimeToHour', () => {
  it('parses HH:MM into a float hour', () => {
    expect(parseTimeToHour('09:00')).toBe(9)
    expect(parseTimeToHour('09:30')).toBeCloseTo(9.5)
    expect(parseTimeToHour('13:45')).toBeCloseTo(13.75)
  })
  it('accepts trailing seconds', () => {
    expect(parseTimeToHour('09:00:00')).toBe(9)
  })
  it('rejects garbage', () => {
    expect(parseTimeToHour(null)).toBeNull()
    expect(parseTimeToHour('')).toBeNull()
    expect(parseTimeToHour('nope')).toBeNull()
    expect(parseTimeToHour('25:00')).toBeNull()
    expect(parseTimeToHour('09:70')).toBeNull()
  })
})

describe('computeHourBand', () => {
  it('defaults to 07:00-19:00 when all jobs fit', () => {
    const band = computeHourBand([
      { start_time: '09:00', end_time: '11:00' },
      { start_time: '13:00', end_time: '16:00' },
    ])
    expect(band).toEqual({
      startHour: WEEK_GRID_CONSTANTS.DEFAULT_HOUR_START,
      endHour: WEEK_GRID_CONSTANTS.DEFAULT_HOUR_END,
    })
  })
  it('expands earlier when a job starts before 07:00', () => {
    const band = computeHourBand([{ start_time: '06:00', end_time: '08:00' }])
    expect(band.startHour).toBe(6)
    expect(band.endHour).toBe(WEEK_GRID_CONSTANTS.DEFAULT_HOUR_END)
  })
  it('expands later when a job runs past 19:00', () => {
    const band = computeHourBand([{ start_time: '17:00', end_time: '20:30' }])
    expect(band.startHour).toBe(WEEK_GRID_CONSTANTS.DEFAULT_HOUR_START)
    expect(band.endHour).toBe(21)
  })
  it('clamps to the hard 05:00-22:00 window', () => {
    const band = computeHourBand([{ start_time: '02:00', end_time: '23:30' }])
    expect(band.startHour).toBe(WEEK_GRID_CONSTANTS.HARD_MIN_HOUR)
    expect(band.endHour).toBe(WEEK_GRID_CONSTANTS.HARD_MAX_HOUR)
  })
  it('ignores untimed jobs when computing the band', () => {
    const band = computeHourBand([
      { start_time: null, end_time: null },
      { start_time: '09:00', end_time: '11:00' },
    ])
    expect(band.startHour).toBe(WEEK_GRID_CONSTANTS.DEFAULT_HOUR_START)
  })
  it('uses default duration when a start has no end', () => {
    // 18:00 start with no end → default 2h duration → runs to 20:00, band extends to 20.
    const band = computeHourBand([{ start_time: '18:00', end_time: null }])
    expect(band.endHour).toBe(20)
  })
})

describe('positionForBlock', () => {
  it('places a mid-band block at the correct fractional top/height', () => {
    // Band 8-20 (12h). 10-12 → top = (10-8)/12 = 1/6, height = 2/12 = 1/6.
    const p = positionForBlock(10, 12, { startHour: 8, endHour: 20 })
    expect(p.topPct).toBeCloseTo(1 / 6)
    expect(p.heightPct).toBeCloseTo(1 / 6)
    expect(p.clipped).toBe(false)
  })
  it('clips a block extending past the top of the band', () => {
    const p = positionForBlock(5, 9, { startHour: 8, endHour: 20 })
    expect(p.topPct).toBe(0)
    expect(p.heightPct).toBeCloseTo(1 / 12)   // just the visible hour 8-9
    expect(p.clipped).toBe(true)
  })
  it('returns zero-height when a block is fully outside the band', () => {
    const p = positionForBlock(21, 23, { startHour: 8, endHour: 20 })
    expect(p.heightPct).toBe(0)
    expect(p.clipped).toBe(true)
  })
})

describe('layoutDayColumn — overlap → side-by-side lanes', () => {
  it('assigns a single job to lane 0 of 1', () => {
    const rows = layoutDayColumn([{ id: 'a', start_time: '09:00', end_time: '10:00' }])
    expect(rows).toEqual([{ jobId: 'a', laneIndex: 0, laneCount: 1, startHour: 9, endHour: 10 }])
  })
  it('splits a real overlap side-by-side (audit checklist §3)', () => {
    // 9-11 and 10-12 overlap → both must show; two lanes.
    const rows = layoutDayColumn([
      { id: 'a', start_time: '09:00', end_time: '11:00' },
      { id: 'b', start_time: '10:00', end_time: '12:00' },
    ])
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.laneCount)).toEqual([2, 2])
    // Different lanes so they render side-by-side.
    expect(rows[0].laneIndex).not.toBe(rows[1].laneIndex)
  })
  it('reuses a lane when a new job starts after the previous one ends', () => {
    // 9-10, 10-11 → no overlap; both can share lane 0. laneCount = 1 for both.
    const rows = layoutDayColumn([
      { id: 'a', start_time: '09:00', end_time: '10:00' },
      { id: 'b', start_time: '10:00', end_time: '11:00' },
    ])
    expect(rows.map(r => r.laneCount)).toEqual([1, 1])
    expect(rows.map(r => r.laneIndex)).toEqual([0, 0])
  })
  it('handles three-way overlap → laneCount=3', () => {
    const rows = layoutDayColumn([
      { id: 'a', start_time: '09:00', end_time: '12:00' },
      { id: 'b', start_time: '10:00', end_time: '11:00' },
      { id: 'c', start_time: '10:30', end_time: '11:30' },
    ])
    expect(rows.every(r => r.laneCount === 3)).toBe(true)
    // Three distinct lane indices.
    expect(new Set(rows.map(r => r.laneIndex)).size).toBe(3)
  })
  it('drops jobs without a start_time (they belong in the untimed strip)', () => {
    const rows = layoutDayColumn([
      { id: 'a', start_time: null, end_time: null },
      { id: 'b', start_time: '09:00', end_time: '10:00' },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].jobId).toBe('b')
  })
  it('defaults an end_time-missing job to a 2h duration for layout', () => {
    // 09:00 start + no end → 09-11 for layout purposes; the 10-11 job overlaps.
    const rows = layoutDayColumn([
      { id: 'a', start_time: '09:00', end_time: null },
      { id: 'b', start_time: '10:00', end_time: '11:00' },
    ])
    expect(rows.every(r => r.laneCount === 2)).toBe(true)
  })
})

describe('splitTimedUntimed', () => {
  it('routes null start_times to untimed and the rest to timed', () => {
    const { timed, untimed } = splitTimedUntimed([
      { id: 'a', start_time: null },
      { id: 'b', start_time: '09:00' },
      { id: 'c', start_time: '' },
    ])
    expect(timed.map(j => j.id)).toEqual(['b'])
    expect(untimed.map(j => j.id)).toEqual(['a', 'c'])
  })
})

describe('weekDaysContaining', () => {
  it('returns 7 YYYY-MM-DD strings starting on Sunday', () => {
    // Tuesday 2026-07-07 → Sunday 2026-07-05.
    const days = weekDaysContaining(new Date(2026, 6, 7))
    expect(days).toHaveLength(7)
    expect(days[0]).toBe('2026-07-05')
    expect(days[6]).toBe('2026-07-11')
  })
  it('starts on Sunday itself when given a Sunday', () => {
    const days = weekDaysContaining(new Date(2026, 6, 5))
    expect(days[0]).toBe('2026-07-05')
  })
})
