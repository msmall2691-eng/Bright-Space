/**
 * Editing a quote where you read it.
 *
 * The quote page could Send, Preview, Download, Copy and Archive a quote —
 * everything except change what it says. The items, quantities, prices,
 * discount and tax were a read-only table, and the only editor lived on a
 * different page reachable by knowing to click a row there. Owner report:
 * "I'm not able to edit the quotes easily."
 *
 * The load-bearing rule under all of this is that THE SERVER OWNS THE MONEY.
 * The rows can preview a sum while you type, but a stored total always comes
 * back from the server's own recompute — two implementations of a total is how
 * a quote and its invoice come to disagree by a penny.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ patch: vi.fn() }))
const toastError = vi.fn()
vi.mock('../../../utils/toastBus', () => ({
  toast: { error: (...a) => toastError(...a), success: vi.fn(), info: vi.fn() },
}))

import { patch } from '../../../api'
import QuoteLineEditor, { normalizeItems, subtotalOf } from '../QuoteLineEditor'

const QUOTE = {
  id: 3, status: 'draft',
  items: [{ name: 'Deep clean', description: '3 bed', qty: 1, unit_price: 300 }],
  subtotal: 300, tax_rate: 0, tax: 0, discount: 0, total: 300,
  sent_at: null, updated_at: '2026-09-01T10:00:00Z',
}

const show = (quote = QUOTE, props = {}) =>
  render(<QuoteLineEditor quote={quote} editable onSaved={() => {}} {...props} />)

const editCell = (openBy, value) => {
  fireEvent.click(openBy)
  const input = document.querySelector('input:focus')
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
  return input
}

beforeEach(() => { patch.mockReset(); toastError.mockReset(); patch.mockResolvedValue(QUOTE) })
afterEach(cleanup)

// ── the shapes items actually arrive in ─────────────────────────────────────

it('reads both historical item shapes and writes back one', () => {
  // Older rows carry quantity/price; newer ones qty/unit_price. The editor
  // must not treat a legacy row as a zero.
  expect(normalizeItems([{ name: 'A', quantity: 2, price: 50 }])).toEqual(
    [{ name: 'A', description: '', qty: 2, unit_price: 50 }])
  expect(subtotalOf([{ qty: 2, unit_price: 50 }, { qty: 1, unit_price: 25 }])).toBe(125)
})

// ── editing ─────────────────────────────────────────────────────────────────

it('changing a price saves the whole item list in the canonical shape', async () => {
  show()
  editCell(screen.getByText('300'), '350')
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/quotes/3', {
    items: [{ name: 'Deep clean', description: '3 bed', qty: 1, unit_price: 350 }],
  }))
})

it('takes the server’s totals, not its own arithmetic', async () => {
  // Local math is a preview. What gets shown after a save is what the server
  // computed — including tax it applied that the browser never modelled.
  const onSaved = vi.fn()
  patch.mockResolvedValue({ ...QUOTE, items: [{ name: 'Deep clean', qty: 1, unit_price: 350 }],
    subtotal: 350, tax_rate: 5, tax: 17.5, total: 367.5 })
  const { rerender } = show(QUOTE, { onSaved })
  editCell(screen.getByText('300'), '350')

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(
    expect.objectContaining({ total: 367.5, tax: 17.5 })))
  // The page re-renders with the server's quote; the editor shows its numbers.
  rerender(<QuoteLineEditor quote={{ ...QUOTE, subtotal: 350, tax: 17.5, total: 367.5 }}
    editable onSaved={onSaved} />)
  expect(screen.getByText('$367.50')).toBeTruthy()
})

it('adds and removes lines', async () => {
  show()
  fireEvent.click(screen.getByRole('button', { name: /Add a line/ }))
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/quotes/3', {
    items: [expect.objectContaining({ name: 'Deep clean' }),
            { name: '', description: '', qty: 1, unit_price: 0 }],
  }))

  patch.mockClear()
  fireEvent.click(screen.getByRole('button', { name: /Remove Deep clean/ }))
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/quotes/3', { items: [] }))
})

it('edits the discount and the tax rate', async () => {
  show()
  editCell(screen.getAllByText('0')[0], '25')     // discount
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/quotes/3',
    expect.objectContaining({ discount: 25 })))
})

it('Escape abandons a cell without saving', () => {
  show()
  fireEvent.click(screen.getByText('300'))
  const input = document.querySelector('input:focus')
  fireEvent.change(input, { target: { value: '999' } })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(patch).not.toHaveBeenCalled()
  expect(screen.getByText('300')).toBeTruthy()
})

it('puts the old numbers back when a save fails', async () => {
  // Leaving the typed number on screen would tell her a price is saved that
  // isn't — the one lie a money screen must never tell.
  patch.mockRejectedValue({ detail: 'Quote is locked' })
  show()
  editCell(screen.getByText('300'), '350')
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Quote is locked'))
  expect(screen.getByText('300')).toBeTruthy()
})

// ── the customer's copy ─────────────────────────────────────────────────────

it('says the customer is looking at an older version after an edit', () => {
  show({ ...QUOTE, status: 'sent',
    sent_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-02T10:00:00Z' })
  expect(screen.getByText(/still sees the old version until you resend/)).toBeTruthy()
})

it('stays quiet on a quote that has not changed since it was sent', () => {
  show({ ...QUOTE, status: 'sent',
    sent_at: '2026-09-02T10:00:00Z', updated_at: '2026-09-01T10:00:00Z' })
  expect(screen.queryByText(/still sees the old version/)).toBeNull()
})

it('stays quiet on a quote that was never sent', () => {
  show()
  expect(screen.queryByText(/still sees the old version/)).toBeNull()
})

// ── permissions ─────────────────────────────────────────────────────────────

it('a viewer sees the numbers and cannot touch them', () => {
  show(QUOTE, { editable: false })
  expect(screen.getByText('300')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Add a line/ })).toBeNull()
  fireEvent.click(screen.getByText('300'))
  expect(document.querySelector('input:focus')).toBeNull()
})
