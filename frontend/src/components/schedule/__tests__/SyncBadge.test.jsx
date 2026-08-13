/**
 * Per-visit sync chip logic (T-30).
 *
 * The visit's Google sync field is subtle: gcal_event_id lives on Job, but
 * /api/schedule/week's derived visit shape spreads the job dict, so it can
 * appear on either side. These tests pin the visit-first-then-job fallback
 * so a future refactor can't silently regress the at-a-glance signal.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { computeVisitSyncState, SyncStatusChips } from '../SyncBadge'

afterEach(cleanup)

describe('computeVisitSyncState', () => {
  it('reads gcal_event_id off the visit first, falling back to the job', () => {
    expect(computeVisitSyncState({ gcal_event_id: 'evt_abc' }, {}).gcalOk).toBe(true)
    expect(computeVisitSyncState({}, { gcal_event_id: 'evt_abc' }).gcalOk).toBe(true)
    expect(computeVisitSyncState({}, {}).gcalOk).toBe(false)
  })
})

describe('SyncStatusChips', () => {
  it('shows the Google chip as synced when the event is on the calendar', () => {
    const { container } = render(
      <SyncStatusChips
        visit={{ cleaner_ids: [7] }}
        job={{ gcal_event_id: 'e' }}
      />,
    )
    expect(container.textContent).toMatch(/Google/)
    expect(screen.getByTitle('On Google Calendar')).toBeTruthy()
    expect(container.textContent).toMatch(/✓/)
  })

  it('renders an unsynced Google chip when the job has no gcal_event_id', () => {
    const { container } = render(
      <SyncStatusChips
        visit={{ cleaner_ids: [7] }}
        job={{}}
      />,
    )
    expect(container.textContent).toMatch(/Google/)
    expect(screen.getByTitle('Not yet on Google Calendar')).toBeTruthy()
  })

  it('renders correctly when both visit and job are null-safe', () => {
    // Defensive: parents can pass an undefined job while data loads.
    const { container } = render(<SyncStatusChips visit={{}} job={null} />)
    expect(container.textContent).toMatch(/Google/)
  })
})
