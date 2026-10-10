/**
 * The invoice record page, which had no test at all.
 *
 * It is one of the two places money leaves the business and the only place an
 * invoice can be sent, marked paid, or hard-deleted, so the things worth
 * pinning are the ones where being wrong costs the owner a payment or a
 * customer relationship rather than a layout.
 *
 * ## The one that is easy to get wrong
 *
 * `POST /api/invoices/{id}/send` answers **200 with a per-channel result**:
 * `{results: {email: 'sent' | '<some failure>'}}`. A send that never reached
 * the customer is therefore a SUCCESSFUL request, and the obvious
 * `await post(...); toast.success('Sent')` reports a delivery that did not
 * happen and flips the invoice to `sent`. The owner then waits on a payment
 * for an invoice nobody received, and the status says it went.
 *
 * The page reads `results.email` and treats anything but `'sent'` as a
 * failure — the comment at the call site says so, which is exactly the kind of
 * decision that survives in prose until someone simplifies the function. These
 * cases hold it: a failed delivery must stay a failure AND must not advance
 * the status.
 *
 * ## What is deliberately NOT here
 *
 * The hard-delete guard. `utils/__tests__/invoiceDelete.test.js` already reads
 * both call sites' source and fails if either reaches for `del` directly, and
 * duplicating that here would mean two tests to update for one decision. What
 * IS here is the behaviour that file cannot see: declining the confirm leaves
 * you on the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(), patch: vi.fn(), post: vi.fn(), del: vi.fn(), download: vi.fn(),
}))
vi.mock('../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('../../utils/invoiceDelete', () => ({ confirmAndDeleteInvoice: vi.fn() }))

import { get, post } from '../../api'
import { toast } from '../../utils/toastBus'
import { confirmAndDeleteInvoice } from '../../utils/invoiceDelete'
import InvoiceDetail from '../InvoiceDetail'

const INVOICE = {
  id: 7,
  invoice_number: 'INV-1042',
  status: 'draft',
  total: 240,
  client_id: 3,
  client_name: 'Anna Sweet',
  items: [{ description: 'Deep clean', quantity: 1, rate: 240, amount: 240 }],
}

function mountAt(invoice = INVOICE) {
  get.mockResolvedValue(invoice)
  return render(
    <MemoryRouter initialEntries={['/invoices/7']}>
      <Routes><Route path="/invoices/:id" element={<InvoiceDetail />} /></Routes>
    </MemoryRouter>,
  )
}

/**
 * The real role gate, not a mock of it. `utils/perms.canEdit()` reads the
 * cached user out of localStorage, and the send / mark-paid / delete actions
 * are all behind it — so a test that mocked perms away would be asserting
 * about buttons the owner's own session might not even render. Setting the
 * role for real costs one line and buys the viewer case below.
 */
function signInAs(role) {
  localStorage.setItem('brightbase_user', JSON.stringify({ id: 1, role }))
}

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); signInAs('admin') })
afterEach(cleanup)

