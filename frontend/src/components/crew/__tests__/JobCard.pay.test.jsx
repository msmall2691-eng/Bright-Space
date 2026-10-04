/**
 * What an assigned job pays, on the crew card.
 *
 * The cleaner's own per-job rate (agreed_rate) already rode the my-day payload
 * but was only ever shown on an open offer's claim row — a job they'd already
 * won showed no money at all. These pin that their income is visible on a job
 * that's theirs, hidden where there's no rate on file, and never an hourly
 * figure (brightbase-marketplace: per job, never per hour).
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import JobCard from '../JobCard'

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:stub')
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, blob: () => Promise.resolve(new Blob(['x'], { type: 'image/jpeg' })),
  }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const BASE = {
  id: 42, title: 'Clean', property_name: 'Harbour St', status: 'scheduled',
  scheduled_date: '2026-09-10', job_type: 'residential',
  client_name: 'Dana', my_helpers: [], house_notes: [],
}
const show = (job) => render(<MemoryRouter><JobCard job={job} /></MemoryRouter>)

it('shows what an assigned job pays', () => {
  show({ ...BASE, open: false, agreed_rate: 120 })
  expect(screen.getByText(/pays/i)).toBeTruthy()
  expect(screen.getByText('$120')).toBeTruthy()
})

it('shows nothing when no rate is on file', () => {
  show({ ...BASE, open: false, agreed_rate: null })
  expect(screen.queryByText(/pays/i)).toBeNull()
})

it('does not show the agreed-rate pay line on an open offer', () => {
  // An open offer carries its asking price in the claim row, not here; and it
  // has no agreed_rate yet. The top-of-card "Pays" line must not appear.
  show({ ...BASE, open: true, address: null, agreed_rate: null, posted_rate: 90 })
  expect(screen.queryByText(/pays/i)).toBeNull()
})
