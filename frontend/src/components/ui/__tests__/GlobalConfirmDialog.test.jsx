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
