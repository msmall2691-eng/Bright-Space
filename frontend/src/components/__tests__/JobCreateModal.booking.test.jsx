/**
 * Booking never dead-ends on a missing address.
 *
 * The trap this pins: a quote could be accepted for a client with no property
 * and no address on file, then "Book it" opened this modal, the operator hit
 * Save, and the backend 422'd ("no property / no service address") as a raw
 * error with the fix hidden on another page. Now the modal treats a one-off
 * job as needing somewhere to live — it requires an address when no property
 * is picked, reveals the field so the operator can add one in place, and
 * accepts the source quote's address as a prefill so it's never re-typed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../api', () => ({ get: (...a) => get(...a), post: (...a) => post(...a) }))
vi.mock('../../utils/toastBus', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('../../hooks/useEmployees', () => ({ useEmployees: () => ({ employees: [] }) }))

import JobCreateModal from '../JobCreateModal'

// A client with NO properties and NO address on file — the stranded-quote case.
beforeEach(() => {
  get.mockImplementation((url) => {
    if (url.startsWith('/api/properties')) return Promise.resolve([])
    if (url.startsWith('/api/clients/')) return Promise.resolve({ id: 42, name: 'Casey' })
    return Promise.resolve([])
  })
  post.mockResolvedValue({ id: 1 })
})
afterEach(() => { cleanup(); get.mockReset(); post.mockReset() })

describe('Booking a quote with no place for the work to live', () => {
  it('disables Save and reveals the address field instead of dead-ending', async () => {
    render(<JobCreateModal clientId={42} clientName="Casey" onClose={() => {}} onCreated={() => {}} />)
    // The inline guidance appears (so the hidden "More options" address field
    // has been revealed), and Save is blocked until there's somewhere to go.
    const hint = await screen.findByText(/somewhere to go/i)
    expect(hint).toBeTruthy()
    expect(screen.getByTestId('job-create-submit').disabled).toBe(true)
  })

  it('enables Save once a service address is typed — no backend round-trip to fail', async () => {
    render(<JobCreateModal clientId={42} clientName="Casey" onClose={() => {}} onCreated={() => {}} />)
    await screen.findByText(/somewhere to go/i)
    const addr = screen.getByPlaceholderText(/123 Main St/i)
    fireEvent.change(addr, { target: { value: '9 Dockside Ln, Portland, ME' } })
    await waitFor(() => expect(screen.getByTestId('job-create-submit').disabled).toBe(false))
  })

  it('prefills the address from the source quote so Save is ready and the field need not be re-typed', async () => {
    render(
      <JobCreateModal
        clientId={42}
        clientName="Casey"
        initialQuoteId={99}
        initialAddress="9 Dockside Ln, Portland, ME"
        onClose={() => {}}
        onCreated={() => {}}
      />,
    )
    // With the quote's address seeded, the job has a place to live immediately:
    // Save is enabled and the "add an address" guidance never shows.
    await waitFor(() => expect(screen.getByTestId('job-create-submit').disabled).toBe(false))
    expect(screen.queryByText(/somewhere to go/i)).toBeNull()
  })
})
