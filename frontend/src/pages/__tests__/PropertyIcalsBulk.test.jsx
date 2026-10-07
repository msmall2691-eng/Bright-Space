/**
 * The bulk iCal feed screen, which had no test at all despite being fully
 * instrumented with testids nothing referenced.
 *
 * Two things worth pinning, and they are different kinds of thing.
 *
 * ## 1. BB-SEC-13 — which endpoint it reads
 *
 * This page used to load `GET /api/properties/{id}`, whose own BB-SEC-11
 * comment describes it as "the full property dict — house_code, access_notes,
 * wifi_password included". The page renders seven fields and none of them, so
 * every visit to a feed screen put a property's door code and wifi password on
 * the wire for nothing. Both routes are office-only, so this was never a
 * BB-SEC-08..12 violation; the point is that the fewer screens a door code
 * reaches, the fewer places it can be logged or left open on a laptop.
 *
 * The narrow route is guarded on the server by
 * `backend/tests/test_property_icals_payload.py`, which fails if a sensitive
 * field appears in the payload. This is the other half: the page has to
 * actually ASK for the narrow one, because a server-side allow-list does
 * nothing if the client goes back to the fat route.
 *
 * ## 2. The paste parser, which is the page's own logic
 *
 * Paste a block of URLs, get a row each, and the ones already on the property
 * come back marked duplicate so "Add all" skips them — case-insensitively,
 * because the same Airbnb feed pasted from a different place differs only in
 * case. Without that, adding twice gives the property two identical feeds and
 * the sync then creates every turnover twice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(), post: vi.fn(), del: vi.fn(), patch: vi.fn(),
}))
vi.mock('../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  pushToast: vi.fn(),
}))

import { get, post } from '../../api'
import PropertyIcalsBulk from '../PropertyIcalsBulk'

/** What the narrow endpoint returns — deliberately WITHOUT any access detail,
 *  mirroring the server-side allow-list. */
const FEED_PAYLOAD = {
  id: 4,
  name: 'Harbor Cottage',
  address: '12 Harbor Rd',
  city: 'Portland',
  state: 'ME',
  property_type: 'str',
  default_duration_hours: 3,
  icals: [
    {
      id: 11,
      url: 'https://www.airbnb.com/calendar/ical/ALREADY.ics',
      source: 'airbnb',
      active: true,
      last_synced_at: '2026-10-01T12:00:00',
      last_sync_status: 'ok',
      last_sync_error: null,
    },
  ],
}

function mount() {
  get.mockResolvedValue(FEED_PAYLOAD)
  return render(
    <MemoryRouter initialEntries={['/properties/4/icals']}>
      <Routes>
        <Route path="/properties/:propertyId/icals" element={<PropertyIcalsBulk />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

describe('PropertyIcalsBulk', () => {
  it('reads the narrow feed payload, never the full property record', async () => {
    mount()
    await screen.findByTestId('property-icals-bulk')

    const urls = get.mock.calls.map(c => c[0])
    expect(urls).toContain('/api/properties/4/icals')
    // The fat route, exactly. `/4/icals` must not satisfy this by substring.
    expect(urls.some(u => /\/api\/properties\/4$/.test(u)),
      'went back to the full property dict — house_code and wifi_password with it')
      .toBe(false)
  })

  it('shows the feeds the property already has', async () => {
    mount()
    await screen.findByTestId('existing-feeds')
    expect(screen.getAllByTestId('existing-feed-row')).toHaveLength(1)
  })

  it('turns each pasted line into a row and ignores blank ones', async () => {
    mount()
    await screen.findByTestId('property-icals-bulk')
    fireEvent.change(screen.getByTestId('bulk-paste'), {
      target: { value: 'https://a.example/one.ics\n\n  \nhttps://b.example/two.ics\n' },
    })
    await waitFor(() => expect(screen.getAllByTestId('parsed-feed-row')).toHaveLength(2))
  })

  it('does not re-add a feed the property already has, whatever its case', async () => {
    // The same Airbnb URL pasted from a different place differs only in case.
    // Adding it twice gives the property two identical feeds, and the sync
    // then creates every turnover twice.
    mount()
    await screen.findByTestId('property-icals-bulk')
    fireEvent.change(screen.getByTestId('bulk-paste'), {
      target: { value: 'https://WWW.AIRBNB.COM/calendar/ical/already.ics\nhttps://b.example/new.ics' },
    })
    await waitFor(() => expect(screen.getAllByTestId('parsed-feed-row')).toHaveLength(2))

    post.mockResolvedValue({})
    fireEvent.click(screen.getByTestId('bulk-add'))

    await waitFor(() => expect(post).toHaveBeenCalled())
    const posted = post.mock.calls
      .filter(c => String(c[0]).endsWith('/icals'))
      .map(c => c[1]?.url)
    expect(posted, 'the duplicate was added again').toEqual(['https://b.example/new.ics'])
  })
})
