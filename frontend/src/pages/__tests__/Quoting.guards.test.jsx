/**
 * Regression tests for the June 10 prod freeze report (P1): the /quoting page
 * must render — never crash or wedge the renderer — for any data the API can
 * plausibly return. Mounts the REAL Quoting page inside MemoryRouter with
 * fetch mocked, and fuzzes pathological shapes (legacy JSON item shapes,
 * garbage dates, envelopes, duplicate ids, huge numbers).
 *
 * Also pins the eachDay() iteration cap in CalendarView: a corrupt iCal/GCal
 * checkout date (e.g. year 9999) used to iterate millions of days per event
 * per render — the one construct in the frontend that could genuinely
 * hard-lock the browser on bad data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Quoting from '../Quoting'
import { eachDay } from '../../components/CalendarView'

const clients = [
  { id: 91, name: 'Harborview Rentals', email: 'guest@harborview.com', phone: '+12075550191', address: '12 Pier Rd', city: 'Portland', state: 'ME', zip_code: '04101', status: 'active' },
  { id: 12, name: 'Jane Doe', email: 'jane@example.com', phone: '+12075550112', status: 'active' },
]

const mkQuote = (over) => ({
  id: 1, client_id: 12, client_name: 'Jane Doe', intake_id: null, opportunity_id: null,
  property_id: null, quote_number: 'QT-2026-0001', public_token: null, title: null,
  service_type: 'residential', address: '5 Elm St, Portland, ME', notes: '',
  items: [{ name: 'Standard clean', description: '', qty: 1, unit_price: 185 }],
  subtotal: 185, tax_rate: 0, tax: 0, discount: 0, total: 185, status: 'draft',
  valid_until: null, sent_at: null, viewed_at: null, accepted_at: null,
  accepted_by_name: null, accepted_by_email: null, declined_at: null, converted_at: null,
  follow_up_sent_at: null, declined_reason: null, declined_by_name: null,
  requested_changes_message: null, requested_changes_at: null,
  created_at: '2026-06-01T14:00:00', updated_at: '2026-06-01T14:00:00', ...over,
})

// Mirrors the June 10 prod dataset: quote 8 is a draft with a public_token
// after a failed email send; quote 7 was just accepted.
const baseQuotes = [
  mkQuote({ id: 8, quote_number: 'QT-2026-0008', client_id: 91, public_token: 'tok_8', status: 'draft',
    created_at: '2026-06-10T17:05:00' }),
  mkQuote({ id: 7, quote_number: 'QT-2026-0007', client_id: 91, public_token: 'tok_7', status: 'accepted',
    sent_at: '2026-06-08T12:00:00', viewed_at: '2026-06-09T12:00:00', accepted_at: '2026-06-10T16:55:00' }),
  mkQuote({ id: 6, quote_number: 'QT-2026-0006', status: 'sent', public_token: 'tok_6', sent_at: '2026-06-05T12:00:00' }),
]

let DATA = {}

const routes = (url) => {
  const u = String(url)
  if (u.includes('/api/quotes/follow-ups')) return DATA.followUps ?? []
  const one = u.match(/\/api\/quotes\/(\d+)$/)
  if (one) return (DATA.quotes ?? []).find(q => String(q.id) === one[1]) ?? mkQuote({ id: +one[1] })
  if (u.includes('/api/quotes')) return DATA.quotes ?? []
  if (u.includes('/api/intake')) return DATA.intakes ?? []
  if (u.includes('/api/clients')) return DATA.clients ?? clients
  if (u.includes('/api/settings/quote-templates')) return DATA.templates ?? { templates: [] }
  if (u.includes('/api/settings')) return { company_name: 'Maine Cleaning Co' }
  return []
}

beforeEach(() => {
  localStorage.setItem('brightbase_jwt', 'test-jwt')
  localStorage.setItem('brightbase_user', JSON.stringify({ id: 1, email: 'office@mainecleaningco.com', role: 'admin' }))
  vi.stubGlobal('fetch', vi.fn(async (url) => new Response(JSON.stringify(routes(url)), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })))
})

const renderQuotesTab = async (entries = ['/quoting?tab=quotes']) => {
  const r = render(<MemoryRouter initialEntries={entries}><Quoting /></MemoryRouter>)
  await waitFor(() => expect(document.body.textContent).toMatch(/QT-|No quotes yet/))
  return r
}

const variants = {
  baseline: () => { DATA = { quotes: baseQuotes } },
  items_json_string: () => { DATA = { quotes: [mkQuote({ id: 8, items: '[{"name":"x","qty":1,"unit_price":5}]' })] } },
  items_object: () => { DATA = { quotes: [mkQuote({ id: 8, items: { name: 'x' } })] } },
  items_null_entries: () => { DATA = { quotes: [mkQuote({ id: 8, items: [null, { name: 'x' }] })] } },
  created_at_null: () => { DATA = { quotes: [mkQuote({ id: 8, created_at: null })] } },
  created_at_garbage: () => { DATA = { quotes: [mkQuote({ id: 8, created_at: '20266-13-99T99:99:99' })] } },
  total_string: () => { DATA = { quotes: [mkQuote({ id: 8, total: 'abc' })] } },
  status_null: () => { DATA = { quotes: [mkQuote({ id: 8, status: null })] } },
  duplicate_ids: () => { DATA = { quotes: [mkQuote({ id: 8 }), mkQuote({ id: 8 })] } },
  followups_weird: () => {
    DATA = {
      quotes: baseQuotes,
      followUps: [
        { ...mkQuote({ id: 6, status: 'sent' }), follow_up_reason: 'sent_not_viewed', hours_waiting: null },
        { ...mkQuote({ id: 5, status: 'viewed' }), follow_up_reason: 'viewed_not_accepted', hours_waiting: -12.5 },
      ],
    }
  },
  envelope_quotes: () => { DATA = { quotes: { items: baseQuotes, total: 3 } } },
  huge_qty: () => { DATA = { quotes: [mkQuote({ id: 8, items: [{ name: 'x', qty: 1e308, unit_price: 1e308 }] })] } },
}

describe('Quoting renders for any data shape', () => {
  for (const [name, setup] of Object.entries(variants)) {
    it(`variant: ${name}`, async () => {
      setup()
      await renderQuotesTab()
      cleanup()
    }, 10000)
  }

  it('navigation with state.quoteId opens the edit panel (items coerced)', async () => {
    DATA = { quotes: [mkQuote({ id: 8, quote_number: 'QT-2026-0008', items: { broken: true } })] }
    render(
      <MemoryRouter initialEntries={[{ pathname: '/quoting', state: { quoteId: 8 } }]}>
        <Quoting />
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText(/Edit QT-2026-0008/)).toBeDefined())
  }, 10000)

  it('send panel opens for the failed-send draft (quote 8)', async () => {
    DATA = { quotes: baseQuotes }
    const user = userEvent.setup()
    await renderQuotesTab()
    await user.click(screen.getAllByRole('button', { name: /Send/ })[0])
    await waitFor(() => expect(screen.getByText('Send Quote')).toBeDefined())
  }, 10000)
})

describe('eachDay is bounded', () => {
  it('caps a corrupt far-future checkout instead of iterating millions of days', () => {
    const days = eachDay('2026-06-01', '9999-12-31')
    expect(days.length).toBe(400)
    expect(days[0]).toBe('2026-06-01')
  })
  it('returns [] for invalid dates', () => {
    expect(eachDay('garbage', '2026-06-05')).toEqual([])
    expect(eachDay('2026-06-01', null)).toEqual([])
  })
  it('still walks a normal stay inclusively', () => {
    expect(eachDay('2026-06-01', '2026-06-04')).toEqual(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'])
  })
})
