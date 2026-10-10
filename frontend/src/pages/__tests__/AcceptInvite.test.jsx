/**
 * The set-your-password landing an invited person reaches from their email.
 *
 * Two things this pins, both from the 8 Sep walk:
 *   - the copy doesn't call the reader an employee ("the crew", "clock in").
 *     They're a subcontractor, and the page can't know their role before they
 *     sign in anyway, so the words stay role-neutral.
 *   - a bad token surfaces as the one sanctioned error treatment (ErrorNote:
 *     hairline card + red dot), never the vetoed bg-red-50 banner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({ post: vi.fn(), setJWT: vi.fn() }))
import AcceptInvite from '../AcceptInvite'

const mountAt = (search) =>
  render(<MemoryRouter initialEntries={[`/accept-invite${search}`]}><AcceptInvite /></MemoryRouter>)

afterEach(cleanup)

describe('AcceptInvite', () => {
  it('welcomes without employee vocabulary', () => {
    mountAt('?token=abc')
    expect(screen.getByText(/Welcome to The Maine Cleaning Co\./)).toBeTruthy()
    // No "the crew" and no "clock in" — a subcontractor is neither.
    expect(document.body.textContent).not.toMatch(/clock in/i)
    expect(document.body.textContent).not.toMatch(/the crew/i)
  })

  it('shows a missing-code error as a quiet card, not a tinted banner', () => {
    const { container } = mountAt('')          // no token → up-front error
    expect(screen.getByText(/missing its code/i)).toBeTruthy()
    // The vetoed pattern is a resting red fill; the sanctioned one is a dot.
    expect(container.innerHTML).not.toMatch(/\bbg-red-(50|100|200)\b/)
    // Assert the SHAPE, not a specific hue. This pinned `.bg-red-500`, which
    // was standing in for "a dot is present" — but it also froze the dot's
    // colour step, so BB-A11Y-02 moving red-500 (2.55:1, under the 3:1
    // non-text floor) to a step that clears broke a test about banners vs
    // dots. The rule this guards is the shape; the colour is measured by
    // __tests__/boardToneContrast.test.js, which is the right place for it.
    const dot = container.querySelector('.rounded-full.w-1\\.5')
    expect(dot, "ErrorNote's dot is missing — status must not be text-only").toBeTruthy()
  })
})
