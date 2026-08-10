/**
 * OpsSummary crew hand-off chip: shows "N/M sent to crew", warns while any
 * assigned job is still un-notified, and hides entirely before anything is
 * assigned (denominator 0).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import OpsSummary from '../OpsSummary'

afterEach(cleanup)

const base = { jobs: 4, unassigned: 0, capacityPct: 50, crewsOut: 2 }

describe('OpsSummary — hand-off chip', () => {
  it('shows N/M sent to crew when jobs are assigned', () => {
    render(<OpsSummary stats={{ ...base, assignedForHandoff: 3, sentToCrew: 1 }} isToday />)
    expect(screen.getByText('1/3')).toBeTruthy()
    expect(screen.getByText('sent to crew')).toBeTruthy()
  })

  it('omits the chip when nothing is assigned yet', () => {
    render(<OpsSummary stats={{ ...base, assignedForHandoff: 0, sentToCrew: 0 }} isToday />)
    expect(screen.queryByText('sent to crew')).toBeNull()
  })

  it('renders nothing at all when there are no jobs', () => {
    const { container } = render(<OpsSummary stats={{ ...base, jobs: 0 }} isToday />)
    expect(container.firstChild).toBeNull()
  })
})