describe('InvoiceDetail', () => {
  it('reads the invoice once on mount, and from the details endpoint', async () => {
    mountAt()
    await screen.findByText('INV-1042')
    // The Tier 2c lesson: a record page that fetches twice on mount is a
    // request storm on the single container, and it only ever grows.
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toBe('/api/invoices/7/details')
  })

  it('renders the not-found state rather than throwing when the invoice is gone', async () => {
    get.mockRejectedValue(new Error('404'))
    render(
      <MemoryRouter initialEntries={['/invoices/7']}>
        <Routes><Route path="/invoices/:id" element={<InvoiceDetail />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/invoice not found/i)).toBeTruthy()
  })

  it('reports a send that did not reach the customer as a failure', async () => {
    // 200 OK, and the email still bounced. This is the whole point.
    post.mockResolvedValue({ results: { email: 'smtp: 550 mailbox unavailable' } })
    mountAt()
    fireEvent.click(await screen.findByRole('button', { name: /send invoice/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.error.mock.calls[0][0]).toMatch(/550 mailbox unavailable/)
    expect(toast.success, 'a failed delivery was reported as sent').not.toHaveBeenCalled()
  })

  it('does not advance a draft to sent when the delivery failed', async () => {
    // The status is what the owner reads later to decide whether to chase a
    // payment. A draft that silently became `sent` is an invoice nobody
    // follows up on.
    post.mockResolvedValue({ results: { email: 'no email on file' } })
    mountAt()
    fireEvent.click(await screen.findByRole('button', { name: /send invoice/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // Still offering to send it, which it would not be if it had flipped.
    expect(screen.getByRole('button', { name: /send invoice/i })).toBeTruthy()
    expect(screen.queryByText(/^sent$/i)).toBeNull()
  })

  it('reports a real send as sent', async () => {
    post.mockResolvedValue({ results: { email: 'sent' } })
    mountAt()
    fireEvent.click(await screen.findByRole('button', { name: /send invoice/i }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Invoice sent'))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('marks paid through the pay endpoint, not a status patch', async () => {
    // `/pay` records a Payment; a bare `PATCH {status: 'paid'}` would move the
    // invoice without the money ever being recorded against it.
    post.mockResolvedValue({})
    mountAt()
    fireEvent.click(await screen.findByRole('button', { name: /mark paid/i }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Invoice marked paid'))
    expect(post.mock.calls[0][0]).toBe('/api/invoices/7/pay')
  })

  /* The pay link. `invoice_to_dict` carried a `public_token` commented "lets
   * InvoiceDetail show/copy the customer's pay-page link" and this page never
   * read it — so the link the comment promised did not exist on the one screen
   * it named. */

  it('copies a pay link for a draft the customer has never been sent', async () => {
    // The case that makes the server round-trip necessary rather than tidy:
    // `public_token` is NULL until the invoice has been sent at least once, so
    // a link built from what is already on screen would be `/pay/null`.
    const link = 'https://maineclean.co/pay/tok_abc123'
    post.mockResolvedValue({ public_token: 'tok_abc123', invoice_link: link })
    const writeText = vi.fn().mockResolvedValue()
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    mountAt({ ...INVOICE, public_token: null })
    fireEvent.click(await screen.findByRole('button', { name: /copy pay link/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link))
    expect(post.mock.calls[0][0]).toBe('/api/invoices/7/generate-token')
    expect(await screen.findByText(/pay link copied/i)).toBeTruthy()
  })

  it('copies the link the server built, not one assembled from the browser origin', async () => {
    // An office user on a preview or LAN host would otherwise hand the
    // customer a URL only the office can reach. QuoteDetail builds its link
    // from window.location.origin; this one must not.
    post.mockResolvedValue({
      public_token: 'tok_abc123',
      invoice_link: 'https://maineclean.co/pay/tok_abc123',
    })
    const writeText = vi.fn().mockResolvedValue()
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    mountAt()
    fireEvent.click(await screen.findByRole('button', { name: /copy pay link/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0][0]).toBe('https://maineclean.co/pay/tok_abc123')
    expect(writeText.mock.calls[0][0]).not.toContain('localhost')
  })

  it('reports a failed copy instead of claiming it worked', async () => {
    post.mockRejectedValue(new Error('clipboard blocked'))
    mountAt()
    fireEvent.click(await screen.findByRole('button', { name: /copy pay link/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.queryByText(/pay link copied/i)).toBeNull()
  })

  it('does not offer a pay link once the invoice is paid', async () => {
    // Nothing left to pay, so the link is noise next to the record of payment.
    mountAt({ ...INVOICE, status: 'paid', paid_at: '2026-10-01T12:00:00' })
    await screen.findByText('INV-1042')
    expect(screen.queryByRole('button', { name: /copy pay link/i })).toBeNull()
  })

  it('hides the money actions from a viewer rather than letting them click into a 403', async () => {
    // perms.js states the reason: mutations are admin/manager-only on the
    // backend, so a viewer who can see the invoice must not be offered the
    // buttons. The invoice itself still renders — they can read it.
    signInAs('viewer')
    mountAt()
    expect(await screen.findByText('INV-1042')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /send invoice/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /mark paid/i })).toBeNull()
  })

  it('stays on the page when the delete confirm is declined', async () => {
    // The behaviour utils/invoiceDelete.test.js cannot see from source: a
    // decline returns false, and false must not navigate away.
    confirmAndDeleteInvoice.mockResolvedValue(false)
    mountAt()
    fireEvent.click(await screen.findByRole('button', { name: /delete/i }))

    await waitFor(() => expect(confirmAndDeleteInvoice).toHaveBeenCalled())
    expect(screen.getByText('INV-1042'), 'a declined delete navigated away').toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
