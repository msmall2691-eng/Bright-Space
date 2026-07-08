/**
 * Per-visit sync chip logic (T-30 + Codex #524 review).
 *
 * The visit's Google/Connecteam sync fields are subtle: gcal_event_id lives
 * on Job, connecteam_shift_ids may be a partial list (mid-loop auto_dispatch
 * failure on a multi-cleaner job) or a legitimate 1-entry array with zero
 * cleaners (Push open shifts writes a shift with no cleaner assigned).
 *
 * These tests pin the four-state Connecteam status so a future refactor
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

  describe('connecteamStatus', () => {
    it('is "none" when there\'s no cleaner and no shift', () => {
      const s = computeVisitSyncState({}, {}).connecteamStatus
      expect(s).toBe('none')
    })

    it('is "synced" when every assigned cleaner has a shift', () => {
      const s = computeVisitSyncState(
        { cleaner_ids: [7, 8] },
        { connecteam_shift_ids: ['s1', 's2'] },
      ).connecteamStatus
      expect(s).toBe('synced')
    })

    it('is "synced" for open-shift push (shift with 0 cleaners assigned)', () => {
      // Codex review comment #2 on #524: Settings → Push open shifts writes
      // connecteam_shift_ids with no cleaner attached. Rendering "not synced"
      // here made a legitimate push indistinguishable from an un-pushed job.
      const s = computeVisitSyncState(
        { cleaner_ids: [] },
        { connecteam_shift_ids: ['shift_open_1'], cleaner_ids: [] },
      ).connecteamStatus
      expect(s).toBe('synced')
    })

    it('is "partial" when a mid-dispatch Connecteam create failed', () => {
      // Codex review comment #1 on #524: auto_dispatch_job persists the
      // successful shift ids even if a later cleaner's shift creation
      // failed. A 2-cleaner job with 1 shift should read as PARTIAL, not
      // fully synced — the operator still needs to fix the missing one.
      const state = computeVisitSyncState(
        { cleaner_ids: [7, 8] },
        { connecteam_shift_ids: ['s1'] },
      )
      expect(state.connecteamStatus).toBe('partial')
      expect(state.connecteamShifts).toBe(1)
      expect(state.connecteamExpected).toBe(2)
    })

    it('is "missing" when cleaners are assigned but no shift exists', () => {
      const s = computeVisitSyncState(
        { cleaner_ids: [7] },
        { connecteam_shift_ids: [] },
      ).connecteamStatus
      expect(s).toBe('missing')
    })

    it('handles connecteam_shift_ids=null defensively (JSON column NULL)', () => {
      const s = computeVisitSyncState(
        { cleaner_ids: [7] },
        { connecteam_shift_ids: null },
      ).connecteamStatus
      expect(s).toBe('missing')
    })
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

  it('renders the Connecteam chip as PARTIAL for a half-dispatched multi-cleaner job', () => {
    const { container } = render(
      <SyncStatusChips
        visit={{ cleaner_ids: [7, 8] }}
        job={{ gcal_event_id: 'e', connecteam_shift_ids: ['s1'] }}
      />,
    )
    // Amber half-circle mark, not green ✓.
    expect(container.textContent).toMatch(/◐/)
    // Tooltip surfaces the numeric partial state so Meg knows what's missing.
    expect(
      screen.getByTitle('Only 1 of 2 cleaners pushed to Connecteam'),
    ).toBeTruthy()
  })

  it('renders an unsynced Google chip when the job has no gcal_event_id', () => {
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

  it('shows a Connecteam chip for an OPEN-SHIFT push even without cleaners', () => {
    // Regression for Codex review #2 — the Connecteam pusher writes
    // shift_ids for open-shift pushes with no cleaner attached; hiding
    // the chip made them indistinguishable from un-pushed jobs.
    const { container } = render(
      <SyncStatusChips
        visit={{ cleaner_ids: [] }}
        job={{ connecteam_shift_ids: ['open_1'] }}
      />,
    )
    expect(container.textContent).toMatch(/Connecteam/)
    expect(screen.getByTitle('Pushed to Connecteam (open shift)')).toBeTruthy()
  })

  it('hides the Connecteam chip entirely when nothing to sync', () => {
    // Cleanerless, un-pushed job legitimately has nothing to say about
    // Connecteam. The "needs cleaner" queue is the appropriate surface.
    const { container } = render(
      <SyncStatusChips
        visit={{ cleaner_ids: [] }}
        job={{ gcal_event_id: 'e', cleaner_ids: [], connecteam_shift_ids: [] }}
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
