/**
 * The office looking at a cleaner's app.
 *
 * The point is that it is the REAL screen, so what is pinned is that it
 * fetches the preview endpoint and renders MyDay itself — and that, while
 * doing so, the office cannot act as the person they are watching.
 *
 * The backend is the actual guarantee: every mutating /api/crew route is
 * Depends(require_role("cleaner")) and require_role has no admin bypass, so an
 * office session is refused whatever this renders (pinned in
 * backend/tests/test_crew_preview.py). This layer is so the screen says why
 * instead of showing a 403 — and so a write added to MyDay later is blocked by
 * default rather than needing somebody to remember a guard.
 *
 * Why it matters beyond tidiness: an office user tapping Accept for a
 * subcontractor would be ASSIGNING them work, and a sub requests or accepts
 * and is never assigned (brightbase-marketplace, Rule 0).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(),
  logout: vi.fn(), download: vi.fn(),
}))
vi.mock('../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  pushToast: vi.fn(),
}))

import { get, post, del, patch } from '../../api'
import CrewAppPreview from '../CrewAppPreview'

// The real key set, taken from a live call to the endpoint rather than
// guessed — a fixture missing a key MyDay reads makes this suite fail for a
// reason that has nothing to do with what it is testing.
const PAYLOAD = {
  as_of: '2026-09-07', crew_id: 'CT-DANA', first_name: 'Dana',
  today: [], upcoming: [], open_jobs: [], routes: [], unread_messages: 0,
  preview: { read_only: true, cleaner_name: 'Dana Reed', user_id: 42 },
}

beforeEach(() => {
  get.mockReset(); post.mockReset(); del.mockReset(); patch.mockReset()
  get.mockResolvedValue(PAYLOAD)
  localStorage.clear()
})
afterEach(() => { cleanup(); localStorage.clear() })

const show = (path = '/crew/42/app') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/crew/:userId/app" element={<CrewAppPreview />} /></Routes>
    </MemoryRouter>)

it('asks the preview endpoint for that cleaner, not for itself', async () => {
  show()
  await waitFor(() => expect(get).toHaveBeenCalled())
  // The id from the URL, and the preview route — not /api/crew/my-day, which
  // would silently show the office user their own (empty) day.
  expect(get.mock.calls.some(([u]) => u === '/api/crew/preview/42/my-day?days=14'))
    .toBe(true)
  expect(get.mock.calls.some(([u]) => u === '/api/crew/my-day?days=14')).toBe(false)
})

it('says whose day it is', async () => {
  show()
  expect(await screen.findByText(/Dana Reed/)).toBeTruthy()
  expect(document.body.textContent).toMatch(/Preview/)
})

it('does not fetch the viewer’s own week pay', async () => {
  show()
  await waitFor(() => expect(get).toHaveBeenCalled())

  // The Me tab has to be OPENED for this to mean anything: week pay only
  // loads when that tab is shown, so asserting it on the default tab passes
  // whether or not the guard exists. (It did, until this line was added.)
  fireEvent.click(await screen.findByRole('button', { name: /Me/ }))

  // /api/crew/my-week resolves from the CALLER, so in preview it would be the
  // office user's own week rendered under the cleaner's name — an empty pay
  // card that reads as "they earned nothing".
  // "Me" appears on the tab and in the header once open — assert the tab
  // actually switched via the header, then that no week-pay call was made.
  await waitFor(() => expect(screen.getAllByText('Me').length).toBeGreaterThan(1))
  expect(get.mock.calls.some(([u]) => String(u).includes('my-week'))).toBe(false)
})

it('does not put another person’s day in the viewer’s offline cache', async () => {
  show()
  await waitFor(() => expect(get).toHaveBeenCalled())
  // That cache is "my day, for when I have no signal". Somebody else's jobs
  // and addresses do not belong in it, on an office laptop least of all.
  expect(localStorage.getItem('bb_myday_cache')).toBeNull()
})

it('refuses a nonsense id instead of asking the API about it', () => {
  show('/crew/not-a-number/app')
  expect(screen.getByText(/isn’t a cleaner I can show you/)).toBeTruthy()
  expect(get).not.toHaveBeenCalled()
})
