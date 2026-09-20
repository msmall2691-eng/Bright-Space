/**
 * Optimistic status changes on the Quoting list.
 *
 * A quote's status chip (and a lead's status) used to change only after the
 * PATCH round-trip completed. Now the chip flips across the list at once and a
 * background reload reconciles; a failed write rolls the list back to the
 * pre-action snapshot. accept/declined still confirm first (they convert to a
 * job and notify) and only flip once the owner confirms.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../api', () => ({ del: vi.fn(), patch: vi.fn(), post: vi.fn() }))
vi.mock('../../utils/confirmBus', () => ({ confirmDialog: vi.fn() }))
import { patch } from '../../api'
import { useQuotingMutations } from '../useQuotingMutations'

function setup(extra = {}) {
  const state = {
    quotes: [{ id: 1, status: 'draft' }, { id: 2, status: 'sent' }],
    intakes: [{ id: 10, status: 'new' }],
  }
  const setQuotes = vi.fn(a => { state.quotes = typeof a === 'function' ? a(state.quotes) : a })
  const setIntakes = vi.fn(a => { state.intakes = typeof a === 'function' ? a(state.intakes) : a })
  const loadQuotes = vi.fn(), loadIntakes = vi.fn(), loadFollowUps = vi.fn(), loadArchived = vi.fn(), toast = vi.fn()
  const props = {
    toast, loadQuotes, loadIntakes, loadFollowUps, loadArchived,
    setQuotes, setIntakes, selectedIds: new Set(), clearSelection: vi.fn(),
    currentSelectedId: null, onSelectedCleared: vi.fn(), ...extra,
  }
  const { result } = renderHook(() => useQuotingMutations(props))
  return { result, state, loadQuotes, loadFollowUps, loadIntakes, toast }
}
const q = (state, id) => state.quotes.find(x => x.id === id)
const lead = (state, id) => state.intakes.find(x => x.id === id)

beforeEach(() => vi.clearAllMocks())

describe('optimistic quote status', () => {
  it('flips the chip at once and reconciles on success (plain status)', async () => {
    patch.mockResolvedValue({})
    const { result, state, loadQuotes, loadFollowUps } = setup()
    await act(async () => { await result.current.updateStatus(1, 'sent') })
    expect(q(state, 1).status).toBe('sent')
    expect(q(state, 2).status).toBe('sent')  // untouched
    expect(patch).toHaveBeenCalledWith('/api/quotes/1', { status: 'sent' })
    expect(loadQuotes).toHaveBeenCalled()
    expect(loadFollowUps).toHaveBeenCalled()
  })

  it('rolls back when the write fails', async () => {
    patch.mockRejectedValue(new Error('boom'))
    const { result, state, loadQuotes, toast } = setup()
    await act(async () => { await result.current.updateStatus(1, 'viewed') })
    expect(q(state, 1).status).toBe('draft')  // restored
    expect(loadQuotes).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalled()
  })
})

describe('optimistic lead status', () => {
  it('marks a lead reviewed at once and reconciles', async () => {
    patch.mockResolvedValue({})
    const { result, state, loadIntakes } = setup()
    await act(async () => { await result.current.markIntakeReviewed(10) })
    expect(lead(state, 10).status).toBe('reviewed')
    expect(patch).toHaveBeenCalledWith('/api/intake/10', { status: 'reviewed' })
    expect(loadIntakes).toHaveBeenCalled()
  })

  it('rolls a lead back on failure', async () => {
    patch.mockRejectedValue(new Error('nope'))
    const { result, state, loadIntakes, toast } = setup()
    await act(async () => { await result.current.updateLeadStatus(10, 'quoted') })
    expect(lead(state, 10).status).toBe('new')
    expect(loadIntakes).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalled()
  })
})
