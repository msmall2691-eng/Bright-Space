/**
 * GlobalToasts is the app-wide toast surface every page-level toast
 * implementation was consolidated onto (audit: 4 implementations in 3
 * screen positions -> 1). It must support everything the old per-page
 * useToast() hook did, including the action ("Undo") button used by
 * WeekGrid's conflict-retry toast and JobEditModal's cancel-undo flow.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import GlobalToasts from '../GlobalToasts'
import { toast } from '../../../utils/toastBus'

afterEach(cleanup)

describe('GlobalToasts', () => {
  it('renders a pushed toast message', () => {
    render(<GlobalToasts />)
    act(() => { toast.success('Saved') })
    expect(screen.getByText('Saved')).toBeDefined()
  })

  it('renders an action button and invokes onClick, then dismisses', () => {
    render(<GlobalToasts />)
    const onClick = vi.fn()
    act(() => {
      toast.error("Can't move: conflict", { action: { label: 'Reschedule anyway', onClick } })
    })
    const button = screen.getByRole('button', { name: 'Reschedule anyway' })
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.queryByText("Can't move: conflict")).toBeNull()
  })

  it('clicking the toast body (not the action) dismisses without firing onClick', () => {
    render(<GlobalToasts />)
    const onClick = vi.fn()
    act(() => { toast.info('Heads up', { action: { label: 'Do it', onClick } }) })
    fireEvent.click(screen.getByText('Heads up'))
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.queryByText('Heads up')).toBeNull()
  })
})
