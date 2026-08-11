import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Both SyncCenter (post) and useSyncOverview (get) import src/api.js — from the
// test file that module id is '../../api'. Mocking it covers both.
const get = vi.fn()
const post = vi.fn()
vi.mock('../../api', () => ({ get: (...a) => get(...a), post: (...a) => post(...a) }))

import SyncCenter from '../SyncCenter'

afterEach(cleanup)
beforeEach(() => {
  get.mockReset(); post.mockReset()
  localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin' }))
})

const overview = (over = {}) => ({
  overall: 'attention',
  headline: 'Google Calendar isn’t connected',
  master: 'brightbase',
  auto_pilot: {
    on: false,
    toggles: {
      gcal_auto_sync_enabled: true, ical_auto_sync_enabled: true,
      recurring_auto_generate_enabled: true, sync_reconcile_enabled: true,
      connecteam_auto_dispatch_enabled: true, calendar_source_of_truth: 'brightbase',
    },
  },
  channels: [
    { key: 'google', name: 'Google Calendar', icon: 'calendar', direction: 'out',
      authority: 'brightbase', connected: false, enabled: true, toggle_key: 'gcal_auto_sync_enabled',
      last_sync_at: null, backlog: 0, sync_action: 'gcal', status: 'disconnected', summary: 'Not connected' },
    { key: 'connecteam', name: 'Connecteam', icon: 'users', direction: 'out',
      authority: 'brightbase', connected: true, enabled: true, toggle_key: 'connecteam_auto_dispatch_enabled',
      last_sync_at: null, backlog: 0, sync_action: 'reconcile', status: 'ok', summary: 'Every crew shift is up to date' },
    { key: 'airbnb', name: 'Airbnb & rentals', icon: 'home', direction: 'in',
      authority: 'external', connected: true, enabled: true, toggle_key: 'ical_auto_sync_enabled',
      last_sync_at: null, backlog: 0, feed_count: 1,
      feeds: [{ id: 1, property_id: 2, property: 'Unit 4', source: 'airbnb', last_synced_at: null, status: 'ok', error: null }],
      turnovers_upcoming: 2, sync_action: 'ical', status: 'ok', summary: '1 feed, 2 upcoming turnovers' },
    { key: 'recurring', name: 'Recurring cleanings', icon: 'repeat', direction: 'internal',
      authority: 'brightbase', connected: true, enabled: true, toggle_key: 'recurring_auto_generate_enabled',
      last_sync_at: null, backlog: 0, active_series: 1, upcoming_visits: 3, sync_action: 'recurring',
      status: 'ok', summary: '1 series · 3 visits scheduled' },
  ],
  attention: [{ level: 'warn', key: 'google_disconnected', title: 'Google Calendar isn’t connected',
    detail: 'Jobs can’t reach the calendar until you reconnect Google.',
    action: { kind: 'link', label: 'Open Settings', href: '/settings' } }],
  issues: { duplicate_jobs: 0, orphaned_shifts: 0 },
  background_jobs: [
    { key: 'gcal_sync', name: 'Push the schedule to Google', group: 'scheduling', cadence_minutes: 10, enabled: true },
  ],
  ...over,
})

const draw = () => render(<MemoryRouter><SyncCenter /></MemoryRouter>)

describe('SyncCenter', () => {
  it('renders the headline and every channel once loaded', async () => {
    get.mockResolvedValue(overview())
    draw()
    expect(await screen.findByText('Google Calendar')).toBeTruthy()
    expect(screen.getByText('Connecteam')).toBeTruthy()
    expect(screen.getByText('Airbnb & rentals')).toBeTruthy()
    expect(screen.getByText('Recurring cleanings')).toBeTruthy()
    // Attention item surfaces the disconnected backbone.
    expect(screen.getAllByText('Google Calendar isn’t connected').length).toBeGreaterThan(0)
  })

  it('flips the master auto-pilot switch by posting every auto-pilot flag (incl. reconcile)', async () => {
    get.mockResolvedValue(overview())
    post.mockResolvedValue({})
    draw()
    await screen.findByText('Google Calendar')
    // The master switch is the first one in the DOM (banner precedes the grid).
    fireEvent.click(screen.getAllByRole('switch')[0])
    // sync_reconcile_enabled MUST be in the set — otherwise the 30-min reconcile
    // tick keeps pushing to Google/Connecteam and "off" wouldn't actually pause.
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/settings/automation', {
      gcal_auto_sync_enabled: true, ical_auto_sync_enabled: true,
      recurring_auto_generate_enabled: true, connecteam_auto_dispatch_enabled: true,
      sync_reconcile_enabled: true,
    }))
  })

  it('lets managers run syncs but not flip admin-only toggles', async () => {
    localStorage.setItem('brightbase_user', JSON.stringify({ role: 'manager' }))
    get.mockResolvedValue(overview())
    draw()
    // Managers CAN sync (endpoints allow them)…
    expect(await screen.findByText('Sync everything now')).toBeTruthy()
    // …but every toggle (auto-pilot + per-channel pause) is admin-only, so all
    // switches are disabled (settings/automation is require_role("admin")).
    screen.getAllByRole('switch').forEach(sw => expect(sw.disabled).toBe(true))
    expect(screen.getByText(/pausing channels and auto-pilot is admin-only/i)).toBeTruthy()
  })

  it('"Sync everything now" fans out to the reconcile, feeds, and recurring endpoints', async () => {
    get.mockResolvedValue(overview())
    post.mockResolvedValue({})
    draw()
    fireEvent.click(await screen.findByText('Sync everything now'))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/jobs/sync-reconcile', {}))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/properties/sync-all', {}))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/recurring/generate-all', {}))
  })

  it('hides write controls from viewer accounts', async () => {
    localStorage.setItem('brightbase_user', JSON.stringify({ role: 'viewer' }))
    get.mockResolvedValue(overview())
    draw()
    await screen.findByText('Google Calendar')
    expect(screen.queryByText('Sync everything now')).toBeNull()
    // The read-only hint is shown instead.
    expect(screen.getByText(/read-only mode/i)).toBeTruthy()
  })
})
