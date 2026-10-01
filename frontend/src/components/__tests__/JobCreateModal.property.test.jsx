/**
 * Guardrail #6 — Property is field #2 on the schedule form (right after the
 * client), not buried in the "More options" disclosure, and it auto-fills when
 * the client has exactly one property. Jobs kept landing without a property
 * because the picker was hidden; this pins it visible and pre-selected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../api', () => ({ get: (...a) => get(...a), post: (...a) => post(...a) }))
vi.mock('../../utils/toastBus', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('../../hooks/useEmployees', () => ({ useEmployees: () => ({ employees: [] }) }))

import JobCreateModal from '../JobCreateModal'

const PROP = { id: 7, name: '4 Red Barn Circle', address: '4 Red Barn Circle', property_type: 'residential', client_id: 42 }

beforeEach(() => {
  get.mockImplementation((url) => {
    if (url.startsWith('/api/properties')) return Promise.resolve([PROP])
    return Promise.resolve([])
  })
  post.mockResolvedValue({ id: 1 })
})
afterEach(() => { cleanup(); get.mockReset(); post.mockReset() })

describe('Property on the schedule form', () => {
  it('shows the Property picker on open, without expanding More options', () => {
    render(<JobCreateModal clientId={42} clientName="Casey" onClose={() => {}} onCreated={() => {}} />)
    // Present immediately — not gated behind the "More options" disclosure.
    expect(screen.getByTestId('job-create-property-select')).toBeTruthy()
  })

  it('auto-selects the client\'s only property', async () => {
    render(<JobCreateModal clientId={42} clientName="Casey" onClose={() => {}} onCreated={() => {}} />)
    const select = screen.getByTestId('job-create-property-select')
    // The load effect applies the single property, so the field comes
    // pre-filled — no interaction needed in the common one-property case.
    await waitFor(() => expect(select.value).toBe('7'))
  })
})
