/**
 * "Customer confirmed" on the crew card.
 *
 * A cleaner heading to a house wants to know the visit is still on without
 * calling the office. The office already captures that (the customer taps the
 * confirm link in their reminder text, or — on manual-invite jobs — says "Yes"
 * to the Google Calendar invite); this just surfaces it on the card, as a quiet
 * emerald dot+word, never a badge or banner (BrightBase design language).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import JobCard from '../JobCard'

afterEach(cleanup)

const BASE = {
  id: 1, title: 'Deep clean', property_name: 'Harbour St', status: 'scheduled',
  scheduled_date: '2026-09-10', job_type: 'residential', open: false,
  client_name: 'Dana Wells', my_helpers: [], house_notes: [],
}

const show = (job) => render(<MemoryRouter><JobCard job={job} /></MemoryRouter>)

it('shows "Customer confirmed" when the visit is confirmed', () => {
  show({ ...BASE, customer_confirmed: true })
  expect(screen.getByText(/Customer confirmed/)).toBeTruthy()
})

it('says nothing when the customer has not confirmed', () => {
  show({ ...BASE, customer_confirmed: false })
  expect(screen.queryByText(/Customer confirmed/)).toBeNull()
})

it('treats a missing flag as not-confirmed (older payloads)', () => {
  show({ ...BASE })
  expect(screen.queryByText(/Customer confirmed/)).toBeNull()
})
