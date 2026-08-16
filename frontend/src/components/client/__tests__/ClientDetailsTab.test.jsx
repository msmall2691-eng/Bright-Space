import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ClientDetailsTab from '../ClientDetailsTab'

afterEach(cleanup)

const baseProps = {
  form: {}, setForm: vi.fn(),
  saving: false, save: vi.fn(),
  showBilling: false, setShowBilling: vi.fn(),
}

describe('ClientDetailsTab — upcoming cleanings linearity', () => {
  it('links each upcoming-cleaning card to its job (previously inert text)', () => {
    render(
      <MemoryRouter>
        <ClientDetailsTab {...baseProps} upcomingJobs={[
          { id: 42, scheduled_date: '2026-08-20', start_time: '09:00', end_time: '11:00', job_type: 'residential' },
        ]} />
      </MemoryRouter>
    )
    const link = screen.getByText('09:00 – 11:00').closest('a')
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('/jobs/42')
  })

  it('renders nothing in the strip when there are no upcoming jobs', () => {
    render(
      <MemoryRouter>
        <ClientDetailsTab {...baseProps} upcomingJobs={[]} />
      </MemoryRouter>
    )
    expect(screen.queryByText('Upcoming Cleanings')).toBeNull()
  })
})
