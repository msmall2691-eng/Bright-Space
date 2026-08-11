/**
 * Tidy Up review page: renders a duplicate group from the scan, and the
 * two-step merge (Merge duplicates → confirm) posts primary+duplicate and
 * drops the resolved group. Merge is destructive, so the confirm step matters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({ get: vi.fn(), post: vi.fn() }))

import { get, post } from '../../api'
import Cleanup from '../Cleanup'

const SCAN = {
  scanned: { clients: 2, properties: 0 },
  summary: { duplicate_client_groups: 1, duplicate_property_groups: 0, quality_flags: 0 },
  duplicate_clients: [{
    key: 'c1', reason: 'phone',
    clients: [
      { id: 1, name: 'Jane Doe', email: 'jane@home.com', phone: '2075551234', address: '9 Elm St',
        status: 'active', records: { jobs: 2, invoices: 1, quotes: 0, properties: 1 }, record_total: 4 },
      { id: 2, name: 'Jane Doe', email: 'jane@work.com', phone: '2075551234', address: '',
        status: 'active', records: { jobs: 0, invoices: 0, quotes: 0, properties: 0 }, record_total: 0 },
    ],
  }],
  duplicate_properties: [],
  quality: { no_contact: { count: 0, samples: [] }, no_property: { count: 0, samples: [] } },
}

beforeEach(() => {
  get.mockReset(); post.mockReset()
  get.mockResolvedValue(SCAN)
  post.mockResolvedValue({ merged_into: { id: 1, name: 'Jane Doe' }, removed: 2, moved: { jobs: 2 } })
})
afterEach(cleanup)

describe('Cleanup', () => {
  it('shows a duplicate group and merges it on confirm', async () => {
    render(<MemoryRouter><Cleanup /></MemoryRouter>)

    // group rendered (both records shown)
    expect(await screen.findByText('matched on phone')).toBeTruthy()
    expect(screen.getAllByText('Jane Doe').length).toBe(2)

    // two-step confirm
    fireEvent.click(screen.getByRole('button', { name: /merge duplicates/i }))
    const confirmBtn = screen.getByRole('button', { name: /merge 1 into keep/i })
    fireEvent.click(confirmBtn)

    // posted primary (richest, id 1) + duplicate (id 2)
    expect(await screen.findByText(/Merged 1 duplicate into Jane Doe/i)).toBeTruthy()
    expect(post).toHaveBeenCalledWith('/api/cleanup/clients/merge', { primary_id: 1, duplicate_id: 2 })
    expect(screen.getByText('No duplicate clients found')).toBeTruthy()
  })
})
