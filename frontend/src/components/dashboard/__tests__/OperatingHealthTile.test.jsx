/**
 * The two numbers a managed home-services business lives or dies on.
 *
 * Most of what's pinned here is HONESTY rather than arithmetic. A number on a
 * dashboard is read as fact, so the failure that matters isn't a wrong
 * calculation — it's a confident-looking figure computed off partial data, or
 * a null rendered as zero.
 */
import { it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { OperatingHealthTile } from '../OperatingHealthTile'

afterEach(cleanup)

const PAYLOAD = {
  as_of: '2026-09-07',
  labour: {
    months: [
      { month: '2026-07', revenue: 8000, labour: 3400, labour_pct: 42.5 },
      { month: '2026-08', revenue: 9000, labour: 4300, labour_pct: 47.8 },
    ],
    benchmark: { good_max: 45, warn_max: 55 },
    jobs_completed: 40, jobs_invoiced: 40, coverage_pct: 100,
  },
  repeat: {
    window_days: 60, considered: 30, returned: 24, rate_pct: 80.0,
    one_off_considered: 8, one_off_returned: 3, one_off_rate_pct: 37.5,
  },
}

const show = (data) => render(<OperatingHealthTile loading={false} error={false} data={data} />)

it('leads with the latest month that has revenue to divide by', () => {
  const { container } = show(PAYLOAD)
  // 47.8% legitimately appears twice — as the headline and again in the
  // month-by-month strip — so target the headline by its own size rather than
  // by the string, which would pass for the wrong reason.
  const headline = container.querySelector('.text-2xl')
  expect(headline.textContent).toBe('47.8%')
  expect(screen.getByText(/of revenue went to the people doing the work/)).toBeTruthy()
  // Both months are listed underneath, oldest first.
  expect(screen.getByText('07')).toBeTruthy()
  expect(screen.getByText('42.5%')).toBeTruthy()
})

it('gives the benchmark in words, not just a colour', () => {
  show(PAYLOAD)
  // A percentage with nothing to compare it against is trivia, and a colour
  // alone fails anyone who can't distinguish it.
  expect(screen.getByText(/Well run is the low 40s/)).toBeTruthy()
})

it('says how many customers came back, and splits out the one-offs', () => {
  show(PAYLOAD)
  expect(screen.getByText('80%')).toBeTruthy()
  expect(screen.getByText(/24 of 30 cleanings led to another one/)).toBeTruthy()
  // A high rate that is all recurring says the schedule generator works.
  expect(screen.getByText(/not on a standing schedule: 37.5%/)).toBeTruthy()
})

it('warns when the labour number is computed off half the jobs', () => {
  show({ ...PAYLOAD, labour: { ...PAYLOAD.labour, jobs_invoiced: 20, coverage_pct: 50 } })
  expect(screen.getByText(/Only 50% of finished jobs have an invoice/)).toBeTruthy()
  expect(screen.getByText(/higher than the truth/)).toBeTruthy()
})

it('stays quiet about coverage when every job is invoiced', () => {
  show(PAYLOAD)
  expect(screen.queryByText(/have an invoice/)).toBeNull()
})

it('renders an unknown rate as a dash, never as zero percent', () => {
  // A new book is not a book with 0% retention, and a month with no invoices
  // is not a month with no labour cost. This is the failure that would quietly
  // tell Meg her business is broken.
  show({
    as_of: '2026-09-07',
    labour: { months: [{ month: '2026-08', revenue: 0, labour: 0, labour_pct: null }],
              benchmark: { good_max: 45, warn_max: 55 },
              jobs_completed: 0, jobs_invoiced: 0, coverage_pct: null },
    repeat: { window_days: 60, considered: 0, returned: 0, rate_pct: null,
              one_off_considered: 0, one_off_returned: 0, one_off_rate_pct: null },
  })
  expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
  expect(screen.queryByText('0%')).toBeNull()
  expect(screen.getByText(/Not enough finished work yet to say/)).toBeTruthy()
})

it('survives a payload with nothing in it', () => {
  const { container } = show(null)
  expect(container.textContent).toContain('Is this working')
})

it('says it in dots and words, never a tinted banner', () => {
  // The owner vetoed SaaS banners twice. (?!\d) keeps the required dot's own
  // bg-amber-500 from matching the vetoed bg-amber-50 fill.
  const { container } = show({ ...PAYLOAD, labour: { ...PAYLOAD.labour, coverage_pct: 50 } })
  expect(container.innerHTML).not.toMatch(/\bbg-\w+-(50|100|200)(?!\d)/)
  expect(container.querySelectorAll('.w-1\\.5.h-1\\.5.rounded-full').length).toBeGreaterThan(0)
})
