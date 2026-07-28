import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

// Mock the api layer the pill reads from. Path resolves to src/api.js — the
// same module the component imports as '../../api'.
const get = vi.fn()
const post = vi.fn()
vi.mock('../../../api', () => ({ get: (...a) => get(...a), post: (...a) => post(...a) }))

import SyncHealthPill from '../SyncHealthPill'

afterEach(cleanup)
beforeEach(() => { get.mockReset(); post.mockReset() })

const health = (over = {}) => ({
  overall: 'ok', auto_flow_on: true,
  google: { configured: true, unsynced_count: 0 },
  connecteam: { configured: true, auto_dispatch: true, unsynced_count: 0 },
  issues: { duplicate_jobs: 0, orphaned_shifts: 0 },
  automation: { calendar_source_of_truth: 'brightbase' },
  ...over,
})

describe('SyncHealthPill', () => {
  it('renders nothing until health loads, then shows the calm ok state', async () => {
    get.mockResolvedValue(health())
    render(<SyncHealthPill />)
    expect(await screen.findByText('Auto-sync on')).toBeTruthy()
  })

  it('shows a syncing state with the backlog count', async () => {
    get.mockResolvedValue(health({
      overall: 'syncing', google: { configured: true, unsynced_count: 3 },
    }))
    render(<SyncHealthPill />)
    expect(await screen.findByText('Syncing 3…')).toBeTruthy()
  })

  it('shows an attention state with the issue count', async () => {
    get.mockResolvedValue(health({
      overall: 'attention', issues: { duplicate_jobs: 2, orphaned_shifts: 1 },
    }))
    render(<SyncHealthPill />)
    expect(await screen.findByText('3 need attention')).toBeTruthy()
  })

  it('opens the panel and the "Sync now" override calls the reconcile endpoint', async () => {
    get.mockResolvedValue(health())
    post.mockResolvedValue({ message: 'ok' })
    const onForced = vi.fn()
    render(<SyncHealthPill onForced={onForced} />)
    fireEvent.click(await screen.findByTestId('sync-health-pill'))
    fireEvent.click(await screen.findByText('Sync now'))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/jobs/sync-reconcile', {}))
    await waitFor(() => expect(onForced).toHaveBeenCalled())
  })

  it('stays quiet (renders nothing) if the health fetch fails', async () => {
    get.mockRejectedValue(new Error('boom'))
    const { container } = render(<SyncHealthPill />)
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="sync-health-pill"]')).toBeNull()
  })
})
