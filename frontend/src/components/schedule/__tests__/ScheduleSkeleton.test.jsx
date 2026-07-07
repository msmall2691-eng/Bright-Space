import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import ScheduleSkeleton from '../ScheduleSkeleton'

afterEach(cleanup)

describe('ScheduleSkeleton', () => {
  it('renders the month shape by default (7-column grid)', () => {
    render(<ScheduleSkeleton />)
    expect(screen.getByTestId('schedule-skeleton-month')).toBeTruthy()
  })

  it('renders a week-shaped skeleton when viewMode="week"', () => {
    render(<ScheduleSkeleton viewMode="week" />)
    expect(screen.getByTestId('schedule-skeleton-week')).toBeTruthy()
  })

  it('renders an agenda-shaped skeleton when viewMode="agenda"', () => {
    render(<ScheduleSkeleton viewMode="agenda" />)
    expect(screen.getByTestId('schedule-skeleton-agenda')).toBeTruthy()
  })

  it('falls back to the month shape for an unknown viewMode', () => {
    render(<ScheduleSkeleton viewMode="google" />)
    expect(screen.getByTestId('schedule-skeleton-month')).toBeTruthy()
  })
})
