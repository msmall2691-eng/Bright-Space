/**
 * ScheduleCommandBar — the dense header above the office calendar views.
 *
 * It had NO test, and it carries a duplicated render condition that is exactly
 * the kind of thing that rots: `hasAlerts` re-states OpsAlerts' own "do I draw
 * anything" logic so the bento's alert column isn't mounted empty (which would
 * leave a dead half-width cell). Every time OpsAlerts learns a new alert type,
 * that mirror has to learn it too — otherwise a day whose ONLY signal is the
 * new type computes hasAlerts === false and the alert is silently dropped.
 *
 * These tests pin the mirror, the self-nulling, and the bento (side by side at
 * shell:, never a stack of full-width bands).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ScheduleCommandBar from '../ScheduleCommandBar'

afterEach(cleanup)

const QUIET_TODAY = { jobs: 4, unassigned: 0, capacityPct: 10 }

function draw(props = {}) {
  return render(
    <MemoryRouter>
      <ScheduleCommandBar
        stats={{ today: 4, week: 18 }}
        weekLabel="This week"
        todayStats={QUIET_TODAY}
        {...props}
      />
    </MemoryRouter>,
  )
}

describe('ScheduleCommandBar', () => {
  it('shows the at-a-glance counts', () => {
    draw()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByText('today')).toBeTruthy()
    expect(screen.getByText('18')).toBeTruthy()
    expect(screen.getByText('This week')).toBeTruthy()
  })

  it('renders NOTHING when there is no KPI line, no alert and no undated job', () => {
    const { container } = draw({ showKpis: false })
    expect(container.textContent).toBe('')
  })

  it('suppresses the KPI line on the wide Day view, which has its own header', () => {
    draw({ showKpis: false, unscheduled: [{ id: 1, client_name: 'Nina Cole' }] })
    // The needs-a-date column still draws; the echoed today/week counts do not.
    expect(screen.getByTestId('needs-date-strip')).toBeTruthy()
    expect(screen.queryByText('today')).toBeNull()
  })

  it('mounts the alert column for a reschedule request alone', () => {
    // The mirror bug this test exists for: with awaitingReply empty, no
    // unassigned jobs and capacity low, a reschedule request is the ONLY
    // signal. If `hasAlerts` forgets it, the column never mounts and the
    // customer waiting on an answer is invisible.
    draw({
      rescheduleRequests: [{
        id: 1, job_id: 1, status: 'scheduled',
        reschedule_requested_at: '2026-10-04T10:00:00Z',
        reschedule_requested_date: '2026-10-12',
        client_name: 'Nina Cole',
      }],
    })
    expect(screen.getByText('A customer wants to move a visit')).toBeTruthy()
  })

  it('mounts the alert column for each of the other signals alone', () => {
    draw({ awaitingReply: [{ pending_claim_requests: 1, property_name: 'Harbour St' }] })
    expect(screen.getByText(/waiting to hear back/)).toBeTruthy()
    cleanup()

    draw({
      todayStats: { jobs: 6, unassigned: 2, capacityPct: 20 },
      unassignedToday: [{ start_time: '10:00:00', open_for_claims: true }],
      onFocusUnassigned: vi.fn(),
    })
    expect(screen.getByText(/need(s)? a crew/)).toBeTruthy()
    cleanup()

    draw({ todayStats: { jobs: 10, unassigned: 0, capacityPct: 95 } })
    expect(screen.getByText(/booked/)).toBeTruthy()
  })

  it('packs alerts and needs-a-date side by side rather than stacking bands', () => {
    const { container } = draw({
      awaitingReply: [{ pending_claim_requests: 1, property_name: 'Harbour St' }],
      unscheduled: [{ id: 1, client_name: 'Nina Cole' }],
    })
    // Both columns present...
    expect(screen.getByText(/waiting to hear back/)).toBeTruthy()
    expect(screen.getByTestId('needs-date-strip')).toBeTruthy()
    // ...in one row that goes horizontal at the 900px shell: breakpoint, never
    // at lg: (1024) — the owner's window is ~940px.
    const row = container.querySelector('.shell\\:flex-row')
    expect(row, 'the bento row should go horizontal at shell:').toBeTruthy()
    expect(container.innerHTML).not.toMatch(/\blg:/)
  })

  it('passes the job opener through to the alert', () => {
    const onOpenJob = vi.fn()
    draw({
      onOpenJob,
      rescheduleRequests: [{
        id: 1, job_id: 42, status: 'scheduled',
        reschedule_requested_at: '2026-10-04T10:00:00Z',
        reschedule_requested_date: '2026-10-12',
        client_name: 'Nina Cole',
      }],
    })
    const open = screen.getByRole('button', { name: 'Open' })
    open.click()
    expect(onOpenJob).toHaveBeenCalledWith(42)
  })
})
