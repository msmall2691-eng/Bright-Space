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
vi.mock('../../utils/confirmBus', () => ({ confirmDialog: vi.fn() }))
import { del, patch } from '../../api'
import { confirmDialog } from '../../utils/confirmBus'
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

beforeEach(() => vi.clearAllMocks())

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

/* ---------------------------------------------------------------------- */

/**
 * deleteInvoice is a HARD delete and used to run with no confirmation at all,
 * while InvoiceDetail gated the same endpoint behind a danger dialog. It goes
 * through utils/invoiceDelete now. These cover the hook's half of that: it
 * asks, it only touches the list when something was actually deleted, and it
 * no longer eats the API's error message.
 */
describe('deleteInvoice asks first', () => {
  const selected = { id: 1, status: 'sent', invoice_number: 'INV-1' }

  it('does not touch the list when the operator backs out', async () => {
    confirmDialog.mockResolvedValue(false)
    const { result, load, toast, setPanel } = setup({ selected })
    await act(async () => { await result.current.deleteInvoice() })
    expect(del).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    expect(setPanel).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })

  it('deletes, refreshes and closes the panel once confirmed', async () => {
    confirmDialog.mockResolvedValue(true)
    del.mockResolvedValue({})
    const { result, load, toast, setPanel } = setup({ selected })
    await act(async () => { await result.current.deleteInvoice() })
    expect(del).toHaveBeenCalledWith('/api/invoices/1')
    expect(load).toHaveBeenCalled()
    expect(setPanel).toHaveBeenCalledWith(null)
    expect(toast).toHaveBeenCalledWith('Invoice deleted')
  })

  it("surfaces the API's message instead of a generic failure", async () => {
    // The old `catch {}` discarded it, so a 409 explaining exactly why the
    // delete was refused reached the operator as "Failed to delete invoice".
    confirmDialog.mockResolvedValue(true)
    del.mockRejectedValue(new Error('Cannot delete a paid invoice'))
    const { result, toast, load } = setup({ selected })
    await act(async () => { await result.current.deleteInvoice() })
    expect(toast).toHaveBeenCalledWith('Cannot delete a paid invoice', 'error')
    expect(load).not.toHaveBeenCalled()
  })
})
