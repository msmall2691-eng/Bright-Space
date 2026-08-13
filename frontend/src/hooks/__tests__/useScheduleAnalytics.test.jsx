import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useScheduleAnalytics } from '../useScheduleAnalytics'

const YMD = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const anchor = new Date('2026-07-08T12:00')
const today = YMD(anchor)
const tomorrow = YMD(new Date('2026-07-09T12:00'))

const makeVisit = (o) => ({
  id: o.id,
  job_id: o.id,
  status: o.status || 'scheduled',
  scheduled_date: o.date,
  start_time: o.start,
  end_time: o.end,
  cleaner_ids: o.cleaners || [],
})

describe('useScheduleAnalytics', () => {
  it('summarizes today: counts, unassigned, capacity, crews', () => {
    const visits = [
      makeVisit({ id: 1, date: today, start: '09:00', end: '12:00', cleaners: ['a', 'b'] }), // 3h
      makeVisit({ id: 2, date: today, start: '09:00', end: '11:00', cleaners: ['c'] }),      // 2h
      makeVisit({ id: 3, date: today, start: '14:00', end: '16:00', cleaners: [] }),         // 2h, unassigned
      makeVisit({ id: 4, date: tomorrow, start: '09:00', end: '12:00', cleaners: ['a'] }),   // not today
      makeVisit({ id: 5, date: today, start: '10:00', end: '11:00', cleaners: ['a'], status: 'cancelled' }),
    ]
    const employees = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] // 3 crews × 8h = 24 capacity
    const { result } = renderHook(() =>
      useScheduleAnalytics({ visits, currentDate: anchor, employees }),
    )
    const stats = result.current.todayStats
    expect(stats.jobs).toBe(3)             // cancelled excluded
    expect(stats.unassigned).toBe(1)       // visit 3
    expect(stats.crewsOut).toBe(3)         // a, b, c
    expect(stats.hours).toBe(7)            // 3 + 2 + 2
    expect(stats.capacityPct).toBe(29)     // 7 / 24 ≈ 29%
  })

  it('produces a 7-day Sunday-first window with load per day', () => {
    const visits = [
      makeVisit({ id: 1, date: today, start: '09:00', end: '17:00', cleaners: ['a'] }),      // 8h → 100% w/ 1 crew, ~33% w/ 3
    ]
    const employees = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const { result } = renderHook(() =>
      useScheduleAnalytics({ visits, currentDate: anchor, employees }),
    )
    const { weekDates, loadByDate } = result.current
    expect(weekDates.length).toBe(7)
    // Sunday-first ordering: weekday of weekDates[0] should be Sun (0).
    expect(new Date(`${weekDates[0]}T12:00`).getDay()).toBe(0)
    expect(loadByDate[today].jobs).toBe(1)
    expect(loadByDate[today].hours).toBe(8)
  })

  it('collects crew load and idles as separate rows', () => {
    const visits = [
      makeVisit({ id: 1, date: today, start: '09:00', end: '12:00', cleaners: ['sarah'] }),  // 3h
      makeVisit({ id: 2, date: today, start: '13:00', end: '15:00', cleaners: ['sarah'] }),  // 2h
    ]
    const employees = [{ id: 'sarah' }, { id: 'grace' }, { id: 'jamie' }]
    const { result } = renderHook(() =>
      useScheduleAnalytics({ visits, currentDate: anchor, employees }),
    )
    const load = result.current.crewLoad
    const sarah = load.find(c => c.id === 'sarah')
    const grace = load.find(c => c.id === 'grace')
    expect(sarah.hours).toBe(5)
    expect(sarah.visits.length).toBe(2)
    expect(grace.hours).toBe(0)  // idle rosters still show up
  })

  it('sorts unassignedToday by start time', () => {
    const visits = [
      makeVisit({ id: 1, date: today, start: '16:00', end: '18:00' }),
      makeVisit({ id: 2, date: today, start: '09:00', end: '11:00' }),
      makeVisit({ id: 3, date: today, start: '13:00', end: '15:00' }),
    ]
    const { result } = renderHook(() =>
      useScheduleAnalytics({ visits, currentDate: anchor, employees: [] }),
    )
    const unassigned = result.current.unassignedToday
    expect(unassigned.map(v => v.id)).toEqual([2, 3, 1])
  })
})
