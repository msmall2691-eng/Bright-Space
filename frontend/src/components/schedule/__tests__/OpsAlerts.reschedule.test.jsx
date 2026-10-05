/**
 * A customer asking to move a visit has to be visible on the Schedule page.
 *
 * `reschedule_requested_at` / `_date` / `_scope` / `_message` have ridden every
 * job in the week payload since the customer confirm/reschedule page shipped,
 * and nothing on Schedule read them — so the request existed only on the job's
 * own page and in the owner's inbox, and the one screen the office sits on
 * could not tell you somebody was waiting on an answer.
 *
 * The alert deliberately carries NO inline approve. Approving applies the held
 * date, pushes Google Calendar and emails the customer, and the decision needs
 * the scope ("this visit" vs "this and all future") and what they actually
 * wrote — which is JobDetail's card, not a one-line alert. Same reasoning the
 * claim-requests alert records for having no button.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import OpsAlerts from '../OpsAlerts'

afterEach(cleanup)

const QUIET = { jobs: 4, unassigned: 0, capacityPct: 10 }

function req(over = {}) {
  return {
    id: 1, job_id: 1, status: 'scheduled',
    reschedule_requested_at: '2026-10-04T10:00:00Z',
    reschedule_requested_date: '2026-10-12',
    reschedule_requested_scope: 'this',
    client_name: 'Nina Cole',
    ...over,
  }
}

describe('OpsAlerts — customer reschedule requests', () => {
  it('says nothing when nobody has asked', () => {
    const { container } = render(<OpsAlerts stats={QUIET} rescheduleRequests={[]} />)
    expect(container.textContent).toBe('')
  })

  it('names the customer and the date they want', () => {
    render(<OpsAlerts stats={QUIET} rescheduleRequests={[req()]} />)
    expect(screen.getByText('A customer wants to move a visit')).toBeTruthy()
    // Short date, no year — "to Oct 12".
    expect(screen.getByText(/Nina Cole, to Oct 12/)).toBeTruthy()
  })

  it('counts them when several are waiting, and caps the names at two', () => {
    render(<OpsAlerts stats={QUIET} rescheduleRequests={[
      req({ id: 1, job_id: 1, client_name: 'Nina Cole' }),
      req({ id: 2, job_id: 2, client_name: 'Dana Smith', reschedule_requested_date: '2026-10-13' }),
      req({ id: 3, job_id: 3, client_name: 'Pat Lee', reschedule_requested_date: '2026-10-14' }),
    ]} />)
    expect(screen.getByText('3 customers want to move a visit')).toBeTruthy()
    const detail = screen.getByText(/Nina Cole/)
    expect(detail.textContent).toContain('Dana Smith')
    expect(detail.textContent).not.toContain('Pat Lee')
    expect(detail.textContent).toContain('and more')
  })

  it('offers Open for a single request, and never an inline Approve', () => {
    const onOpenJob = vi.fn()
    render(<OpsAlerts stats={QUIET} rescheduleRequests={[req({ job_id: 77 })]} onOpenJob={onOpenJob} />)
    const labels = screen.getAllByRole('button').map(b => b.textContent)
    expect(labels).toContain('Open')
    // The consequential action stays on the job page, where the scope and the
    // customer's message are visible.
    expect(labels.some(t => /approve|move|dismiss|decline/i.test(t))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenJob).toHaveBeenCalledWith(77)
  })

  it('offers no Open when several are waiting — it would be ambiguous', () => {
    render(<OpsAlerts stats={QUIET} onOpenJob={vi.fn()} rescheduleRequests={[
      req({ id: 1, job_id: 1 }), req({ id: 2, job_id: 2, client_name: 'Dana Smith' }),
    ]} />)
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
  })

  it('survives a request with no date (a message-only ask)', () => {
    render(<OpsAlerts stats={QUIET} rescheduleRequests={[
      req({ reschedule_requested_date: null, reschedule_request_message: 'any chance of Friday?' }),
    ]} />)
    expect(screen.getByText('A customer wants to move a visit')).toBeTruthy()
    expect(screen.getByText(/Nina Cole/)).toBeTruthy()
  })

  it('falls back to the property when the client has no name', () => {
    render(<OpsAlerts stats={QUIET} rescheduleRequests={[
      req({ client_name: null, property_name: '9 Lakeshore Dr' }),
    ]} />)
    expect(screen.getByText(/9 Lakeshore Dr, to Oct 12/)).toBeTruthy()
  })

  it('sits alongside the other alerts rather than replacing them', () => {
    render(
      <OpsAlerts
        stats={{ jobs: 10, unassigned: 2, capacityPct: 95 }}
        unassignedToday={[{ start_time: '10:00:00', open_for_claims: false }]}
        awaitingReply={[{ pending_claim_requests: 1, property_name: 'Harbour St' }]}
        rescheduleRequests={[req()]}
        onFocusUnassigned={vi.fn()}
      />,
    )
    expect(screen.getByText(/waiting to hear back/)).toBeTruthy()
    expect(screen.getByText(/need(s)? a crew/)).toBeTruthy()
    expect(screen.getByText('A customer wants to move a visit')).toBeTruthy()
    expect(screen.getByText(/booked/)).toBeTruthy()
  })

  it('carries no vetoed chrome and no failing status step', () => {
    const { container } = render(<OpsAlerts stats={QUIET} rescheduleRequests={[req()]} />)
    const html = container.innerHTML
    // Dots come from the measured SEV_DOT map (boardToneContrast holds it), so
    // the 500 steps that were under the 3:1 non-text floor cannot come back.
    expect(html).not.toMatch(/bg-(amber|rose|red|blue|emerald|violet)-500\b/)
    // No filled pill, no tinted resting banner.
    expect(html).not.toMatch(/rounded-full[^"]*bg-(amber|rose|blue|emerald|violet)-(50|100|200)\b/)
    expect(html).not.toMatch(/bg-(amber|rose|red|blue|emerald|violet)-(50|100)\b/)
  })
})

describe('OpsAlerts — the dots are all on the measured map', () => {
  it('uses no raw 500-step dot for any alert type', () => {
    const { container } = render(
      <OpsAlerts
        stats={{ jobs: 10, unassigned: 2, capacityPct: 95 }}
        unassignedToday={[{ start_time: '10:00:00', open_for_claims: true }]}
        awaitingReply={[{ pending_claim_requests: 2, property_name: 'Elm Ave' }]}
        rescheduleRequests={[req()]}
      />,
    )
    const dots = [...container.querySelectorAll('span[aria-hidden="true"]')]
      .map(s => s.className)
      .filter(c => c.includes('rounded-full'))
    expect(dots.length).toBe(4)
    for (const c of dots) {
      expect(c, `${c} is a failing 500 step`).not.toMatch(/-(amber|rose|red|blue|emerald|violet)-500\b/)
    }
  })
})
