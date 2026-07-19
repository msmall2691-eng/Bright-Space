import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const get = vi.fn()
vi.mock('../../../api', () => ({ get: (...a) => get(...a), post: vi.fn(), patch: vi.fn() }))
vi.mock('../../../utils/toastBus', () => ({ toast: vi.fn() }))
vi.mock('../../../utils/confirmBus', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }))

import ScheduleAuditPanel from '../ScheduleAuditPanel'

beforeEach(() => {
  get.mockImplementation((url) => {
    if (url.includes('/audit')) return Promise.resolve({ duplicate_jobs: [], orphaned_shifts: [] })
    if (url.includes('connecteam-drift')) return Promise.resolve({
      changes: [
        { job_id: 136, title: 'Turnover — 22 Kincaid St', type: 'deleted_in_connecteam' },
        { job_id: 6583, title: 'Residential Clean', type: 'changed_in_connecteam',
          brightbase: { scheduled_date: '2026-07-14', start_time: '09:00:00' },
          connecteam: { scheduled_date: '2026-07-14', start_time: '05:00:00' } },
      ],
    })
    return Promise.resolve(null)
  })
})
afterEach(() => { cleanup(); get.mockReset() })

describe('ScheduleAuditPanel', () => {
  it('renders nothing on a clean schedule', async () => {
    get.mockResolvedValue({ duplicate_jobs: [], orphaned_shifts: [], changes: [] })
    const { container } = render(<ScheduleAuditPanel />)
    await waitFor(() => expect(container.firstChild).toBeNull())
  })

  it('summarizes in plain language and offers a bulk re-send', async () => {
    render(<ScheduleAuditPanel />)
    await waitFor(() => expect(screen.getByText(/Connecteam sync — 2 to review/)).toBeTruthy())
    expect(screen.getByText(/Re-send all 2/)).toBeTruthy()
  })

  it('expands to plain-English items with clear actions (no jargon)', async () => {
    render(<ScheduleAuditPanel />)
    await waitFor(() => expect(screen.getByText(/2 to review/)).toBeTruthy())
    fireEvent.click(screen.getByText(/2 to review/))
    expect(screen.getByText('Its shift is no longer in Connecteam')).toBeTruthy()
    expect(screen.getByText('The time was changed in Connecteam')).toBeTruthy()
    expect(screen.getAllByText('Re-send to Connecteam').length).toBeGreaterThan(0)
    // The old jargon is gone.
    expect(screen.queryByText(/Keep BrightBase/)).toBeNull()
    expect(screen.queryByText(/orphaned/i)).toBeNull()
  })
})
