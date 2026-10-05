/**
 * EditPanel is documented as "fully controlled — parent owns ... every
 * handler", and the invoice-delete confirm deliberately lives in
 * useInvoicingMutations rather than here. These tests pin that split: the
 * footer hands off to the injected handler and raises NO dialog of its own, so
 * the gate can't later drift into the component and double-prompt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const confirmDialog = vi.fn(() => Promise.resolve(true))
vi.mock('../../../utils/confirmBus', () => ({ confirmDialog: (...a) => confirmDialog(...a) }))
// Pulls in ../api and fetches its field list on mount; not what's under test.
vi.mock('../../CustomFields', () => ({ CustomFieldsForm: () => null }))

import { EditPanel } from '../EditPanel'

const SENT = { id: 7, invoice_number: 'INV-007', client_id: 3, status: 'sent' }

let deleteInvoice
const props = (over = {}) => ({
  selected: SENT,
  // `items` must be an array — constants.sub() reduces over it.
  form: {
    client_id: '3', items: [{ name: 'Clean', qty: 1, unit_price: 100 }],
    tax_rate: 0, discount: 0, due_date: '', notes: '', custom_fields: {},
  },
  setForm: vi.fn(),
  updateItem: vi.fn(),
  showInvAdvanced: false, setShowInvAdvanced: vi.fn(),
  saving: false, save: vi.fn(),
  deleting: false, deleteInvoice,
  closePanel: vi.fn(),
  openSend: vi.fn(),
  clients: [{ id: 3, name: 'Acme' }],
  clientName: () => 'Acme',
  ...over,
})

beforeEach(() => { vi.clearAllMocks(); deleteInvoice = vi.fn() })
afterEach(cleanup)

describe('EditPanel delete footer', () => {
  it('hands off to the injected handler and raises no dialog of its own', () => {
    render(<EditPanel {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: /Delete invoice/ }))
    expect(deleteInvoice).toHaveBeenCalledTimes(1)
    // The confirm belongs to the hook — a second one here would double-prompt.
    expect(confirmDialog).not.toHaveBeenCalled()
  })

  it('blocks a second click while a delete is in flight', () => {
    render(<EditPanel {...props({ deleting: true })} />)
    const btn = screen.getByRole('button', { name: /Deleting/ })
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(deleteInvoice).not.toHaveBeenCalled()
  })

  it('offers no delete at all when creating a new invoice', () => {
    render(<EditPanel {...props({ selected: null })} />)
    expect(screen.queryByRole('button', { name: /Delete invoice/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create invoice' })).toBeTruthy()
  })
})
