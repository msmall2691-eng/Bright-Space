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
        status: 'active', created_at: '2024-03-12T10:00:00Z',
        records: { jobs: 2, invoices: 1, quotes: 0, properties: 1 }, record_total: 4 },
      { id: 2, name: 'Jane Doe', email: 'jane@work.com', phone: '2075551234', address: '',
        status: 'lead', created_at: '2026-09-01T10:00:00Z',
        records: { jobs: 0, invoices: 0, quotes: 0, properties: 0 }, record_total: 0 },
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
    // The resolved group is gone and, with nothing else flagged, the page says
    // so ONCE — not a per-section all-clear card, which is furniture that
    // teaches you to skip the spot the real finding appears in.
    expect(screen.queryByText('matched on phone')).toBeNull()
    expect(screen.getByText('Nothing to tidy up')).toBeTruthy()
  })

  it('shows when each record was added, and its lifecycle', async () => {
    // `created_at` and `status` have ridden the scan payload since it shipped
    // and nothing rendered either — on the one screen whose entire job is
    // "which of these do I keep". The date is the "which is the original"
    // signal; the status stops you folding an active client into a lead.
    render(<MemoryRouter><Cleanup /></MemoryRouter>)
    await screen.findByText('matched on phone')
    expect(screen.getByText(/added Mar 12, 2024/)).toBeTruthy()
    expect(screen.getByText(/added Sep 1, 2026/)).toBeTruthy()
    expect(screen.getByText('active')).toBeTruthy()
    expect(screen.getByText('lead')).toBeTruthy()
  })

  it('survives a record with no created_at', async () => {
    get.mockResolvedValue({
      ...SCAN,
      duplicate_clients: [{
        ...SCAN.duplicate_clients[0],
        clients: SCAN.duplicate_clients[0].clients.map(c => ({ ...c, created_at: null })),
      }],
    })
    render(<MemoryRouter><Cleanup /></MemoryRouter>)
    await screen.findByText('matched on phone')
    expect(screen.queryByText(/added /)).toBeNull()
  })

  it('caps the duplicate groups and folds the rest', async () => {
    // A business with twenty duplicate groups got twenty expanded cards and an
    // unbounded scroll. This is a triage surface: a screenful, then the tail.
    const many = Array.from({ length: 9 }, (_, i) => ({
      key: `c${i + 10}`, reason: 'phone',
      clients: [
        { id: 100 + i * 2, name: `Dup ${i} A`, email: '', phone: '', address: '', status: 'active',
          created_at: null, records: {}, record_total: 1 },
        { id: 101 + i * 2, name: `Dup ${i} B`, email: '', phone: '', address: '', status: 'active',
          created_at: null, records: {}, record_total: 0 },
      ],
    }))
    get.mockResolvedValue({ ...SCAN, duplicate_clients: many })
    render(<MemoryRouter><Cleanup /></MemoryRouter>)
    await screen.findByText('Dup 0 A')
    expect(screen.getByText('Dup 5 A')).toBeTruthy()   // 6th group, the cap
    expect(screen.queryByText('Dup 6 A')).toBeNull()   // 7th, folded
    fireEvent.click(screen.getByRole('button', { name: /\+3 more duplicate groups/i }))
    expect(await screen.findByText('Dup 8 A')).toBeTruthy()
  })

  it('carries no status colour at a failing step', async () => {
    const { container } = render(<MemoryRouter><Cleanup /></MemoryRouter>)
    await screen.findByText('matched on phone')
    // Measured against this page's grounds: rose-500 2.98:1 and emerald-500
    // 2.09:1 against a 3:1 dot floor, rose-600 3.88:1 against 4.5:1 for text.
    // `bg-indigo-500` is the ACCENT (remapped to --accent-500), not a status,
    // and marks the keeper — so it is allowed and excluded here.
    const html = container.innerHTML
    expect(html).not.toMatch(/bg-(rose|red|amber|emerald)-500\b/)
    expect(html).not.toMatch(/text-(rose|red|amber|emerald)-(500|600)\b/)
  })

  it('costs exactly one scan on mount', async () => {
    render(<MemoryRouter><Cleanup /></MemoryRouter>)
    await screen.findByText('matched on phone')
    expect(get).toHaveBeenCalledTimes(1)
    expect(String(get.mock.calls[0][0])).toBe('/api/cleanup/scan')
  })
})
