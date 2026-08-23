/**
 * CustomerActions — the "message them / book them" row now sitting on job,
 * property, request and deal pages.
 *
 * What's worth pinning is the judgement, not the markup: it costs nothing
 * until pressed (it's on pages that render constantly), it opens on the
 * channel the customer actually has, a lead with no client record can still
 * be answered, and you can't book a visit for a customer who doesn't exist.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  pushToast: vi.fn(),
}))

// Compose + booking are existing, separately-tested surfaces. Stub them so
// these tests are about what CustomerActions decides, and assert on the props
// it hands over — that hand-off is the actual contract.
vi.mock('../ComposeModal', () => ({
  ComposeModal: (props) => (
    <div data-testid="compose"
      data-to={props.initialTo}
      data-channel={props.initialChannel}
      data-client={String(props.clientId)}>
      <button onClick={() => props.onSent?.({ id: 1 })}>fake-send</button>
    </div>
  ),
}))
vi.mock('../../JobCreateModal', () => ({
  default: (props) => (
    <div data-testid="job-modal"
      data-client={String(props.clientId)}
      data-property={String(props.initialPropertyId)}>
      <button onClick={() => props.onCreated?.({ id: 9 })}>fake-create</button>
    </div>
  ),
}))

import { get } from '../../../api'
import CustomerActions from '../CustomerActions'

beforeEach(() => { get.mockReset() })
afterEach(cleanup)

describe('CustomerActions', () => {
  it('fetches nothing on mount', () => {
    render(<CustomerActions clientId={4} clientName="Anna Sweet" />)
    expect(get).not.toHaveBeenCalled()
    expect(screen.getByTestId('customer-message')).toBeTruthy()
  })

  it('looks the customer up on first press and opens on their phone', async () => {
    get.mockResolvedValue({ phone: '+12075550143', email: 'anna@example.com' })
    render(<CustomerActions clientId={4} clientName="Anna Sweet" />)

    fireEvent.click(screen.getByTestId('customer-message'))

    const compose = await screen.findByTestId('compose')
    expect(get).toHaveBeenCalledWith('/api/clients/4')
    expect(compose.getAttribute('data-to')).toBe('+12075550143')
    expect(compose.getAttribute('data-channel')).toBe('sms')
    expect(compose.getAttribute('data-client')).toBe('4')
  })

  it('opens on email when there is no phone on file', async () => {
    get.mockResolvedValue({ phone: null, email: 'anna@example.com' })
    render(<CustomerActions clientId={4} />)

    fireEvent.click(screen.getByTestId('customer-message'))

    const compose = await screen.findByTestId('compose')
    expect(compose.getAttribute('data-channel')).toBe('email')
    expect(compose.getAttribute('data-to')).toBe('anna@example.com')
  })

  it('only looks the customer up once, however many times you open it', async () => {
    get.mockResolvedValue({ phone: '+12075550143', email: null })
    render(<CustomerActions clientId={4} />)

    fireEvent.click(screen.getByTestId('customer-message'))
    fireEvent.click(await screen.findByText('fake-send'))
    await waitFor(() => expect(screen.queryByTestId('compose')).toBeNull())
    fireEvent.click(screen.getByTestId('customer-message'))
    await screen.findByTestId('compose')

    expect(get).toHaveBeenCalledTimes(1)
  })

  it('skips the lookup entirely when the host already has the contact', async () => {
    render(<CustomerActions clientId={4} phone="+12075550143" />)
    fireEvent.click(screen.getByTestId('customer-message'))

    const compose = await screen.findByTestId('compose')
    expect(get).not.toHaveBeenCalled()
    expect(compose.getAttribute('data-to')).toBe('+12075550143')
  })

  it('lets you answer a lead that has no client record yet', async () => {
    render(<CustomerActions phone="+12075550143" clientName="New lead" />)

    // Nothing to look up, and nothing to book a visit against.
    expect(screen.queryByTestId('customer-book')).toBeNull()
    fireEvent.click(screen.getByTestId('customer-message'))

    const compose = await screen.findByTestId('compose')
    expect(get).not.toHaveBeenCalled()
    expect(compose.getAttribute('data-to')).toBe('+12075550143')
  })

  it('renders nothing when there is neither a client nor a contact', () => {
    const { container } = render(<CustomerActions />)
    expect(container.textContent).toBe('')
  })

  it('books against this client and house, then tells the page to refresh', async () => {
    const onBooked = vi.fn()
    render(<CustomerActions clientId={4} clientName="Anna Sweet" propertyId={11} onBooked={onBooked} />)

    fireEvent.click(screen.getByTestId('customer-book'))
    const modal = await screen.findByTestId('job-modal')
    expect(modal.getAttribute('data-client')).toBe('4')
    expect(modal.getAttribute('data-property')).toBe('11')

    fireEvent.click(screen.getByText('fake-create'))
    expect(onBooked).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('job-modal')).toBeNull())
  })

  it('still opens the composer when the lookup fails', async () => {
    get.mockRejectedValue(new Error('offline'))
    render(<CustomerActions clientId={4} />)

    fireEvent.click(screen.getByTestId('customer-message'))

    // Blocking the send because a lookup failed would strand the operator —
    // they can type the number they already know.
    const compose = await screen.findByTestId('compose')
    expect(compose.getAttribute('data-to')).toBe('')
  })
})
