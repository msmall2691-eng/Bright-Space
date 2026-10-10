/**
 * "Recent visits" must not claim a visit happened.
 *
 * The panel drew a CheckCircle2 next to every job dated before today, whatever
 * its status. So a visit nobody closed out — still `scheduled`, three days ago
 * — appeared under "Recent visits" with a checkmark beside it. The one place
 * an operator looks to answer *"did we actually go?"* was answering **yes** on
 * the strength of the date alone.
 *
 * That is worse than a missing signal: a missing signal sends you to look, a
 * wrong one stops you looking. The owner's screenshot had a customer asking
 * exactly this question.
 *
 * Asserted through the rendered panel rather than by exporting the row, so
 * what is pinned is what the operator sees.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { ContactPanel } from '../ContactPanel'

const DETAIL = {
  id: 1, channel: 'sms', external_contact: '+12075550111',
  client: { id: 9, name: 'Anna Sweet', status: 'active' },
  messages: [],
}

const job = (over) => ({
  id: 50, title: 'Weekly clean', scheduled_date: '2020-03-02', status: 'completed', ...over,
})

function draw(pastJobs) {
  return render(
    <MemoryRouter>
      <ContactPanel detail={DETAIL} context={{ pastJobs }} mobileActive desktopOpen />
    </MemoryRouter>,
  )
}

/** The "Recent visits" block, found from its label. */
const recentVisits = () =>
  screen.getByText('Recent visits').closest('div').parentElement

afterEach(cleanup)

describe('a past visit shows its real state', () => {
  it('does not tick a visit that was never closed out', () => {
    const { container } = draw([job({ status: 'scheduled' })])
    const block = recentVisits()

    expect(
      within(block).queryByText(/not closed out/),
      'an unresolved visit reads as ordinary history',
    ).toBeTruthy()
    expect(
      block.querySelector('svg.lucide-circle-check-big, svg.lucide-check-circle-2'),
      'a visit nobody closed out is still wearing a checkmark',
    ).toBeNull()
    expect(container.querySelector('span.rounded-full')).toBeTruthy()
  })

  it('still ticks a completed visit', () => {
    // The other half. Suppressing the tick everywhere would pass the case
    // above and strip the panel of the one thing it was getting right.
    const block = (draw([job({ status: 'completed' })]), recentVisits())
    expect(within(block).queryByText(/not closed out/)).toBeNull()
    expect(
      block.querySelector('svg.lucide-circle-check-big, svg.lucide-check-circle-2'),
      'a completed visit lost its checkmark',
    ).toBeTruthy()
  })

  it('treats a cancelled visit as resolved, not as a loose end', () => {
    // The customer called it off. Flagging it would nag about work that was
    // agreed not to happen.
    const block = (draw([job({ status: 'cancelled' })]), recentVisits())
    expect(within(block).queryByText(/not closed out/)).toBeNull()
  })

  it('does not nag about a job that was never given a date', () => {
    // An accepted quote with no date yet produces status `unscheduled` and
    // scheduled_date null (quoting/router.py). `(null || '') < today` is
    // true, so it lands in pastJobs — and the first version of this row
    // called it "not closed out", nagging about work nobody had promised for
    // any particular day. The thread's note never counted it; the row and the
    // note now read the same predicate, so they cannot disagree again.
    const block = (draw([job({ status: 'unscheduled', scheduled_date: null })]), recentVisits())
    expect(within(block).queryByText(/not closed out/)).toBeNull()
  })
})
