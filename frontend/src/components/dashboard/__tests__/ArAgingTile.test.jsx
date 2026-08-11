/**
 * ArAgingTile pins the "Collect this morning" behavior: it renders the four
 * aging buckets from the derived `arAging` shape, sums each bucket's invoice
 * totals, shows the combined outstanding, and routes bucket clicks to the
 * matching invoice filter. The empty state must appear only when NOTHING is
 * outstanding.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ArAgingTile } from '../ArAgingTile'

afterEach(cleanup)

const aging = {
  current: [{ id: 1, total: 100 }, { id: 2, total: 50 }],
  30: [{ id: 3, total: 200 }],
  60: [],
  90: [{ id: 4, total: 1000 }],
}

describe('ArAgingTile', () => {
  it('renders each bucket total and the combined outstanding', () => {
    render(<ArAgingTile loading={false} arAging={aging} navigate={() => {}} />)
    expect(screen.getByText('$150')).toBeTruthy()   // current: 100 + 50
    expect(screen.getByText('$200')).toBeTruthy()   // 30–60
    expect(screen.getByText('$1,000')).toBeTruthy() // 90+
    // Outstanding footer = 150 + 200 + 0 + 1000 = 1350
    expect(screen.getByText('$1,350')).toBeTruthy()
  })

  it('labels invoice counts (singular vs plural) per bucket', () => {
    render(<ArAgingTile loading={false} arAging={aging} navigate={() => {}} />)
    expect(screen.getByText(/2 invoices · not yet 30 days/)).toBeTruthy()
    expect(screen.getByText(/1 invoice · past due/)).toBeTruthy()
  })

  it('routes an overdue bucket click to the filtered invoice list', () => {
    const navigate = vi.fn()
    render(<ArAgingTile loading={false} arAging={aging} navigate={navigate} />)
    fireEvent.click(screen.getByText('90+ days'))
    expect(navigate).toHaveBeenCalledWith('/billing?view=invoices&status=overdue')
  })

  it('routes the current bucket to the unfiltered list (nothing overdue yet)', () => {
    const navigate = vi.fn()
    render(<ArAgingTile loading={false} arAging={aging} navigate={navigate} />)
    fireEvent.click(screen.getByText('Current'))
    expect(navigate).toHaveBeenCalledWith('/billing?view=invoices&status=sent')
  })

  it('disables an empty bucket so it can’t navigate to an empty view', () => {
    const navigate = vi.fn()
    render(<ArAgingTile loading={false} arAging={aging} navigate={navigate} />)
    fireEvent.click(screen.getByText('60–90 days'))
    expect(navigate).not.toHaveBeenCalled()
  })

  it('shows the all-paid empty state only when nothing is outstanding', () => {
    render(<ArAgingTile loading={false} arAging={{ current: [], 30: [], 60: [], 90: [] }} navigate={() => {}} />)
    expect(screen.getByText('Nothing to collect')).toBeTruthy()
  })

  it('tolerates a missing arAging prop without crashing', () => {
    render(<ArAgingTile loading={false} arAging={undefined} navigate={() => {}} />)
    expect(screen.getByText('Nothing to collect')).toBeTruthy()
  })
})
