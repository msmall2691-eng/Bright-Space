import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react'
import GlobalConfirmDialog from '../GlobalConfirmDialog'
import { confirmDialog } from '../../../utils/confirmBus'

afterEach(cleanup)

describe('GlobalConfirmDialog', () => {
  it('renders a pushed request and resolves true on Confirm', async () => {
    render(<GlobalConfirmDialog />)

    let pending
    act(() => {
      pending = confirmDialog('Delete this client?', { confirmLabel: 'Delete', danger: true })
    })
    expect(screen.getByText('Delete this client?')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await expect(pending).resolves.toBe(true)
    await waitFor(() => expect(screen.queryByText('Delete this client?')).toBeNull())
  })

  it('resolves false on Cancel', async () => {
    render(<GlobalConfirmDialog />)

    let pending
    act(() => {
      pending = confirmDialog('Remove this property?')
    })
    expect(screen.getByText('Remove this property?')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect(pending).resolves.toBe(false)
  })

  it('queues a second request behind the first', async () => {
    render(<GlobalConfirmDialog />)

    let first, second
    act(() => {
      first = confirmDialog('First?')
      second = confirmDialog('Second?')
    })
    expect(screen.getByText('First?')).toBeDefined()
    expect(screen.queryByText('Second?')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await expect(first).resolves.toBe(true)
    await waitFor(() => expect(screen.getByText('Second?')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await expect(second).resolves.toBe(true)
  })
})

/**
 * The third answer.
 *
 * Cancelling a recurring series has two honest yeses — "and clear the visits
 * already booked" and "but leave them on the calendar" — and squeezing that
 * into yes/no is what made cancelling feel like it did nothing: the app took
 * the safe branch every time and left eight weeks of visits on the schedule.
 */
describe('GlobalConfirmDialog — a third answer', () => {
  it('resolves the string "alt" so the caller can tell it from a plain yes', async () => {
    render(<GlobalConfirmDialog />)
    let pending
    act(() => {
      pending = confirmDialog('Cancel this series?', {
        confirmLabel: 'Cancel series and its 8 visits',
        altLabel: 'Keep the booked visits',
      })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Keep the booked visits' }))
    await expect(pending).resolves.toBe('alt')
  })

  it('still resolves true and false from the other two', async () => {
    render(<GlobalConfirmDialog />)
    let pending
    act(() => { pending = confirmDialog('Cancel?', { altLabel: 'Keep them' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await expect(pending).resolves.toBe(true)

    act(() => { pending = confirmDialog('Cancel?', { altLabel: 'Keep them' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect(pending).resolves.toBe(false)
  })

  it('shows no third button when the caller does not offer one', () => {
    // Every existing caller is in this case, and must be untouched.
    render(<GlobalConfirmDialog />)
    act(() => { confirmDialog('Delete this?') })
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})
