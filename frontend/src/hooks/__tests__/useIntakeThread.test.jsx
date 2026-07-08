/**
 * useIntakeThread — the Requests drawer's inline conversation hook.
 *
 * Two things worth pinning:
 *   1. Phone lookup searches the bare 10-digit tail, not the raw
 *      formatted value — the DB stores E.164 (+12075551234), so a
 *      literal "(207) 555-1234" LIKE-search would never match.
 *   2. Sending the first message (no existing conversation) goes
 *      through /api/comms/sms or /email — which auto-creates the
 *      conversation — and then loads the returned conversation_id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act, cleanup } from '@testing-library/react'

vi.mock('../../api', () => ({
  get: vi.fn(),
  post: vi.fn(),
}))

import { useIntakeThread } from '../useIntakeThread'
import { get, post } from '../../api'

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useIntakeThread', () => {
  it('searches the phone as a bare 10-digit tail, not the formatted value', async () => {
    get.mockResolvedValueOnce([]) // no match by phone
    const intake = { id: 1, name: 'Alice', phone: '(207) 555-1234' }
    renderHook(() => useIntakeThread(intake))

    await waitFor(() => expect(get).toHaveBeenCalled())
    const url = get.mock.calls[0][0]
    expect(url).toContain('2075551234')
    expect(url).not.toContain('%28') // no raw "(" encoded into the query
  })

  it('tries email before phone when both are present', async () => {
    get.mockResolvedValueOnce([]) // email search: no match
    get.mockResolvedValueOnce([]) // phone search: no match
    const intake = { id: 1, name: 'Alice', email: 'alice@example.com', phone: '2075551234' }
    renderHook(() => useIntakeThread(intake))

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    expect(get.mock.calls[0][0]).toContain('alice%40example.com')
    expect(get.mock.calls[1][0]).toContain('2075551234')
  })

  it('loads the matching conversation detail when the search finds one', async () => {
    get.mockResolvedValueOnce([{ id: 42, channel: 'sms' }]) // list match
    get.mockResolvedValueOnce({ id: 42, channel: 'sms', messages: [] }) // detail
    const intake = { id: 1, name: 'Alice', phone: '2075551234' }
    const { result } = renderHook(() => useIntakeThread(intake))

    await waitFor(() => expect(result.current.detail?.id).toBe(42))
    expect(result.current.channel).toBe('sms')
  })

  it('sending the first message with no existing thread creates one via /api/comms/sms', async () => {
    get.mockResolvedValueOnce([]) // no existing conversation
    const intake = { id: 1, name: 'Alice', phone: '2075551234', client_id: null }
    const { result } = renderHook(() => useIntakeThread(intake))
    await waitFor(() => expect(result.current.loading).toBe(false))

    post.mockResolvedValueOnce({ id: 99, conversation_id: 7, channel: 'sms' })
    get.mockResolvedValueOnce({ id: 7, channel: 'sms', messages: [{ id: 99, body: 'hi' }] })

    let ok
    await act(async () => {
      ok = await result.current.send({ body: 'hi', isNote: false })
    })

    expect(ok).toBe(true)
    expect(post).toHaveBeenCalledWith('/api/comms/sms', {
      to: '2075551234', body: 'hi', client_id: null,
    })
    await waitFor(() => expect(result.current.detail?.id).toBe(7))
  })

  it('surfaces the Twilio-sent-but-not-recorded case as an error instead of silently losing it', async () => {
    get.mockResolvedValueOnce([])
    const intake = { id: 1, name: 'Alice', phone: '2075551234' }
    const { result } = renderHook(() => useIntakeThread(intake))
    await waitFor(() => expect(result.current.loading).toBe(false))

    post.mockResolvedValueOnce({ success: false, twilio_sid: 'SM123' })

    let ok
    await act(async () => {
      ok = await result.current.send({ body: 'hi', isNote: false })
    })

    expect(ok).toBe(false)
    expect(result.current.error).toMatch(/SM123/)
  })
})
