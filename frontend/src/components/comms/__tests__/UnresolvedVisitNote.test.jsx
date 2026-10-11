/**
 * The note that answers "no one came yesterday" before the operator has to
 * go and find out.
 *
 * Three properties matter, and each is a way this could go wrong:
 *
 *  - it says nothing when nothing is wrong (a permanent all-clear trains
 *    people to skip the spot the real thing appears in);
 *  - it LINKS rather than acts — `Job` is canonical and the Schedule owns
 *    resolving one, so a "Mark complete" here would make the inbox a second
 *    writer of schedule state (scheduling-invariants Rule 0);
 *  - it names the date, because "a visit wasn't closed out" sends the
 *    operator hunting for which one.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { UnresolvedVisitNote } from '../UnresolvedVisitNote'

const visit = (over) => ({ id: 31, title: 'Weekly clean', scheduled_date: '2026-10-09', ...over })

const draw = (visits) => render(
  <MemoryRouter><UnresolvedVisitNote visits={visits} /></MemoryRouter>,
)

afterEach(cleanup)

describe('it only speaks when there is something to say', () => {
  it('renders nothing when every past visit is closed out', () => {
    const { container } = draw([])
    expect(container.innerHTML, 'a standing all-clear is noise').toBe('')
  })

  it('renders nothing when the prop is missing entirely', () => {
    const { container } = render(<MemoryRouter><UnresolvedVisitNote /></MemoryRouter>)
    expect(container.innerHTML).toBe('')
  })
})

describe('what it says', () => {
  it('names the day, so the operator does not have to go hunting', () => {
    draw([visit()])
    expect(screen.getByText(/Friday/)).toBeTruthy()
  })

  it('counts the earlier ones without listing them', () => {
    draw([visit(), visit({ id: 32, scheduled_date: '2026-10-02' }), visit({ id: 33, scheduled_date: '2026-09-25' })])
    expect(screen.getByText(/2 earlier ones/)).toBeTruthy()
  })

  it('says "one" rather than "1 ones" for a single extra', () => {
    draw([visit(), visit({ id: 32, scheduled_date: '2026-10-02' })])
    expect(screen.getByText(/1 earlier one(?!s)/)).toBeTruthy()
  })

  it('does not mention earlier visits when there is only the one', () => {
    draw([visit()])
    expect(screen.queryByText(/earlier/)).toBeNull()
  })
})

describe('it points at the screen that owns the answer', () => {
  it('links to the job rather than offering to resolve it here', () => {
    const { container } = draw([visit({ id: 77 })])

    const link = container.querySelector('a[href="/jobs/77"]')
    expect(link, 'no link to the job the note is about').toBeTruthy()

    // The constraint, pinned: Job is canonical and the inbox must not become
    // a second writer of schedule state. A button here would be that.
    expect(
      within(container).queryAllByRole('button'),
      'the note offers an action — resolving a visit belongs on the Schedule',
    ).toEqual([])
  })
})
