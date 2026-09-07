/**
 * My Day renders at all.
 *
 * This exists because it did not. PR #777 ("Delete the employee model")
 * removed the time-clock block that `const longDate = …` was declared beside
 * and left the `{longDate}` in the header. A bare undefined identifier is not
 * a build error — a bundler has to assume it might be a browser global — so it
 * shipped green, and every cleaner opening the app got
 * `ReferenceError: longDate is not defined` at render. The crew branch had no
 * ErrorBoundary either, so what they saw was a white page with nothing on it
 * to report. The bug reached the owner as "it just goes blank".
 *
 * Nothing in the suite rendered this screen, which is how a 1,400-line page
 * that every subcontractor depends on stayed broken across a deploy. This test
 * does the least useful-sounding and most valuable thing available: it mounts
 * the component and asserts it produced something.
 *
 * If you are here because this failed: something in MyDay throws on first
 * render. Read the error, not this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(),
  logout: vi.fn(), download: vi.fn(),
}))
vi.mock('../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  pushToast: vi.fn(),
}))

import { get } from '../../api'
import MyDay from '../MyDay'

const DAY = {
  as_of: '2026-09-07', crew_id: 'CT-DANA', first_name: 'Dana',
  today: [], upcoming: [], open_jobs: [], routes: [], unread_messages: 0,
}

let consoleError
beforeEach(() => {
  get.mockReset()
  localStorage.clear()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { consoleError.mockRestore(); cleanup(); localStorage.clear() })

const show = async () => {
  render(<MemoryRouter><MyDay /></MemoryRouter>)
  await waitFor(() => expect(get).toHaveBeenCalled())
}

it('renders without throwing, with a normal day', async () => {
  get.mockResolvedValue(DAY)
  await show()
  expect(await screen.findByText('My Day')).toBeTruthy()
  // The header line whose missing definition was the whole bug.
  expect(await screen.findByText(/September 7/)).toBeTruthy()
})

it('captions the day from the payload, not the device clock', async () => {
  // `as_of` is resolved in Maine time on the server. A phone in another
  // timezone must not caption today's jobs with yesterday.
  get.mockResolvedValue({ ...DAY, as_of: '2026-12-25' })
  await show()
  expect(await screen.findByText(/December 25/)).toBeTruthy()
})

it('renders when the payload has no date at all', async () => {
  get.mockResolvedValue({ ...DAY, as_of: null })
  await show()
  expect(await screen.findByText('My Day')).toBeTruthy()
})

it('renders the error state instead of a blank page when the day fails', async () => {
  get.mockRejectedValue({ detail: 'Server is down' })
  render(<MemoryRouter><MyDay /></MemoryRouter>)
  await waitFor(() => expect(get).toHaveBeenCalled())
  // Something is on screen. The failure this file exists for produced nothing.
  await waitFor(() => expect(document.body.textContent.trim().length)
    .toBeGreaterThan(0))
})
