/**
 * VisitDetailsDrawer crew hand-off section. Pins that the drawer:
 *   - surfaces "Not sent yet" with a "Send to crew" action for an assigned
 *     but un-dispatched visit, and calls onDispatch(job) on tap;
 *   - shows "Sent to crew" (with a Re-send) once shifts exist;
 *   - hides the hand-off block entirely when there's no crew to notify.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import VisitDetailsDrawer from '../VisitDetailsDrawer'

afterEach(cleanup)

const baseProps = {
  showMore: false,
  onToggleMore: () => {},
  jobEvents: [],
  empName: (id) => `Cleaner ${id}`,
  onClose: () => {},
  onNavigateJob: () => {},
  onComplete: () => {},
  onEditJob: () => {},
  onDelete: () => {},
  onToggleReminder: () => {},
}

const bundle = (jobOverrides = {}, visitOverrides = {}) => ({
  visit: { id: 5, status: 'scheduled', scheduled_date: '2026-08-10', start_time: '09:00', cleaner_ids: [1], ...visitOverrides },
  job: { id: 42, client_name: 'Acme', cleaner_ids: [1], connecteam_shift_ids: [], ...jobOverrides },
  property: { name: 'Site', address: '1 Main St' },
})

describe('VisitDetailsDrawer — crew hand-off', () => {
  it('shows "Not sent yet" and sends on tap for an un-dispatched visit', () => {
    const onDispatch = vi.fn()
    render(<VisitDetailsDrawer {...baseProps} selectedVisit={bundle()} onDispatch={onDispatch} dispatchingJobId={null} />)
    expect(screen.getByText(/Not sent yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Send to crew/ }))
    expect(onDispatch).toHaveBeenCalledTimes(1)
    expect(onDispatch.mock.calls[0][0].id).toBe(42)
  })

  it('shows "Sent to crew" with a Re-send once shifts exist', () => {
    render(<VisitDetailsDrawer {...baseProps}
      selectedVisit={bundle({ connecteam_shift_ids: ['s1'] })} onDispatch={() => {}} dispatchingJobId={null} />)
    expect(screen.getByText(/Sent to crew/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Re-send/ })).toBeTruthy()
  })

  it('shows a busy state while dispatching', () => {
    render(<VisitDetailsDrawer {...baseProps}
      selectedVisit={bundle()} onDispatch={() => {}} dispatchingJobId={42} />)
    const btn = screen.getByRole('button', { name: /Sending…/ })
    expect(btn.disabled).toBe(true)
  })

  it('hides the hand-off block when there is no crew to notify', () => {
    render(<VisitDetailsDrawer {...baseProps}
      selectedVisit={bundle({ cleaner_ids: [] }, { cleaner_ids: [] })} onDispatch={() => {}} dispatchingJobId={null} />)
    expect(screen.queryByText('Crew hand-off')).toBeNull()
  })

  it('omits the hand-off block entirely when no onDispatch handler is provided', () => {
    render(<VisitDetailsDrawer {...baseProps} selectedVisit={bundle()} />)
    expect(screen.queryByText('Crew hand-off')).toBeNull()
  })
})
