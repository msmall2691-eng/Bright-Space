/**
 * Turnover windows.
 *
 * The bug pinned here: a failed load left `windows` null, same as still
 * loading — and the skeleton was keyed only on `windows === null`, so it pulsed
 * forever underneath the error line. The page looked hung on a network blip.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const render = (ui) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>)

vi.mock('../../api', () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }))
vi.mock('../../utils/toastBus', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../../utils/confirmBus', () => ({ confirmDialog: vi.fn(() => Promise.resolve(false)) }))

import { get, post } from '../../api'
import Turnovers from '../Turnovers'

beforeEach(() => { get.mockReset(); post.mockReset() })
afterEach(cleanup)

it('shows the error and stops the skeleton when the load fails', async () => {
  get.mockRejectedValue({ detail: 'Server said no' })
  const { container } = render(<Turnovers />)
  expect(await screen.findByText(/Server said no/)).toBeTruthy()
  // The load failed, so the loading skeleton must be gone — not pulsing forever.
  expect(container.querySelector('.animate-pulse')).toBeNull()
})

it('shows the empty state when there are no windows', async () => {
  get.mockResolvedValue({ windows: [] })
  render(<Turnovers />)
  expect(await screen.findByText(/No windows planned/)).toBeTruthy()
})

it('plans a day through a real date field, not a window.prompt', async () => {
  // The picker used to be window.prompt('YYYY-MM-DD') — a bare text box, blocked
  // or ugly on a phone. It's a real <input type=date> in an inline form now.
  get.mockResolvedValue({ windows: [] })
  post.mockResolvedValue({ id: 42 })
  render(<Turnovers />)
  await screen.findByText(/No windows planned/)

  fireEvent.click(screen.getByRole('button', { name: /Plan a day/ }))
  const field = document.querySelector('input[type="date"]')
  expect(field).toBeTruthy()                       // a real date input, not a JS prompt
  fireEvent.change(field, { target: { value: '2026-09-19' } })
  fireEvent.click(screen.getByRole('button', { name: /Plan it/ }))

  await waitFor(() => expect(post).toHaveBeenCalledWith(
    '/api/turnover-windows', { service_date: '2026-09-19' }))
})
