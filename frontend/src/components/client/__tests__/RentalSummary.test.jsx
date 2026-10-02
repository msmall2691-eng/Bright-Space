import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import RentalSummary from '../RentalSummary'

afterEach(cleanup)

const strProperty = (overrides = {}) => ({
  id: 1,
  property_type: 'str',
  check_in_time: '15:00',
  check_out_time: '11:00',
  default_duration_hours: 3,
  default_price: 175,
  custom_fields: { guests: 6, turnover_day: 'Saturday', listing_url: 'https://airbnb.com/h/x' },
  icals: [{ id: 10, source: 'airbnb', last_synced_at: '2026-09-18T14:00:00Z' }],
  ...overrides,
})

describe('RentalSummary', () => {
  it('renders nothing for a non-STR property', () => {
    render(<RentalSummary property={{ id: 2, property_type: 'residential' }} />)
    expect(screen.queryByTestId('rental-summary')).toBeNull()
  })

  it('renders nothing for an STR property with no rental data', () => {
    render(<RentalSummary property={{ id: 3, property_type: 'str' }} />)
    expect(screen.queryByTestId('rental-summary')).toBeNull()
  })

  it('surfaces the rental facts read-only, without needing Edit', () => {
    render(<RentalSummary property={strProperty()} />)
    expect(screen.getByTestId('rental-summary')).toBeTruthy()
    // Times are humanized from 24h.
    expect(screen.getByText('11:00 AM')).toBeTruthy()   // check-out
    expect(screen.getByText('3:00 PM')).toBeTruthy()    // check-in
    expect(screen.getByText('3h')).toBeTruthy()         // turnover
    expect(screen.getByText('$175.00')).toBeTruthy()    // price
    expect(screen.getByText('6')).toBeTruthy()          // sleeps
    expect(screen.getByText('Saturday')).toBeTruthy()   // turnover day
    // Listing link opens the real listing in a new tab.
    const link = screen.getByRole('link', { name: /view listing/i })
    expect(link.getAttribute('href')).toBe('https://airbnb.com/h/x')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('shows iCal sync health per feed', () => {
    render(<RentalSummary property={strProperty({
      icals: [
        { id: 1, source: 'airbnb', last_synced_at: '2026-09-18T14:00:00Z' },
        { id: 2, source: 'vrbo', last_sync_status: 'failed', last_sync_error: 'timeout' },
        { id: 3, source: 'manual' },
      ],
    })} />)
    expect(screen.getByText(/sync failed/i)).toBeTruthy()
    expect(screen.getByText(/never synced/i)).toBeTruthy()
    expect(screen.getByText(/^synced /i)).toBeTruthy()
    expect(screen.getAllByTestId('rental-feed-row').length).toBe(3)
  })

  it('leaves an unparseable check-in time as-is (a raw phrase the request carried)', () => {
    render(<RentalSummary property={strProperty({
      check_in_time: 'flexible', check_out_time: null,
      custom_fields: {}, icals: [],
    })} />)
    expect(screen.getByText('flexible')).toBeTruthy()
  })

  it('renders a linen plan when one is stored (forward-compatible)', () => {
    render(<RentalSummary property={strProperty({
      custom_fields: { linen: 'Two-set swap, laundered on-site' },
      icals: [],
    })} />)
    expect(screen.getByText('Two-set swap, laundered on-site')).toBeTruthy()
  })
})
