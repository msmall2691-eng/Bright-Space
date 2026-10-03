/**
 * FrequencyPicker is the one repeat-cadence control, shared by the New-Job
 * modal and the Edit-recurring-rule modal. These pin the two things that were
 * actually wrong before it existed:
 *
 *  1. The edit screen had no "Daily" option, and a daily series opened showing
 *     "Weekly" selected — so saving it silently turned a daily clean weekly.
 *  2. The two screens offered different option lists.
 *
 * So: the full list (incl. Daily and Monthly) renders, the lit button is
 * derived from BOTH frequency and interval_weeks (a legacy weekly+3 rule reads
 * back as "Every 3 weeks", a daily rule reads back as "Daily"), and picking an
 * option patches frequency + interval_weeks + days together.
 */
import { it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import FrequencyPicker, { activeFrequency, pickFrequency } from '../FrequencyPicker'

afterEach(cleanup)

const pressed = (name) =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed')

it('offers the full option list, Daily and Monthly included', () => {
  render(<FrequencyPicker value={{ frequency: 'weekly', interval_weeks: 1 }} onChange={() => {}} />)
  for (const label of ['Daily', 'Weekly', 'Every 2 weeks', 'Every 3 weeks',
    'Every 4 weeks', 'Every 8 weeks', 'Monthly']) {
    expect(screen.getByRole('button', { name: label })).toBeTruthy()
  }
})

it('lights Daily for a daily rule — not Weekly (the old bug)', () => {
  expect(activeFrequency({ frequency: 'daily', interval_weeks: 1 })).toBe('daily')
  render(<FrequencyPicker value={{ frequency: 'daily', interval_weeks: 1 }} onChange={() => {}} />)
  expect(pressed('Daily')).toBe('true')
  expect(pressed('Weekly')).toBe('false')
})

it('reads a legacy weekly+interval_weeks=3 rule back as Every 3 weeks', () => {
  expect(activeFrequency({ frequency: 'weekly', interval_weeks: 3 })).toBe('every_3_weeks')
  render(<FrequencyPicker value={{ frequency: 'weekly', interval_weeks: 3 }} onChange={() => {}} />)
  expect(pressed('Every 3 weeks')).toBe('true')
})

it('keys monthly off the frequency string', () => {
  expect(activeFrequency({ frequency: 'monthly', interval_weeks: 1 })).toBe('monthly')
})

it('patches frequency + interval_weeks + days when an option is picked', () => {
  // Daily clears the weekday filter (blank = every day).
  expect(pickFrequency({ value: 'daily', interval: 1 }, { days_of_week: [2] }))
    .toEqual({ frequency: 'daily', interval_weeks: 1, days_of_week: [] })
  // Every 3 weeks carries its stride and seeds a weekday when none is set.
  expect(pickFrequency({ value: 'every_3_weeks', interval: 3 }, {}))
    .toEqual({ frequency: 'every_3_weeks', interval_weeks: 3, days_of_week: [0] })
})

it('emits the pick patch on click', () => {
  const onChange = vi.fn()
  render(<FrequencyPicker value={{ frequency: 'weekly', interval_weeks: 1 }} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Daily' }))
  expect(onChange).toHaveBeenCalledWith({ frequency: 'daily', interval_weeks: 1, days_of_week: [] })
})
