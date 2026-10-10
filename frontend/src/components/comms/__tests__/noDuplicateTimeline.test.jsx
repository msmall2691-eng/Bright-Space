/**
 * The customer panel no longer re-prints the thread sitting next to it.
 *
 * `ContactPanel` used to close with a "Conversation activity" feed: the last 15
 * messages of THIS thread, as author + channel + relative time + the body
 * truncated to 100 characters. #1152 turned this panel into a real column at
 * `shell:` instead of a full-screen overlay, which put that feed directly
 * beside the thread pane it was summarising — so it spent roughly a third of
 * the panel's height showing strictly less of what was already on screen. The
 * owner has named that kind of duplication herself ("it's almost a little
 * redundant").
 *
 * ## The test that makes the deletion safe
 *
 * Deleting a view is only correct while the view beside it is genuinely
 * richer. `the thread pane carries everything the feed did` below pins that:
 * author, channel, timestamp, full body, delivery status. If MessageBubble ever
 * stops showing the author, this deletion silently becomes a real loss of
 * information, and that case is what will say so.
 *
 * The one thing the feed marked that the bubbles do not is the channel of each
 * SMS — bubbles badge email and voice and leave SMS unmarked. That is the right
 * encoding (mark the exceptions, not the default) rather than an oversight, and
 * putting an icon on every bubble of a thread that is usually all texts would
 * cost more than it tells anyone.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MessageBubble } from '../MessageBubble'

// AiInsight POSTs on mount; the panel is not what that is about.
vi.mock('../../../api', () => ({
  get: vi.fn(() => Promise.resolve(null)),
  post: vi.fn(() => Promise.reject(new Error('no ai in tests'))),
  getCached: vi.fn(() => Promise.resolve(null)),
  onCacheInvalidated: vi.fn(() => () => {}),
  invalidateCached: vi.fn(),
}))

const { ContactPanel } = await import('../ContactPanel')

const DETAIL = {
  id: 9,
  channel: 'sms',
  external_contact: '+12075551212',
  client: { id: 4, name: 'Sam Rivera', phone: '+12075551212', status: 'active' },
  messages: [
    { id: 1, direction: 'inbound', channel: 'sms', body: 'a distinctive inbound line',
      created_at: '2026-10-01T12:00:00Z' },
    { id: 2, direction: 'outbound', channel: 'sms', body: 'a distinctive outbound line',
      created_at: '2026-10-01T13:00:00Z', author: 'Meg', status: 'delivered' },
  ],
}

const CONTEXT = {
  upcomingJobs: [{ id: 11, title: 'Deep clean', scheduled_date: '2026-11-02', start_time: '10:00:00' }],
  pastJobs: [],
  openQuotes: [{ id: 21, total: 450, status: 'sent' }],
  unpaidInvoices: [],
  stats: { visitCount: 7, lifetimeValue: 2400, nextServiceDate: '2026-11-02' },
}

const panel = (over = {}) => render(
  <MemoryRouter>
    <ContactPanel detail={DETAIL} context={CONTEXT} mobileActive desktopOpen
      onBack={() => {}} onClose={() => {}} {...over} />
  </MemoryRouter>,
)

afterEach(cleanup)

describe('the panel does not summarise the thread beside it', () => {
  it('has no activity feed heading', () => {
    panel()
    expect(screen.queryByText(/conversation activity/i)).toBeNull()
    expect(screen.queryByText(/no activity yet/i)).toBeNull()
  })

  it('does not re-print the message bodies', () => {
    panel()
    expect(screen.queryByText(/a distinctive inbound line/)).toBeNull()
    expect(screen.queryByText(/a distinctive outbound line/)).toBeNull()
  })
})

describe('its neighbours survived the deletion', () => {
  // The feed sat at the bottom of a scrolling column; removing it must not take
  // the sections above it, which are the reason to open this panel at all.
  it('still shows the upcoming appointment', () => {
    panel()
    expect(screen.getByText(/upcoming appointments/i)).toBeTruthy()
    expect(screen.getByText('Deep clean')).toBeTruthy()
  })

  it('still shows open money', () => {
    panel()
    expect(screen.getByText(/^money$/i)).toBeTruthy()
    expect(screen.getByText(/\$450 quote/)).toBeTruthy()
  })

  it('still shows the headline stats and the identity', () => {
    panel()
    expect(screen.getByText('7')).toBeTruthy()
    expect(screen.getByText('$2,400')).toBeTruthy()
    expect(screen.getAllByText('Sam Rivera').length).toBeGreaterThan(0)
  })
})

describe('the thread pane carries everything the feed did', () => {
  // This is what licenses the deletion. Each assertion names the field the
  // feed used to show, so if a bubble ever stops showing one, the loss is
  // reported here rather than discovered by the operator.
  const bubble = (m, over = {}) => render(
    <MessageBubble m={m} isFirst contactName="Sam Rivera" {...over} />,
  )

  it('shows who sent an outbound message', () => {
    bubble(DETAIL.messages[1])
    expect(screen.getByText('Meg')).toBeTruthy()
  })

  it('falls back to the contact name for an inbound message', () => {
    bubble(DETAIL.messages[0])
    expect(screen.getByText('Sam Rivera')).toBeTruthy()
  })

  it('shows the timestamp', () => {
    const { container } = bubble(DETAIL.messages[1])
    // fullTime renders a clock time; any digits-and-colon is enough to prove
    // a timestamp is rendered without pinning the locale format.
    expect(container.textContent).toMatch(/\d{1,2}:\d{2}/)
  })

  it('shows the whole body, not a 100-character slice', () => {
    const long = 'x'.repeat(260)
    bubble({ ...DETAIL.messages[0], body: long })
    expect(screen.getByText(long)).toBeTruthy()
  })

  it('marks a non-SMS channel', () => {
    const { container } = bubble({ ...DETAIL.messages[0], channel: 'email', subject: 'Re: quote' })
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0)
    expect(screen.getByText('Re: quote')).toBeTruthy()
  })

  it('shows delivery status, which the feed never did', () => {
    bubble(DETAIL.messages[1])
    expect(screen.getByLabelText('delivered')).toBeTruthy()
  })
})
