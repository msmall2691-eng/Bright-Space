/**
 * Owner Dashboard analytics widgets — the quiet-style tiles added for
 * "more analytics, no SaaS bubbles":
 *   • PropertyEconomicsTile: renders the per-property money table, links each
 *     property to its record, and blanks $/hr when no crew hours exist.
 *   • WeekCapacityTile: utilization headline + honest "assumed 8h/day" caption.
 *   • CrewHoursTile: hours per cleaner, amber-dot + footer for unclassified.
 *   • FeedHealthTile: fresh/stale/failed feed classification and record links.
 *   • RecurringHealthTile: severity split of the Recurring Doctor audit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { PropertyEconomicsTile } from '../PropertyEconomicsTile'
import { WeekCapacityTile } from '../WeekCapacityTile'
import { CrewHoursTile } from '../CrewHoursTile'
import { FeedHealthTile, feedTone } from '../FeedHealthTile'
import { RecurringHealthTile, splitBySeverity } from '../RecurringHealthTile'

afterEach(cleanup)

describe('PropertyEconomicsTile', () => {
  const data = {
    window_days: 90,
    properties_total: 2,
    properties: [
      { property_id: 7, property_name: '4 Red Barn Circle', property_type: 'str',
        client_id: 3, invoice_count: 4, revenue_paid: 1200, revenue_invoiced: 1500,
        visits: 6, crew_hours: 16, effective_hourly: 75 },
      { property_id: 9, property_name: '12 Elm St', property_type: 'residential',
        client_id: 4, invoice_count: 1, revenue_paid: 150, revenue_invoiced: 150,
        visits: 1, crew_hours: 0, effective_hourly: null },
    ],
  }

  it('renders each property as a link to its record with its money', () => {
    render(<PropertyEconomicsTile loading={false} data={data} navigate={() => {}} />)
    const link = screen.getByText('4 Red Barn Circle')
    expect(link.getAttribute('href')).toBe('/properties/7')
    expect(screen.getByText('$1,200')).toBeTruthy()   // paid
    expect(screen.getByText('$1,500')).toBeTruthy()   // invoiced
    expect(screen.getByText('$75')).toBeTruthy()      // effective $/hr
  })

  it('blanks $/hr and hours when no crew hours were clocked', () => {
    render(<PropertyEconomicsTile loading={false} data={data} navigate={() => {}} />)
    const row = screen.getByText('12 Elm St').closest('tr')
    // hours and $/hr both show the honest em-dash
    expect(row.textContent).toContain('—')
    expect(row.textContent).not.toContain('$/hr')
  })

  it('shows the empty state when nothing was invoiced', () => {
    render(<PropertyEconomicsTile loading={false}
      data={{ window_days: 90, properties_total: 0, properties: [] }} navigate={() => {}} />)
    expect(screen.getByText(/No invoiced work in the last 90 days/)).toBeTruthy()
  })
})

describe('WeekCapacityTile', () => {
  const data = {
    week_start: '2026-08-10', week_end: '2026-08-16',
    booked_hours: 30, available_hours: 60, utilization_pct: 50,
    crew_count: 3, crew_without_pattern: 1,
    days: [
      { date: '2026-08-10', weekday: 'mon', jobs: 2, booked_hours: 6, available_hours: 12 },
      { date: '2026-08-11', weekday: 'tue', jobs: 1, booked_hours: 3, available_hours: 12 },
    ],
  }

  it('shows the utilization headline and hours', () => {
    render(<WeekCapacityTile loading={false} data={data} navigate={() => {}} />)
    expect(screen.getByText('50%')).toBeTruthy()
    expect(screen.getByText(/30h of 60h crew availability/)).toBeTruthy()
  })

  it('captions the assumed-full-time crew so the estimate is honest', () => {
    render(<WeekCapacityTile loading={false} data={data} navigate={() => {}} />)
    expect(screen.getByText(/1 crew without availability set — assumed 8h\/day/)).toBeTruthy()
  })

  it('flags an over-capacity week', () => {
    render(<WeekCapacityTile loading={false} navigate={() => {}}
      data={{ ...data, booked_hours: 70, utilization_pct: 117 }} />)
    expect(screen.getByText('over capacity')).toBeTruthy()
  })
})

describe('CrewHoursTile', () => {
  const data = {
    employees: [
      { employee_id: 'a1', name: 'Dana', total_hours: 22.5, unclassified_hours: 0 },
      { employee_id: 'b2', name: 'Kim', total_hours: 12, unclassified_hours: 3 },
      { employee_id: 'c3', name: 'Idle', total_hours: 0, unclassified_hours: 0 },
    ],
  }

  it('lists cleaners with hours (skipping zero-hour rows) and flags unclassified', () => {
    render(<CrewHoursTile loading={false} data={data} navigate={() => {}} />)
    expect(screen.getByText('Dana')).toBeTruthy()
    expect(screen.getByText(/3h unclassified/)).toBeTruthy()
    expect(screen.queryByText('Idle')).toBeNull()
    expect(screen.getByText(/unpaid until the punch is assigned/)).toBeTruthy()
  })

  it('routes the tile action to payroll', () => {
    const navigate = vi.fn()
    render(<CrewHoursTile loading={false} data={data} navigate={navigate} />)
    fireEvent.click(screen.getByText('Open payroll'))
    expect(navigate).toHaveBeenCalledWith('/payroll')
  })
})

describe('FeedHealthTile', () => {
  it('classifies feed freshness like the Sync Center', () => {
    const now = new Date().toISOString()
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString()
    expect(feedTone({ status: 'failed', last_synced_at: now })).toBe('failing')
    expect(feedTone({ status: 'retrying', last_synced_at: now })).toBe('failing')
    expect(feedTone({ status: 'ok', last_synced_at: null })).toBe('never')
    expect(feedTone({ status: 'ok', last_synced_at: old })).toBe('stale')
    expect(feedTone({ status: 'ok', last_synced_at: now })).toBe('fresh')
  })

  it('renders each feed with a property link and event count', () => {
    const data = {
      channels: [{
        key: 'airbnb',
        feeds: [{
          id: 1, property_id: 7, property: '4 Red Barn Circle', source: 'airbnb',
          last_synced_at: new Date().toISOString(), last_events_seen: 31, status: 'ok',
        }],
      }],
    }
    render(<FeedHealthTile loading={false} data={data} navigate={() => {}} />)
    const link = screen.getByText('4 Red Barn Circle')
    expect(link.getAttribute('href')).toBe('/properties/7')
    expect(screen.getByText(/31 events/)).toBeTruthy()
  })

  it('shows the empty state with no feeds', () => {
    render(<FeedHealthTile loading={false} data={{ channels: [] }} navigate={() => {}} />)
    expect(screen.getByText('No rental feeds connected.')).toBeTruthy()
  })
})

describe('RecurringHealthTile', () => {
  it('splits issues by their worst problem severity', () => {
    const issues = [
      { problems: [{ severity: 'warn' }, { severity: 'error' }] },  // worst: error
      { problems: [{ severity: 'warn' }] },
      { problems: [{ severity: 'info' }] },
    ]
    expect(splitBySeverity(issues)).toEqual({ error: 1, warn: 1, info: 1 })
  })

  it('renders the severity split with a link to /recurring', () => {
    const navigate = vi.fn()
    const data = {
      scanned: 10, healthy: 7,
      issues: [
        { problems: [{ severity: 'error' }] },
        { problems: [{ severity: 'warn' }] },
        { problems: [{ severity: 'warn' }] },
      ],
    }
    render(<RecurringHealthTile loading={false} data={data} navigate={navigate} />)
    expect(screen.getByText('1 error')).toBeTruthy()
    expect(screen.getByText('2 need attention')).toBeTruthy()
    fireEvent.click(screen.getByText('2 need attention'))
    expect(navigate).toHaveBeenCalledWith('/recurring')
  })

  it('shows the all-healthy line when the audit is clean', () => {
    render(<RecurringHealthTile loading={false}
      data={{ scanned: 8, healthy: 8, issues: [] }} navigate={() => {}} />)
    expect(screen.getByText(/All 8 series healthy/)).toBeTruthy()
  })
})
