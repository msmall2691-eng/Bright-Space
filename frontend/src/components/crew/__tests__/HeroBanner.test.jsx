/**
 * The My Day header carries the day's training tip, grouped into the same box
 * as the greeting and weather: one quiet line at rest (today's headline) that
 * taps open to the full tip and flips through the rest of the deck. The owner
 * wanted it "up there, out of the way, concise" — not a sticky note.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn() }))
import { get } from '../../../api'
import HeroBanner from '../HeroBanner'

const DECK = [
  { title: 'Start the longest job first', body: 'Start what takes longest, then clean around it while it works.' },
  { title: 'Two cloths in every bathroom', body: 'One for the toilet, a different one for sinks and counters.' },
]

beforeEach(() => { get.mockReset(); get.mockResolvedValue({ available: false }) })
afterEach(cleanup)

it('shows the greeting and today\'s tip headline, collapsed', async () => {
  render(<HeroBanner firstName="Dana" jobCount={2} tips={DECK} />)
  expect(screen.getByText(/Good (morning|afternoon|evening), Dana/)).toBeTruthy()
  // The tip is a dainty one-liner: a short "Tip" eyebrow + today's headline.
  expect(screen.getByText('Tip')).toBeTruthy()
  expect(screen.getByText('Start the longest job first')).toBeTruthy()
  // Collapsed: the detail body isn't shown until you open it.
  expect(screen.queryByText(/clean around it while it works/)).toBeNull()
})

it('opens to the full tip and flips through the deck', async () => {
  render(<HeroBanner firstName="Dana" jobCount={1} tips={DECK} />)
  fireEvent.click(screen.getByText('Start the longest job first'))
  // Body now shows.
  expect(await screen.findByText(/clean around it while it works/)).toBeTruthy()
  // Flip to the next one — labelled "Pro tip", not today's.
  fireEvent.click(screen.getByRole('button', { name: /next tip/i }))
  expect(await screen.findByText('Two cloths in every bathroom')).toBeTruthy()
  expect(screen.getByText('Pro tip')).toBeTruthy()
})

it('shows a daily motivational quote', async () => {
  render(<HeroBanner firstName="Dana" jobCount={2} tips={DECK} />)
  // The quote rotates daily; assert the element is present via its italic text.
  const quote = document.querySelector('.italic')
  expect(quote).toBeTruthy()
  expect(quote.textContent.trim().length).toBeGreaterThan(0)
})

it('renders fine with no tips (just greeting + day line)', async () => {
  render(<HeroBanner firstName="Dana" jobCount={0} />)
  expect(screen.getByText(/Nothing on the books today/)).toBeTruthy()
  expect(screen.queryByText(/^Pro tip$/)).toBeNull()
})
