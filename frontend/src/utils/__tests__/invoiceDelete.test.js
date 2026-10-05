/**
 * Deleting an invoice is permanent, so it asks first — from everywhere.
 *
 * `DELETE /api/invoices/{id}` is a hard delete: no soft-delete, no trash, no
 * undo, and with `?force=true` it takes a paid invoice's payment record with
 * it. `InvoiceDetail` gated it behind a danger dialog. The Invoicing list
 * panel called the SAME endpoint with no confirmation at all — one click on a
 * sent invoice destroyed it and stopped the customer's copy working, with
 * nothing asked.
 *
 * The shape of the fix matters as much as the fix: copying the dialog into the
 * second call site would have left two copies to drift apart, which is how
 * they got here. Both call this instead, and the last case below is the one
 * that keeps it that way.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../../api', () => ({ del: vi.fn() }))
vi.mock('../confirmBus', () => ({ confirmDialog: vi.fn() }))

import { del } from '../../api'
import { confirmDialog } from '../confirmBus'
import { confirmAndDeleteInvoice } from '../invoiceDelete'

const SRC = dirname(fileURLToPath(import.meta.url))

const SENT = { id: 7, status: 'sent', invoice_number: 'INV-0007' }
const PAID = { id: 9, status: 'paid', invoice_number: 'INV-0009' }

beforeEach(() => { del.mockReset(); confirmDialog.mockReset(); del.mockResolvedValue({}) })
afterEach(() => vi.clearAllMocks())

describe('it asks before destroying anything', () => {
  it('does NOT call the API when the operator backs out', async () => {
    confirmDialog.mockResolvedValue(false)
    const deleted = await confirmAndDeleteInvoice(SENT)
    expect(deleted).toBe(false)
    expect(del).not.toHaveBeenCalled()
  })

  it('deletes once confirmed', async () => {
    confirmDialog.mockResolvedValue(true)
    const deleted = await confirmAndDeleteInvoice(SENT)
    expect(deleted).toBe(true)
    expect(del).toHaveBeenCalledWith('/api/invoices/7')
  })

  it('names the invoice in the prompt, so you can see what you are destroying', async () => {
    confirmDialog.mockResolvedValue(true)
    await confirmAndDeleteInvoice(SENT)
    expect(confirmDialog.mock.calls[0][0]).toContain('INV-0007')
    expect(confirmDialog.mock.calls[0][1]).toMatchObject({ danger: true })
  })

  it('refuses an invoice with no id rather than calling DELETE /api/invoices/undefined', async () => {
    expect(await confirmAndDeleteInvoice(null)).toBe(false)
    expect(await confirmAndDeleteInvoice({})).toBe(false)
    expect(confirmDialog).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })
})

describe('a paid invoice is the dangerous case', () => {
  it('warns that the payment record goes too', async () => {
    confirmDialog.mockResolvedValue(true)
    await confirmAndDeleteInvoice(PAID)
    expect(confirmDialog.mock.calls[0][0]).toMatch(/PAID/)
    expect(confirmDialog.mock.calls[0][0]).toMatch(/erases the record of that payment/)
  })

  it('escalates to ?force=true ONLY for a paid invoice (BB-SEC-10)', async () => {
    confirmDialog.mockResolvedValue(true)
    await confirmAndDeleteInvoice(PAID)
    expect(del).toHaveBeenCalledWith('/api/invoices/9?force=true')

    del.mockClear()
    await confirmAndDeleteInvoice(SENT)
    expect(del).toHaveBeenCalledWith('/api/invoices/7')   // no force
  })

  it('does not warn about payment for an unpaid invoice', async () => {
    confirmDialog.mockResolvedValue(true)
    await confirmAndDeleteInvoice(SENT)
    expect(confirmDialog.mock.calls[0][0]).not.toMatch(/PAID/)
  })
})

describe('errors reach the caller', () => {
  it('propagates instead of swallowing, so a 409 can be explained', async () => {
    // The list panel's old `catch {}` threw the message away, so the backend's
    // "cannot delete a paid invoice" became a generic failure.
    confirmDialog.mockResolvedValue(true)
    del.mockRejectedValue(new Error('Cannot delete a paid invoice'))
    await expect(confirmAndDeleteInvoice(SENT)).rejects.toThrow('Cannot delete a paid invoice')
  })
})

describe('there is exactly one delete path', () => {
  it('neither call site calls the endpoint directly any more', () => {
    // The guard against the two copies drifting apart again. Both files must
    // go through this helper rather than reaching for `del` themselves.
    for (const rel of ['../../pages/InvoiceDetail.jsx', '../../hooks/useInvoicingMutations.js']) {
      const src = readFileSync(join(SRC, rel), 'utf8')
      expect(src, `${rel} still deletes an invoice directly`)
        .not.toMatch(/del\(\s*`?\/api\/invoices\//)
      expect(src, `${rel} does not use the shared delete`).toContain('confirmAndDeleteInvoice')
    }
  })
})
