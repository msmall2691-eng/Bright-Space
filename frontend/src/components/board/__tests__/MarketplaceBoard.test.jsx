/**
 * The marketplace strip on the office home. It leads the board with the two
 * things the bench-claims-and-she-approves model puts on the owner: cleaners
 * waiting on her yes, and jobs open to nobody. It reads /api/marketplace and
 * LINKS to the hub to act — it never approves here. Quiet when nothing waits.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../../api', () => ({ get: vi.fn() }))

import { get } from '../../../api'
import MarketplaceBoard from '../MarketplaceBoard'

const mount = (payload) => {
  get.mockResolvedValue(payload)
  render(<MemoryRouter><MarketplaceBoard /></MemoryRouter>)
}

beforeEach(() => { get.mockReset() })
afterEach(cleanup)

it('leads with the cleaners waiting on the office to say yes', async () => {
  mount({ waiting: { people_waiting: 3, job_count: 2 }, open_job_count: 2 })
  expect(await screen.findByText(/3 cleaners waiting on your yes/)).toBeTruthy()
  // Links to the hub — it never approves on the home.
  expect(screen.getByText('Review').closest('a').getAttribute('href')).toBe('/marketplace')
})

it('flags jobs open to the bench that nobody has claimed', async () => {
  // 5 open, 2 have someone waiting → 3 are open to nobody yet.
  mount({ waiting: { people_waiting: 2, job_count: 2 }, open_job_count: 5 })
  expect(await screen.findByText(/3 jobs open to the bench with nobody yet/)).toBeTruthy()
})

it('reads a single waiting cleaner in the singular', async () => {
  mount({ waiting: { people_waiting: 1, job_count: 1 }, open_job_count: 1 })
  expect(await screen.findByText(/1 cleaner waiting on your yes/)).toBeTruthy()
})

it('surfaces cleaners applying to join and links to Crew to review them', async () => {
  mount({ waiting: { people_waiting: 0, job_count: 0, application_count: 2 }, open_job_count: 0 })
  expect(await screen.findByText(/2 cleaners applied to join/)).toBeTruthy()
  expect(screen.getByText('Review').closest('a').getAttribute('href')).toBe('/crew')
})

it('shows money owed to cleaners and links to Payouts', async () => {
  mount({ waiting: { people_waiting: 0, job_count: 0 }, open_job_count: 0, money: { owed: 1240 } })
  expect(await screen.findByText(/\$1,240 owed to your cleaners/)).toBeTruthy()
  expect(screen.getByText('Payouts').closest('a').getAttribute('href')).toBe('/payroll')
})

it('renders nothing when nothing is waiting and nothing is uncovered', async () => {
  const { container } = (() => {
    get.mockResolvedValue({ waiting: { people_waiting: 0, job_count: 0 }, open_job_count: 0 })
    return render(<MemoryRouter><MarketplaceBoard /></MemoryRouter>)
  })()
  // Give the effect a tick; the section must not appear.
  await waitFor(() => expect(get).toHaveBeenCalled())
  expect(container.querySelector('section')).toBeNull()
})

it('renders nothing when the fetch fails (e.g. a viewer 403)', async () => {
  get.mockRejectedValue({ status: 403 })
  const { container } = render(<MemoryRouter><MarketplaceBoard /></MemoryRouter>)
  await waitFor(() => expect(get).toHaveBeenCalled())
  expect(container.querySelector('section')).toBeNull()
})
