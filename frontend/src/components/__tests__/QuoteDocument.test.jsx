/**
 * The customer-facing quote document must look intentional with EVERYTHING
 * populated and with the bare minimum — optional sections collapse entirely,
 * and operator-only data can never render. QuoteDocument is the exact
 * component behind both /quote/:token and the editor preview, so these tests
 * guard what customers actually see.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'

afterEach(cleanup)
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import QuoteDocument from '../QuoteDocument'
import PublicQuote from '../../pages/PublicQuote'

const FULL_QUOTE = {
  id: 14,
  quote_number: 'QT-2026-0014',
  quote_date: 'June 12, 2026',
  title: 'Bi-weekly residential cleaning — Falmouth, ME',
  customer_message: 'Hi Jane! Great speaking with you — here is the quote we discussed.',
  company_name: 'Maine Cleaning Co',
  company_email: 'office@mainecleaningco.com',
  company_phone: '+12075550100',
  terms: 'Payment due upon completion. 24h cancellation notice.',
  brand_color: '#1f2937',
  address: '12 Lighthouse Rd, Falmouth, ME',
  service_type: 'residential',
  notes: 'Includes kitchen, baths, floors. Excludes windows.',
  items: [
    { name: 'Bi-weekly clean', description: '3 bed / 2 bath', qty: 2, unit_price: 165 },
    { name: 'Inside fridge', description: '', qty: 1, unit_price: 35 },
  ],
  subtotal: 365, tax_rate: 5.5, tax: 20.08, total: 385.08,
  valid_until: 'June 30, 2026',
}

const MINIMAL_QUOTE = {
  id: 15,
  quote_number: 'QT-2026-0015',
  quote_date: null,
  title: null,
  customer_message: null,
  company_name: 'Maine Cleaning Co',
  company_email: null,
  company_phone: null,
  terms: null,
  brand_color: null,
  address: '',
  service_type: null,
  notes: null,
  items: [{ name: 'Standard clean', description: '', qty: 1, unit_price: 150 }],
  subtotal: 150, tax_rate: 0, tax: 0, total: 150,
  valid_until: null,
}

describe('QuoteDocument — fully populated', () => {
  it('renders every section of the shared design', () => {
    render(<QuoteDocument quote={FULL_QUOTE} />)
    expect(screen.getByText('Bi-weekly residential cleaning — Falmouth, ME')).toBeDefined()
    expect(screen.getAllByText(/Maine Cleaning Co/).length).toBeGreaterThan(0)
    expect(screen.getByText(/QT-2026-0014 · June 12, 2026/)).toBeDefined()
    expect(screen.getByText('Valid for 30 days — expires June 30, 2026')).toBeDefined()
    expect(screen.getByText(/Great speaking with you/)).toBeDefined()
    expect(screen.getByText('Service Address')).toBeDefined()
    expect(screen.getByText('12 Lighthouse Rd, Falmouth, ME')).toBeDefined()
    expect(screen.getByText('residential cleaning')).toBeDefined()
    expect(screen.getByText(/Includes kitchen, baths/)).toBeDefined()
    // Itemized table: qty + per-line amounts + totals, all currency-formatted
    expect(screen.getByText('Qty')).toBeDefined()
    expect(screen.getByText('Bi-weekly clean')).toBeDefined()
    expect(screen.getByText('3 bed / 2 bath')).toBeDefined()
    expect(screen.getByText('$330.00')).toBeDefined()   // 2 × 165
    expect(screen.getByText('$365.00')).toBeDefined()   // subtotal
    expect(screen.getByText('$385.08')).toBeDefined()   // total
    expect(screen.getByText(/Tax \(5.5%\)/)).toBeDefined()
    // Trust block
    expect(screen.getByText('office@mainecleaningco.com')).toBeDefined()
    expect(screen.getByText('+12075550100')).toBeDefined()
    expect(screen.getByText(/Payment due upon completion/)).toBeDefined()
  })
})

describe('QuoteDocument — minimal quote stays intentional', () => {
  it('collapses every empty optional section, no broken headings', () => {
    render(<QuoteDocument quote={MINIMAL_QUOTE} />)
    // Fallback headline instead of a blank header
    expect(screen.getByText('Your Cleaning Quote')).toBeDefined()
    expect(screen.getByText('Standard clean')).toBeDefined()
    expect(screen.getAllByText('$150.00').length).toBeGreaterThan(0)
    // Optional sections are GONE, not empty shells
    expect(screen.queryByText('Service Address')).toBeNull()
    expect(screen.queryByText('Scope & Details')).toBeNull()
    expect(screen.queryByText('Terms & Conditions')).toBeNull()
    expect(screen.queryByText(/Questions\?/)).toBeNull()
    expect(screen.queryByText(/Valid until/)).toBeNull()
    expect(screen.queryByText(/Tax/)).toBeNull()
  })
})

describe('QuoteDocument — customer safety', () => {
  it('never renders internal notes, even if present on the object', () => {
    render(<QuoteDocument quote={{
      ...FULL_QUOTE,
      internal_notes: 'TEST submission by Claude ... Please disregard.',
    }} />)
    expect(screen.queryByText(/Please disregard/)).toBeNull()
    expect(screen.queryByText(/TEST submission/)).toBeNull()
  })
})

describe('PublicQuote page renders the shared document with actions', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(
      JSON.stringify({ ...FULL_QUOTE, status: 'sent' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
  })

  it('shows the document + the action hierarchy', async () => {
    render(
      <MemoryRouter initialEntries={['/quote/tok123']}>
        <Routes><Route path="/quote/:token" element={<PublicQuote />} /></Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText('Bi-weekly residential cleaning — Falmouth, ME')).toBeDefined())
    expect(screen.getByRole('button', { name: 'Accept & schedule' })).toBeDefined()
    expect(screen.getByRole('button', { name: /Accept — we'll reach out/ })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Decline quote' })).toBeDefined()
  })

  it('offers Download PDF + Print in every state', async () => {
    render(
      <MemoryRouter initialEntries={['/quote/tok123']}>
        <Routes><Route path="/quote/:token" element={<PublicQuote />} /></Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText(/Download PDF/)).toBeDefined())
    const dl = screen.getByText(/Download PDF/).closest('a')
    expect(dl.getAttribute('href')).toContain('/api/quotes/public/tok123/pdf?download=1')
    expect(screen.getByRole('button', { name: /Print/ })).toBeDefined()
  })
})

describe('PublicQuote accept flow (e-sign + document stays visible)', () => {
  it('posts typed name/email and keeps the document with an Accepted banner', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url, opts })
      if (String(url).endsWith('/accept')) {
        return new Response(JSON.stringify({ status: 'accepted' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ...FULL_QUOTE, status: 'sent' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    render(
      <MemoryRouter initialEntries={['/quote/tok123']}>
        <Routes><Route path="/quote/:token" element={<PublicQuote />} /></Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /Accept — we'll reach out/ })).toBeDefined())

    fireEvent.change(screen.getByPlaceholderText(/Your name/), { target: { value: 'Megan Small' } })
    fireEvent.change(screen.getByPlaceholderText(/Your email/), { target: { value: 'megan@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /Accept — we'll reach out/ }))

    await waitFor(() => expect(screen.getByText(/Accepted ✓/)).toBeDefined())
    // Document is still mounted (not swapped for a standalone thank-you).
    expect(screen.getByText('Bi-weekly residential cleaning — Falmouth, ME')).toBeDefined()
    // The acceptor's typed name/email were sent.
    const accept = calls.find(c => String(c.url).endsWith('/accept'))
    const body = JSON.parse(accept.opts.body)
    expect(body.name).toBe('Megan Small')
    expect(body.email).toBe('megan@example.com')
  })
})

describe('PublicQuote self-schedule flow', () => {
  it('loads availability, books a slot, and shows a Booked banner', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url: String(url), opts })
      if (String(url).endsWith('/availability')) {
        return new Response(JSON.stringify({
          windows: [{ key: 'morning', label: 'Morning (9am–12pm)' }, { key: 'afternoon', label: 'Afternoon (1pm–4pm)' }],
          dates: [{ date: '2099-01-05', available: true }, { date: '2099-01-06', available: false }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (String(url).endsWith('/schedule')) {
        return new Response(JSON.stringify({ scheduled: true, date_label: 'January 05, 2099', window: 'morning', job_id: 9 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ...FULL_QUOTE, status: 'sent' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    render(
      <MemoryRouter initialEntries={['/quote/tok123']}>
        <Routes><Route path="/quote/:token" element={<PublicQuote />} /></Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept & schedule' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Accept & schedule' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Accept & book this time/ })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /Accept & book this time/ }))

    await waitFor(() => expect(screen.getByText(/Booked ✓ for January 05, 2099/)).toBeDefined())
    // Only the available date was offered as an option.
    const sched = calls.find(c => c.url.endsWith('/schedule'))
    expect(JSON.parse(sched.opts.body).date).toBe('2099-01-05')
    // Document still mounted.
    expect(screen.getByText('Bi-weekly residential cleaning — Falmouth, ME')).toBeDefined()
  })
})
