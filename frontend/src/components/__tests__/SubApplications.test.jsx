/**
 * Applications in Settings.
 *
 * This screen hides itself when nobody has applied — a permanent empty panel is
 * noise. The trap that created was: a failed FETCH also rendered nothing, so a
 * real applicant sitting behind a network error looked exactly like zero
 * applicants. What's pinned here is that an error says so, while a genuine
 * empty stays hidden.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('../../api', () => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }))
vi.mock('../../utils/toastBus', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../../utils/confirmBus', () => ({ confirmDialog: vi.fn(() => Promise.resolve(false)) }))
vi.mock('../../utils/inviteFallback', () => ({ reportInvite: vi.fn(() => Promise.resolve(false)) }))

import { get } from '../../api'
import SubApplications from '../SubApplications'

beforeEach(() => { get.mockReset() })
afterEach(cleanup)

it('says so when applications cannot be loaded, instead of looking empty', async () => {
  get.mockRejectedValue(new Error('offline'))
  render(<SubApplications />)
  expect(await screen.findByText(/Couldn’t load applications just now/)).toBeTruthy()
})

it('stays hidden when nobody has actually applied', async () => {
  get.mockResolvedValue({ applications: [], counts: {} })
  const { container } = render(<SubApplications />)
  // Give the resolved promise a tick; the panel must still not appear.
  await Promise.resolve()
  expect(container.firstChild).toBeNull()
})

it('draws the panel once there are applications', async () => {
  get.mockResolvedValue({
    applications: [{ id: 1, name: 'Sam Reed', email: 's@example.com', status: 'new',
      created_at: '2026-09-01T00:00:00Z' }],
    counts: { new: 1 },
  })
  render(<SubApplications />)
  expect(await screen.findByText('Sam Reed')).toBeTruthy()
  expect(screen.queryByText(/Couldn’t load applications/)).toBeNull()
})
