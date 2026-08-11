/**
 * useDeals — data + the two row mutations that drive the board.
 *   moveStage  → optimistic PATCH to /api/opportunities, reverts on failure
 *   triageLead → POST convert-to-client, then reload (the inbox→deal bridge)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const get = vi.fn()
const patch = vi.fn()
const post = vi.fn()
vi.mock('../../api', () => ({
  get: (...a) => get(...a), patch: (...a) => patch(...a), post: (...a) => post(...a),
}))

import { useDeals } from '../useDeals'

const lead = { id: 'lead-1', kind: 'lead', lead_id: 1, stage: 'inbox', title: 'Web Lead' }
const deal = { id: 'deal-9', kind: 'deal', opportunity_id: 9, stage: 'new', title: 'Deal' }

beforeEach(() => {
  get.mockResolvedValue([lead, deal])
  patch.mockResolvedValue({})
  post.mockResolvedValue({})
})
afterEach(() => { get.mockReset(); patch.mockReset(); post.mockReset() })

const mounted = async () => {
  const h = renderHook(() => useDeals())
  await waitFor(() => expect(h.result.current.loading).toBe(false))
  return h
}

describe('useDeals', () => {
  it('loads the deal cards', async () => {
    const { result } = await mounted()
    expect(result.current.deals).toHaveLength(2)
  })

  it('moveStage optimistically updates then PATCHes the opportunity', async () => {
    const { result } = await mounted()
    await act(async () => { await result.current.moveStage(deal, 'qualified') })
    expect(patch).toHaveBeenCalledWith('/api/opportunities/9', { stage: 'qualified' })
    expect(result.current.deals.find(d => d.id === 'deal-9').stage).toBe('qualified')
  })

  it('moveStage reverts the card when the PATCH fails', async () => {
    patch.mockRejectedValueOnce(new Error('boom'))
    const { result } = await mounted()
    await act(async () => { await result.current.moveStage(deal, 'won') })
    expect(result.current.deals.find(d => d.id === 'deal-9').stage).toBe('new')
    expect(result.current.error).toMatch(/reverted/i)
  })

  it('moveStage ignores inbox leads (they are triaged, not moved)', async () => {
    const { result } = await mounted()
    await act(async () => { await result.current.moveStage(lead, 'new') })
    expect(patch).not.toHaveBeenCalled()
  })

  it('triageLead converts the lead then reloads', async () => {
    const { result } = await mounted()
    get.mockResolvedValueOnce([deal])  // after triage the lead is gone from the inbox
    await act(async () => { await result.current.triageLead(lead) })
    expect(post).toHaveBeenCalledWith('/api/intake/1/convert-to-client', {})
    await waitFor(() => expect(result.current.deals).toHaveLength(1))
  })
})
