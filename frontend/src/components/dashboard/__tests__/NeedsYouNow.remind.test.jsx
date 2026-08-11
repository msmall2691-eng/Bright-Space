/**
 * NeedsYouNow inline "Remind" flow. A past-due invoice attention row carries
 * an `invoiceId`, which turns its action into a two-tap payment reminder:
 *   tap 1 (Remind) arms a confirm — nothing is sent yet
 *   tap 2 (Send email) POSTs /api/invoices/{id}/send and dismisses the row
 * The two-tap gate exists because tap 2 emails a real customer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../../api', () => ({ get: (...a) => get(...a), post: (...a) => post(...a) }))
vi.mock('../../../utils/toastBus', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

import { NeedsYouNow } from '../NeedsYouNow'
import { toast } from '../../../utils/toastBus'

beforeEach(() => {
  get.mockResolvedValue({ requests: [] })   // no reschedule approvals
  post.mockResolvedValue({ ok: true })
})
afterEach(() => { cleanup(); get.mockReset(); post.mockReset(); toast.success.mockReset(); toast.error.mockReset() })

const invoiceItem = {
  key: 'inv-42',
  tone: 'rose',
  title: 'Past-due invoice · $500',
  sub: 'Invoice #42 · Acme',
  action: 'Call',
  onClick: vi.fn(),
  invoiceId: 42,
}

const renderTile = (attention) =>
  render(<NeedsYouNow attention={attention} loading={false} navigate={() => {}} />)

describe('NeedsYouNow — inline invoice Remind', () => {
  it('shows a Remind action and does not send on the first tap', async () => {
    renderTile([invoiceItem])
    const remind = await screen.findByRole('button', { name: 'Remind' })
    fireEvent.click(remind)
    // Arms the confirm — still nothing sent.
    expect(screen.getByRole('button', { name: /Send email/ })).toBeTruthy()
    expect(post).not.toHaveBeenCalled()
  })

  it('sends the reminder on the second tap and dismisses the row', async () => {
    renderTile([invoiceItem])
    fireEvent.click(await screen.findByRole('button', { name: 'Remind' }))
    fireEvent.click(screen.getByRole('button', { name: /Send email/ }))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/api/invoices/42/send')
    expect(body.channel).toBe('email')
    expect(typeof body.custom_message).toBe('string')
    expect(toast.success).toHaveBeenCalledWith('Reminder sent')

    // Row drops out after a successful send.
    await waitFor(() => expect(screen.queryByText('Past-due invoice · $500')).toBeNull())
  })

  it('cancel disarms the confirm without sending', async () => {
    renderTile([invoiceItem])
    fireEvent.click(await screen.findByRole('button', { name: 'Remind' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Remind' })).toBeTruthy()
    expect(post).not.toHaveBeenCalled()
  })

  it('keeps the row and toasts on a send failure', async () => {
    post.mockRejectedValueOnce(new Error('smtp down'))
    renderTile([invoiceItem])
    fireEvent.click(await screen.findByRole('button', { name: 'Remind' }))
    fireEvent.click(screen.getByRole('button', { name: /Send email/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('smtp down'))
    expect(screen.getByText('Past-due invoice · $500')).toBeTruthy()
  })
})
