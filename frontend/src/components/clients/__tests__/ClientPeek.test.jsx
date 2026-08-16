import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const get = vi.fn()
const patch = vi.fn()
const post = vi.fn()
vi.mock('../../../api', () => ({
  get: (...a) => get(...a),
  patch: (...a) => patch(...a),
  post: (...a) => post(...a),
}))
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }))
vi.mock('../../../utils/toastBus', () => ({ toast }))

import ClientPeek from '../ClientPeek'

const PROFILE = {
  id: 7,
  name: 'Jamie Rivera',
  status: 'active',
  phone: '2075550100',
  email: 'jamie@example.com',
  address: '10 Harbor Rd',
  city: 'Portland',
  state: 'ME',
  properties: [],
  upcoming_visits: [],
  past_visits: [],
  visit_stats: { total: 0, completed: 0, upcoming: 0 },
}

const renderPeek = (props = {}) =>
  render(
    <MemoryRouter>
      <ClientPeek clientId={7} onClose={() => {}} {...props} />
    </MemoryRouter>
  )

beforeEach(() => {
  get.mockReset(); patch.mockReset(); post.mockReset()
  toast.success.mockReset(); toast.error.mockReset()
  get.mockResolvedValue(PROFILE)
})
afterEach(() => cleanup())

describe('ClientPeek — inline edit', () => {
  it('edits phone in place: click to edit, blur saves via PATCH, no profile refetch', async () => {
    patch.mockResolvedValue({ id: 7, phone: '+12075559999' })
    renderPeek()

    // Phone/Email/Address each render a "Click to edit" row; Phone is first.
    const editButtons = await screen.findAllByTitle('Click to edit', {}, { timeout: 3000 })
    fireEvent.click(editButtons[0])
    const input = screen.getByDisplayValue('2075550100')
    fireEvent.change(input, { target: { value: '2075559999' } })
    fireEvent.blur(input)

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/clients/7', { phone: '2075559999' }))
    // One load on mount; the edit must not trigger a second /profile fetch.
    expect(get).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it('shows a Message action that opens compose prefilled with the client', async () => {
    renderPeek()
    const msgBtn = await screen.findByRole('button', { name: /message/i })
    fireEvent.click(msgBtn)
    // ComposeModal renders a "To" field seeded with the client's phone.
    expect(await screen.findByDisplayValue('2075550100')).toBeTruthy()
  })
})

describe('ClientPeek — linear connectivity', () => {
  it('links a listed property to its record (previously inert text)', async () => {
    get.mockResolvedValue({
      ...PROFILE,
      properties: [{ id: 88, name: 'Lake House', address: '3 Shore Rd' }],
    })
    renderPeek()
    const link = await screen.findByText('Lake House')
    expect(link.closest('a').getAttribute('href')).toBe('/properties/88')
  })

  it('links an upcoming visit row to its job (previously inert text)', async () => {
    get.mockResolvedValue({
      ...PROFILE,
      upcoming_visits: [{ id: 99, scheduled_date: '2026-08-20', title: 'Biweekly clean', status: 'scheduled' }],
    })
    renderPeek()
    const link = await screen.findByText('Biweekly clean')
    expect(link.closest('a').getAttribute('href')).toBe('/jobs/99')
  })
})
