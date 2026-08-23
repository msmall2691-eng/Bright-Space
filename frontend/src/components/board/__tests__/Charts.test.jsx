/**
 * Home's two charts.
 *
 * What's pinned here is the judgement a chart can get wrong silently: both
 * money series share ONE scale (a second axis is how two series lie), the
 * lines are identified by more than colour, a chart with no data hides itself
 * rather than drawing twelve zeroes, and the funnel's bars are shares of the
 * first stage so they can only ever narrow.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { MoneyTrend, LeadFunnel } from '../Charts'

const draw = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>)
afterEach(cleanup)

// Twelve consecutive Mondays, labelled the way the backend labels them.
const weeks = (vals) => vals.map(([c, i], n) => {
  const d = new Date(Date.UTC(2026, 2, 2 + n * 7))   // Mon 2 Mar 2026 onward
  const label = `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}`
  return { week: d.toISOString().slice(0, 10), label, collected: c, invoiced: i }
})

const TREND = {
  weeks: 12,
  points: weeks([[100, 200], [150, 100], [0, 0], [400, 250], [220, 300], [90, 90],
    [310, 120], [180, 400], [260, 210], [0, 150], [340, 280], [500, 460]]),
  collected_total: 2550, invoiced_total: 2560, has_data: true,
}

describe('MoneyTrend', () => {
  it('draws both series against one shared scale', () => {
    const { container } = draw(<MoneyTrend snap={TREND} />)
    const paths = [...container.querySelectorAll('path')]
    expect(paths).toHaveLength(2)

    // The tallest point of EITHER series must sit at the top of the plot. If
    // each series were scaled to its own peak (a second axis by another name),
    // both would touch the top and the comparison would be a lie.
    const ys = paths.flatMap(p => p.getAttribute('d').match(/,(\d+\.?\d*)/g).map(m => parseFloat(m.slice(1))))
    const topmost = Math.min(...ys)
    const collectedTop = Math.min(...paths[0].getAttribute('d').match(/,(\d+\.?\d*)/g).map(m => parseFloat(m.slice(1))))
    const billedTop = Math.min(...paths[1].getAttribute('d').match(/,(\d+\.?\d*)/g).map(m => parseFloat(m.slice(1))))
    expect(collectedTop).toBe(topmost)      // 500 is the overall peak…
    expect(billedTop).toBeGreaterThan(topmost)  // …so 460 sits below it.
  })

  it('names both series so they are never told apart by colour alone', () => {
    draw(<MoneyTrend snap={TREND} />)
    expect(screen.getByText('Collected')).toBeTruthy()
    expect(screen.getByText('Billed')).toBeTruthy()
  })

  it('shows the totals, then the hovered week', () => {
    const { container } = draw(<MoneyTrend snap={TREND} />)
    const readout = () => within(screen.getByTestId('trend-readout'))
    expect(readout().getByText('Last 12 weeks')).toBeTruthy()
    expect(readout().getByText(/\$2,550/)).toBeTruthy()

    const svg = container.querySelector('svg')
    svg.getBoundingClientRect = () => ({ left: 0, width: 120 })
    fireEvent.mouseMove(svg, { clientX: 120 })     // far right → last week

    const last = TREND.points[TREND.points.length - 1]
    expect(readout().getByText(`Week of ${last.label}`)).toBeTruthy()
    expect(readout().getByText(/\$500/)).toBeTruthy()
    expect(readout().getByText(/\$460/)).toBeTruthy()
  })

  it('labels only some weeks, not a number on every point', () => {
    const { container } = draw(<MoneyTrend snap={TREND} />)
    const labels = [...container.querySelectorAll('span')]
      .filter(el => /^[A-Z][a-z]{2} \d+$/.test(el.textContent))
    const visible = labels.filter(el => !el.className.includes('invisible'))
    expect(labels).toHaveLength(12)
    expect(visible.length).toBeLessThan(labels.length)
  })

  it('hides itself rather than drawing an empty chart', () => {
    const { container } = draw(
      <MoneyTrend snap={{ ...TREND, has_data: false }} />)
    expect(container.textContent).toBe('')
  })

  it('hides itself when the box failed to build server-side', () => {
    const { container } = draw(<MoneyTrend snap={null} />)
    expect(container.textContent).toBe('')
  })
})

const FUNNEL = {
  window_days: 30,
  steps: [
    { key: 'requests', label: 'Requests', count: 20 },
    { key: 'quoted', label: 'Quoted', count: 12 },
    { key: 'accepted', label: 'Accepted', count: 7 },
    { key: 'won', label: 'Won', count: 5 },
  ],
  widths: [100, 60, 35, 25],
  overall_pct: 25.0,
  by_source: [
    { source: 'website', requests: 12, won: 3, won_pct: 25.0 },
    { source: 'referral', requests: 8, won: 2, won_pct: 25.0 },
  ],
  has_data: true,
}

describe('LeadFunnel', () => {
  it('shows every stage with its count and the step-to-step drop', () => {
    draw(<LeadFunnel snap={FUNNEL} />)
    for (const s of FUNNEL.steps) {
      expect(screen.getByText(s.label)).toBeTruthy()
      expect(screen.getByText(String(s.count))).toBeTruthy()
    }
    expect(screen.getByText('60%')).toBeTruthy()   // 12 of 20 quoted
    expect(screen.getByText('58%')).toBeTruthy()   // 7 of 12 accepted
  })

  it('draws bars that only ever narrow down the funnel', () => {
    const { container } = draw(<LeadFunnel snap={FUNNEL} />)
    const bars = [...container.querySelectorAll('[style*="width"]')]
      .map(el => parseFloat(el.style.width))
    expect(bars).toHaveLength(4)
    expect(bars[0]).toBe(100)
    expect(bars).toEqual([...bars].sort((a, b) => b - a))
  })

  it('says where the leads came from', () => {
    draw(<LeadFunnel snap={FUNNEL} />)
    expect(screen.getByText('website')).toBeTruthy()
    expect(screen.getByText('referral')).toBeTruthy()
    expect(screen.getByText(/12 · 3 won/)).toBeTruthy()
  })

  it('links out to the full funnel', () => {
    draw(<LeadFunnel snap={FUNNEL} />)
    expect(screen.getByText(/Full funnel/).getAttribute('href')).toBe('/funnel')
  })

  it('hides itself for a business with no requests in the window', () => {
    const { container } = draw(
      <LeadFunnel snap={{ ...FUNNEL, has_data: false }} />)
    expect(container.textContent).toBe('')
  })
})
