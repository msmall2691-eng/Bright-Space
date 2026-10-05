/**
 * Recurring helpers — the occurrence projection, finally testable.
 *
 * `computeUpcoming` is a hand-written FRONTEND MIRROR of the backend's
 * `generate_dates`. The survey logged that as a defect in its own right: two
 * implementations of one rule, and if they disagree the page shows the
 * operator dates the scheduler will never create. It had no test, because it
 * lived two hundred lines inside a 1795-line page module and could not be
 * imported. Splitting that file is what makes this file possible, so these
 * are the cases that would actually catch a drift.
 *
 * The invariant the code's own comments single out twice is **phase counted
 * from the anchor, not from today** — for biweekly and for an N-day step.
 * Re-seating phase off "today" is the bug that makes a biweekly series look
 * correct on the day you load it and wrong the following week, and it is the
 * thing most likely to be reintroduced by a well-meaning simplification. Two
 * anchors of opposite parity must give DIFFERENT dates; that is the assertion
 * a "today"-based implementation cannot pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computeUpcoming, ruleSummary, endsSummary, fmtTime, fmtDate, SEVERITY_DOT } from '../helpers'

// A Monday, mid-June: no DST transition inside any window these tests use, so
// the local-midnight date maths can't drift an hour and land on the day before.
const TODAY = new Date(2026, 5, 1, 9, 0, 0)   // Mon 2026-06-01

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(TODAY) })
afterEach(() => { vi.useRealTimers() })

const dates = (out) => out.map(o => o.date)

describe('computeUpcoming — weekly', () => {
  it('projects consecutive occurrences on the chosen weekday', () => {
    const out = computeUpcoming(
      { frequency: 'weekly', days_of_week: [0], start_time: '09:00', anchor_date: '2026-06-01' }, [], 4)
    expect(dates(out)).toEqual(['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'])
  })

  it('handles several weekdays in one series, in date order', () => {
    const out = computeUpcoming(
      { frequency: 'weekly', days_of_week: [0, 2], anchor_date: '2026-06-01' }, [], 4)
    expect(dates(out)).toEqual(['2026-06-01', '2026-06-03', '2026-06-08', '2026-06-10'])
  })
})

describe('computeUpcoming — biweekly phase comes from the anchor', () => {
  it('keeps a 14-day gap', () => {
    const out = computeUpcoming(
      { frequency: 'biweekly', days_of_week: [0], anchor_date: '2026-06-01' }, [], 3)
    expect(dates(out)).toEqual(['2026-06-01', '2026-06-15', '2026-06-29'])
  })

  it('an anchor one week over gives the OTHER Mondays', () => {
    // The whole point. A projection that counted parity from "today" would
    // return the same list for both anchors — this is the case that fails it.
    const a = computeUpcoming({ frequency: 'biweekly', days_of_week: [0], anchor_date: '2026-06-01' }, [], 3)
    const b = computeUpcoming({ frequency: 'biweekly', days_of_week: [0], anchor_date: '2026-06-08' }, [], 3)
    expect(dates(a)).toEqual(['2026-06-01', '2026-06-15', '2026-06-29'])
    expect(dates(b)).toEqual(['2026-06-08', '2026-06-22', '2026-07-06'])
    expect(dates(a)).not.toEqual(dates(b))
  })

  it('falls back to series_start_date when there is no anchor yet', () => {
    const out = computeUpcoming(
      { frequency: 'biweekly', days_of_week: [0], series_start_date: '2026-06-08' }, [], 2)
    expect(dates(out)).toEqual(['2026-06-08', '2026-06-22'])
  })
})

describe('computeUpcoming — daily', () => {
  it('steps every day at interval 1', () => {
    const out = computeUpcoming({ frequency: 'daily', anchor_date: '2026-06-01' }, [], 3)
    expect(dates(out)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03'])
  })

  it('phases an N-day step off the anchor, not today', () => {
    const a = computeUpcoming({ frequency: 'daily', interval_weeks: 3, anchor_date: '2026-06-01' }, [], 3)
    const b = computeUpcoming({ frequency: 'daily', interval_weeks: 3, anchor_date: '2026-06-02' }, [], 3)
    expect(dates(a)).toEqual(['2026-06-01', '2026-06-04', '2026-06-07'])
    expect(dates(b)).toEqual(['2026-06-02', '2026-06-05', '2026-06-08'])
  })

  it('intersects the step with chosen weekdays', () => {
    const out = computeUpcoming(
      { frequency: 'daily', interval_weeks: 1, days_of_week: [5, 6], anchor_date: '2026-06-01' }, [], 4)
    expect(dates(out)).toEqual(['2026-06-06', '2026-06-07', '2026-06-13', '2026-06-14'])
  })
})

describe('computeUpcoming — monthly', () => {
  it('lands on the chosen day each month, within the lookahead window', () => {
    // The default window is 8 weeks, which from 2026-06-01 ends 2026-07-27 —
    // so August is correctly outside it and two occurrences is the right
    // answer, not a truncation.
    expect(dates(computeUpcoming({ frequency: 'monthly', day_of_month: 15 }, [], 3)))
      .toEqual(['2026-06-15', '2026-07-15'])
    // Widen the window and the third appears.
    expect(dates(computeUpcoming({ frequency: 'monthly', day_of_month: 15, generate_weeks_ahead: 16 }, [], 3)))
      .toEqual(['2026-06-15', '2026-07-15', '2026-08-15'])
  })

  it('SKIPS a month that has no such day rather than rolling into the next', () => {
    // day 31 in a 30-day month: JS would roll Jun-31 to Jul-01, which is a
    // different month and a wrong date. The month check is what prevents it.
    const out = computeUpcoming(
      { frequency: 'monthly', day_of_month: 31, generate_weeks_ahead: 20 }, [], 4)
    for (const d of dates(out)) expect(d.endsWith('-31')).toBe(true)
    expect(dates(out)).not.toContain('2026-07-01')
  })
})

describe('computeUpcoming — exceptions', () => {
  const weekly = { frequency: 'weekly', days_of_week: [0], start_time: '09:00', end_time: '11:00', anchor_date: '2026-06-01' }

  it('a skip removes that date', () => {
    const out = computeUpcoming(weekly, [{ exception_date: '2026-06-08', exception_type: 'skip' }], 3)
    expect(dates(out)).toEqual(['2026-06-01', '2026-06-15', '2026-06-22'])
  })

  it('a reschedule removes the original and adds the new date, flagged', () => {
    const out = computeUpcoming(weekly, [{
      exception_date: '2026-06-08', exception_type: 'reschedule',
      rescheduled_date: '2026-06-10', rescheduled_start_time: '13:00',
    }], 4)
    expect(dates(out)).toEqual(['2026-06-01', '2026-06-10', '2026-06-15', '2026-06-22'])
    const moved = out.find(o => o.date === '2026-06-10')
    expect(moved.rescheduled).toBe(true)
    expect(moved.start).toBe('13:00')
    expect(moved.end).toBe('11:00')          // falls back to the series' own end
  })

  it('a reschedule ONTO an existing occurrence does not double it', () => {
    const out = computeUpcoming(weekly, [{
      exception_date: '2026-06-08', exception_type: 'reschedule', rescheduled_date: '2026-06-15',
    }], 4)
    expect(dates(out).filter(d => d === '2026-06-15')).toHaveLength(1)
  })
})

describe('computeUpcoming — bounds', () => {
  it('returns nothing for no schedule', () => {
    expect(computeUpcoming(null, [])).toEqual([])
  })

  it('honours maxCount', () => {
    const out = computeUpcoming({ frequency: 'daily', anchor_date: '2026-06-01' }, [], 5)
    expect(out).toHaveLength(5)
  })

  it('clamps the lookahead window to 4–52 weeks', () => {
    const tiny = computeUpcoming({ frequency: 'weekly', days_of_week: [0], anchor_date: '2026-06-01', generate_weeks_ahead: 1 }, [], 99)
    const huge = computeUpcoming({ frequency: 'weekly', days_of_week: [0], anchor_date: '2026-06-01', generate_weeks_ahead: 999 }, [], 99)
    expect(tiny.length).toBeGreaterThanOrEqual(4)   // floored at 4 weeks, not 1
    expect(tiny.length).toBeLessThanOrEqual(5)
    expect(huge.length).toBeLessThanOrEqual(53)     // ceilinged at 52 weeks
  })
})

describe('the label helpers', () => {
  it('summarises a rule in words', () => {
    expect(ruleSummary({ frequency: 'weekly', days_of_week: [0, 2] })).toMatch(/Mon/)
    expect(ruleSummary({ frequency: 'monthly', day_of_month: 15 })).toMatch(/15/)
  })
  it('summarises how a series ends', () => {
    expect(endsSummary({ end_date: '2026-12-31' })).toBeTruthy()
    expect(endsSummary({})).toBeTruthy()
  })
  it('formats a time and a date without throwing on empty input', () => {
    expect(fmtTime('09:00')).toBeTruthy()
    expect(() => fmtTime(null)).not.toThrow()
    expect(() => fmtDate(null)).not.toThrow()
  })
})

/* ---- BB-A11Y-02 ------------------------------------------------------- */

const PALETTE = {
  'red-500': '#ef4444', 'amber-500': '#f59e0b', 'gray-400': '#9ca3af',
  'rose-600': '#e11d48', 'amber-700': '#b45309',
}
const LIGHT = ['#ffffff', '#f7f7f8', '#f1f1f3', '#e9e9ec']
const chan = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = (hex) => {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(1).slice(i, i + 2), 16))
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
const lightStep = (cls) => (cls.match(/(?:^|\s)bg-((?:red|rose|amber|gray|emerald|blue)-\d{3})\b/) || [])[1] || null

describe('the health-scan severity dots clear 3:1', () => {
  it('on all four light grounds', () => {
    let checked = 0
    for (const [key, cls] of Object.entries(SEVERITY_DOT)) {
      const step = lightStep(cls)
      if (!step) continue          // `info` is the neutral ink-3 token
      const hex = PALETTE[step]
      expect(hex, `${step} is not in this test's palette — add it`).toBeTruthy()
      for (const g of LIGHT) {
        const got = ratio(hex, g)
        expect(got, `${key} (${step}) on ${g} is ${got.toFixed(2)}:1, under 3:1`).toBeGreaterThanOrEqual(3)
      }
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(2)
  })
})
