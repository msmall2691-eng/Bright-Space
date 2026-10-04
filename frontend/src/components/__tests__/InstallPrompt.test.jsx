/**
 * The "Add to Home Screen" nudge: it must stay quiet until it's genuinely
 * useful (installable, signed in, not already installed, not just dismissed)
 * and it must never nag again once the person says no.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import InstallPrompt from '../InstallPrompt'

const DISMISS_KEY = 'bb_a2hs_dismissed_at'

function renderAt(path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <InstallPrompt />
    </MemoryRouter>
  )
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('brightbase_jwt', 'test-jwt')   // signed in
  window.__bbInstallEvent = null
  delete window.navigator.standalone
})

afterEach(() => {
  cleanup()
  window.__bbInstallEvent = null
})

describe('InstallPrompt', () => {
  it('stays hidden when the browser never offered to install', () => {
    renderAt()
    expect(screen.queryByText(/add brightbase to your home screen/i)).toBeNull()
  })

  it('stays hidden when the app is already installed (standalone)', () => {
    window.navigator.standalone = true
    window.__bbInstallEvent = { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'accepted' }) }
    renderAt()
    expect(screen.queryByText(/add brightbase to your home screen/i)).toBeNull()
  })

  it('stays hidden before sign-in', () => {
    localStorage.removeItem('brightbase_jwt')
    window.__bbInstallEvent = { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'accepted' }) }
    renderAt()
    expect(screen.queryByText(/add brightbase to your home screen/i)).toBeNull()
  })

  it('shows the card and runs the native prompt when installable', async () => {
    const prompt = vi.fn()
    window.__bbInstallEvent = { prompt, userChoice: Promise.resolve({ outcome: 'accepted' }) }
    renderAt()
    expect(screen.getByText(/add brightbase to your home screen/i)).toBeTruthy()
    const btn = screen.getByRole('button', { name: /install/i })
    await act(async () => { fireEvent.click(btn) })
    expect(prompt).toHaveBeenCalledTimes(1)
    // Accepting is recorded so it won't nag again.
    expect(localStorage.getItem(DISMISS_KEY)).toBeTruthy()
  })

  it('dismiss hides it and records the dismissal so it does not nag again', () => {
    window.__bbInstallEvent = { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'dismissed' }) }
    renderAt()
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByText(/add brightbase to your home screen/i)).toBeNull()
    expect(localStorage.getItem(DISMISS_KEY)).toBeTruthy()
  })

  it('does not reappear within the suppression window after a dismissal', () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    window.__bbInstallEvent = { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'accepted' }) }
    renderAt()
    expect(screen.queryByText(/add brightbase to your home screen/i)).toBeNull()
  })

  it('never nags on a public/applicant route', () => {
    window.__bbInstallEvent = { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'accepted' }) }
    renderAt('/apply')
    expect(screen.queryByText(/add brightbase to your home screen/i)).toBeNull()
  })
})
