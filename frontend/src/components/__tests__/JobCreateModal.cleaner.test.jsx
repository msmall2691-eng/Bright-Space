import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../api', () => ({ get: (...a) => get(...a), post: (...a) => post(...a) }))
vi.mock('../../utils/toastBus', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('../../hooks/useEmployees', () => ({
  useEmployees: () => ({
    employees: [{ id: 'e1', name: 'Alice' }, { id: 'e2', name: 'Bob' }],
    empName: (id) => ({ e1: 'Alice', e2: 'Bob' }[id]),
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
  it('shows the cleaner picker in the essentials', () => {
    renderModal()
    expect(screen.getByText('Cleaner')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alice' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Bob' })).toBeTruthy()
  })

  it('sends the selected cleaner_ids when creating the job', async () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Alice' }))
    fireEvent.click(screen.getByRole('button', { name: /^Schedule Job$|^Create/i }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    const [url, body] = post.mock.calls.find(c => c[0] === '/api/jobs') || []
    expect(url).toBe('/api/jobs')
    expect(body.cleaner_ids).toEqual(['e1'])
  })

  it('defaults to unassigned (empty cleaner_ids) when none picked', async () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /^Schedule Job$|^Create/i }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    const [, body] = post.mock.calls.find(c => c[0] === '/api/jobs') || []
    expect(body.cleaner_ids).toEqual([])
  })
})
