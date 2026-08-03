/**
 * Appointment-aware SMS templates — power the composer's Remind/Confirm chips
 * and the contact panel's per-appointment reminder bell. Pins the wording and
 * the date phrasing so a one-tap reminder always lands with the right visit.
 */
import { describe, it, expect } from 'vitest'
import { apptDatePhrase, apptReminderText, apptConfirmText, onWayText, firstNameOf } from '../utils'

describe('apptDatePhrase', () => {
  it('renders weekday + date + 12h time from a date-only string + start_time', () => {
    // '2026-06-16' is a Tuesday; 14:30 -> 2:30 PM.
    expect(apptDatePhrase({ scheduled_date: '2026-06-16', start_time: '14:30:00' }))
      .toBe('Tue, Jun 16 at 2:30 PM')
  })
  it('omits the time when there is no start_time', () => {
    expect(apptDatePhrase({ scheduled_date: '2026-06-16' })).toBe('Tue, Jun 16')
  })
  it('formats midnight as 12:00 AM (not 0:00)', () => {
    expect(apptDatePhrase({ scheduled_date: '2026-06-16', start_time: '00:00' }))
      .toBe('Tue, Jun 16 at 12:00 AM')
  })
  it('returns empty for a job with no date', () => {
    expect(apptDatePhrase({})).toBe('')
  })
})

describe('firstNameOf', () => {
  it('prefers structured first_name', () => {
    expect(firstNameOf({ client: { first_name: 'Dana', name: 'Dana Smith' } })).toBe('Dana')
  })
  it('falls back to the first token of the display name', () => {
    expect(firstNameOf({ client: { name: 'Dana Smith' } })).toBe('Dana')
  })
  it('drops phone-number-shaped names (unknown senders)', () => {
    expect(firstNameOf({ client: { name: '+12075551234' } })).toBe('')
    expect(firstNameOf({ external_contact: '+12075551234' })).toBe('')
  })
})

describe('reminder / confirm / on-way text', () => {
  const job = { scheduled_date: '2026-06-16', start_time: '09:00' }

  it('reminder greets by name, names the company, and states the visit', () => {
    const t = apptReminderText({ job, firstName: 'Dana', company: 'BrightBase Clean' })
    expect(t).toContain('Hi Dana,')
    expect(t).toContain('from BrightBase Clean')
    expect(t).toContain('Tue, Jun 16 at 9:00 AM')
  })

  it('reminder degrades gracefully with no first name or company', () => {
    const t = apptReminderText({ job, firstName: '', company: '' })
    expect(t.startsWith('Hi, ')).toBe(true)
    expect(t).not.toContain('from ')
    expect(t).toContain('Tue, Jun 16 at 9:00 AM')
  })

  it('confirm restates the appointment', () => {
    expect(apptConfirmText({ job, firstName: 'Dana' }))
      .toBe('Hi Dana, just confirming your cleaning for Tue, Jun 16 at 9:00 AM. See you then!')
  })

  it('on-way is a short heads-up', () => {
    expect(onWayText({ firstName: 'Dana' })).toBe("Hi Dana, we're on our way for your cleaning now!")
  })
})
