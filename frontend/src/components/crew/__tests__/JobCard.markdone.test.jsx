/**
 * Mark done on the crew job card.
 *
 * Marking an assigned job done is the single most important thing a cleaner
 * does, and for a stretch the card quietly stopped rendering the button (the
 * onMarkDone handler was wired from MyDay but never drawn). These pin that it's
 * back: present and working on an assigned job, and correctly absent where it
 * would be wrong — an open offer (not theirs to finish) and an already-done job.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import JobCard from '../JobCard'

beforeEach(() => {
  // PropertyPhoto fetches a blob on mount for any card with an address.
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
const show = (job, props = {}) =>
  render(<MemoryRouter><JobCard job={job} {...props} /></MemoryRouter>)

it('shows Mark done on an assigned job and fires the handler', () => {
  const onMarkDone = vi.fn()
  show({ ...BASE, open: false }, { onMarkDone })
  const btn = screen.getByRole('button', { name: /mark done/i })
  fireEvent.click(btn)
  expect(onMarkDone).toHaveBeenCalledTimes(1)
})

it('never shows Mark done on an open offer', () => {
  show({ ...BASE, open: true, address: null, posted_rate: 80 }, { onMarkDone: vi.fn() })
  expect(screen.queryByRole('button', { name: /mark done/i })).toBeNull()
})

it('never shows Mark done on an already-completed job', () => {
  show({ ...BASE, open: false, status: 'completed' }, { onMarkDone: vi.fn() })
  expect(screen.queryByRole('button', { name: /mark done/i })).toBeNull()
})

it('is absent as a read-only card (no handler passed)', () => {
  show({ ...BASE, open: false })
  expect(screen.queryByRole('button', { name: /mark done/i })).toBeNull()
})
