/**
 * One-tap "On my way" on the crew job card.
 *
 * The on_the_way text already existed, two taps deep in the Text-client sheet.
 * This surfaces it as a single tap on the day's job — but only where it's valid:
 * a job that's theirs, with a phone on file, and only when the caller wires the
 * handler (MyDay does that for TODAY's jobs; the server refuses it otherwise).
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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
  client_name: 'Dana', can_text_client: true, my_helpers: [], house_notes: [],
}
const show = (job, props = {}) =>
  render(<MemoryRouter><JobCard job={job} {...props} /></MemoryRouter>)
const onMyWay = (q = /on my way/i) => screen.queryByRole('button', { name: q })

it('shows On my way on an assigned, textable job and fires the handler', () => {
  const onOnMyWay = vi.fn()
  show({ ...BASE, open: false }, { onOnMyWay })
  const btn = onMyWay()
  expect(btn).toBeTruthy()
  fireEvent.click(btn)
  expect(onOnMyWay).toHaveBeenCalledTimes(1)
})

it('is hidden when the client has no phone on file', () => {
  show({ ...BASE, open: false, can_text_client: false }, { onOnMyWay: vi.fn() })
  expect(onMyWay()).toBeNull()
})

it('is hidden on an open offer', () => {
  show({ ...BASE, open: true, address: null, can_text_client: false }, { onOnMyWay: vi.fn() })
  expect(onMyWay()).toBeNull()
})

it('is hidden on a completed job', () => {
  show({ ...BASE, open: false, status: 'completed' }, { onOnMyWay: vi.fn() })
  expect(onMyWay()).toBeNull()
})

it('is absent without the handler (e.g. a future job in the schedule list)', () => {
  show({ ...BASE, open: false })
  expect(onMyWay()).toBeNull()
})

it('shows a done state (not a button) once the customer has been notified', () => {
  const onOnMyWay = vi.fn()
  show({ ...BASE, open: false }, { onOnMyWay, clientNotified: true })
  // No tappable "On my way" button — a quiet confirmation instead.
  expect(onMyWay()).toBeNull()
  expect(screen.getByText(/customer knows you're on the way/i)).toBeTruthy()
})
