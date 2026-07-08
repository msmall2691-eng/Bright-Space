/**
 * useClientQuickLinks — powers the Comms ContactPanel's "Open Items"
 * section (the Twenty-style "linked both ways" piece: a thread's contact
 * panel shouldn't dead-end at just phone/email/address).
 *
 * Pins the filtering rules since a wrong status set here would either
 * spam the panel with closed-out records or hide ones that need action.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'

vi.mock('../../api', () => ({ get: vi.fn() }))

import { useClientQuickLinks } from '../useClientQuickLinks'
import { get } from '../../api'

afterEach(() => cleanup())
beforeEach(() => vi.clearAllMocks())

describe('useClientQuickLinks', () => {
  it('returns empty lists with no client id, and never calls the API', async () => {
    const { result } = renderHook(() => useClientQuickLinks(null))
    expect(result.current.openQuotes).toEqual([])
    expect(result.current.upcomingJobs).toEqual([])
    expect(result.current.unpaidInvoices).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })

  it('keeps only open-ish quotes, upcoming+active jobs, and unpaid invoices', async () => {
    get.mockImplementation(async (url) => {
      if (url.includes('/api/quotes')) {
        return [
          { id: 1, status: 'sent', total: 100 },
          { id: 2, status: 'draft', total: 50 },      // excluded: not yet sent
          { id: 3, status: 'converted', total: 200 },  // excluded: already closed
          { id: 4, status: 'viewed', total: 75 },
        ]
      }
      if (url.includes('/api/jobs')) {
        return [
          { id: 10, status: 'scheduled', scheduled_date: '2999-01-01', title: 'Future' },
          { id: 11, status: 'completed', scheduled_date: '2999-01-02', title: 'Done already' }, // excluded
          { id: 12, status: 'scheduled', scheduled_date: '2000-01-01', title: 'Long past' }, // excluded: not upcoming
        ]
      }
      if (url.includes('/api/invoices')) {
        return [
          { id: 20, status: 'overdue', total: 300, invoice_number: 'INV-1' },
          { id: 21, status: 'paid', total: 150, invoice_number: 'INV-2' }, // excluded
          { id: 22, status: 'draft', total: 80, invoice_number: 'INV-3' }, // excluded: not sent yet
        ]
      }
      return []
    })

    const { result } = renderHook(() => useClientQuickLinks(42))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.openQuotes.map(q => q.id).sort()).toEqual([1, 4])
    expect(result.current.upcomingJobs.map(j => j.id)).toEqual([10])
    expect(result.current.unpaidInvoices.map(i => i.id)).toEqual([20])
  })

  it('caps each list at 3 items', async () => {
    get.mockImplementation(async (url) => {
      if (url.includes('/api/quotes')) {
        return Array.from({ length: 5 }, (_, i) => ({ id: i, status: 'sent', total: i }))
      }
      return []
    })
    const { result } = renderHook(() => useClientQuickLinks(1))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.openQuotes).toHaveLength(3)
  })

  it("degrades to empty on a failed endpoint instead of throwing", async () => {
    get.mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useClientQuickLinks(1))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.openQuotes).toEqual([])
    expect(result.current.upcomingJobs).toEqual([])
    expect(result.current.unpaidInvoices).toEqual([])
  })
})
