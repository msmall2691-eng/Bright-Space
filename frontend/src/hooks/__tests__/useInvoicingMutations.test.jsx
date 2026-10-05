/**
 * Optimistic row actions on the Invoicing list.
 *
 * markPaid / markOverdue used to `await patch(); await load()` — the row only
 * changed after a full round-trip, so it felt a beat slow. Now the row flips
 * locally at once and a background load() reconciles; a failed write rolls the
 * list back to the pre-action snapshot and turns the toast into an error. The
 * success toast fires only after the write confirms, so a failure shows just
 * the rollback error, never a "paid… then failed" double-toast.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../api', () => ({ del: vi.fn(), get: vi.fn(), patch: vi.fn(), post: vi.fn() }))
// Deleting an invoice now asks first. The spy has to be a module-level const
// wrapped in an arrow inside the factory — vi.mock is hoisted above the
// imports, so referencing it directly would hit the TDZ.
const confirmDialog = vi.fn(() => Promise.resolve(true))
vi.mock('../../utils/confirmBus', () => ({ confirmDialog: (...a) => confirmDialog(...a) }))
import { del, patch } from '../../api'
import { useInvoicingMutations } from '../useInvoicingMutations'

function setup(extra = {}) {
  const state = { invoices: [{ id: 1, status: 'sent', total: 100 }, { id: 2, status: 'sent', total: 50 }] }
  const setInvoices = vi.fn(arg => { state.invoices = typeof arg === 'function' ? arg(state.invoices) : arg })
  const load = vi.fn(), toast = vi.fn(), setPanel = vi.fn()
  const props = { load, setInvoices, selected: null, setPanel, form: {}, sendForm: {}, setSendForm: vi.fn(), toast, ...extra }
  const { result } = renderHook(() => useInvoicingMutations(props))
  return { result, state, load, toast, setPanel }
}
const byId = (state, id) => state.invoices.find(i => i.id === id)

const SENT = { id: 7, status: 'sent', invoice_number: 'INV-007' }
const PAID = { id: 9, status: 'paid', invoice_number: 'INV-009' }

// clearAllMocks clears calls but not implementations; re-arm the default yes so
// each test states its own answer.
beforeEach(() => { vi.clearAllMocks(); confirmDialog.mockResolvedValue(true) })

describe('optimistic markPaid', () => {
  it('flips the row at once, then confirms + reconciles on success', async () => {
    patch.mockResolvedValue({})
    const { result, state, load, toast } = setup()
    await act(async () => { await result.current.markPaid(1) })
    expect(byId(state, 1).status).toBe('paid')
    expect(byId(state, 1).paid_at).toBeTruthy()
    expect(byId(state, 2).status).toBe('sent')             // untouched
    expect(patch).toHaveBeenCalledWith('/api/invoices/1', expect.objectContaining({ paid_at: expect.any(String) }))
    expect(toast).toHaveBeenCalledWith('Marked as paid')   // success toast AFTER the write
    expect(load).toHaveBeenCalled()                        // background reconcile
  })

  it('rolls the list back and shows an error when the write fails', async () => {
    patch.mockRejectedValue(new Error('boom'))
    const { result, state, load, toast } = setup()
    await act(async () => { await result.current.markPaid(1) })
    expect(byId(state, 1).status).toBe('sent')             // restored to the snapshot
    expect(byId(state, 1).paid_at).toBeUndefined()
    expect(load).not.toHaveBeenCalled()                    // no reconcile on failure
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'error')  // error surfaced
    expect(toast).not.toHaveBeenCalledWith('Marked as paid') // no premature success toast
  })
})

describe('optimistic markOverdue', () => {
  it('flips at once on success', async () => {
    patch.mockResolvedValue({})
    const { result, state, toast, load } = setup()
    await act(async () => { await result.current.markOverdue(2) })
    expect(byId(state, 2).status).toBe('overdue')
    expect(toast).toHaveBeenCalledWith('Marked as overdue')
    expect(load).toHaveBeenCalled()
  })

  it('rolls back on failure', async () => {
    patch.mockRejectedValue(new Error('nope'))
    const { result, state, toast } = setup()
    await act(async () => { await result.current.markOverdue(2) })
    expect(byId(state, 2).status).toBe('sent')
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'error')
    expect(toast).not.toHaveBeenCalledWith('Marked as overdue')
  })
})

/**
 * The delete gate. DELETE /api/invoices/{id} is the only unrecoverable action
 * on this page and it used to fire straight off a single click in the edit
 * panel's footer, while the same endpoint on InvoiceDetail was already gated.
 * BB-SEC-10: the backend 409s a PAID invoice unless ?force=true, so the
 * escalated warning and the force flag have to travel together — a confirm
 * that warns about erasing a payment record and then fails is worse than none.
 */
describe('delete gate', () => {
  const run = async (selected) => {
    const ctx = setup({ selected })
    await act(async () => { await ctx.result.current.deleteInvoice() })
    return ctx
  }

  it('sends nothing when the confirm is cancelled', async () => {
    confirmDialog.mockResolvedValue(false)
    const { load, toast, setPanel } = await run(SENT)
    expect(confirmDialog).toHaveBeenCalledTimes(1)
    expect(del).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    expect(setPanel).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })

  it('deletes, refetches and closes the panel on a yes', async () => {
    del.mockResolvedValue({})
    const { load, toast, setPanel } = await run(SENT)
    expect(del).toHaveBeenCalledWith('/api/invoices/7')   // no force on an unpaid invoice
    expect(load).toHaveBeenCalled()
    expect(setPanel).toHaveBeenCalledWith(null)
    expect(toast).toHaveBeenCalledWith('Invoice deleted')
  })

  it('names the invoice and escalates the copy for a paid one', async () => {
    del.mockResolvedValue({})
    await run(PAID)
    const [msg, opts] = confirmDialog.mock.calls[0]
    expect(msg).toContain('INV-009')
    expect(msg).toMatch(/PAID/)
    expect(msg).toMatch(/cannot be recovered/)
    expect(opts).toMatchObject({ confirmLabel: 'Delete permanently', danger: true })
  })

  it('leaves the paid warning out when the invoice is unpaid', async () => {
    del.mockResolvedValue({})
    await run(SENT)
    expect(confirmDialog.mock.calls[0][0]).not.toMatch(/PAID/)
  })

  it('backs the escalated warning with force, so the delete actually lands', async () => {
    // Without ?force=true the server 409s and the dialog would have promised
    // something it can't do (BB-SEC-10).
    del.mockResolvedValue({})
    await run(PAID)
    expect(del).toHaveBeenCalledWith('/api/invoices/9?force=true')
  })

  it('asks nothing when no invoice is selected', async () => {
    await run(null)
    expect(confirmDialog).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })
})
