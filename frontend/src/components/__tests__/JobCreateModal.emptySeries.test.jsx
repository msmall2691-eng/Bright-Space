/**
 * "Converting Adam from the request to a quote to a job is ridiculous and it
 * didn't show up on the schedule after I created it." — the owner.
 *
 * Root cause: she created an STR-turnover RECURRING series, which POSTs to
 * /api/recurring and can come back with jobs_created === 0 (no property on the
 * series, or every turnover date in range already on the calendar from the
 * property's feed). The modal handed the response to onCreated and closed, so
 * the Schedule page toasted success and showed nothing — a created series with
 * no visible visit and no explanation.
 *
 * What's pinned here: a zero-visit recurring create is NEVER a silent success.
 * The modal holds itself open and says what happened instead of closing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../api', () => ({ get: (...a) => get(...a), post: (...a) => post(...a) }))
vi.mock('../../utils/toastBus', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('../../hooks/useEmployees', () => ({ useEmployees: () => ({ employees: [] }) }))

import JobCreateModal from '../JobCreateModal'

beforeEach(() => { get.mockResolvedValue([]) })
afterEach(() => { cleanup(); get.mockReset(); post.mockReset() })

const fillAddress = () =>
  fireEvent.change(screen.getByPlaceholderText('123 Main St, Portland, ME'),
    { target: { value: '9 Test Rd, Wells, ME' } })

describe('recurring create that generates no visits', () => {
  it('holds the modal open and explains instead of closing on a silent success', async () => {
    post.mockResolvedValue({ id: 7, jobs_created: 0 })
    const onCreated = vi.fn()
    const onClose = vi.fn()
    render(<JobCreateModal clientId={42} clientName="Adam" defaultRecurring
      onClose={onClose} onCreated={onCreated} />)

    fillAddress()
    fireEvent.click(screen.getByTestId('job-create-submit'))

    // The warning appears...
    expect(await screen.findByText(/no visits were added/i)).toBeTruthy()
    expect(screen.getByText(/No property was selected/i)).toBeTruthy()
    // ...and the modal did NOT close as a success.
    expect(onCreated).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes normally when the series actually generates visits', async () => {
    post.mockResolvedValue({ id: 7, jobs_created: 3 })
    const onCreated = vi.fn()
    const onClose = vi.fn()
    render(<JobCreateModal clientId={42} clientName="Adam" defaultRecurring
      onClose={onClose} onCreated={onCreated} />)

    fillAddress()
    fireEvent.click(screen.getByTestId('job-create-submit'))

    // No warning; it hands back with the count and closes.
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(onCreated.mock.calls[0][0]).toMatchObject({ kind: 'recurring', jobsCreated: 3 })
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByText(/no visits were added/i)).toBeNull()
  })
})
