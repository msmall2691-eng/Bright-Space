import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../api', () => ({ get: (...a) => get(...a), post: (...a) => post(...a) }))
vi.mock('../../utils/toastBus', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('../../hooks/useEmployees', () => ({
  useEmployees: () => ({
    // Mixed roster shapes: a clean {id,name} AND a raw Connecteam
    // {userId,firstName,lastName} with no `id`, to prove normalization.
    employees: [
      { id: 'e1', name: 'Alice' },
      { userId: 'u2', firstName: 'Bob', lastName: 'Ng' },
    ],
  }),
}))

import JobCreateModal from '../JobCreateModal'

beforeEach(() => {
  get.mockResolvedValue([])           // property load, etc.
  post.mockResolvedValue({ id: 1, title: 'Casey — Clean' })
})
afterEach(() => { cleanup(); get.mockReset(); post.mockReset() })

// clientId (+ clientName) puts the modal in client-scoped mode: the client
// picker is skipped and the essentials are pre-valid, so we can drive straight
// to the cleaner picker + Create.
const renderModal = (props = {}) =>
  render(<JobCreateModal clientId={42} clientName="Casey" onClose={() => {}} onCreated={() => {}} {...props} />)

describe('JobCreateModal — assign cleaner at creation', () => {
  it('shows the cleaner picker in the essentials, with Connecteam names normalized', () => {
    renderModal()
    expect(screen.getByText('Cleaner')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alice' })).toBeTruthy()
    // Raw Connecteam shape (userId + first/last, no id/name) still renders a
    // real name — not "Cleaner undefined".
    expect(screen.getByRole('button', { name: 'Bob Ng' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /undefined/i })).toBeNull()
  })

  it('sends the normalized cleaner_ids (userId when there is no id)', async () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Bob Ng' }))
    fireEvent.click(screen.getByRole('button', { name: /^Schedule Job$|^Create/i }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    const [url, body] = post.mock.calls.find(c => c[0] === '/api/jobs') || []
    expect(url).toBe('/api/jobs')
    expect(body.cleaner_ids).toEqual(['u2'])  // userId, not 'undefined'
  })

  it('defaults to unassigned (empty cleaner_ids) when none picked', async () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /^Schedule Job$|^Create/i }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    const [, body] = post.mock.calls.find(c => c[0] === '/api/jobs') || []
    expect(body.cleaner_ids).toEqual([])
  })
})
