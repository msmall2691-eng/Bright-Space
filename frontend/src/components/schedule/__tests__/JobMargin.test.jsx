/**
 * The margin line beside the price box.
 *
 * What's pinned here is the distinction the old code lost: a fetch that FAILS
 * is not the same as one still in flight. Both left `data` null and the
 * component rendered nothing, so a margin that errored just silently vanished —
 * the office typed a price and the helpful number wasn't there, with no way to
 * tell it had failed rather than come back empty.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn() }))
import { get } from '../../../api'
import JobMargin from '../JobMargin'

beforeEach(() => { get.mockReset() })
afterEach(cleanup)

it('renders nothing while the fetch is still in flight', () => {
  get.mockReturnValue(new Promise(() => {}))   // never resolves
  const { container } = render(<JobMargin jobId={5} pay={80} />)
  expect(container.firstChild).toBeNull()
})

it('says the margin could not be worked out when the fetch fails', async () => {
  get.mockRejectedValue(new Error('offline'))
  render(<JobMargin jobId={5} pay={80} />)
  expect(await screen.findByText(/Couldn’t work out the margin just now/)).toBeTruthy()
})

it('shows the number when it comes back', async () => {
  get.mockResolvedValue({ billed: 12000, pay: 8000, margin: 4000, margin_pct: 33,
    billed_source: 'invoice' })
  render(<JobMargin jobId={5} pay={80} />)
  expect(await screen.findByText(/left/)).toBeTruthy()
  expect(screen.queryByText(/Couldn’t work out the margin/)).toBeNull()
})

it('clears the error once a later fetch succeeds', async () => {
  get.mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ billed: 10000, pay: 7000, margin: 3000, margin_pct: 30,
      billed_source: 'quote' })
  const { rerender } = render(<JobMargin jobId={5} pay={80} />)
  await screen.findByText(/Couldn’t work out the margin just now/)
  rerender(<JobMargin jobId={5} pay={90} />)      // new pay → refetch
  await waitFor(() => expect(screen.queryByText(/Couldn’t work out the margin/)).toBeNull())
})
