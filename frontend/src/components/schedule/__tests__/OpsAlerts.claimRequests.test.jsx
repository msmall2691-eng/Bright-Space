/**
 * The office finding out that somebody is waiting — review finding 11.
 *
 * A sub filing a request fired a web push to the office and NOTHING ELSE. No
 * push subscription, notifications declined in the browser, VAPID unset on the
 * server — and the request sat pending with nobody aware of it until they
 * happened to open that job.
 *
 * The count now rides `pending_claim_requests`, already on every job in the
 * week payload, so this line cannot go missing with a notification and costs
 * no extra fetch. Pinned here: that it appears, that it counts PEOPLE rather
 * than jobs, that it covers the whole loaded range rather than only today, and
 * that it stays quiet when nobody is waiting.
 */
import { it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import OpsAlerts from '../OpsAlerts'

afterEach(cleanup)

const show = (props) => render(<OpsAlerts stats={{ unassigned: 0 }} unassignedToday={[]} {...props} />)

it('says how many people are waiting to hear back', () => {
  show({
    awaitingReply: [
      { id: 1, property_name: 'Harbour St', pending_claim_requests: 2, scheduled_date: '2026-09-10' },
      { id: 2, property_name: 'Elm Ave', pending_claim_requests: 1, scheduled_date: '2026-09-11' },
    ],
  })
  // Three people across two jobs — the number that matters is people, because
  // each one is somebody who asked and has heard nothing.
  expect(screen.getByText('3 subs are waiting to hear back')).toBeTruthy()
  expect(screen.getByText(/Harbour St, Elm Ave/)).toBeTruthy()
})

it('reads correctly for a single person', () => {
  show({ awaitingReply: [{ id: 1, property_name: 'Harbour St', pending_claim_requests: 1 }] })
  expect(screen.getByText('1 sub is waiting to hear back')).toBeTruthy()
})

it('says nothing when nobody is waiting', () => {
  // The control. This renders on every agenda load; a row that is always there
  // is a row nobody reads.
  const { container } = show({ awaitingReply: [] })
  expect(container.innerHTML).toBe('')
})

it('survives having never been given the prop', () => {
  // An older cached bundle, or any caller that doesn't pass it.
  const { container } = show({})
  expect(container.innerHTML).toBe('')
})

it('says it as a dot and words, never a count bubble', () => {
  // The owner vetoed count bubbles and tinted banners. (?!\d) keeps the
  // required 1.5×1.5 dot's own bg-violet-500 from matching bg-violet-50.
  const { container } = show({
    awaitingReply: [{ id: 1, property_name: 'Harbour St', pending_claim_requests: 2 }],
  })
  expect(container.innerHTML).not.toMatch(/\bbg-\w+-(50|100|200)(?!\d)/)
  expect(container.querySelectorAll('.w-1\\.5.h-1\\.5.rounded-full').length).toBeGreaterThan(0)
})
