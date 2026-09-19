import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const roleRef = { value: 'admin' }
vi.mock('../../../nav/routes', () => ({ currentRole: () => roleRef.value }))

import QuickActions from '../QuickActions'

const navigate = vi.fn()
beforeEach(() => { roleRef.value = 'admin'; navigate.mockReset() })
afterEach(cleanup)

describe('QuickActions', () => {
  it('renders the action tiles for an office role', () => {
    render(<QuickActions navigate={navigate} />)
    expect(screen.getByTestId('home-quick-actions')).toBeTruthy()
    ;['New quote', 'New job', 'Text a client', 'Add lead', 'New invoice', 'Quick note']
      .forEach(l => expect(screen.getByTestId(`qa-${l}`)).toBeTruthy())
  })

  it('deep-links each action to the form that owns it', () => {
    render(<QuickActions navigate={navigate} />)
    fireEvent.click(screen.getByTestId('qa-New quote'))
    expect(navigate).toHaveBeenCalledWith('/quotes?new=1')
    fireEvent.click(screen.getByTestId('qa-New invoice'))
    expect(navigate).toHaveBeenCalledWith('/billing?view=invoices&new=1')
    fireEvent.click(screen.getByTestId('qa-Text a client'))
    expect(navigate).toHaveBeenCalledWith('/comms?compose=1')
  })

  it('"Quick note" fires the add-note event instead of navigating', () => {
    const spy = vi.fn()
    window.addEventListener('bb:add-note', spy)
    render(<QuickActions navigate={navigate} />)
    fireEvent.click(screen.getByTestId('qa-Quick note'))
    expect(spy).toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    window.removeEventListener('bb:add-note', spy)
  })

  it('renders nothing for a non-office role', () => {
    roleRef.value = 'cleaner'
    render(<QuickActions navigate={navigate} />)
    expect(screen.queryByTestId('home-quick-actions')).toBeNull()
  })
})
