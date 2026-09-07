/**
 * A cleaner must never get a white screen.
 *
 * The only ErrorBoundary in App.jsx sat inside the office shell's <main>, so
 * the two branches that return before it — the crew app and the not-yet-
 * approved waiting room — had no boundary at all. Any render error there gave
 * a cleaner a blank page: no message, no reload button, and nothing to report
 * beyond "it just goes blank".
 *
 * It also cost them the stale-chunk recovery, which lives in
 * componentDidCatch. A deploy renames every content-hashed asset; a phone
 * holding the old index.html — a home-screen PWA is exactly that — fails the
 * import and throws. Inside a boundary that is one reload. Outside, it is a
 * dead screen, on the half of the app most likely to be a stale icon nobody
 * has hard-reloaded in weeks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../pages/MyDay', () => ({
  default: () => { throw new Error('My Day blew up') },
}))
vi.mock('../pages/PendingApproval', () => ({
  default: () => { throw new Error('Waiting room blew up') },
}))
// Keep the office shell's imports inert — this file is only about the two
// branches that return before it.
vi.mock('../api', () => ({
  get: vi.fn(() => Promise.resolve({})),
  post: vi.fn(() => Promise.resolve({})),
  patch: vi.fn(() => Promise.resolve({})),
  del: vi.fn(() => Promise.resolve({})),
  setToken: vi.fn(), getToken: vi.fn(), clearToken: vi.fn(),
}))

import App from '../App'

const signIn = (user) => {
  localStorage.setItem('brightbase_jwt', 'test-token')
  localStorage.setItem('brightbase_user', JSON.stringify(user))
}

let consoleError
beforeEach(() => {
  localStorage.clear()
  // React logs the caught error; that is expected here and would otherwise
  // bury the real assertion output.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { consoleError.mockRestore(); cleanup(); localStorage.clear() })

const show = async () => {
  render(<MemoryRouter initialEntries={['/dashboard']}><App /></MemoryRouter>)
  return screen.findByText('Something went wrong')
}

it('shows a cleaner what broke instead of a blank page', async () => {
  signIn({ user_id: 7, email: 'cleaner@example.com', role: 'cleaner', status: 'active' })

  expect(await show()).toBeTruthy()
  // The message and a way out. Without the boundary this branch rendered
  // nothing at all — the reported symptom exactly.
  expect(screen.getByText('My Day blew up')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Reload page/i })).toBeTruthy()
})

it('does the same in the waiting room, which had no boundary either', async () => {
  signIn({ user_id: 8, email: 'new@example.com', role: 'cleaner', status: 'pending' })

  expect(await show()).toBeTruthy()
  expect(screen.getByText('Waiting room blew up')).toBeTruthy()
})
