/**
 * The Autopilot approval queue on Home.
 *
 * What's pinned is what protects the owner and her customers:
 *
 *   - A drafted message is EDITABLE, and an edit is saved BEFORE the send.
 *     Approve executes immediately, so a send that raced the save would go
 *     out with the words she just replaced.
 *   - A structural proposal (assign this cleaner) has no message box —
 *     there's nothing to edit, and a textarea would imply otherwise.
 *   - An empty message can't be sent.
 *   - Drafting costs money, so it fires at most once per day per browser, and
 *     the day is claimed BEFORE the request — a failing run must not become a
 *     retry on every reload.
 *   - An empty queue renders nothing (the board was just cleared of dead
 *     space; a permanent "no proposals" box would put some back).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }))
vi.mock('../../../utils/toastBus', () => ({ pushToast: vi.fn() }))

import { get, post, patch } from '../../../api'
import ProposalsQueue, { claimDailyDraftRun, relTime } from '../ProposalsQueue'

const MESSAGE = {
  id: 21, agent_id: 'scout', kind: 'send_sms',
  title: 'Reply to Anna Sweet — waiting 6h',
  detail: 'Anna texted 6 hours ago and hasn’t had an answer.',
  payload: { conversation_id: 5, body: 'Hi Anna! Saturday works — see you at 9.',
             source: 'waiting_reply:5' },
  status: 'pending', created_at: '2026-08-23T12:00:00',
}

const ASSIGN = {
  id: 22, agent_id: 'mia', kind: 'assign_cleaner',
  title: 'Assign Dana to Sea Rose turnover on 2026-08-25',
  detail: null, payload: { job_id: 9, cleaner_id: 'crew-1' },
  status: 'pending', created_at: '2026-08-23T12:00:00',
}

const mountWith = (rows) => {
  get.mockResolvedValue(rows)
  return render(<ProposalsQueue />)
}

beforeEach(() => {
  localStorage.clear()
  get.mockReset(); post.mockReset(); patch.mockReset()
  post.mockResolvedValue({ status: 'executed' })
  patch.mockResolvedValue({})
})
afterEach(cleanup)

// ── the drafted message ─────────────────────────────────────────────────────

describe('a drafted message', () => {
  it('shows the draft in an editable box', async () => {
    mountWith([MESSAGE])
    const box = await screen.findByTestId('proposal-body-21')
    expect(box.value).toBe('Hi Anna! Saturday works — see you at 9.')
    expect(screen.getByRole('button', { name: /send it/i })).toBeTruthy()
  })

  it('saves an edit before sending, never after', async () => {
    mountWith([MESSAGE])
    const box = await screen.findByTestId('proposal-body-21')
    fireEvent.change(box, { target: { value: 'Hi Anna — Saturday at 10 instead?' } })
    fireEvent.click(screen.getByRole('button', { name: /send it/i }))

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/ai/proposals/21/approve'))
    expect(patch).toHaveBeenCalledWith('/api/ai/proposals/21',
      { payload: { body: 'Hi Anna — Saturday at 10 instead?' } })

    // Approve executes the send server-side the moment it lands, so the order
    // here is the whole point: a save that arrived second would be too late.
    const savedAt = patch.mock.invocationCallOrder[0]
    const sentAt = post.mock.invocationCallOrder.at(-1)
    expect(savedAt).toBeLessThan(sentAt)
  })

  it('sends an untouched draft without a pointless save', async () => {
    mountWith([MESSAGE])
    await screen.findByTestId('proposal-body-21')
    fireEvent.click(screen.getByRole('button', { name: /send it/i }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/ai/proposals/21/approve'))
    expect(patch).not.toHaveBeenCalled()
  })

  it('will not send an empty message', async () => {
    mountWith([MESSAGE])
    const box = await screen.findByTestId('proposal-body-21')
    fireEvent.change(box, { target: { value: '   ' } })
    const send = screen.getByRole('button', { name: /send it/i })
    expect(send.disabled).toBe(true)
    fireEvent.click(send)
    expect(post).not.toHaveBeenCalledWith('/api/ai/proposals/21/approve')
  })

  it('keeps the row and shows why when the send fails', async () => {
    post.mockResolvedValue({ status: 'failed', result: { error: 'No phone number on file' } })
    mountWith([MESSAGE])
    fireEvent.click(await screen.findByRole('button', { name: /send it/i }))
    expect(await screen.findByText(/No phone number on file/)).toBeTruthy()
    // Retrying blindly is exactly wrong here — she should read it and fix it.
    expect(screen.queryByRole('button', { name: /send it/i })).toBeNull()
  })
})

// ── a structural proposal ───────────────────────────────────────────────────

describe('a structural proposal', () => {
  it('has no message box, because there is nothing to edit', async () => {
    mountWith([ASSIGN])
    await screen.findByText(/Assign Dana/)
    expect(screen.queryByTestId('proposal-body-22')).toBeNull()
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeTruthy()
  })

  it('approves without touching the payload', async () => {
    mountWith([ASSIGN])
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/ai/proposals/22/approve'))
    expect(patch).not.toHaveBeenCalled()
  })
})

// ── dismissing ──────────────────────────────────────────────────────────────

it('dismisses without saving an edit', async () => {
  mountWith([MESSAGE])
  const box = await screen.findByTestId('proposal-body-21')
  fireEvent.change(box, { target: { value: 'not sending this' } })
  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/api/ai/proposals/21/dismiss'))
  expect(patch).not.toHaveBeenCalled()
})

// ── the empty queue ─────────────────────────────────────────────────────────

it('renders nothing at all when there is nothing waiting', async () => {
  const { container } = mountWith([])
  await waitFor(() => expect(get).toHaveBeenCalled())
  expect(container.textContent).toBe('')
})

// ── the once-a-day drafting run ─────────────────────────────────────────────

describe('the drafting run', () => {
  it('fires once on the first mount of the day, then lists', async () => {
    mountWith([MESSAGE])
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/ai/proposals?status=pending'))
    expect(post).toHaveBeenCalledWith('/api/ai/autopilot/draft-followups')
    // Listing first would show a queue that is about to grow — which reads as
    // a bug, not as work arriving.
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0])
  })

  it('does not fire again on the next mount that day', async () => {
    mountWith([MESSAGE])
    await waitFor(() => expect(get).toHaveBeenCalled())
    cleanup()
    post.mockClear(); get.mockClear()

    mountWith([MESSAGE])
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(post).not.toHaveBeenCalledWith('/api/ai/autopilot/draft-followups')
  })

  it('still lists the queue when drafting fails', async () => {
    post.mockRejectedValueOnce(new Error('rate limited'))
    mountWith([MESSAGE])
    expect(await screen.findByTestId('proposal-body-21')).toBeTruthy()
  })
})

describe('claimDailyDraftRun', () => {
  it('claims the day before the request, so a failure is not a retry loop', () => {
    const store = new Map()
    const storage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    }
    expect(claimDailyDraftRun(storage, '2026-08-23')).toBe(true)
    expect(claimDailyDraftRun(storage, '2026-08-23')).toBe(false)
    expect(claimDailyDraftRun(storage, '2026-08-24')).toBe(true)
  })

  it('declines rather than fires every load when storage is blocked', () => {
    // Private mode: without a place to remember the day, "once a day" would
    // silently become "every page load", which is the expensive failure.
    const storage = { getItem() { throw new Error('blocked') }, setItem() {} }
    expect(claimDailyDraftRun(storage, '2026-08-23')).toBe(false)
  })
})

describe('relTime', () => {
  it('reads a zoneless backend stamp as UTC, not as local time', () => {
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString().replace('Z', '')
    expect(relTime(oneHourAgo)).toBe('1h ago')
  })

  it('is blank rather than "Invalid Date" when there is no stamp', () => {
    expect(relTime(null)).toBe('')
  })
})
