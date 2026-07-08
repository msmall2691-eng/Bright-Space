/**
 * Per-visit sync chip logic (T-30).
 *
 * The visit's Google/Connecteam sync fields are subtle: gcal_event_id lives
 * on Job (Visit is derived post-migration), connecteam_shift_ids may be an
 * empty array vs missing, and Connecteam skips jobs with no cleaner_ids by
 * design — a "not synced" chip there would flag a state the operator has
 * to fix by ASSIGNING first, not by pushing.
 *
 * These tests pin the invariants so a future refactor of the Visit shape
 * can't silently regress the field-cleaner's at-a-glance signal.
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

  it('marks connecteamOk when the job carries at least one shift id', () => {
    expect(computeVisitSyncState({}, { connecteam_shift_ids: ['s1'] }).connecteamOk).toBe(true)
    expect(computeVisitSyncState({}, { connecteam_shift_ids: [] }).connecteamOk).toBe(false)
    expect(computeVisitSyncState({}, {}).connecteamOk).toBe(false)
    // Defensive: JSON column could arrive as null.
    expect(computeVisitSyncState({}, { connecteam_shift_ids: null }).connecteamOk).toBe(false)
  })

  it('reports hasCleaner from visit OR job cleaner_ids', () => {
    expect(computeVisitSyncState({ cleaner_ids: [7] }, {}).hasCleaner).toBe(true)
    expect(computeVisitSyncState({}, { cleaner_ids: [7] }).hasCleaner).toBe(true)
    expect(computeVisitSyncState({ cleaner_ids: [] }, { cleaner_ids: [] }).hasCleaner).toBe(false)
  })
})

describe('SyncStatusChips', () => {
  it('shows both chips as synced when everything is pushed', () => {
    const { container } = render(
      <SyncStatusChips
        visit={{ cleaner_ids: [7] }}
        job={{ gcal_event_id: 'e', connecteam_shift_ids: ['s'] }}
      />,
    )
    expect(container.textContent).toMatch(/Google/)
    expect(container.textContent).toMatch(/Connecteam/)
    // Two ✓ marks — one per chip.
    expect(container.textContent.match(/✓/g)?.length).toBe(2)
  })

  it('shows an unsynced Google chip when the job has no gcal_event_id', () => {
    const { container } = render(
      <SyncStatusChips
        visit={{ cleaner_ids: [7] }}
        job={{ connecteam_shift_ids: ['s'] }}
      />,
    )
    expect(container.textContent).toMatch(/Google/)
    expect(screen.getByTitle('Not yet on Google Calendar')).toBeTruthy()
    expect(screen.getByTitle('Pushed to Connecteam')).toBeTruthy()
  })

  it('hides the Connecteam chip entirely when no cleaner is assigned', () => {
    // A no-cleaner job legitimately has no Connecteam shift (dispatcher
    // skips it). Rendering "not synced" would send the operator down the
    // wrong path — they need to ASSIGN first.
    const { container } = render(
      <SyncStatusChips
        visit={{ cleaner_ids: [] }}
        job={{ gcal_event_id: 'e', cleaner_ids: [] }}
      />,
    )
    expect(container.textContent).toMatch(/Google/)
    expect(container.textContent).not.toMatch(/Connecteam/)
  })

  it('renders correctly when both visit and job are null-safe', () => {
    // Defensive: parents can pass an undefined job while data loads.
    const { container } = render(<SyncStatusChips visit={{}} job={null} />)
    expect(container.textContent).toMatch(/Google/)
    expect(container.textContent).not.toMatch(/Connecteam/)
  })
})
