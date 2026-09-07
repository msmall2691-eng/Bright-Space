/**
 * The public recruiting page.
 *
 * This is the one screen a cleaner sees before deciding whether to bother, and
 * it is also the only page in the app that describes the ARRANGEMENT in
 * sentences. Both facts are why it has tests.
 *
 * WHAT IS PINNED, and it is mostly honesty:
 *
 *   * it still says the things that ARE the arrangement — you choose, nothing
 *     is assigned, no rota, you may work for anyone else. Those are not
 *     marketing lines to soften on a later pass; a recruiting page promising
 *     steady assigned hours would describe employment, and the whole bench
 *     rests on it not doing that (brightbase-marketplace, Rule 0);
 *   * it names the two documents that actually gate work — a W-9 and a
 *     certificate of insurance — because "you'll hear about the rest later"
 *     is how somebody gets three weeks in and discovers they can't be paid;
 *   * it never asks for, or mentions wanting, a Social Security number;
 *   * it gives somebody who ALREADY has an account a way out, without being
 *     able to tell anyone whether an email is known. That is a plain link, not
 *     a lookup — a form that answers "is this one of yours?" is an
 *     account-enumeration oracle;
 *   * it invents no pay figures. The rate is per job and set by the office,
 *     so a range printed here would be the one dishonest thing on the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import Apply from '../Apply'

beforeEach(() => { global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 201 })) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

// ── The arrangement, in words ───────────────────────────────────────────────

it('still says the things that are the arrangement, not the pitch', () => {
  render(<Apply />)
  const page = document.body.textContent

  expect(page).toMatch(/nothing is assigned to you/i)
  expect(page).toMatch(/You choose what you take/i)
  expect(page).toMatch(/no rota/i)
  expect(page).toMatch(/free to clean for anyone else/i)
  // Per job, never per hour. The distinction is legal, not stylistic.
  expect(page).toMatch(/price per job/i)
  expect(page).toMatch(/Never an hourly rate/i)
})

it('does not promise assigned or guaranteed work', () => {
  render(<Apply />)
  const page = document.body.textContent
  for (const employmentish of [
    /guaranteed hours/i, /set schedule/i, /we.ll assign/i, /hourly wage/i,
  ]) {
    expect(page).not.toMatch(employmentish)
  }
})

// ── What it tells somebody before they commit ───────────────────────────────

it('names the two documents that actually gate work', () => {
  render(<Apply />)

  // Scoped to the "What you'll need" section, not the whole page. Both
  // phrases also occur incidentally — the EIN field's hint mentions a W-9 —
  // so a page-wide match passed even with the requirements section gutted.
  // These are services/sub_vetting.REQUIRED_KINDS: without them a person
  // cannot be paid, and finding that out three weeks in is the failure.
  const heading = screen.getByText('What you’ll need')
  const section = heading.closest('section').textContent

  expect(section).toMatch(/W-9/)
  expect(section).toMatch(/certificate from your insurer/i)
  // And the walkthrough says it early, not as a surprise at the end.
  expect(screen.getByText('How it works').closest('section').textContent)
    .toMatch(/W-9 and a certificate of insurance/i)
})

it('walks through what happens after applying', () => {
  render(<Apply />)
  expect(screen.getByText('How it works')).toBeTruthy()
  const page = document.body.textContent
  expect(page).toMatch(/We get in touch/i)
  expect(page).toMatch(/Jobs come to your phone/i)
  // The counter-offer is real (JobClaimRequest.requested_rate) and it is the
  // most persuasive true thing on the page.
  expect(page).toMatch(/You can counter/i)
})

it('invents no pay figures', () => {
  render(<Apply />)
  // Any dollar amount here would be made up: the rate is per job, set by the
  // office, and differs by house.
  expect(document.body.textContent).not.toMatch(/\$\s?\d/)
})

// ── The two doors ───────────────────────────────────────────────────────────

it('sends somebody who already has an account to sign in', () => {
  render(<Apply />)
  const link = screen.getByRole('link', { name: /sign in/i })
  expect(link.getAttribute('href')).toBe('/login')
  expect(document.body.textContent).toMatch(/don’t need to apply again/i)
})

it('cannot tell anyone whether an email is already known', () => {
  render(<Apply />)
  // No lookup on mount, and no email-checking field: the only thing this page
  // may do is submit.
  expect(global.fetch).not.toHaveBeenCalled()
})

it('never asks for a Social Security number, and says so', () => {
  render(<Apply />)

  // No field could take one. This is the assertion that matters: the page
  // mentions an SSN twice, and both times to REFUSE it — "we never ask for a
  // Social Security number", "never put a social security number here". An
  // earlier version of this test banned the phrase outright, which would have
  // deleted the reassurance rather than the risk.
  // The field's own TITLE span, not the whole <label>. Field renders
  // <label><span>title</span>{input}<span>hint</span></label>, and the EIN
  // hint legitimately contains "never put a social security number here" — an
  // earlier version of this check excluded any label mentioning "never" and
  // therefore let a field literally titled "Social Security number" pass.
  const titles = [...document.querySelectorAll('label > span:first-child')]
    .map(el => el.textContent)
  expect(titles.length).toBeGreaterThan(3)
  expect(titles.some(t => /social security|\bSSN\b/i.test(t))).toBe(false)

  const page = document.body.textContent
  expect(page).toMatch(/never ask for a Social Security number/i)
  expect(page).toMatch(/never put a social security number here/i)
})

// ── It is still a working form ──────────────────────────────────────────────

it('still submits, and only needs a name and an email', async () => {
  render(<Apply />)
  const send = screen.getByRole('button', { name: /Send application/i })
  expect(send.disabled).toBe(true)

  fireEvent.change(screen.getByLabelText(/Your name/i), { target: { value: 'Dana Reed' } })
  fireEvent.change(screen.getByLabelText(/^Email/i), { target: { value: 'dana@example.com' } })
  expect(send.disabled).toBe(false)

  fireEvent.click(send)
  await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/apply', expect.anything()))
  expect(await screen.findByText(/Thanks — we’ve got it/)).toBeTruthy()
})
