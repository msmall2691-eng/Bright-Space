/**
 * KpiCard — the headline stat tiles across the top of the owner dashboard and
 * quote funnel. The behaviour pinned here is the loading state: while a tile's
 * data is in flight it used to fall back to a bare "—" / "Loading…" line; now
 * the label + glyph stay put and only the number + sub shimmer as skeletons.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TrendingUp } from 'lucide-react'
import { KpiCard } from '../primitives'

afterEach(cleanup)

describe('KpiCard', () => {
  it('shows the value and sub when not loading', () => {
    render(<KpiCard icon={TrendingUp} label="Close rate" value="42%" sub="9 of 21 sent" />)
    expect(screen.getByText('Close rate')).toBeTruthy()
    expect(screen.getByText('42%')).toBeTruthy()
    expect(screen.getByText('9 of 21 sent')).toBeTruthy()
  })

  it('keeps the label but hides the value/sub while loading', () => {
    render(<KpiCard icon={TrendingUp} label="Close rate" value="42%" sub="9 of 21 sent" loading />)
    // Label + glyph still frame the tile so it reads as shaped, not blank…
    expect(screen.getByText('Close rate')).toBeTruthy()
    // …but the real number/sub are withheld in favour of skeleton bars.
    expect(screen.queryByText('42%')).toBeNull()
    expect(screen.queryByText('9 of 21 sent')).toBeNull()
    expect(screen.queryByText('Loading…')).toBeNull()
  })
})
