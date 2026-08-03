/**
 * useCustomerContext — powers the redesigned Comms Customer-360 panel
 * (Twenty-CRM record detail applied to a live conversation): the operator's
 * "everything I need while I'm texting them" aggregate.
 *
 * Pins the derivation rules — a wrong split here would hide the customer's
 * next visit or miscount their history mid-conversation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'

vi.mock('../../api', () => ({ get: vi.fn() }))
// Pin "today" so the upcoming/past split is deterministic regardless of when
// the suite runs. useCustomerContext reads todayYMD() from utils/format.
vi.mock('../../utils/format', () => ({ todayYMD: () => '2026-06-15' }))

import { useCustomerContext } from '../useCustomerContext'
import { get } from '../../api'

afterEach(() => cleanup())
beforeEach(() => vi.clearAllMocks())

describe('useCustomerContext', () => {
  it('returns empty state with no client id and never calls the API', () => {
    const { result } = renderHook(() => useCustomerContext(null))
    expect(result.current.upcomingJobs).toEqual([])
    expect(result.current.pastJobs).toEqual([])
    expect(result.current.stats.visitCount).toBe(0)
    expect(get).not.toHaveBeenCalled()
  })

  it('splits upcoming vs past jobs, sums paid lifetime value, and counts completed visits', async () => {
    get.mockImplementation(async (url) => {
      if (url.includes('/api/jobs')) {
        return [
          { id: 1, status: 'scheduled', scheduled_date: '2026-07-01', title: 'Next' },
          { id: 2, status: 'scheduled', scheduled_date: '2026-06-20', title: 'Sooner' },
          { id: 3, status: 'completed', scheduled_date: '2026-05-01', title: 'Done' },
          { id: 4, status: 'completed', scheduled_date: '2026-04-01', title: 'Older done' },
        ]
      }
      if (url.includes('/api/invoices')) {
        return [
          { id: 20, status: 'paid', total: 200, invoice_number: 'INV-1' },
          { id: 21, status: 'paid', total: 150, invoice_number: 'INV-2' },
          { id: 22, status: 'overdue', total: 90, invoice_number: 'INV-3' },
        ]
      }
      return []
    })

    const { result } = renderHook(() => useCustomerContext(7))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Upcoming sorted ascending -> soonest first; next visit = soonest date.
    expect(result.current.upcomingJobs.map(j => j.id)).toEqual([2, 1])
    expect(result.current.stats.nextServiceDate).toBe('2026-06-20')
    // Past sorted descending -> most recent first; last service = most recent.
    expect(result.current.pastJobs.map(j => j.id)).toEqual([3, 4])
    expect(result.current.stats.lastServiceDate).toBe('2026-05-01')
    // Lifetime = sum of PAID invoices only; visit count = completed jobs.
    expect(result.current.stats.lifetimeValue).toBe(350)
    expect(result.current.stats.visitCount).toBe(2)
    expect(result.current.unpaidInvoices.map(i => i.id)).toEqual([22])
  })

  it('degrades to empty on a failed endpoint instead of throwing', async () => {
    get.mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useCustomerContext(1))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.upcomingJobs).toEqual([])
    expect(result.current.stats.lifetimeValue).toBe(0)
  })
})
