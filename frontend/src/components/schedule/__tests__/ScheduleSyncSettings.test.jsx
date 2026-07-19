import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../../api', () => ({ get: (...a) => get(...a), post: (...a) => post(...a) }))
vi.mock('../../../utils/toastBus', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import ScheduleSyncSettings from '../ScheduleSyncSettings'
import { toast } from '../../../utils/toastBus'

const renderDrawer = (open = true) =>
  render(<MemoryRouter><ScheduleSyncSettings open={open} onClose={() => {}} /></MemoryRouter>)

beforeEach(() => {
  get.mockResolvedValue({
    connecteam_auto_dispatch_enabled: true,
    gcal_live_sync: true,
    calendar_source_of_truth: 'brightbase',
    ical_auto_sync_enabled: true,
    recurring_auto_generate_enabled: true,
  })
  post.mockResolvedValue({ status: 'saved' })
})
afterEach(() => { cleanup(); get.mockReset(); post.mockReset() })

describe('ScheduleSyncSettings', () => {
  it('renders nothing when closed', () => {
    const { container } = renderDrawer(false)
    expect(container.firstChild).toBeNull()
  })

  it('loads settings and shows the grouped scheduling controls', async () => {
    renderDrawer()
    await waitFor(() => expect(screen.getByText('Live push to Connecteam')).toBeTruthy())
    expect(screen.getByText('Live sync with Google')).toBeTruthy()
    expect(screen.getByText('Auto-import turnovers')).toBeTruthy()
    expect(screen.getByText('Auto-generate upcoming visits')).toBeTruthy()
    expect(get).toHaveBeenCalledWith('/api/settings/automation')
  })

  it('saves a partial update when a toggle is flipped', async () => {
    renderDrawer()
    await waitFor(() => expect(screen.getByText('Live push to Connecteam')).toBeTruthy())
    // The Connecteam switch is on; flip it off.
    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[0])
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/settings/automation', { connecteam_auto_dispatch_enabled: false }))
  })

  it('warns when Google live sync is turned on but registration fails', async () => {
    // live sync starts OFF here so the toggle turns it ON.
    get.mockResolvedValue({ gcal_live_sync: false })
    post.mockResolvedValue({ status: 'saved', live_sync: { ok: false, error: 'Google not connected' } })
    renderDrawer()
    await waitFor(() => expect(screen.getByText('Live sync with Google')).toBeTruthy())
    const googleSwitch = screen.getAllByRole('switch')[1]  // Connecteam, Google, Airbnb, Recurring
    fireEvent.click(googleSwitch)
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/couldn't start.*Google not connected/)))
  })

  it('sets the source-of-truth via the who-wins buttons', async () => {
    renderDrawer()
    await waitFor(() => expect(screen.getByText('Google wins')).toBeTruthy())
    fireEvent.click(screen.getByText('Google wins'))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/settings/automation', { calendar_source_of_truth: 'google' }))
  })
})
