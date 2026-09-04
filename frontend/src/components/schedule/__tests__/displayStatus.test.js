import { describe, it, expect } from 'vitest'
import { computeDisplayStatus, VISIT_STATUS_CONFIG } from '../constants'

// A job that is genuinely ready: on the calendar, at a place, with a crew.
const ready = {
  status: 'scheduled',
  scheduled_date: '2026-09-10',
  property_id: 7,
  cleaner_ids: ['c1'],
}

describe('computeDisplayStatus', () => {
  it('passes a fully set-up scheduled job straight through', () => {
    expect(computeDisplayStatus(ready)).toBe('scheduled')
  })

  it('flags a missing date as needs_setup', () => {
    expect(computeDisplayStatus({ ...ready, scheduled_date: '' })).toBe('needs_setup')
    expect(computeDisplayStatus({ ...ready, scheduled_date: null })).toBe('needs_setup')
    expect(computeDisplayStatus({ ...ready, scheduled_date: '   ' })).toBe('needs_setup')
  })

  it('flags a missing property as needs_setup', () => {
    expect(computeDisplayStatus({ ...ready, property_id: null })).toBe('needs_setup')
  })

  // The whole point of the split: a crewless visit is the normal state of most
  // of the calendar (a recurring series can be created with no cleaners and
  // every visit inherits that), so it must not wear the same amber "something
  // is wrong here" label as a visit with no date.
  it('calls a crew-only gap unassigned, not needs_setup', () => {
    expect(computeDisplayStatus({ ...ready, cleaner_ids: [] })).toBe('unassigned')
  })

  it('prefers needs_setup when the date is missing too', () => {
    expect(computeDisplayStatus({ ...ready, cleaner_ids: [], scheduled_date: null }))
      .toBe('needs_setup')
  })

  // AgendaUpcoming's payload omits cleaner_ids entirely — "we don't know" must
  // not render as "nobody is on it".
  it('leaves an absent cleaner_ids field alone', () => {
    const { cleaner_ids, ...noCrewField } = ready // eslint-disable-line no-unused-vars
    expect(computeDisplayStatus(noCrewField)).toBe('scheduled')
  })

  // Raw visits carry no property_id at all; the caller resolves it from the
  // linked job, so absence of the key is not absence of a property.
  it('only counts property_id when the field is present on the record', () => {
    const { property_id, ...visitShape } = ready // eslint-disable-line no-unused-vars
    expect(computeDisplayStatus(visitShape)).toBe('scheduled')
  })

  it('never relabels a non-scheduled status', () => {
    for (const raw of ['completed', 'cancelled', 'in_progress', 'no_show']) {
      expect(computeDisplayStatus({ ...ready, status: raw, cleaner_ids: [], property_id: null }))
        .toBe(raw)
    }
  })

  it('defaults to scheduled for a missing entity', () => {
    expect(computeDisplayStatus(null)).toBe('scheduled')
    expect(computeDisplayStatus(undefined)).toBe('scheduled')
  })

  it('has a config entry for every status it can return', () => {
    for (const s of ['needs_setup', 'unassigned', 'scheduled']) {
      expect(VISIT_STATUS_CONFIG[s]).toBeTruthy()
      expect(VISIT_STATUS_CONFIG[s].label).toBeTruthy()
    }
    // Unassigned is deliberately quiet — amber is reserved for needs_setup.
    expect(VISIT_STATUS_CONFIG.unassigned.badge).toBe('neutral')
    expect(VISIT_STATUS_CONFIG.needs_setup.badge).toBe('warning')
  })
})
