/**
 * useLaunch — the Launch flow's stage detection + step actions. Stage is
 * INFERRED from the deal's quotes/jobs, so the stepper opens at the right
 * place and each action wraps the matching existing endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const get = vi.fn()
const post = vi.fn()
const patch = vi.fn()
vi.mock('../../api', () => ({ get: (...a) => get(...a), post: (...a) => post(...a), patch: (...a) => patch(...a) }))
vi.mock('../../utils/toastBus', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { useLaunch } from '../useLaunch'

const details = (over = {}) => ({ id: 5, quotes: [], jobs: [], ...over })

beforeEach(() => { get.mockResolvedValue(details()); post.mockResolvedValue({}); patch.mockResolvedValue({}) })
afterEach(() => { get.mockReset(); post.mockReset(); patch.mockReset() })

const mounted = async () => {
  const h = renderHook(() => useLaunch(5))
  await waitFor(() => expect(h.result.current.loading).toBe(false))
  return h
}

describe('useLaunch — stage detection', () => {
  it('opens at "quote" for a deal with no quote', async () => {
    const { result } = await mounted()
    expect(result.current.currentStep).toBe('quote')
    expect(result.current.steps.every(s => !s.done)).toBe(true)
  })

  it('opens at "send" once a draft quote exists', async () => {
    get.mockResolvedValue(details({ quotes: [{ id: 9, status: 'draft', quote_number: 'QT-1' }] }))
    const { result } = await mounted()
    expect(result.current.currentStep).toBe('send')
    expect(result.current.steps.find(s => s.key === 'quote').done).toBe(true)
  })

  it('opens at "accept" once the quote is sent', async () => {
    get.mockResolvedValue(details({ quotes: [{ id: 9, status: 'sent' }] }))
    const { result } = await mounted()
    expect(result.current.currentStep).toBe('accept')
  })

  it('opens at "schedule" once accepted with no scheduled job', async () => {
    get.mockResolvedValue(details({ quotes: [{ id: 9, status: 'accepted' }], jobs: [{ id: 3, status: 'unscheduled' }] }))
    const { result } = await mounted()
    expect(result.current.currentStep).toBe('schedule')
  })

  it('is fully done once a job is scheduled', async () => {
    get.mockResolvedValue(details({
      quotes: [{ id: 9, status: 'converted' }],
      jobs: [{ id: 3, status: 'scheduled', scheduled_date: '2026-08-10', cleaner_ids: [1] }],
    }))
    const { result } = await mounted()
    expect(result.current.steps.every(s => s.done)).toBe(true)
    expect(result.current.currentStep).toBe('schedule')
  })
})

describe('useLaunch — actions wrap the right endpoints', () => {
  it('sendQuote POSTs the quote send endpoint', async () => {
    get.mockResolvedValue(details({ quotes: [{ id: 9, status: 'draft' }] }))
    const { result } = await mounted()
    await act(async () => { await result.current.sendQuote() })
    expect(post).toHaveBeenCalledWith('/api/quotes/9/send', { channel: 'email' })
  })

  it('acceptQuote POSTs the accept endpoint', async () => {
    get.mockResolvedValue(details({ quotes: [{ id: 9, status: 'sent' }] }))
    const { result } = await mounted()
    await act(async () => { await result.current.acceptQuote() })
    expect(post).toHaveBeenCalledWith('/api/quotes/9/accept', { notify_customer: true })
  })

  it('scheduleJob POSTs convert-to-job with the schedule body', async () => {
    get.mockResolvedValue(details({ quotes: [{ id: 9, status: 'accepted' }] }))
    const { result } = await mounted()
    await act(async () => { await result.current.scheduleJob({ scheduled_date: '2026-08-12', start_time: '09:00', end_time: '11:00' }) })
    expect(post).toHaveBeenCalledWith('/api/quotes/9/convert-to-job', { scheduled_date: '2026-08-12', start_time: '09:00', end_time: '11:00' })
  })

  it('scheduleJob updates the EXISTING job (PATCH) instead of convert-to-job', async () => {
    // Accepting a property-linked quote already created an unscheduled job.
    get.mockResolvedValue(details({
      quotes: [{ id: 9, status: 'converted' }],
      jobs: [{ id: 3, status: 'unscheduled' }],
    }))
    const { result } = await mounted()
    await act(async () => { await result.current.scheduleJob({ scheduled_date: '2026-08-12', start_time: '09:00', end_time: '11:00' }) })
    expect(patch).toHaveBeenCalledWith('/api/jobs/3', { scheduled_date: '2026-08-12', start_time: '09:00', end_time: '11:00' })
    expect(post).not.toHaveBeenCalled()
  })
})

describe('useLaunch — surfaces soft failures instead of false success', () => {
  it('sendQuote rejects when the quote was not delivered', async () => {
    get.mockResolvedValue(details({ quotes: [{ id: 9, status: 'draft' }] }))
    post.mockResolvedValue({ delivered: false, errors: ['No email address'] })
    const { result } = await mounted()
    await expect(result.current.sendQuote()).rejects.toThrow(/No email address/)
  })
})
